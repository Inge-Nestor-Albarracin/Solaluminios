import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { businessToday } from '../src/shared/db.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Sales returns (documento DV) on the real PostgreSQL test database:
// request (seller → chosen administrator, or an administrator directly),
// approval and rejection, reception by the warehouse (closed bundle read by
// chip, loose profiles, damaged ones), the value with and without VAT, the
// money (saldo a favor, reintegro, lower balance), the credit note of an
// invoiced order, saldo a favor as a payment (with its races), visibility by
// role, retries and the database rules. Each scenario uses its own finish so
// stock never mixes between them. Data: unique suffix, test database only.
interface ReturnBody {
  id: string;
  number: string;
  status: string;
  amount?: string | null;
  baseAmount?: string | null;
  settledAmount?: string | null;
  refundPending?: boolean;
  refund?: { medium: string; transferEntity: { id: string } | null } | null;
  creditNote: { number: string } | null;
  creditNotePending: boolean;
  lines: {
    id: string;
    quantity: number;
    goodQuantity: number | null;
    damagedQuantity: number | null;
    amount?: string | null;
    sources?: { epc: string; picked: number; closed: boolean }[];
    movements: { epc: string; quantity: number }[];
  }[];
}
interface OrderBody {
  id: string;
  number: string;
  total: string;
  paymentStatus: 'PENDING' | 'PAID' | null;
  lines: { id: string }[];
  returns: { number: string; status: string }[];
  paymentSummary?: { returned: string; settled: string; net: string; paid: string; balance: string };
  customerCredit?: string;
  payments?: { medium: string; amount: string }[];
}

