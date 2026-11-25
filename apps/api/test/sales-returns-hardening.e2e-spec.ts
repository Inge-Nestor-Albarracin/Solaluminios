import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { businessToday } from '../src/shared/db.js';
import { barrierAtTransactionStart, createBarrier } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Hardening of sales returns (documento DV) and saldo a favor on the real
// PostgreSQL test database: races (requests, decisions, receptions, the money
// of two returns of one order, saldo a favor, credit note and refund), hostile
// input (SQL injection in paths, queries and bodies; stored text returned
// verbatim), authorization by role, owner and location, validation, and the
// database rules when the API is bypassed. Each scenario uses its own finish
// so stock never mixes. Data: unique suffix, test database only; nothing is
// deleted (received returns are final by design).

type Res = request.Response;

interface ReturnLine {
  id: string;
  salesOrderLineId: string;
  quantity: number;
  goodQuantity: number | null;
  damagedQuantity: number | null;
}
interface ReturnBody {
  id: string;
  number: string;
  status: string;
  notes?: string | null;
  decisionNote?: string | null;
  cancelReason?: string | null;
  receptionNote?: string | null;
  amount?: string | null;
  baseAmount?: string | null;
  settledAmount?: string | null;
  refundPending?: boolean;
  refund?: { medium: string; note: string | null; refundedOn: string | null; transferEntity: { id: string } | null } | null;
  creditNote: { number: string } | null;
  creditNotePending: boolean;
  lines: ReturnLine[];
}
interface OrderBody {
  id: string;
  number: string;
  total: string;
  paymentStatus: 'PENDING' | 'PAID' | null;
  lines: { id: string; quantity: number }[];
  paymentSummary: { returned: string; settled: string; net: string; paid: string; balance: string };
  customerCredit: string;
  payments: { medium: string; amount: string }[];
}
interface Returnable {
  lines: { id: string; delivered: number; returned: number; inProcess: number; returnable: number }[];
}
interface ListBody {
  total: number;
  items: ({ id: string; status: string } & Record<string, unknown>)[];
}

const FINISHES = [
  'RACE_CREATE',
  'RACE_KEY',
  'RACE_DECIDE',
  'RACE_CANCEL',
  'RACE_RECEIVE',
  'RACE_RECV_CANCEL',
  'RACE_TWO',
  'RACE_TWO_ABONO',
  'RACE_CREDIT',
  'RACE_DOCS',
  'HOSTILE_PATH',
  'HOSTILE',
  'HOSTILE_BILL',
  'HOSTILE_KEYS',
  'HOSTILE_NUL',
  'AUTHZ',
  'VALID_CREATE',
  'VALID_RECV_A',
  'VALID_RECV_B',
  'VALID_MONEY',
  'VALID_CONVERT',
  'DB_RULES',
] as const;
type FinishKey = (typeof FINISHES)[number];

const NASTY_SQL = "'; DROP TABLE sales_returns;--";
const NASTY_HTML = '<script>alert(1)</script>';
const NASTY = `${NASTY_SQL} ${NASTY_HTML}`;
const PRICE = 11900; // 10.000 + VAT 19 %

// Money fields that the warehouse must never receive.
const MONEY_KEYS = new Set(['amount', 'baseAmount', 'settledAmount', 'estimatedAmount', 'total', 'refund', 'lineTotal', 'unitValue', 'customerCredit']);
function moneyFields(value: unknown, onlyWithValue: boolean, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => moneyFields(item, onlyWithValue, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => [
    ...(MONEY_KEYS.has(key) && (!onlyWithValue || (item !== null && item !== undefined)) ? [`${path}.${key}=${JSON.stringify(item)}`] : []),
    ...moneyFields(item, onlyWithValue, `${path}.${key}`),
  ]);
}

const codes = (responses: Res[]) => responses.map((r) => r.status).sort((a, b) => a - b);
const dump = (responses: Res[]) => JSON.stringify(responses.map((r) => [r.status, (r.body as { message?: unknown }).message]));
const message = (res: Res) => {
  const value = (res.body as { message?: unknown }).message;
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
};
const pesos = (value: number) => value.toFixed(2);

// The text of a rejected database call (message, code, meta and cause).
async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const e = error as { message?: string; code?: string; meta?: unknown; cause?: unknown };
    const safe = (value: unknown) => {
      try {
        return JSON.stringify(value ?? {});
      } catch {
        return '';
      }
    };
    return `${e.code ?? ''} ${e.message ?? ''} ${safe(e.meta)} ${safe(e.cause)}`;
  }
  return 'NOT REJECTED';
}