describe('Sales returns (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', supplier: '', customer: '', branch: '', loc: '', rack: '' };
  const finishes: Record<'F1' | 'F2' | 'F3', string> = { F1: '', F2: '', F3: '' };
  let epcCounter = 0;
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.77.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  const bundle = async (finish: keyof typeof finishes, quantity: number) => {
    const epc = `DV${S}${String(++epcCounter).padStart(4, '0')}`;
    const res = await http()
      .post('/inventory/bundles')
      .set(as('WAREHOUSE'))
      .send({
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
      })
      .expect(201);
    return { id: res.body.id as string, epc };
  };

  // Price 10.000 per profile + VAT 19 % = 11.900.
  const order = async (finish: keyof typeof finishes, quantity: number, paymentMethod: string, extra: Record<string, unknown> = {}, status = 200) => {
    const quote = (
      await http()
        .post('/quotes')
        .set(as('SALES'))
        .send({ customerId: ids.customer, lines: [{ referenceId: ids.ref, finishId: finishes[finish], origin: 'NATIONAL', quantity, discountPercent: '0', taxRatePercent: '19' }] })
        .expect(201)
    ).body as { id: string };
    const res = await http().post(`/quotes/${quote.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID(), paymentMethod, ...extra });
    expect(res.status).toBe(status);
    return res.body as OrderBody & { message?: string };
  };

  // Reserve, dispatch everything and confirm the physical exit.
  const deliver = async (o: OrderBody, quantity: number) => {
    await http().post(`/sales-orders/${o.id}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.loc }).expect(200);
    const dispatch = (
      await http()
        .post(`/sales-orders/${o.id}/dispatches`)
        .set(as('SALES'))
        .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(5), lines: [{ salesOrderLineId: o.lines[0].id, quantity }] })
        .expect(201)
    ).body as { id: string };
    const detail = (await http().get(`/dispatches/${dispatch.id}`).set(as('WAREHOUSE')).expect(200)).body as { lines: { suggested: { epc: string }[] }[] };
    for (const suggestion of detail.lines[0].suggested) {
      expect((await http().post(`/dispatches/${dispatch.id}/scan`).set(as('WAREHOUSE')).send({ epc: suggestion.epc }).expect(200)).body.result).toBe('PREPARED');
    }
    await http().post(`/dispatches/${dispatch.id}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(200);
  };

  const getOrder = async (id: string, who = 'SALES') => (await http().get(`/sales-orders/${id}`).set(as(who)).expect(200)).body as OrderBody;
  const getReturn = (id: string, who: string) => http().get(`/sales-returns/${id}`).set(as(who));
  const requestReturn = (o: OrderBody, quantity: number, body: Record<string, unknown> = {}, who = 'SALES') =>
    http()
      .post(`/sales-orders/${o.id}/returns`)
      .set(as(who))
      .send({
        operationKey: randomUUID(),
        reason: 'SELLER_ERROR',
        settlement: 'CREDIT',
        lines: [{ salesOrderLineId: o.lines[0].id, quantity }],
        ...(who === 'SALES' ? { approverId: U.ADMIN } : {}),
        ...body,
      });
  const receive = (r: ReturnBody, good: number, damaged: number, extra: Record<string, unknown> = {}, who = 'WAREHOUSE') =>
    http()
      .post(`/sales-returns/${r.id}/receive`)
      .set(as(who))
      .send({ operationKey: randomUUID(), lines: [{ lineId: r.lines[0].id, good, damaged }], ...extra });
  const bundleRow = (id: string) => prisma.bundle.findUniqueOrThrow({ where: { id }, select: { quantity: true, openedAt: true } });
  const credit = async () => Number((await getOrder(firstOrder.id)).customerCredit);

  let firstOrder: OrderBody;

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'SALES', 'SALES2', 'WAREHOUSE', 'BILLING'] as const) {
      const user = await createTestUser(app, role === 'SALES2' ? 'SALES' : role, `DV${role}${S}`);
      H[role] = user.headers;
      U[role] = user.id;
    }
    const branch = await prisma.branch.create({ data: { code: `E2E-DV-${S}`, name: 'Sucursal devoluciones' } });
    ids.branch = branch.id;
    const loc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `E2E-DV-${S}`, name: 'Bodega devoluciones' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: loc.id, number: 1 } });
    ids.loc = loc.id;
    ids.rack = (await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } })).id;
    await prisma.user.update({ where: { id: U.WAREHOUSE }, data: { defaultInventoryLocationId: ids.loc } });
    ids.ref = (await prisma.reference.create({ data: { code: `DV-REF-${S}`, description: 'Fixture devoluciones' } })).id;
    for (const key of ['F1', 'F2', 'F3'] as const) finishes[key] = (await prisma.finish.create({ data: { code: `DV${key}-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `DV-${S}`, name: 'Proveedor devoluciones', origins: ['NATIONAL'] } })).id;
    ids.customer = (
      await prisma.customer.create({
        data: { name: `Cliente devoluciones ${S}`, taxId: `7${S.replace(/\D/g, '').padEnd(8, '3').slice(0, 8)}`, email: `dv-${S.toLowerCase()}@test.local`, createdById: U.SALES },
      })
    ).id;
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `DV-${S}`,
        documentDate: '2026-11-03',
        lines: (['F1', 'F2', 'F3'] as const).map((key) => ({
          referenceId: ids.ref,
          finishId: finishes[key],
          origin: 'NATIONAL',
          quantity: 10,
          grossAmount: '80000',
          discountPercent: '0',
          taxRatePercent: '0',
        })),
      })
      .expect(201);
    const confirmed = (await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200)).body as { lines: { id: string }[] };
    for (const line of confirmed.lines) {
      await http().post('/sale-prices').set(as('ADMIN')).send({ purchaseId: purchase.body.id, purchaseLineId: line.id, markupPercent: '25', enabled: true }).expect(201);
    }
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await app?.close();
  });

  it('contado: seller asks, administrator approves, a closed bundle comes back closed and the value becomes saldo a favor', async () => {
    const closed = await bundle('F1', 10);
    firstOrder = await order('F1', 10, 'CASH');
    expect(Number(firstOrder.total)).toBe(119000);

    // Nothing delivered yet: nothing to return.
    expect((await http().get(`/sales-orders/${firstOrder.id}/returnable`).set(as('SALES')).expect(200)).body.lines[0]).toMatchObject({ delivered: 0, returnable: 0 });
    expect((await requestReturn(firstOrder, 1).expect(400)).body.message).toMatch(/no tiene perfiles entregados/);
    await deliver(firstOrder, 10);
    expect(await bundleRow(closed.id)).toMatchObject({ quantity: 0, openedAt: null });

    // Another seller does not see the order; more than delivered is refused;
    // a seller must choose an administrator.
    await http().get(`/sales-orders/${firstOrder.id}/returnable`).set(as('SALES2')).expect(404);
    await requestReturn(firstOrder, 1, {}, 'SALES2').expect(404);
    expect((await requestReturn(firstOrder, 11).expect(400)).body.message).toMatch(/hasta 10 perfiles/);
    await requestReturn(firstOrder, 1, { approverId: undefined }).expect(400);

    // Same key twice: one return.
    const key = randomUUID();
    const asked = (await requestReturn(firstOrder, 10, { operationKey: key }).expect(201)).body as ReturnBody;
    const again = (await requestReturn(firstOrder, 10, { operationKey: key }).expect(201)).body as ReturnBody;
    expect(again.id).toBe(asked.id);
    expect(asked.status).toBe('REQUESTED');
    expect(asked.number).toMatch(/^DV-\d{6}$/);
    expect(await prisma.task.findFirst({ where: { salesReturnId: asked.id, kind: 'RETURN_APPROVAL' } })).toMatchObject({ assigneeId: U.ADMIN, completedAt: null });
    // Its profiles are held while it is in process.
    expect((await requestReturn(firstOrder, 1).expect(400)).body.message).toMatch(/en trámite 10/);
    // Not yet approved: the warehouse does not see it; the seller cannot approve.
    await getReturn(asked.id, 'WAREHOUSE').expect(404);
    await http().post(`/sales-returns/${asked.id}/approve`).set(as('SALES')).send({}).expect(403);

    const approved = (await http().post(`/sales-returns/${asked.id}/approve`).set(as('ADMIN')).send({ note: 'Ok' }).expect(200)).body as ReturnBody;
    expect(approved.status).toBe('APPROVED');
    expect(await prisma.task.findFirst({ where: { salesReturnId: asked.id, kind: 'RETURN_APPROVAL' } })).toMatchObject({ completedAt: expect.any(Date) });
    expect(await prisma.task.findFirst({ where: { salesReturnId: asked.id, kind: 'RETURN_RECEPTION' } })).toMatchObject({ assigneeId: U.WAREHOUSE, completedAt: null });

    // The warehouse sees where it left from, without money.
    const seen = (await getReturn(asked.id, 'WAREHOUSE').expect(200)).body as ReturnBody;
    expect(seen.amount).toBeUndefined();
    expect(seen.lines[0].amount).toBeUndefined();
    expect(seen.lines[0].sources).toEqual([{ bundleId: closed.id, epc: closed.epc, picked: 10, returned: 0, closed: true }]);

    // A chip that did not leave in this order is refused.
    const other = await bundle('F1', 3);
    expect((await receive(approved, 10, 0, { sealedEpcs: [other.epc] }).expect(400)).body.message).toMatch(/no salió en esta orden/);

    const received = (await receive(approved, 10, 0, { sealedEpcs: [closed.epc.toLowerCase()] }).expect(200)).body as ReturnBody;
    // The warehouse answer carries no money; the seller sees the value.
    expect(received).toMatchObject({ status: 'RECEIVED' });
    expect(received.amount).toBeUndefined();
    const done = (await getReturn(asked.id, 'SALES').expect(200)).body as ReturnBody;
    expect(done).toMatchObject({ status: 'RECEIVED', amount: '119000.00', baseAmount: '100000.00', settledAmount: '119000.00' });
    expect(done.lines[0]).toMatchObject({ goodQuantity: 10, damagedQuantity: 0, amount: '119000.00' });
    expect(done.lines[0].movements).toEqual([expect.objectContaining({ epc: closed.epc, quantity: 10 })]);
    // Back closed, in the same place, with a RETURN movement.
    expect(await bundleRow(closed.id)).toMatchObject({ quantity: 10, openedAt: null });
    expect(await prisma.inventoryMovement.count({ where: { bundleId: closed.id, type: 'RETURN' } })).toBe(1);
    expect(await prisma.task.findFirst({ where: { salesReturnId: asked.id, kind: 'RETURN_RECEPTION' } })).toMatchObject({ completedAt: expect.any(Date) });
    expect(await prisma.notificationOutbox.count({ where: { userId: U.SALES, kind: 'return-received' } })).toBe(1);

    // Order: the value came back; net 0; the customer has 119.000 in favour.
    const after = await getOrder(firstOrder.id);
    expect(after.paymentSummary).toMatchObject({ returned: '119000.00', settled: '119000.00', net: '0.00', paid: '119000.00', balance: '0.00' });
    expect(after.returns).toEqual([expect.objectContaining({ number: asked.number, status: 'RECEIVED' })]);
    expect(after.customerCredit).toBe('119000.00');
    // Everything delivered already came back.
    expect((await requestReturn(firstOrder, 1).expect(400)).body.message).toMatch(/hasta 0 perfiles/);

    // A received return never changes (database rule).
    await expect(prisma.salesReturn.update({ where: { id: asked.id }, data: { amount: '1.00' } })).rejects.toThrow();
  });

  it('saldo a favor pays new orders: once, never more than the customer has (also in a race)', async () => {
    // Two conversions racing for 100.000 each of the 119.000: one wins.
    const quotes = await Promise.all(
      [1, 2].map(async () =>
        (
          await http()
            .post('/quotes')
            .set(as('SALES'))
            .send({ customerId: ids.customer, lines: [{ referenceId: ids.ref, finishId: finishes.F1, origin: 'NATIONAL', quantity: 10, discountPercent: '0', taxRatePercent: '19' }] })
            .expect(201)
        ).body as { id: string },
      ),
    );
    const results = await Promise.all(
      quotes.map((q) => http().post(`/quotes/${q.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID(), paymentMethod: 'CASH', creditAmount: '100000' })),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 400]);
    const won = results.find((r) => r.status === 200)!.body as OrderBody;
    expect(won.payments!.map((p) => [p.medium, Number(p.amount)])).toEqual([
      ['CREDIT_BALANCE', 100000],
      ['CASH', 19000],
    ]);
    expect(await credit()).toBe(19000);

    expect((await order('F1', 5, 'CASH', { creditAmount: '20000' }, 400)).message).toMatch(/19\.000 de saldo a favor/);
    // Abono order: the saldo a favor is its first abono; the rest from the order.
    const abono = await order('F1', 5, 'PARTIAL', { creditAmount: '19000' });
    expect(abono.payments!.map((p) => [p.medium, Number(p.amount)])).toEqual([['CREDIT_BALANCE', 19000]]);
    expect(abono.paymentStatus).toBe('PENDING');
    expect(await credit()).toBe(0);
    // Nothing left: neither an abono nor a direct insert can use more.
    const add = await http()
      .post(`/sales-orders/${abono.id}/payments`)
      .set(as('SALES'))
      .send({ operationKey: randomUUID(), medium: 'CREDIT_BALANCE', amount: '1000', paidOn: businessToday() })
      .expect(400);
    expect(add.body.message).toMatch(/no tiene saldo a favor/);
    await expect(
      prisma.salesOrderPayment.create({
        data: { salesOrderId: abono.id, medium: 'CREDIT_BALANCE', amount: '1000', paidOn: new Date(`${businessToday()}T00:00:00Z`), operationKey: randomUUID(), createdById: U.SALES },
      }),
    ).rejects.toThrow();
  });

  it('abono: an administrator returns part as loose profiles (some damaged); the balance drops first and the rest is refunded', async () => {
    const source = await bundle('F2', 15);
    const o = await order('F2', 10, 'PARTIAL');
    await http().post(`/sales-orders/${o.id}/payments`).set(as('SALES')).send({ operationKey: randomUUID(), medium: 'CASH', amount: '100000', paidOn: businessToday() }).expect(201);
    await deliver(o, 10);
    expect(await bundleRow(source.id)).toMatchObject({ quantity: 5, openedAt: expect.any(Date) });

    // An administrator's request is approved at once (task to the warehouse).
    const asked = (await requestReturn(o, 6, { settlement: 'REFUND', reason: 'CUSTOMER_ERROR' }, 'ADMIN').expect(201)).body as ReturnBody;
    expect(asked.status).toBe('APPROVED');
    expect(await prisma.task.count({ where: { salesReturnId: asked.id, kind: 'RETURN_APPROVAL' } })).toBe(0);

    // More than requested, or nothing at all, is refused.
    await receive(asked, 6, 1).expect(400);
    expect((await receive(asked, 0, 0).expect(400)).body.message).toMatch(/cancela la devolución/);
    // An opened bundle cannot come back «closed».
    expect((await receive(asked, 4, 1, { sealedEpcs: [source.epc] }).expect(400)).body.message).toMatch(/salió abierto/);

    // 4 good + 1 damaged of 6: value of 5 profiles (59.500); only the good
    // ones go back to stock (as loose profiles).
    await receive(asked, 4, 1).expect(200);
    const done = (await getReturn(asked.id, 'ADMIN').expect(200)).body as ReturnBody;
    expect(done).toMatchObject({ amount: '59500.00', baseAmount: '50000.00' });
    expect(await bundleRow(source.id)).toMatchObject({ quantity: 9 });
    // Paid 100.000; new net 59.500: 40.500 goes back as reintegro, balance 0.
    expect(done).toMatchObject({ settledAmount: '40500.00', refundPending: true });
    const after = await getOrder(o.id);
    expect(after.paymentStatus).toBe('PAID');
    expect(after.paymentSummary).toMatchObject({ net: '59500.00', paid: '100000.00', settled: '40500.00', balance: '0.00' });
    await http().post(`/sales-orders/${o.id}/payments`).set(as('SALES')).send({ operationKey: randomUUID(), medium: 'CASH', amount: '1', paidOn: businessToday() }).expect(400);
    // The rest (one profile not brought) can still be returned.
    expect((await http().get(`/sales-orders/${o.id}/returnable`).set(as('SALES')).expect(200)).body.lines[0]).toMatchObject({ delivered: 10, returned: 5, returnable: 5 });

    // The seller records the refund: a transfer says from which entity.
    const refund = (body: Record<string, unknown>) => http().post(`/sales-returns/${asked.id}/refund`).set(as('SALES')).send({ refundedOn: businessToday(), ...body });
    await refund({ medium: 'TRANSFER' }).expect(400);
    const refunded = (await refund({ medium: 'TRANSFER', transferEntityId: 'NEQUI' }).expect(200)).body as ReturnBody;
    expect(refunded).toMatchObject({ refundPending: false, refund: { medium: 'TRANSFER', transferEntity: { id: 'NEQUI' } } });
    await refund({ medium: 'TRANSFER', transferEntityId: 'NEQUI' }).expect(200);
    await refund({ medium: 'CASH' }).expect(409);
  });

  it('cartera of an invoiced order: rejection, approval, retried reception and the credit note for billing', async () => {
    await bundle('F3', 5);
    const o = await order('F3', 2, 'CREDIT', { requiresBilling: true });
    await http().post(`/sales-orders/${o.id}/invoice`).set(as('BILLING')).send({ invoiceNumber: `FE-${S}` }).expect(200);
    await deliver(o, 2);

    const first = (await requestReturn(o, 2).expect(201)).body as ReturnBody;
    await http().post(`/sales-returns/${first.id}/reject`).set(as('ADMIN')).send({ reason: 'x' }).expect(400);
    const rejected = (await http().post(`/sales-returns/${first.id}/reject`).set(as('ADMIN')).send({ reason: 'No aplica la garantía' }).expect(200)).body as ReturnBody;
    expect(rejected.status).toBe('REJECTED');
    expect(await prisma.notificationOutbox.count({ where: { userId: U.SALES, kind: 'return-rejected' } })).toBe(1);

    // Rejected ones free their profiles; an approved one can still be cancelled.
    const cancelled = (await requestReturn(o, 2).expect(201)).body as ReturnBody;
    await http().post(`/sales-returns/${cancelled.id}/approve`).set(as('ADMIN')).send({}).expect(200);
    await http().post(`/sales-returns/${cancelled.id}/cancel`).set(as('SALES')).send({ reason: 'El cliente se quedó con el material' }).expect(200);
    expect(await prisma.task.findFirst({ where: { salesReturnId: cancelled.id, kind: 'RETURN_RECEPTION' } })).toMatchObject({ cancelledAt: expect.any(Date) });
    // The warehouse no longer sees it; nobody can receive it.
    await receive(cancelled, 2, 0).expect(404);
    await receive(cancelled, 2, 0, {}, 'ADMIN').expect(409);

    const asked = (await requestReturn(o, 2).expect(201)).body as ReturnBody;
    await http().post(`/sales-returns/${asked.id}/approve`).set(as('ADMIN')).send({}).expect(200);
    // The same reception sent twice at once: recorded once.
    const key = randomUUID();
    const both = await Promise.all(
      [1, 2].map(() => http().post(`/sales-returns/${asked.id}/receive`).set(as('WAREHOUSE')).send({ operationKey: key, lines: [{ lineId: asked.lines[0].id, good: 2, damaged: 0 }] })),
    );
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.inventoryMovement.count({ where: { type: 'RETURN', salesReturnLine: { salesReturnId: asked.id } } })).toBe(1);
    await receive(asked, 2, 0).expect(409);

    // Cartera without payments: the value only lowers what was owed.
    const after = await getOrder(o.id);
    expect(after.paymentSummary).toMatchObject({ returned: '23800.00', settled: '0.00', net: '0.00', balance: '0.00' });
    expect(after.paymentStatus).toBe('PAID');

    // Invoiced: billing gets the credit note task and records its number.
    const task = await prisma.task.findFirst({ where: { salesReturnId: asked.id, kind: 'CREDIT_NOTE' } });
    // In turn among the active billing users of the database.
    expect(task).toMatchObject({ completedAt: null });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: task!.assigneeId } })).role).toBe('BILLING');
    const seen = (await getReturn(asked.id, 'BILLING').expect(200)).body as ReturnBody;
    expect(seen).toMatchObject({ creditNotePending: true, amount: '23800.00' });
    await http().post(`/sales-returns/${asked.id}/credit-note`).set(as('SALES')).send({ number: 'NC-1' }).expect(403);
    const noted = (await http().post(`/sales-returns/${asked.id}/credit-note`).set(as('BILLING')).send({ number: `NC-${S}` }).expect(200)).body as ReturnBody;
    expect(noted).toMatchObject({ creditNote: { number: `NC-${S}` }, creditNotePending: false });
    await http().post(`/sales-returns/${asked.id}/credit-note`).set(as('BILLING')).send({ number: `NC-${S}` }).expect(200);
    await http().post(`/sales-returns/${asked.id}/credit-note`).set(as('BILLING')).send({ number: 'OTRA' }).expect(409);
    expect(await prisma.task.findFirst({ where: { salesReturnId: asked.id, kind: 'CREDIT_NOTE' } })).toMatchObject({ completedAt: expect.any(Date) });
    // Billing lists only received returns of orders sent to billing.
    const listed = (await http().get('/sales-returns?pageSize=100').set(as('BILLING')).expect(200)).body as { items: { id: string; status: string }[] };
    expect(listed.items.map((i) => i.id)).toContain(asked.id);
    expect(listed.items.every((i) => i.status === 'RECEIVED')).toBe(true);
  });

  it('the seller summary and the Excel subtract the received returns', async () => {
    const summary = (await http().get(`/sales-orders/summary?sellerId=${U.SALES}`).set(as('ADMIN')).expect(200)).body as { returned: { returns: number; base: string } }[];
    // 100.000 + 50.000 + 20.000 of base without VAT.
    expect(summary[0].returned).toEqual({ returns: 3, base: '170000.00', total: '202300.00' });
    const file = await http().get(`/sales-orders/export?sellerId=${U.SALES}`).set(as('ADMIN')).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((file.body as Buffer).length).toBeGreaterThan(1000);
  });
});