describe('Sales returns hardening (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', supplier: '', branch: '', loc: '', loc2: '', rack: '', customer: '', creditCustomer: '', dbCustomer: '', emptyCustomer: '' };
  const finishes = {} as Record<FinishKey, string>;
  let epcCounter = 0;
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const nextIp = () => {
    ip += 1;
    return `10.78.${Math.floor(ip / 250) % 250}.${(ip % 250) + 1}`;
  };
  const as = (who: string | null) => (who ? { ...H[who], 'X-Forwarded-For': nextIp() } : { 'X-Forwarded-For': nextIp() });
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const shiftDay = (days: number) => new Date(Date.parse(`${businessToday()}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

  const get = (path: string, who: string | null) => http().get(path).set(as(who));
  const post = (path: string, who: string | null, body: string | object = {}) => http().post(path).set(as(who)).send(body);
  const call = (method: 'GET' | 'POST', path: string, who: string | null, body?: object) => (method === 'GET' ? get(path, who) : post(path, who, body ?? {}));

  // Runs `work` with the next `count` interactive transactions held at a
  // barrier, so the racing requests enter their transactions together.
  const racing = async <T>(count: number, work: () => Promise<T>): Promise<T> => {
    const restore = barrierAtTransactionStart(prisma, count, createBarrier(count));
    try {
      return await work();
    } finally {
      restore();
    }
  };

  const bundle = async (finish: FinishKey, quantity: number) => {
    const epc = `HD${S}${String(++epcCounter).padStart(4, '0')}`;
    const res = await post('/inventory/bundles', 'WAREHOUSE', {
      epc,
      referenceId: ids.ref,
      finishId: finishes[finish],
      quantity,
      inventoryLocationId: ids.loc,
      rackId: ids.rack,
      registrationType: 'ENTRY',
      arrivalDatePrecision: 'UNKNOWN',
      origin: 'NATIONAL',
      supplierId: ids.supplier,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { id: res.body.id as string, epc };
  };

  // Price 10.000 per profile + VAT 19 % = 11.900.
  const makeQuote = async (lines: { finish: FinishKey; quantity: number }[], customerId = ids.customer) => {
    const res = await post('/quotes', 'SALES', {
      customerId,
      lines: lines.map((l) => ({ referenceId: ids.ref, finishId: finishes[l.finish], origin: 'NATIONAL', quantity: l.quantity, discountPercent: '0', taxRatePercent: '19' })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; total: string };
  };
  const convert = (quoteId: string, body: Record<string, unknown>) => post(`/quotes/${quoteId}/convert`, 'SALES', { operationKey: randomUUID(), ...body });
  const order = async (lines: { finish: FinishKey; quantity: number }[], paymentMethod: string, extra: Record<string, unknown> = {}, customerId = ids.customer) => {
    const quote = await makeQuote(lines, customerId);
    const res = await convert(quote.id, { paymentMethod, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as OrderBody;
  };

  // Reserve, dispatch every line in full and confirm the physical exit.
  const deliver = async (o: OrderBody) => {
    expect((await post(`/sales-orders/${o.id}/confirm`, 'SALES', { inventoryLocationId: ids.loc })).status).toBe(200);
    const dispatch = await post(`/sales-orders/${o.id}/dispatches`, 'SALES', {
      operationKey: randomUUID(),
      assigneeId: U.WAREHOUSE,
      dueAt: inHours(5),
      lines: o.lines.map((l) => ({ salesOrderLineId: l.id, quantity: l.quantity })),
    });
    expect(dispatch.status, JSON.stringify(dispatch.body)).toBe(201);
    const dispatchId = dispatch.body.id as string;
    const detail = (await get(`/dispatches/${dispatchId}`, 'WAREHOUSE').expect(200)).body as { lines: { suggested: { epc: string }[] }[] };
    for (const line of detail.lines) {
      for (const suggestion of line.suggested) {
        expect((await post(`/dispatches/${dispatchId}/scan`, 'WAREHOUSE', { epc: suggestion.epc }).expect(200)).body.result).toBe('PREPARED');
      }
    }
    expect((await post(`/dispatches/${dispatchId}/confirm`, 'WAREHOUSE', { operationKey: randomUUID() })).status).toBe(200);
  };

  // One bundle, one order of one line, delivered in full.
  const setup = async (finish: FinishKey, quantity: number, paymentMethod = 'CASH', extra: Record<string, unknown> = {}, customerId = ids.customer) => {
    const b = await bundle(finish, quantity);
    const o = await order([{ finish, quantity }], paymentMethod, extra, customerId);
    await deliver(o);
    return { o, b };
  };

  const createReturn = (o: OrderBody, lines: { salesOrderLineId: string; quantity: number }[], body: Record<string, unknown> = {}, who = 'SALES') =>
    post(`/sales-orders/${o.id}/returns`, who, {
      operationKey: randomUUID(),
      reason: 'SELLER_ERROR',
      settlement: 'CREDIT',
      lines,
      ...(who === 'SALES' || who === 'SALES2' ? { approverId: U.ADMIN } : {}),
      ...body,
    });
  const requestReturn = (o: OrderBody, quantity: number, body: Record<string, unknown> = {}, who = 'SALES') =>
    createReturn(o, [{ salesOrderLineId: o.lines[0].id, quantity }], body, who);
  const asked = async (o: OrderBody, quantity: number, body: Record<string, unknown> = {}, who = 'SALES') => {
    const res = await requestReturn(o, quantity, body, who);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as ReturnBody;
  };
  const receiveLines = (id: string, lines: unknown, extra: Record<string, unknown> = {}, who = 'WAREHOUSE') =>
    post(`/sales-returns/${id}/receive`, who, { operationKey: randomUUID(), lines, ...extra });
  const receive = (r: ReturnBody, good: number, damaged: number, extra: Record<string, unknown> = {}, who = 'WAREHOUSE') =>
    receiveLines(r.id, [{ lineId: r.lines[0].id, good, damaged }], extra, who);
  const received = async (r: ReturnBody, good: number, damaged: number, extra: Record<string, unknown> = {}, who = 'WAREHOUSE') => {
    const res = await receive(r, good, damaged, extra, who);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const approve = (id: string, who = 'ADMIN', body: object = {}) => post(`/sales-returns/${id}/approve`, who, body);
  const reject = (id: string, reason: string, who = 'ADMIN') => post(`/sales-returns/${id}/reject`, who, { reason });
  const cancel = (id: string, reason: string, who = 'SALES') => post(`/sales-returns/${id}/cancel`, who, { reason });
  const refund = (id: string, body: Record<string, unknown>, who = 'SALES') => post(`/sales-returns/${id}/refund`, who, { refundedOn: businessToday(), ...body });
  const creditNote = (id: string, number: unknown, who = 'BILLING') => post(`/sales-returns/${id}/credit-note`, who, { number });
  const pay = (orderId: string, medium: string, amount: string, extra: Record<string, unknown> = {}) =>
    post(`/sales-orders/${orderId}/payments`, 'SALES', { operationKey: randomUUID(), medium, amount, paidOn: businessToday(), ...extra });

  const getReturn = (id: string, who = 'ADMIN') => get(`/sales-returns/${id}`, who);
  const returnRow = (id: string) => prisma.salesReturn.findUniqueOrThrow({ where: { id }, include: { lines: true } });
  const getOrder = async (id: string) => (await get(`/sales-orders/${id}`, 'ADMIN').expect(200)).body as OrderBody;
  const returnable = async (id: string) => (await get(`/sales-orders/${id}/returnable`, 'ADMIN').expect(200)).body as Returnable;
  const creditOf = async (customerId: string) => {
    const res = await get(`/customers/${customerId}/credit`, 'ADMIN').expect(200);
    return (res.body as { available: string }).available;
  };
  const bundleRow = (id: string) => prisma.bundle.findUniqueOrThrow({ where: { id }, select: { quantity: true, openedAt: true } });
  const returnMovements = (salesReturnId: string) => prisma.inventoryMovement.findMany({ where: { type: 'RETURN', salesReturnLine: { salesReturnId } } });
  const openTasks = (salesReturnId: string) => prisma.task.findMany({ where: { salesReturnId, completedAt: null, cancelledAt: null } });
  const tasksOf = (salesReturnId: string, kind: 'RETURN_APPROVAL' | 'RETURN_RECEPTION' | 'CREDIT_NOTE') => prisma.task.findMany({ where: { salesReturnId, kind } });
  const notices = (kind: string, salesReturnId: string) => prisma.notificationOutbox.count({ where: { kind, dedupeKey: { startsWith: `${kind}:${salesReturnId}:` } } });

  // Every movement of a bundle chains from 0 to its current quantity.
  const ledgerError = async (bundleId: string) => {
    const b = await prisma.bundle.findUniqueOrThrow({ where: { id: bundleId }, include: { movements: true } });
    const remaining = [...b.movements].sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime() || x.createdAt.getTime() - y.createdAt.getTime());
    let balance = 0;
    while (remaining.length > 0) {
      const index = remaining.findIndex((m) => m.quantityBefore === balance);
      if (index < 0) return `ningún movimiento parte de ${balance}`;
      balance = remaining.splice(index, 1)[0].quantityAfter;
    }
    return balance === b.quantity ? null : `saldo final ${balance} ≠ paquete ${b.quantity}`;
  };

  const myCustomers = () => [ids.customer, ids.creditCustomer, ids.dbCustomer, ids.emptyCustomer];
  const myCounts = async () => ({
    returns: await prisma.salesReturn.count({ where: { customerId: { in: myCustomers() } } }),
    lines: await prisma.salesReturnLine.count({ where: { salesReturn: { customerId: { in: myCustomers() } } } }),
    movements: await prisma.inventoryMovement.count({ where: { bundle: { referenceId: ids.ref } } }),
    stock: (await prisma.bundle.aggregate({ where: { referenceId: ids.ref }, _sum: { quantity: true } }))._sum.quantity,
    tasks: await prisma.task.count({ where: { salesReturn: { customerId: { in: myCustomers() } } } }),
    payments: await prisma.salesOrderPayment.count({ where: { salesOrder: { customerId: { in: myCustomers() } } } }),
    transferEntities: await prisma.transferEntity.count(),
  });
  const TABLES = ['customers', 'inventory_movements', 'sales_order_payments', 'sales_return_lines', 'sales_returns', 'tasks', 'transfer_entities', 'users'];
  const tablesPresent = async () =>
    (
      await prisma.$queryRaw<{ table_name: string }[]>`
        SELECT table_name::text AS table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name::text IN ('customers', 'inventory_movements', 'sales_order_payments', 'sales_return_lines', 'sales_returns', 'tasks', 'transfer_entities', 'users')`
    )
      .map((row) => row.table_name)
      .sort();

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    const roles = {
      ADMIN: 'ADMIN',
      ADMIN_OFF: 'ADMIN',
      SALES: 'SALES',
      SALES2: 'SALES',
      WAREHOUSE: 'WAREHOUSE',
      WAREHOUSE2: 'WAREHOUSE',
      BILLING: 'BILLING',
      READ_ONLY: 'READ_ONLY',
      ACCESSORIES: 'ACCESSORIES',
      CHINA_OPERATOR: 'CHINA_OPERATOR',
    } as const;
    for (const [key, role] of Object.entries(roles)) {
      const user = await createTestUser(app, role, `HD${key.replace('_', '')}${S}`);
      H[key] = user.headers;
      U[key] = user.id;
    }
    await prisma.user.update({ where: { id: U.ADMIN_OFF }, data: { active: false } });
    const branch = await prisma.branch.create({ data: { code: `E2E-HD-${S}`, name: 'Sucursal devoluciones (endurecimiento)' } });
    ids.branch = branch.id;
    const loc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `E2E-HD-${S}`, name: 'Bodega devoluciones (endurecimiento)' } });
    const loc2 = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `E2E-HD2-${S}`, name: 'Otra bodega (endurecimiento)' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: loc.id, number: 1 } });
    ids.loc = loc.id;
    ids.loc2 = loc2.id;
    ids.rack = (await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } })).id;
    await prisma.user.update({ where: { id: U.WAREHOUSE }, data: { defaultInventoryLocationId: ids.loc } });
    await prisma.user.update({ where: { id: U.WAREHOUSE2 }, data: { defaultInventoryLocationId: ids.loc2 } });
    ids.ref = (await prisma.reference.create({ data: { code: `HD-REF-${S}`, description: 'Fixture endurecimiento devoluciones' } })).id;
    for (const [index, key] of FINISHES.entries()) finishes[key] = (await prisma.finish.create({ data: { code: `HD${index}-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `HD-${S}`, name: 'Proveedor endurecimiento', origins: ['NATIONAL'] } })).id;
    const digits = S.replace(/\D/g, '').padEnd(8, '4').slice(0, 8);
    const customer = async (prefix: string, label: string) =>
      (
        await prisma.customer.create({
          data: { name: `Cliente ${label} ${S}`, taxId: `${prefix}${digits}`, email: `hd-${label}-${S.toLowerCase()}@test.local`, createdById: U.SALES },
        })
      ).id;
    ids.customer = await customer('5', 'principal');
    ids.creditCustomer = await customer('4', 'saldo');
    ids.dbCustomer = await customer('3', 'reglas');
    ids.emptyCustomer = await customer('2', 'vacio');
    const purchase = await post('/purchases', 'ADMIN', {
      supplierId: ids.supplier,
      documentNumber: `HD-${S}`,
      documentDate: '2026-11-03',
      lines: FINISHES.map((key) => ({
        referenceId: ids.ref,
        finishId: finishes[key],
        origin: 'NATIONAL',
        quantity: 10,
        grossAmount: '80000',
        discountPercent: '0',
        taxRatePercent: '0',
      })),
    }).expect(201);
    const confirmed = (await post(`/purchases/${purchase.body.id}/confirm`, 'ADMIN').expect(200)).body as { lines: { id: string }[] };
    for (const line of confirmed.lines) {
      await post('/sale-prices', 'ADMIN', { purchaseId: purchase.body.id, purchaseLineId: line.id, markupPercent: '25', enabled: true }).expect(201);
    }
  }, 120_000);

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await app?.close();
  });

  // ---------------------------------------------------------------------------
  describe('concurrency', () => {
    it('N parallel requests with different keys for the whole returnable quantity: exactly one is created', async () => {
      const { o } = await setup('RACE_CREATE', 5);
      const results = await racing(6, () => Promise.all(Array.from({ length: 6 }, () => requestReturn(o, 5))));
      expect(codes(results), dump(results)).toEqual([201, 400, 400, 400, 400, 400]);
      for (const loser of results.filter((r) => r.status === 400)) expect(message(loser)).toMatch(/en trámite 5/);
      const winner = results.find((r) => r.status === 201)!.body as ReturnBody;

      const rows = await prisma.salesReturn.findMany({ where: { salesOrderId: o.id }, include: { lines: true } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: winner.id, status: 'REQUESTED' });
      expect(rows[0].lines.map((l) => l.quantity)).toEqual([5]);
      expect(await tasksOf(winner.id, 'RETURN_APPROVAL')).toHaveLength(1);
      expect((await returnable(o.id)).lines[0]).toMatchObject({ delivered: 5, returned: 0, inProcess: 5, returnable: 0 });
    });

    it('the same operationKey sent N times in parallel creates one return; reused on another order it is refused', async () => {
      const { o } = await setup('RACE_KEY', 4);
      const key = randomUUID();
      const results = await racing(6, () => Promise.all(Array.from({ length: 6 }, () => requestReturn(o, 4, { operationKey: key }))));
      expect(codes(results), dump(results)).toEqual([201, 201, 201, 201, 201, 201]);
      const id = (results[0].body as ReturnBody).id;
      expect(results.every((r) => (r.body as ReturnBody).id === id)).toBe(true);
      expect(await prisma.salesReturn.count({ where: { createOperationKey: key } })).toBe(1);
      expect(await prisma.salesReturn.count({ where: { salesOrderId: o.id } })).toBe(1);
      expect(await prisma.task.count({ where: { salesReturnId: id } })).toBe(1);
      expect(await notices('return-requested', id)).toBe(1);

      // The key belongs to that order: another order (not even delivered) refuses it.
      const other = await order([{ finish: 'RACE_KEY', quantity: 1 }], 'CASH');
      const reused = await requestReturn(other, 1, { operationKey: key });
      expect(reused.status, JSON.stringify(reused.body)).toBe(409);
      expect(message(reused)).toMatch(/ya se usó con otra orden/);
      expect(await prisma.salesReturn.count({ where: { salesOrderId: other.id } })).toBe(0);
    });

    it('the same operationKey on two different orders at the same time: one is created, the other is a 409 (never a 500)', async () => {
      const first = await setup('RACE_KEY', 2);
      const second = await setup('RACE_KEY', 2);
      for (let round = 0; round < 2; round += 1) {
        const key = randomUUID();
        const results = await racing(2, () => Promise.all([requestReturn(first.o, 1, { operationKey: key }), requestReturn(second.o, 1, { operationKey: key })]));
        // Only one return carries the key (the loser's transaction rolled back)...
        expect(await prisma.salesReturn.count({ where: { createOperationKey: key } })).toBe(1);
        expect(await prisma.salesReturn.count({ where: { salesOrderId: { in: [first.o.id, second.o.id] }, createOperationKey: key } })).toBe(1);
        // ...and the loser is told the key belongs to another order.
        expect(codes(results), dump(results)).toEqual([201, 409]);
      }
    });

    it('approve and reject racing on a requested return: exactly one wins and the tasks follow the winner', async () => {
      const { o } = await setup('RACE_DECIDE', 6);
      for (let round = 0; round < 4; round += 1) {
        const r = await asked(o, 1);
        const note = `Aprobada en la ronda ${round}`;
        const why = `Rechazada en la ronda ${round}`;
        const [approved, rejected] = await racing(2, () =>
          round % 2 === 0 ? Promise.all([approve(r.id, 'ADMIN', { note }), reject(r.id, why)]) : Promise.all([reject(r.id, why), approve(r.id, 'ADMIN', { note })]).then(([b, a]) => [a, b]),
        );
        expect(codes([approved, rejected]), dump([approved, rejected])).toEqual([200, 409]);
        const row = await returnRow(r.id);
        const approval = await tasksOf(r.id, 'RETURN_APPROVAL');
        expect(approval).toHaveLength(1);
        expect(approval[0].completedAt).not.toBeNull();
        expect(approval[0].cancelledAt).toBeNull();
        const reception = await tasksOf(r.id, 'RETURN_RECEPTION');
        if (approved.status === 200) {
          expect(row).toMatchObject({ status: 'APPROVED', decisionNote: note, receiverId: U.WAREHOUSE, decidedById: U.ADMIN });
          expect((approved.body as ReturnBody).status).toBe('APPROVED');
          expect(message(rejected)).toMatch(/autorizada y por recibir: ya no se rechaza/);
          expect(reception).toHaveLength(1);
          expect(reception[0]).toMatchObject({ assigneeId: U.WAREHOUSE, completedAt: null, cancelledAt: null });
          expect([await notices('return-approved', r.id), await notices('return-rejected', r.id)]).toEqual([1, 0]);
        } else {
          expect(row).toMatchObject({ status: 'REJECTED', decisionNote: why, receiverId: null });
          expect(message(approved)).toMatch(/rechazada/);
          expect(reception).toHaveLength(0);
          expect([await notices('return-approved', r.id), await notices('return-rejected', r.id)]).toEqual([0, 1]);
        }
        expect(row.decidedAt).not.toBeNull();
      }

      // The same approval sent twice at once: both answer the approved return, one reception task.
      const twice = await asked(o, 1);
      const both = await racing(2, () => Promise.all([approve(twice.id), approve(twice.id)]));
      expect(codes(both), dump(both)).toEqual([200, 200]);
      expect(await tasksOf(twice.id, 'RETURN_RECEPTION')).toHaveLength(1);
      expect(await notices('return-approved', twice.id)).toBe(1);
    }, 120_000);

    it('approve and cancel racing: the final state is consistent and no task stays open on a cancelled return', async () => {
      const { o } = await setup('RACE_CANCEL', 3);
      for (let round = 0; round < 3; round += 1) {
        const r = await asked(o, 1);
        const reason = `Cancelada en la ronda ${round}`;
        const [approved, cancelled] = await racing(2, () =>
          round % 2 === 0 ? Promise.all([approve(r.id), cancel(r.id, reason)]) : Promise.all([cancel(r.id, reason), approve(r.id)]).then(([c, a]) => [a, c]),
        );
        // An approved return can still be cancelled; a cancelled one is never approved.
        expect(cancelled.status, dump([cancelled])).toBe(200);
        expect([200, 409], dump([approved])).toContain(approved.status);
        const row = await returnRow(r.id);
        if (row.status === 'CANCELLED') {
          expect(row).toMatchObject({ cancelReason: reason, cancelledById: U.SALES });
          expect(await openTasks(r.id)).toEqual([]);
          const reception = await tasksOf(r.id, 'RETURN_RECEPTION');
          if (approved.status === 200) {
            expect(reception).toHaveLength(1);
            expect(reception[0].cancelledAt).not.toBeNull();
          } else {
            expect(message(approved)).toMatch(/cancelada/);
            expect(reception).toHaveLength(0);
            expect((await tasksOf(r.id, 'RETURN_APPROVAL'))[0].cancelledAt).not.toBeNull();
          }
        } else {
          expect(row.status).toBe('APPROVED');
          expect(await tasksOf(r.id, 'RETURN_RECEPTION')).toHaveLength(1);
        }
      }
      // Cancelled returns free their profiles.
      expect((await returnable(o.id)).lines[0]).toMatchObject({ delivered: 3, inProcess: 0, returnable: 3 });
    }, 120_000);

    it('N parallel receptions with different keys: one is recorded and the stock moves once', async () => {
      const { o, b } = await setup('RACE_RECEIVE', 6);
      const r = await asked(o, 6, {}, 'ADMIN');
      expect(r.status).toBe('APPROVED');
      const stockBefore = (await bundleRow(b.id)).quantity;
      const creditBefore = Number(await creditOf(ids.customer));
      const keys = Array.from({ length: 6 }, () => randomUUID());
      const results = await racing(6, () =>
        Promise.all(keys.map((operationKey) => post(`/sales-returns/${r.id}/receive`, 'WAREHOUSE', { operationKey, lines: [{ lineId: r.lines[0].id, good: 4, damaged: 1 }] }))),
      );
      expect(codes(results), dump(results)).toEqual([200, 409, 409, 409, 409, 409]);
      for (const loser of results.filter((res) => res.status === 409)) expect(message(loser)).toMatch(/ya fue recibida/);
      const winnerIndex = results.findIndex((res) => res.status === 200);
      const winnerKey = keys[winnerIndex];
      // The warehouse answer carries no money.
      expect(moneyFields(results[winnerIndex].body, false)).toEqual([]);

      const row = await returnRow(r.id);
      expect(row).toMatchObject({ status: 'RECEIVED', receiveOperationKey: winnerKey, receivedById: U.WAREHOUSE });
      expect([row.amount?.toFixed(2), row.baseAmount?.toFixed(2), row.settledAmount?.toFixed(2)]).toEqual(['59500.00', '50000.00', '59500.00']);
      expect(row.lines[0]).toMatchObject({ goodQuantity: 4, damagedQuantity: 1 });
      const moves = await returnMovements(r.id);
      expect(moves.map((m) => m.quantity)).toEqual([4]);
      expect(moves.every((m) => m.operationKey.startsWith(`return:${winnerKey}:`))).toBe(true);
      expect((await bundleRow(b.id)).quantity).toBe(stockBefore + 4);
      expect(await ledgerError(b.id)).toBeNull();
      const reception = await tasksOf(r.id, 'RETURN_RECEPTION');
      expect(reception).toHaveLength(1);
      expect(reception[0].completedAt).not.toBeNull();
      // One notice per person to tell (order owner and requester), never one per racing request.
      const told = await prisma.notificationOutbox.findMany({ where: { kind: 'return-received', dedupeKey: { startsWith: `return-received:${r.id}:` } } });
      expect(told.map((n) => n.userId).sort()).toEqual([U.ADMIN, U.SALES].sort());
      expect(Number(await creditOf(ids.customer))).toBe(creditBefore + 59500);

      // The winner's retry is answered again; nothing moves twice.
      expect((await post(`/sales-returns/${r.id}/receive`, 'WAREHOUSE', { operationKey: winnerKey, lines: [{ lineId: r.lines[0].id, good: 4, damaged: 1 }] })).status).toBe(200);
      expect(await returnMovements(r.id)).toHaveLength(1);
      expect((await bundleRow(b.id)).quantity).toBe(stockBefore + 4);
    }, 120_000);

    it('receive and cancel racing: never both effective; stock, movements and tasks follow the winner', async () => {
      const { o, b } = await setup('RACE_RECV_CANCEL', 4);
      const rounds = [
        { receiver: 'WAREHOUSE', canceller: 'SALES' },
        { receiver: 'WAREHOUSE', canceller: 'ADMIN' },
        { receiver: 'ADMIN', canceller: 'SALES' },
        { receiver: 'ADMIN', canceller: 'ADMIN' },
      ];
      for (const [index, { receiver, canceller }] of rounds.entries()) {
        const r = await asked(o, 1, {}, 'ADMIN');
        const stock = (await bundleRow(b.id)).quantity;
        const reason = `Carrera recibir/cancelar ${index}`;
        const [recv, cancelled] = await racing(2, () =>
          index % 2 === 0 ? Promise.all([receive(r, 1, 0, {}, receiver), cancel(r.id, reason, canceller)]) : Promise.all([cancel(r.id, reason, canceller), receive(r, 1, 0, {}, receiver)]).then(([c, v]) => [v, c]),
        );
        const outcome = dump([recv, cancelled]);
        expect([recv, cancelled].filter((res) => res.status === 200), outcome).toHaveLength(1);
        const row = await returnRow(r.id);
        const moves = await returnMovements(r.id);
        if (recv.status === 200) {
          expect(cancelled.status, outcome).toBe(409);
          expect(message(cancelled)).toMatch(/recibida: ya no se cancela/);
          expect(row).toMatchObject({ status: 'RECEIVED', cancelledAt: null, cancelReason: null });
          expect(moves.map((m) => m.quantity)).toEqual([1]);
          expect((await bundleRow(b.id)).quantity).toBe(stock + 1);
          expect((await tasksOf(r.id, 'RETURN_RECEPTION'))[0].completedAt).not.toBeNull();
        } else {
          // The warehouse no longer sees a cancelled return (404); an administrator gets 409.
          expect(recv.status, outcome).toBe(receiver === 'WAREHOUSE' ? 404 : 409);
          expect(row).toMatchObject({ status: 'CANCELLED', receivedAt: null, amount: null, settledAmount: null, cancelReason: reason });
          expect(moves).toEqual([]);
          expect((await bundleRow(b.id)).quantity).toBe(stock);
          expect(await openTasks(r.id)).toEqual([]);
        }
      }
      expect(await ledgerError(b.id)).toBeNull();
    }, 120_000);

    it('two returns of the same order received in parallel: what goes back never exceeds what was paid', async () => {
      // Contado paid in full (119.000): two returns completing the line.
      const contado = await setup('RACE_TWO', 10);
      const r1 = await asked(contado.o, 4, {}, 'ADMIN');
      const r2 = await asked(contado.o, 6, { settlement: 'REFUND' }, 'ADMIN');
      const creditBefore = Number(await creditOf(ids.customer));
      const both = await racing(2, () => Promise.all([receive(r1, 4, 0), receive(r2, 5, 1)]));
      expect(codes(both), dump(both)).toEqual([200, 200]);
      const rows = await prisma.salesReturn.findMany({ where: { salesOrderId: contado.o.id } });
      const total = (field: 'amount' | 'settledAmount' | 'baseAmount') => rows.reduce((t, row) => t + Number(row[field]), 0);
      expect(total('amount')).toBe(119000);
      expect(total('baseAmount')).toBe(100000);
      expect(total('settledAmount')).toBeLessThanOrEqual(119000);
      expect(total('settledAmount')).toBe(119000);
      for (const row of rows) expect(Number(row.settledAmount)).toBeLessThanOrEqual(Number(row.amount));
      expect(rows.find((row) => row.id === r1.id)?.amount?.toFixed(2)).toBe('47600.00');
      expect(rows.find((row) => row.id === r2.id)?.amount?.toFixed(2)).toBe('71400.00');
      expect((await bundleRow(contado.b.id)).quantity).toBe(4 + 5);
      expect(await ledgerError(contado.b.id)).toBeNull();
      const after = await getOrder(contado.o.id);
      expect(after.paymentSummary).toMatchObject({ returned: '119000.00', settled: '119000.00', net: '0.00', paid: '119000.00', balance: '0.00' });
      expect(Number(await creditOf(ids.customer))).toBe(creditBefore + 47600);
      expect((await returnable(contado.o.id)).lines[0]).toMatchObject({ delivered: 10, returned: 10, inProcess: 0, returnable: 0 });

      // Abono: 119.000 with 100.000 paid; two halves race. The first lowers the
      // balance and gives back 40.500, the second gives back 59.500: 100.000.
      const abono = await setup('RACE_TWO_ABONO', 10, 'PARTIAL');
      expect((await pay(abono.o.id, 'CASH', '100000')).status).toBe(201);
      const a1 = await asked(abono.o, 5, { settlement: 'REFUND' }, 'ADMIN');
      const a2 = await asked(abono.o, 5, {}, 'ADMIN');
      const halves = await racing(2, () => Promise.all([receive(a1, 5, 0), receive(a2, 5, 0)]));
      expect(codes(halves), dump(halves)).toEqual([200, 200]);
      const abonoRows = await prisma.salesReturn.findMany({ where: { salesOrderId: abono.o.id } });
      const settled = abonoRows.map((row) => Number(row.settledAmount)).sort((x, y) => x - y);
      expect(settled).toEqual([40500, 59500]);
      expect(settled[0] + settled[1]).toBeLessThanOrEqual(100000);
      expect(abonoRows.reduce((t, row) => t + Number(row.amount), 0)).toBe(119000);
      const abonoAfter = await getOrder(abono.o.id);
      expect(abonoAfter.paymentSummary).toMatchObject({ returned: '119000.00', settled: '100000.00', net: '0.00', paid: '100000.00', balance: '0.00' });
      expect(Number(abonoAfter.paymentSummary.balance)).toBeGreaterThanOrEqual(0);
      expect(abonoAfter.paymentStatus).toBe('PAID');
      expect((await pay(abono.o.id, 'CASH', '1')).status).toBe(400);
    }, 120_000);

    it('saldo a favor race: parallel abonos (and conversions) each for the whole credit; only one is applied and the credit never goes negative', async () => {
      // 3 profiles bought; 2 come back as saldo a favor (23.800).
      const source = await setup('RACE_CREDIT', 3, 'CASH', {}, ids.creditCustomer);
      const back = await asked(source.o, 2, {}, 'ADMIN');
      await received(back, 2, 0);
      expect(await creditOf(ids.creditCustomer)).toBe('23800.00');

      const abonos: OrderBody[] = [];
      for (let i = 0; i < 4; i += 1) abonos.push(await order([{ finish: 'RACE_CREDIT', quantity: 3 }], 'PARTIAL', {}, ids.creditCustomer));
      const peek = () => get(`/customers/${ids.creditCustomer}/credit`, 'ADMIN');
      const results = await racing(4, () => Promise.all([...abonos.map((a) => pay(a.id, 'CREDIT_BALANCE', '23800')), peek(), peek(), peek(), peek()]));
      const payments = results.slice(0, 4);
      expect(codes(payments), dump(payments)).toEqual([201, 400, 400, 400]);
      for (const loser of payments.filter((r) => r.status === 400)) expect(message(loser)).toMatch(/no tiene saldo a favor/);
      for (const seen of results.slice(4)) {
        expect(seen.status).toBe(200);
        const available = Number((seen.body as { available: string }).available);
        expect(available).toBeGreaterThanOrEqual(0);
        expect(available).toBeLessThanOrEqual(23800);
      }
      expect(await creditOf(ids.creditCustomer)).toBe('0.00');
      const used = await prisma.salesOrderPayment.findMany({ where: { medium: 'CREDIT_BALANCE', salesOrder: { customerId: ids.creditCustomer } } });
      expect(used.map((p) => p.amount.toFixed(2))).toEqual(['23800.00']);
      const winner = abonos[payments.findIndex((r) => r.status === 201)];
      expect((await getOrder(winner.id)).paymentStatus).toBe('PENDING');
      const losers = abonos.filter((a) => a.id !== winner.id);
      expect(await prisma.salesOrderPayment.count({ where: { salesOrderId: { in: losers.map((a) => a.id) } } })).toBe(0);

      // The last profile comes back (11.900): two conversions and two abonos race for it.
      const last = await asked(source.o, 1, {}, 'ADMIN');
      await received(last, 1, 0);
      expect(await creditOf(ids.creditCustomer)).toBe('11900.00');
      const quotes = [await makeQuote([{ finish: 'RACE_CREDIT', quantity: 3 }], ids.creditCustomer), await makeQuote([{ finish: 'RACE_CREDIT', quantity: 3 }], ids.creditCustomer)];
      const mixed = await racing(4, () =>
        Promise.all([
          convert(quotes[0].id, { paymentMethod: 'CASH', creditAmount: '11900' }),
          pay(losers[0].id, 'CREDIT_BALANCE', '11900'),
          convert(quotes[1].id, { paymentMethod: 'CASH', creditAmount: '11900' }),
          pay(losers[1].id, 'CREDIT_BALANCE', '11900'),
          peek(),
          peek(),
        ]),
      );
      const spent = mixed.slice(0, 4);
      expect(spent.filter((r) => r.status === 200 || r.status === 201), dump(spent)).toHaveLength(1);
      expect(spent.filter((r) => r.status === 400), dump(spent)).toHaveLength(3);
      for (const seen of mixed.slice(4)) expect(Number((seen.body as { available: string }).available)).toBeGreaterThanOrEqual(0);
      expect(await creditOf(ids.creditCustomer)).toBe('0.00');
      const credited = await prisma.salesReturn.aggregate({ where: { customerId: ids.creditCustomer, status: 'RECEIVED', settlement: 'CREDIT' }, _sum: { settledAmount: true } });
      const spentTotal = await prisma.salesOrderPayment.aggregate({ where: { medium: 'CREDIT_BALANCE', salesOrder: { customerId: ids.creditCustomer } }, _sum: { amount: true } });
      expect(Number(credited._sum.settledAmount)).toBe(35700);
      expect(Number(spentTotal._sum.amount)).toBe(35700);
      // A conversion that lost leaves its quote as it was, without an order.
      for (const [i, q] of quotes.entries()) {
        const converted = await prisma.salesOrder.count({ where: { quoteId: q.id } });
        expect(converted).toBe(mixed[i * 2].status === 200 ? 1 : 0);
        expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe(converted ? 'CONVERTED' : 'DRAFT');
      }
    }, 120_000);

    it('credit note and refund racing with different data: one is recorded, the others are 409', async () => {
      const b = await bundle('RACE_DOCS', 3);
      const o = await order([{ finish: 'RACE_DOCS', quantity: 3 }], 'CASH', { requiresBilling: true });
      await post(`/sales-orders/${o.id}/invoice`, 'BILLING', { invoiceNumber: `FE-HD-${S}` }).expect(200);
      await deliver(o);
      const r = await asked(o, 3, { settlement: 'REFUND' }, 'ADMIN');
      await received(r, 3, 0);
      expect((await bundleRow(b.id)).quantity).toBe(3);

      const numbers = [1, 2, 3, 4].map((n) => `NC-${S}-${n}`);
      const notes = await racing(4, () => Promise.all(numbers.map((n, i) => creditNote(r.id, n, i % 2 === 0 ? 'BILLING' : 'ADMIN'))));
      expect(codes(notes), dump(notes)).toEqual([200, 409, 409, 409]);
      const winnerNumber = numbers[notes.findIndex((res) => res.status === 200)];
      expect((await returnRow(r.id)).creditNoteNumber).toBe(winnerNumber);
      const creditTasks = await tasksOf(r.id, 'CREDIT_NOTE');
      expect(creditTasks).toHaveLength(1);
      expect(creditTasks[0].completedAt).not.toBeNull();

      const variants = [
        { medium: 'CASH', refundedOn: businessToday() },
        { medium: 'TRANSFER', transferEntityId: 'NEQUI', refundedOn: businessToday() },
        { medium: 'CASH', refundedOn: shiftDay(-1) },
        { medium: 'TRANSFER', transferEntityId: 'NEQUI', refundedOn: shiftDay(-1) },
      ];
      const refunds = await racing(4, () => Promise.all(variants.map((v, i) => refund(r.id, v, i % 2 === 0 ? 'SALES' : 'ADMIN'))));
      expect(codes(refunds), dump(refunds)).toEqual([200, 409, 409, 409]);
      const won = variants[refunds.findIndex((res) => res.status === 200)];
      const row = await returnRow(r.id);
      expect(row.refundMedium).toBe(won.medium);
      expect(row.refundTransferEntityId).toBe(won.transferEntityId ?? null);
      expect(row.refundedOn?.toISOString().slice(0, 10)).toBe(won.refundedOn);
      expect(await prisma.auditEvent.count({ where: { entity: 'SalesReturn', entityId: r.id, action: 'REFUNDED' } })).toBe(1);
    }, 120_000);
  });

  // ---------------------------------------------------------------------------
  describe('hostile input', () => {
    const HOSTILE_IDS = [
      "' OR '1'='1",
      "x'; DROP TABLE sales_returns;--",
      '1 OR 1=1',
      '" OR ""="',
      "') OR ('1'='1",
      "1' UNION SELECT id FROM users--",
      '%27%20OR%201%3D1--',
      '$1',
      '*',
      '../../etc/passwd',
      'a'.repeat(400),
    ];

    it('SQL injection in path parameters answers 404 on every returns route and changes nothing', async () => {
      const { o } = await setup('HOSTILE_PATH', 2);
      const real = await asked(o, 1);
      const before = await myCounts();
      const routes = (returnId: string, orderId: string, customerId: string): ['GET' | 'POST', string, object | undefined][] => [
        ['GET', `/sales-returns/${returnId}`, undefined],
        ['POST', `/sales-returns/${returnId}/approve`, {}],
        ['POST', `/sales-returns/${returnId}/reject`, { reason: 'Motivo de prueba' }],
        ['POST', `/sales-returns/${returnId}/cancel`, { reason: 'Motivo de prueba' }],
        ['POST', `/sales-returns/${returnId}/receive`, { operationKey: randomUUID(), lines: [{ lineId: real.lines[0].id, good: 1, damaged: 0 }] }],
        ['POST', `/sales-returns/${returnId}/refund`, { medium: 'CASH', refundedOn: businessToday() }],
        ['POST', `/sales-returns/${returnId}/credit-note`, { number: 'NC-1' }],
        ['GET', `/customers/${customerId}/credit`, undefined],
        ['GET', `/sales-orders/${orderId}/returnable`, undefined],
        ['POST', `/sales-orders/${orderId}/returns`, { operationKey: randomUUID(), reason: 'SELLER_ERROR', settlement: 'CREDIT', lines: [{ salesOrderLineId: o.lines[0].id, quantity: 1 }] }],
      ];
      const variants: [string, string, string][] = [
        ...HOSTILE_IDS.map((h): [string, string, string] => [h, h, h]),
        ...["' OR '1'='1", "'--", `';${NASTY_SQL}`, '%'].map((sfx): [string, string, string] => [`${real.id}${sfx}`, `${o.id}${sfx}`, `${ids.customer}${sfx}`]),
      ];
      for (const [returnId, orderId, customerId] of variants) {
        const list = routes(encodeURIComponent(returnId), encodeURIComponent(orderId), encodeURIComponent(customerId));
        const results = await Promise.all(list.map(([method, path, body]) => call(method, path, 'ADMIN', body)));
        results.forEach((res, i) => expect(res.status, `${list[i][0]} ${list[i][1]} → ${res.status} ${JSON.stringify(res.body)}`).toBe(404));
      }
      expect(await tablesPresent()).toEqual(TABLES);
      expect(await myCounts()).toEqual(before);
      expect((await returnRow(real.id)).status).toBe('REQUESTED');
    }, 120_000);

    it('injection in the list query is refused with 400; a valid filter still works', async () => {
      const queries = [
        `status=${encodeURIComponent("RECEIVED' OR 1=1--")}`,
        `status=${encodeURIComponent(`RECEIVED${NASTY_SQL}`)}`,
        'status=received',
        'status=RECEIVED&status=APPROVED',
        'status[%24ne]=X',
        `page=${encodeURIComponent('1 OR 1=1')}`,
        `page=${encodeURIComponent(`1${NASTY_SQL}`)}`,
        'page=0',
        'page=-1',
        'page=1.5',
        'page=1e3',
        `pageSize=${encodeURIComponent('10 UNION SELECT * FROM users')}`,
        'pageSize=0',
        'pageSize=101',
        'pageSize=abc',
        `orderBy=${encodeURIComponent('id; DROP TABLE sales_returns')}`,
        `where=${encodeURIComponent('1=1')}`,
      ];
      for (const query of queries) {
        const res = await get(`/sales-returns?${query}`, 'ADMIN');
        expect(res.status, `${query} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      const valid = (await get('/sales-returns?status=RECEIVED&page=1&pageSize=5', 'ADMIN').expect(200)).body as ListBody;
      expect(valid.items.length).toBeLessThanOrEqual(5);
      expect(valid.items.every((i) => i.status === 'RECEIVED')).toBe(true);
      expect(await tablesPresent()).toEqual(TABLES);
    });

    it('hostile text in the body: enums and ids are refused, free text is stored and returned verbatim', async () => {
      const { o, b } = await setup('HOSTILE', 8);
      const before = await myCounts();
      const lineId = o.lines[0].id;
      const refused: [string, Record<string, unknown>][] = [
        ['reason', { reason: "SELLER_ERROR' OR '1'='1" }],
        ['reason', { reason: `SELLER_ERROR${NASTY_SQL}` }],
        ['settlement', { settlement: `CREDIT${NASTY_SQL}` }],
        ['settlement', { settlement: { $ne: null } }],
        ['operationKey', { operationKey: "' OR 1=1--" }],
        ['quantity', { lines: [{ salesOrderLineId: lineId, quantity: '1 OR 1=1' }] }],
        ['salesOrderLineId object', { lines: [{ salesOrderLineId: { $ne: null }, quantity: 1 }] }],
        ['approverId object', { approverId: { $ne: null } }],
        ['approverId too long', { approverId: `${U.ADMIN}${NASTY_SQL}` }],
        ['notes object', { notes: { $ne: null } }],
      ];
      for (const [field, body] of refused) {
        const res = await requestReturn(o, 1, body);
        expect(res.status, `${field}: ${JSON.stringify(res.body)}`).toBe(400);
      }
      // A valid shape with hostile content is refused by the business rules, not by the database.
      const businessRefusals: [Record<string, unknown>, RegExp][] = [
        [{ approverId: "' OR '1'='1" }, /administrador activo/],
        [{ approverId: `${U.ADMIN}' OR '1'='1` }, /administrador activo/],
        [{ approverId: U.SALES2 }, /administrador activo/],
        [{ approverId: U.ADMIN_OFF }, /administrador activo/],
        [{ lines: [{ salesOrderLineId: "' OR '1'='1", quantity: 1 }] }, /no pertenece a la orden/],
        [{ lines: [{ salesOrderLineId: "x'; DROP TABLE sales_return_lines;--", quantity: 1 }] }, /no pertenece a la orden/],
      ];
      for (const [body, expected] of businessRefusals) {
        const res = await requestReturn(o, 1, body);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(message(res)).toMatch(expected);
      }
      expect(await myCounts()).toEqual(before);

      // Request notes, rejection reason, approval note and cancel reason: verbatim.
      const notes = `${NASTY} ‘comillas’ "dobles" \\ barra ñ 💥 %s $1 \${x}`;
      const r1 = await asked(o, 1, { notes });
      expect(r1.notes).toBe(notes);
      expect((await returnRow(r1.id)).notes).toBe(notes);
      expect(((await reject(r1.id, NASTY).expect(200)).body as ReturnBody).decisionNote).toBe(NASTY);
      expect((await returnRow(r1.id)).decisionNote).toBe(NASTY);
      const r2 = await asked(o, 1, { notes: NASTY_HTML });
      expect(((await approve(r2.id, 'ADMIN', { note: NASTY }).expect(200)).body as ReturnBody).decisionNote).toBe(NASTY);
      expect(((await cancel(r2.id, NASTY).expect(200)).body as ReturnBody).cancelReason).toBe(NASTY);
      expect(((await getReturn(r2.id, 'SALES').expect(200)).body as ReturnBody).notes).toBe(NASTY_HTML);

      // Reception: hostile chips and line ids are refused; the note is kept verbatim.
      const r3 = await asked(o, 3, { settlement: 'REFUND' }, 'ADMIN');
      for (const sealedEpcs of [["' OR 1=1--"], [`${b.epc}' OR '1'='1`], [`${b.epc};${NASTY_SQL}`], [{ $ne: null }], "' OR 1=1--"]) {
        const res = await receive(r3, 3, 0, { sealedEpcs });
        expect(res.status, `${JSON.stringify(sealedEpcs)} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      for (const hostileLine of ["' OR '1'='1", `${r3.lines[0].id}' OR '1'='1`]) {
        const res = await receiveLines(r3.id, [{ lineId: hostileLine, good: 3, damaged: 0 }]);
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(message(res)).toMatch(/cada renglón/);
      }
      expect((await receiveLines(r3.id, [{ lineId: { $ne: null }, good: 3, damaged: 0 }])).status).toBe(400);
      expect(await returnMovements(r3.id)).toEqual([]);
      await received(r3, 3, 0, { note: NASTY });
      expect(((await getReturn(r3.id, 'ADMIN').expect(200)).body as ReturnBody).receptionNote).toBe(NASTY);

      // Refund: hostile entity, medium or day refused; the note is kept verbatim.
      const refundRefusals: [Record<string, unknown>, RegExp | null][] = [
        [{ medium: 'TRANSFER', transferEntityId: "NEQUI' OR '1'='1" }, /no existe o ya no se usa/],
        [{ medium: 'TRANSFER', transferEntityId: `x${NASTY_SQL}` }, /no existe o ya no se usa/],
        [{ medium: 'TRANSFER', transferEntityId: { $ne: null } }, null],
        [{ medium: "CASH' OR 1=1--" }, null],
        [{ medium: 'CASH', refundedOn: "2026-01-01' OR '1'='1" }, null],
      ];
      for (const [body, expected] of refundRefusals) {
        const res = await refund(r3.id, body);
        expect(res.status, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`).toBe(400);
        if (expected) expect(message(res)).toMatch(expected);
      }
      expect((await returnRow(r3.id)).refundedAt).toBeNull();
      const refunded = (await refund(r3.id, { medium: 'CASH', note: NASTY }).expect(200)).body as ReturnBody;
      expect(refunded.refund?.note).toBe(NASTY);
      expect((await returnRow(r3.id)).refundNote).toBe(NASTY);

      // Credit note number of an invoiced order: verbatim.
      await bundle('HOSTILE_BILL', 2);
      const billed = await order([{ finish: 'HOSTILE_BILL', quantity: 2 }], 'CREDIT', { requiresBilling: true });
      await post(`/sales-orders/${billed.id}/invoice`, 'BILLING', { invoiceNumber: `FE-HDX-${S}` }).expect(200);
      await deliver(billed);
      const r4 = await asked(billed, 2, {}, 'ADMIN');
      await received(r4, 2, 0);
      expect((await creditNote(r4.id, { $ne: null })).status).toBe(400);
      expect((await creditNote(r4.id, ["NC' OR 1=1"])).status).toBe(400);
      const number = `${NASTY_SQL}${NASTY_HTML}`;
      expect(((await creditNote(r4.id, number).expect(200)).body as ReturnBody).creditNote?.number).toBe(number);
      expect(((await getReturn(r4.id, 'BILLING').expect(200)).body as ReturnBody).creditNote?.number).toBe(number);
      expect((await returnRow(r4.id)).creditNoteNumber).toBe(number);
      expect((await creditNote(r4.id, number)).status).toBe(200);

      // The tables are still there and only the legitimate rows exist.
      expect(await tablesPresent()).toEqual(TABLES);
      const statuses = (await prisma.salesReturn.findMany({ where: { salesOrderId: o.id }, orderBy: { createdAt: 'asc' } })).map((r) => r.status);
      expect(statuses).toEqual(['REJECTED', 'CANCELLED', 'RECEIVED']);
      expect(await prisma.salesReturnLine.count({ where: { salesReturn: { salesOrderId: o.id } } })).toBe(3);
      expect(await prisma.transferEntity.findUnique({ where: { id: 'NEQUI' } })).toMatchObject({ active: true });
      const after = await myCounts();
      expect(after.transferEntities).toBe(before.transferEntities);
      expect(after.returns).toBe(before.returns + 4);
    }, 120_000);

    it('a reception operationKey already used by another return is refused with 409, never a server error', async () => {
      const { o, b } = await setup('HOSTILE_KEYS', 4);
      const r1 = await asked(o, 2, {}, 'ADMIN');
      const r2 = await asked(o, 2, {}, 'ADMIN');
      const key = randomUUID();
      expect((await receive(r1, 2, 0, { operationKey: key })).status).toBe(200);
      const reused = await receive(r2, 2, 0, { operationKey: key });
      // Nothing of the second reception was applied...
      expect(await returnRow(r2.id)).toMatchObject({ status: 'APPROVED', receivedAt: null });
      expect(await returnMovements(r2.id)).toEqual([]);
      expect((await bundleRow(b.id)).quantity).toBe(2);
      // ...and a fresh key still receives it.
      await received(r2, 2, 0);
      expect((await bundleRow(b.id)).quantity).toBe(4);
      // The reused key must be answered as a conflict, not as a server error.
      expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    });

    it('a NUL byte in a path parameter or a text field is refused without a server error', async () => {
      const { o } = await setup('HOSTILE_NUL', 2);
      const r = await asked(o, 1);
      const nul = '\u0000';
      const attempts: [string, () => request.Test][] = [
        ['GET return id', () => get(`/sales-returns/${encodeURIComponent(`${r.id}${nul}`)}`, 'ADMIN')],
        ['GET customer credit', () => get(`/customers/${encodeURIComponent(`${ids.customer}${nul}`)}/credit`, 'ADMIN')],
        ['GET returnable', () => get(`/sales-orders/${encodeURIComponent(`${o.id}${nul}`)}/returnable`, 'ADMIN')],
        ['create notes', () => requestReturn(o, 1, { notes: `Nota${nul}nula` })],
        ['create approverId', () => requestReturn(o, 1, { approverId: `${U.ADMIN}${nul}` })],
        ['reject reason', () => reject(r.id, `Motivo${nul}nulo`)],
      ];
      const outcomes: string[] = [];
      for (const [label, attempt] of attempts) outcomes.push(`${label}: ${(await attempt()).status}`);
      expect((await returnRow(r.id)).status).toBe('REQUESTED');
      expect(await prisma.salesReturn.count({ where: { salesOrderId: o.id } })).toBe(1);
      // Every attempt is a client error (400 or 404), never a 500.
      expect(outcomes.filter((line) => !/: (400|404)$/.test(line)), outcomes.join(' | ')).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('authorization', () => {
    it('another seller, another location and billing cannot reach the returns; the warehouse never sees money', async () => {
      const { o } = await setup('AUTHZ', 6);
      const rReq = await asked(o, 1);
      const rApp = await asked(o, 2);
      await approve(rApp.id).expect(200);
      const rRec = await asked(o, 2, { settlement: 'REFUND' }, 'ADMIN');
      await received(rRec, 2, 0);
      const before = await myCounts();
      const all = [rReq, rApp, rRec];
      const validReceive = { operationKey: randomUUID(), lines: [{ lineId: rApp.lines[0].id, good: 2, damaged: 0 }] };
      const validRefund = { medium: 'CASH', refundedOn: businessToday() };

      const expectStatus = async (label: string, res: Promise<Res> | request.Test, status: number) => {
        const done = await res;
        expect(done.status, `${label} → ${done.status} ${JSON.stringify(done.body)}`).toBe(status);
      };
      const listIds = async (who: string) => ((await get('/sales-returns?pageSize=100', who).expect(200)).body as ListBody).items.map((i) => i.id);

      // Another seller: the order and its returns do not exist for it.
      for (const r of all) await expectStatus(`SALES2 GET ${r.status}`, getReturn(r.id, 'SALES2'), 404);
      await expectStatus('SALES2 cancel', cancel(rReq.id, 'No es mía', 'SALES2'), 404);
      await expectStatus('SALES2 cancel approved', cancel(rApp.id, 'No es mía', 'SALES2'), 404);
      await expectStatus('SALES2 refund', refund(rRec.id, validRefund, 'SALES2'), 404);
      await expectStatus('SALES2 returnable', get(`/sales-orders/${o.id}/returnable`, 'SALES2'), 404);
      await expectStatus('SALES2 create', requestReturn(o, 1, {}, 'SALES2'), 404);
      expect((await listIds('SALES2')).filter((id) => all.some((r) => r.id === id))).toEqual([]);

      // The owner seller cannot decide, receive nor record the credit note.
      await expectStatus('SALES approve', approve(rReq.id, 'SALES'), 403);
      await expectStatus('SALES reject', reject(rReq.id, 'Lo rechazo yo', 'SALES'), 403);
      await expectStatus('SALES receive', post(`/sales-returns/${rApp.id}/receive`, 'SALES', validReceive), 403);
      await expectStatus('SALES credit-note', creditNote(rRec.id, 'NC-X', 'SALES'), 403);

      // Warehouse of another location: nothing.
      await expectStatus('WAREHOUSE2 GET approved', getReturn(rApp.id, 'WAREHOUSE2'), 404);
      await expectStatus('WAREHOUSE2 GET received', getReturn(rRec.id, 'WAREHOUSE2'), 404);
      await expectStatus('WAREHOUSE2 receive', post(`/sales-returns/${rApp.id}/receive`, 'WAREHOUSE2', validReceive), 404);
      expect((await listIds('WAREHOUSE2')).filter((id) => all.some((r) => r.id === id))).toEqual([]);

      // Warehouse of the place: only reception, and never money.
      await expectStatus('WAREHOUSE create', requestReturn(o, 1, {}, 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE approve', approve(rReq.id, 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE reject', reject(rReq.id, 'Motivo bodega', 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE cancel', cancel(rApp.id, 'Motivo bodega', 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE refund', refund(rRec.id, validRefund, 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE credit-note', creditNote(rRec.id, 'NC-X', 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE returnable', get(`/sales-orders/${o.id}/returnable`, 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE customer credit', get(`/customers/${ids.customer}/credit`, 'WAREHOUSE'), 403);
      await expectStatus('WAREHOUSE GET requested', getReturn(rReq.id, 'WAREHOUSE'), 404);
      for (const r of [rApp, rRec]) {
        const seen = (await getReturn(r.id, 'WAREHOUSE').expect(200)).body as Record<string, unknown>;
        expect(moneyFields(seen, false), `GET ${r.id} as WAREHOUSE`).toEqual([]);
        for (const key of ['amount', 'baseAmount', 'settledAmount', 'estimatedAmount', 'refund', 'refundPending']) expect(seen).not.toHaveProperty(key);
      }
      const warehouseList = (await get('/sales-returns?pageSize=100', 'WAREHOUSE').expect(200)).body as ListBody;
      const mine = warehouseList.items.filter((i) => all.some((r) => r.id === i.id));
      expect(mine.map((i) => i.id).sort()).toEqual([rApp.id, rRec.id].sort());
      // The list keeps an `amount` key for every role; for the warehouse it never carries a value.
      // (`total` of the page is the row count, not money: only the items are scanned.)
      expect(moneyFields(warehouseList.items, true)).toEqual([]);
      for (const item of warehouseList.items) for (const key of ['baseAmount', 'settledAmount', 'estimatedAmount']) expect(item).not.toHaveProperty(key);
      const statusList = (await get('/sales-returns?status=RECEIVED&pageSize=100', 'WAREHOUSE').expect(200)).body as ListBody;
      expect(moneyFields(statusList.items, true)).toEqual([]);

      // Billing: only received returns of orders sent to billing.
      for (const r of all) await expectStatus(`BILLING GET ${r.status}`, getReturn(r.id, 'BILLING'), 404);
      await expectStatus('BILLING credit-note on an order without billing', creditNote(rRec.id, 'NC-X', 'BILLING'), 404);
      await expectStatus('BILLING receive', post(`/sales-returns/${rApp.id}/receive`, 'BILLING', validReceive), 403);
      await expectStatus('BILLING approve', approve(rReq.id, 'BILLING'), 403);
      await expectStatus('BILLING cancel', cancel(rReq.id, 'Motivo facturación', 'BILLING'), 403);
      await expectStatus('BILLING refund', refund(rRec.id, validRefund, 'BILLING'), 403);
      await expectStatus('BILLING create', requestReturn(o, 1, {}, 'BILLING'), 403);
      await expectStatus('BILLING returnable', get(`/sales-orders/${o.id}/returnable`, 'BILLING'), 403);
      expect((await listIds('BILLING')).filter((id) => all.some((r) => r.id === id))).toEqual([]);

      // Nothing changed.
      expect(await myCounts()).toEqual(before);
      expect((await returnRow(rReq.id)).status).toBe('REQUESTED');
      expect((await returnRow(rApp.id)).status).toBe('APPROVED');
      expect(await returnRow(rRec.id)).toMatchObject({ status: 'RECEIVED', refundedAt: null, creditNoteNumber: null });
    }, 120_000);

    it('read-only, accessories and China roles get 403 on every returns route; without a session 401', async () => {
      const target = await prisma.salesReturn.findFirst({ where: { customerId: { in: myCustomers() } }, include: { lines: true } });
      const returnId = target?.id ?? 'cl0000000000000000000000';
      const orderId = target?.salesOrderId ?? 'cl0000000000000000000000';
      const lineId = target?.lines[0]?.id ?? 'x';
      const routes: ['GET' | 'POST', string, object | undefined][] = [
        ['GET', '/sales-returns', undefined],
        ['GET', `/sales-returns/${returnId}`, undefined],
        ['GET', `/sales-orders/${orderId}/returnable`, undefined],
        ['GET', `/customers/${ids.customer}/credit`, undefined],
        ['POST', `/sales-orders/${orderId}/returns`, { operationKey: randomUUID(), reason: 'SELLER_ERROR', settlement: 'CREDIT', lines: [{ salesOrderLineId: 'x', quantity: 1 }] }],
        ['POST', `/sales-returns/${returnId}/approve`, {}],
        ['POST', `/sales-returns/${returnId}/reject`, { reason: 'Motivo de prueba' }],
        ['POST', `/sales-returns/${returnId}/cancel`, { reason: 'Motivo de prueba' }],
        ['POST', `/sales-returns/${returnId}/receive`, { operationKey: randomUUID(), lines: [{ lineId, good: 1, damaged: 0 }] }],
        ['POST', `/sales-returns/${returnId}/refund`, { medium: 'CASH', refundedOn: businessToday() }],
        ['POST', `/sales-returns/${returnId}/credit-note`, { number: 'NC-1' }],
      ];
      const before = await myCounts();
      for (const who of ['READ_ONLY', 'ACCESSORIES', 'CHINA_OPERATOR']) {
        for (const [method, path, body] of routes) {
          const res = await call(method, path, who, body);
          expect(res.status, `${who} ${method} ${path} → ${JSON.stringify(res.body)}`).toBe(403);
        }
      }
      for (const [method, path, body] of routes) {
        const res = await call(method, path, null, body);
        expect(res.status, `no token ${method} ${path}`).toBe(401);
        const forged = await (method === 'GET' ? http().get(path) : http().post(path).send(body ?? {})).set({ Authorization: 'Bearer abc.def.ghi', 'X-Forwarded-For': nextIp() });
        expect(forged.status, `forged token ${method} ${path}`).toBe(401);
      }
      expect(await myCounts()).toEqual(before);
    });
  });

  // ---------------------------------------------------------------------------
  describe('validation', () => {
    it('request: unknown fields, bad quantities, lines and keys are refused with 400 and nothing is saved', async () => {
      const { o } = await setup('VALID_CREATE', 3);
      const lineId = o.lines[0].id;
      const line = (quantity: unknown) => ({ lines: [{ salesOrderLineId: lineId, quantity }] });
      const cases: [string, Record<string, unknown>][] = [
        ['amount', { amount: '1' }],
        ['status', { status: 'RECEIVED' }],
        ['customerId', { customerId: ids.customer }],
        ['settledAmount', { settledAmount: '5' }],
        ['inventoryLocationId', { inventoryLocationId: ids.loc }],
        ['requestedById', { requestedById: U.ADMIN }],
        ['amount in a line', { lines: [{ salesOrderLineId: lineId, quantity: 1, amount: '1' }] }],
        ['quantity 0', line(0)],
        ['quantity -1', line(-1)],
        ['quantity 1.5', line(1.5)],
        ['quantity "10"', line('10')],
        ['quantity "1"', line('1')],
        ['quantity 1e9', line(1e9)],
        ['quantity null', line(null)],
        ['quantity true', line(true)],
        ['quantity [1]', line([1])],
        ['no quantity', { lines: [{ salesOrderLineId: lineId }] }],
        ['empty lines', { lines: [] }],
        ['lines not an array', { lines: 'todas' }],
        ['lines null', { lines: null }],
        ['duplicated line', { lines: [{ salesOrderLineId: lineId, quantity: 1 }, { salesOrderLineId: lineId, quantity: 1 }] }],
        ['too many lines', { lines: Array.from({ length: 201 }, () => ({ salesOrderLineId: lineId, quantity: 1 })) }],
        ['operationKey not a UUID', { operationKey: 'abc' }],
        ['operationKey empty', { operationKey: '' }],
        ['operationKey UUID v1', { operationKey: 'a8098c1a-f86e-11da-bd1a-00112444be1e' }],
        ['operationKey number', { operationKey: 12345 }],
        ['reason lowercase', { reason: 'seller_error' }],
        ['reason null', { reason: null }],
        ['settlement unknown', { settlement: 'CASH' }],
        ['notes too long', { notes: 'x'.repeat(501) }],
        ['approverId too long', { approverId: 'x'.repeat(51) }],
      ];
      for (const [label, body] of cases) {
        const res = await requestReturn(o, 1, body);
        expect(res.status, `${label} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      // Required fields missing.
      for (const missing of ['operationKey', 'reason', 'settlement', 'lines']) {
        const body: Record<string, unknown> = { operationKey: randomUUID(), reason: 'SELLER_ERROR', settlement: 'CREDIT', approverId: U.ADMIN, lines: [{ salesOrderLineId: lineId, quantity: 1 }] };
        delete body[missing];
        const res = await post(`/sales-orders/${o.id}/returns`, 'SALES', body);
        expect(res.status, `without ${missing} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      // More than delivered, or a line of another order.
      expect(message(await requestReturn(o, 4).expect(400))).toMatch(/hasta 3 perfiles/);
      const foreign = (await prisma.salesOrderLine.findFirst({ where: { salesOrderId: { not: o.id }, salesOrder: { createdById: U.SALES } } }))!;
      expect(message(await createReturn(o, [{ salesOrderLineId: lineId, quantity: 1 }, { salesOrderLineId: foreign.id, quantity: 1 }]).expect(400))).toMatch(/no pertenece a la orden/);
      expect(await prisma.salesReturn.count({ where: { salesOrderId: o.id } })).toBe(0);
      // The valid request still works.
      expect((await asked(o, 3)).status).toBe('REQUESTED');
    }, 120_000);

    it('reception: every line once, counts within the request, something received, no extra fields', async () => {
      const bA = await bundle('VALID_RECV_A', 3);
      const bB = await bundle('VALID_RECV_B', 2);
      const o = await order([{ finish: 'VALID_RECV_A', quantity: 3 }, { finish: 'VALID_RECV_B', quantity: 2 }], 'CASH');
      await deliver(o);
      const res = await createReturn(o, [{ salesOrderLineId: o.lines[0].id, quantity: 3 }, { salesOrderLineId: o.lines[1].id, quantity: 2 }], {}, 'ADMIN');
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const r = res.body as ReturnBody;
      const la = r.lines.find((l) => l.salesOrderLineId === o.lines[0].id)!.id;
      const lb = r.lines.find((l) => l.salesOrderLineId === o.lines[1].id)!.id;
      const other = await asked((await setup('VALID_RECV_A', 1)).o, 1, {}, 'ADMIN');
      const cases: [string, unknown, Record<string, unknown>, RegExp | null][] = [
        ['missing a line', [{ lineId: la, good: 3, damaged: 0 }], {}, /cada renglón/],
        ['duplicated line', [{ lineId: la, good: 1, damaged: 0 }, { lineId: la, good: 1, damaged: 0 }], {}, /cada renglón/],
        ['duplicated beside the other', [{ lineId: la, good: 1, damaged: 0 }, { lineId: la, good: 1, damaged: 0 }, { lineId: lb, good: 1, damaged: 0 }], {}, /cada renglón/],
        ['unknown line', [{ lineId: la, good: 3, damaged: 0 }, { lineId: 'cl0000000000000000000000', good: 2, damaged: 0 }], {}, /cada renglón/],
        ['line of another return', [{ lineId: la, good: 3, damaged: 0 }, { lineId: other.lines[0].id, good: 1, damaged: 0 }], {}, /cada renglón/],
        ['good + damaged above the line', [{ lineId: la, good: 3, damaged: 1 }, { lineId: lb, good: 2, damaged: 0 }], {}, /llegaron 4/],
        ['all zeros', [{ lineId: la, good: 0, damaged: 0 }, { lineId: lb, good: 0, damaged: 0 }], {}, /cancela la devolución/],
        ['negative', [{ lineId: la, good: -1, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], {}, null],
        ['fraction', [{ lineId: la, good: 1.5, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], {}, null],
        ['string count', [{ lineId: la, good: '3', damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], {}, null],
        ['huge', [{ lineId: la, good: 1e9, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], {}, null],
        ['missing damaged', [{ lineId: la, good: 3 }, { lineId: lb, good: 2, damaged: 0 }], {}, null],
        ['empty', [], {}, null],
        ['not an array', 'todo', {}, null],
        ['extra field in a line', [{ lineId: la, good: 3, damaged: 0, amount: '1' }, { lineId: lb, good: 2, damaged: 0 }], {}, null],
        ['extra amount', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { amount: '0' }, null],
        ['extra status', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { status: 'CANCELLED' }, null],
        ['extra receivedById', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { receivedById: U.ADMIN }, null],
        ['operationKey not a UUID', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { operationKey: 'abc' }, null],
        ['operationKey empty', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { operationKey: '' }, null],
        ['sealedEpcs repeated', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { sealedEpcs: [bA.epc, bA.epc.toLowerCase()] }, /repetido/],
        ['sealedEpcs not an array', [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 2, damaged: 0 }], { sealedEpcs: bA.epc }, null],
        ['sealed bundle above the good ones', [{ lineId: la, good: 2, damaged: 1 }, { lineId: lb, good: 2, damaged: 0 }], { sealedEpcs: [bA.epc] }, /más que los 2/],
      ];
      for (const [label, lines, extra, expected] of cases) {
        const attempt = await receiveLines(r.id, lines, extra, 'WAREHOUSE');
        expect(attempt.status, `${label} → ${JSON.stringify(attempt.body)}`).toBe(400);
        if (expected) expect(message(attempt), label).toMatch(expected);
      }
      expect(await returnRow(r.id)).toMatchObject({ status: 'APPROVED', receivedAt: null, amount: null });
      expect(await returnMovements(r.id)).toEqual([]);
      expect([(await bundleRow(bA.id)).quantity, (await bundleRow(bB.id)).quantity]).toEqual([0, 0]);

      // The valid reception: the closed bundle back closed, the other line loose.
      const ok = await receiveLines(r.id, [{ lineId: la, good: 3, damaged: 0 }, { lineId: lb, good: 1, damaged: 1 }], { sealedEpcs: [bA.epc] }, 'WAREHOUSE');
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(await bundleRow(bA.id)).toMatchObject({ quantity: 3, openedAt: null });
      expect(await bundleRow(bB.id)).toMatchObject({ quantity: 1, openedAt: expect.any(Date) });
      expect((await returnRow(r.id)).amount?.toFixed(2)).toBe(pesos(5 * PRICE));
    }, 120_000);

    it('refund and credit note: the wrong state is 409, bad days and data are 400', async () => {
      const { o } = await setup('VALID_MONEY', 4);
      const rCredit = await asked(o, 1, {}, 'ADMIN');
      await received(rCredit, 1, 0);
      const rPending = await asked(o, 1, { settlement: 'REFUND' }, 'ADMIN');
      const rRefund = await asked(o, 1, { settlement: 'REFUND' }, 'ADMIN');
      await received(rRefund, 1, 0);

      const onCredit = await refund(rCredit.id, { medium: 'CASH' });
      expect(onCredit.status, JSON.stringify(onCredit.body)).toBe(409);
      expect(message(onCredit)).toMatch(/no tiene dinero por reintegrar/);
      const beforeReception = await refund(rPending.id, { medium: 'CASH' });
      expect(beforeReception.status, JSON.stringify(beforeReception.body)).toBe(409);
      expect(message(beforeReception)).toMatch(/no tiene dinero por reintegrar/);

      const badDays = ['2099-01-01', shiftDay(1), '2026-02-30', '2026-13-01', '25/11/2026', '2019-12-31', '', 'hoy', `${businessToday()}T00:00:00Z`, '2026-1-5'];
      for (const refundedOn of badDays) {
        const res = await refund(rRefund.id, { medium: 'CASH', refundedOn });
        expect(res.status, `${refundedOn} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      const badData: Record<string, unknown>[] = [
        { medium: 'TRANSFER' },
        { medium: 'CASH', transferEntityId: 'NEQUI' },
        { medium: 'CREDIT_BALANCE' },
        { medium: 'cash' },
        { medium: 'CASH', amount: '11900' },
        { medium: 'CASH', refundedById: U.SALES },
        { medium: 'CASH', note: 'x'.repeat(301) },
        { medium: 'TRANSFER', transferEntityId: 'NO-EXISTE' },
      ];
      for (const body of badData) {
        const res = await refund(rRefund.id, body);
        expect(res.status, `${JSON.stringify(body)} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      expect((await returnRow(rRefund.id)).refundedAt).toBeNull();
      expect(((await refund(rRefund.id, { medium: 'CASH' }).expect(200)).body as ReturnBody).refundPending).toBe(false);

      const notBilled = await creditNote(rCredit.id, 'NC-1', 'ADMIN');
      expect(notBilled.status, JSON.stringify(notBilled.body)).toBe(409);
      expect(message(notBilled)).toMatch(/no está facturada/);
      const notReceived = await creditNote(rPending.id, 'NC-1', 'ADMIN');
      expect(notReceived.status, JSON.stringify(notReceived.body)).toBe(409);
      expect(message(notReceived)).toMatch(/todavía no se ha recibido/);
      for (const number of ['', '   ', 'x'.repeat(61), 123, null]) {
        const res = await creditNote(rCredit.id, number, 'ADMIN');
        expect(res.status, `${JSON.stringify(number)} → ${JSON.stringify(res.body)}`).toBe(400);
      }
      expect((await post(`/sales-returns/${rCredit.id}/credit-note`, 'ADMIN', {})).status).toBe(400);
      expect((await post(`/sales-returns/${rCredit.id}/credit-note`, 'ADMIN', { number: 'NC-1', at: new Date().toISOString() })).status).toBe(400);
      expect((await returnRow(rCredit.id)).creditNoteNumber).toBeNull();

      // Decisions: reasons and notes are checked too.
      const r = await asked(o, 1);
      for (const reason of ['', 'ab', '   ', 'x'.repeat(501)]) {
        expect((await reject(r.id, reason)).status, `reject ${JSON.stringify(reason)}`).toBe(400);
        expect((await cancel(r.id, reason)).status, `cancel ${JSON.stringify(reason)}`).toBe(400);
      }
      expect((await approve(r.id, 'ADMIN', { note: 'x'.repeat(501) })).status).toBe(400);
      expect((await approve(r.id, 'ADMIN', { receiverId: U.WAREHOUSE2 })).status).toBe(400);
      expect((await returnRow(r.id)).status).toBe('REQUESTED');
    }, 120_000);

    it('saldo a favor as a payment: above the total, 3 decimals, negative or without credit is 400 and no order is created', async () => {
      const quote = await makeQuote([{ finish: 'VALID_CONVERT', quantity: 1 }]);
      expect(Number(quote.total)).toBe(PRICE);
      const cases: [unknown, RegExp | null][] = [
        ['11900.01', /supera el total/],
        ['20000', /supera el total/],
        ['100.123', null],
        ['-100', null],
        ['1e3', null],
        [' 100', null],
        ['100,50', null],
        ['', null],
        [100, null],
        [`100${NASTY_SQL}`, null],
      ];
      for (const [creditAmount, expected] of cases) {
        const res = await convert(quote.id, { paymentMethod: 'CASH', creditAmount });
        expect(res.status, `${JSON.stringify(creditAmount)} → ${JSON.stringify(res.body)}`).toBe(400);
        if (expected) expect(message(res)).toMatch(expected);
      }
      // A customer without saldo a favor cannot use it, with any method.
      const empty = await makeQuote([{ finish: 'VALID_CONVERT', quantity: 1 }], ids.emptyCustomer);
      for (const paymentMethod of ['CASH', 'PARTIAL', 'CREDIT']) {
        const res = await convert(empty.id, { paymentMethod, creditAmount: '100' });
        expect(res.status, `${paymentMethod} → ${JSON.stringify(res.body)}`).toBe(400);
        expect(message(res)).toMatch(/no tiene saldo a favor/);
      }
      for (const q of [quote, empty]) {
        expect(await prisma.salesOrder.count({ where: { quoteId: q.id } })).toBe(0);
        expect((await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status).toBe('DRAFT');
      }
      // Abono with saldo a favor: the customer must have it; it never carries an entity.
      const abono = await order([{ finish: 'VALID_CONVERT', quantity: 1 }], 'PARTIAL', {}, ids.emptyCustomer);
      const noCredit = await pay(abono.id, 'CREDIT_BALANCE', '100');
      expect(noCredit.status, JSON.stringify(noCredit.body)).toBe(400);
      expect(message(noCredit)).toMatch(/no tiene saldo a favor/);
      expect((await pay(abono.id, 'CREDIT_BALANCE', '100', { transferEntityId: 'NEQUI' })).status).toBe(400);
      expect((await pay(abono.id, 'CREDIT_BALANCE', '0')).status).toBe(400);
      expect((await pay(abono.id, 'CREDIT_BALANCE', '-1')).status).toBe(400);
      expect(await prisma.salesOrderPayment.count({ where: { salesOrderId: abono.id } })).toBe(0);
      expect(await creditOf(ids.emptyCustomer)).toBe('0.00');
    });
  });

  // ---------------------------------------------------------------------------
  describe('database rules (API bypassed)', () => {
    it('a received return, its lines, RETURN movements, saldo a favor payments and states are guarded by the database', async () => {
      const { o, b } = await setup('DB_RULES', 3, 'CASH', {}, ids.dbCustomer);
      const rRec = await asked(o, 2, {}, 'ADMIN');
      await received(rRec, 2, 0);
      const rApp = await asked(o, 1, {}, 'ADMIN');
      expect(await creditOf(ids.dbCustomer)).toBe('23800.00');
      const frozen = await returnRow(rRec.id);

      // A received return never changes.
      const headerAttempts: Record<string, unknown>[] = [
        { amount: '1.00' },
        { settledAmount: '0.00' },
        { baseAmount: '0.00' },
        { settlement: 'REFUND' },
        { receivedAt: new Date() },
        { customerId: ids.customer },
        { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: U.ADMIN, cancelReason: 'Intento directo' },
        { status: 'APPROVED', receivedAt: null, receivedById: null, receiveOperationKey: null, amount: null, baseAmount: null, settledAmount: null },
      ];
      for (const data of headerAttempts) {
        expect(await rejection(prisma.salesReturn.update({ where: { id: rRec.id }, data })), JSON.stringify(data)).toMatch(/ya fue recibida/);
      }
      const line = frozen.lines[0];
      for (const data of [{ goodQuantity: 1 }, { damagedQuantity: 1, goodQuantity: 1 }, { amount: '0.00' }, { baseAmount: '1.00' }, { quantity: 3 }]) {
        expect(await rejection(prisma.salesReturnLine.update({ where: { id: line.id }, data })), JSON.stringify(data)).toMatch(/no se modifica/);
      }
      expect(await returnRow(rRec.id)).toEqual(frozen);

      // Every RETURN movement belongs to a return line, and only they do.
      const stock = await bundleRow(b.id);
      const movementCount = await prisma.inventoryMovement.count({ where: { bundleId: b.id } });
      const movement = (data: Record<string, unknown>) =>
        prisma.inventoryMovement.create({
          data: {
            bundleId: b.id,
            quantity: 1,
            quantityBefore: stock.quantity,
            quantityAfter: stock.quantity + 1,
            destinationLocationId: ids.loc,
            occurredAt: new Date(),
            performedById: U.ADMIN,
            operationKey: `hardening:${randomUUID()}`,
            type: 'RETURN',
            ...data,
          } as never,
        });
      expect(await rejection(movement({}))).toMatch(/inventory_movements_sales_return_link/);
      expect(await rejection(movement({ type: 'ENTRY', salesReturnLineId: line.id }))).toMatch(/inventory_movements_sales_return_link/);
      expect(await rejection(movement({ salesReturnLineId: line.id, quantityAfter: stock.quantity + 5 }))).toMatch(/inventory_movements_balance_consistent/);
      expect(await prisma.inventoryMovement.count({ where: { bundleId: b.id } })).toBe(movementCount);
      expect(await bundleRow(b.id)).toEqual(stock);

      // Saldo a favor: payments with it never exceed what the customer was credited.
      const abono = await order([{ finish: 'DB_RULES', quantity: 3 }], 'PARTIAL', {}, ids.dbCustomer);
      const creditPayment = (amount: string) =>
        prisma.salesOrderPayment.create({
          data: { salesOrderId: abono.id, medium: 'CREDIT_BALANCE', amount, paidOn: new Date(`${businessToday()}T00:00:00.000Z`), operationKey: randomUUID(), createdById: U.SALES },
        });
      expect(await rejection(creditPayment('30000.00'))).toMatch(/saldo a favor/);
      expect(await rejection(creditPayment('23800.01'))).toMatch(/saldo a favor/);
      expect(await prisma.salesOrderPayment.count({ where: { salesOrderId: abono.id } })).toBe(0);
      // Within the credit the rule lets it through (it is not a blanket refusal); then nothing is left.
      await creditPayment('23800.00');
      expect(await rejection(creditPayment('0.01'))).toMatch(/saldo a favor/);
      expect(await creditOf(ids.dbCustomer)).toBe('0.00');
      // Payments never exceed the net total of an order with received returns.
      expect(
        await rejection(
          prisma.salesOrderPayment.create({
            data: { salesOrderId: o.id, medium: 'CASH', amount: '1.00', paidOn: new Date(`${businessToday()}T00:00:00.000Z`), operationKey: randomUUID(), createdById: U.SALES },
          }),
        ),
      ).toMatch(/superan su total neto/);

      // Another return cannot be marked received without its reception and value.
      const approved = await returnRow(rApp.id);
      const receptionAttempts: Record<string, unknown>[] = [
        { status: 'RECEIVED' },
        { status: 'RECEIVED', receivedAt: new Date(), receivedById: U.WAREHOUSE, receiveOperationKey: randomUUID() },
        { status: 'RECEIVED', receivedAt: new Date(), receivedById: U.WAREHOUSE, receiveOperationKey: randomUUID(), amount: '100.00', baseAmount: '84.00', settledAmount: '200.00' },
        { status: 'REQUESTED' },
        { status: 'REJECTED', decisionNote: null },
        { amount: '1.00', baseAmount: '1.00', settledAmount: '1.00' },
        { refundedAt: new Date(), refundedById: U.ADMIN, refundMedium: 'CASH', refundedOn: new Date() },
        { creditNoteNumber: 'NC-DIRECTA', creditNoteAt: new Date(), creditNoteById: U.ADMIN },
      ];
      for (const data of receptionAttempts) {
        expect(await rejection(prisma.salesReturn.update({ where: { id: rApp.id }, data })), JSON.stringify(data)).toMatch(/sales_returns_valid/);
      }
      const appLine = approved.lines[0];
      for (const data of [
        { goodQuantity: 1 },
        { goodQuantity: 5, damagedQuantity: 0, amount: '0', baseAmount: '0' },
        { goodQuantity: 1, damagedQuantity: 0, amount: '-1', baseAmount: '0' },
        { quantity: 0 },
      ]) {
        expect(await rejection(prisma.salesReturnLine.update({ where: { id: appLine.id }, data })), JSON.stringify(data)).toMatch(/sales_return_lines_valid/);
      }
      expect(await returnRow(rApp.id)).toEqual(approved);

      // Return tasks point to their return, and only they do.
      const task = (data: Record<string, unknown>) =>
        prisma.task.create({ data: { title: 'Tarea directa', dueAt: new Date(inHours(24)), assigneeId: U.ADMIN, createdById: U.ADMIN, kind: 'RETURN_APPROVAL', ...data } as never });
      expect(await rejection(task({}))).toMatch(/tasks_sales_return_link/);
      expect(await rejection(task({ kind: 'GENERAL', salesReturnId: rApp.id }))).toMatch(/tasks_sales_return_link/);
      expect(await prisma.task.count({ where: { salesReturnId: rApp.id } })).toBe(1);
    }, 120_000);
  });
});
