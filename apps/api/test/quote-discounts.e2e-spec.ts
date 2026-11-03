import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { Decimal } from '../src/shared/money.js';
import { barrierAtTransactionStart, createBarrier } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Global discount of quotes: SALES applies 0.1–3 % alone; above that it asks
// an administrator it chooses, who gets a task and is the only one who can
// answer. Approving applies the discount to the quote. Races repeat with
// fresh data on the real PostgreSQL test database.
const ROUNDS = 10;

interface QuoteBody {
  id: string;
  number: string;
  status: string;
  subtotal: string;
  discountTotal: string;
  globalDiscountPercent: string;
  globalDiscountAmount: string;
  taxTotal: string;
  total: string;
  globalDiscountLimit: string;
  lines: { lineTotal: string; globalDiscountAmount: string; taxAmount: string }[];
  discountRequests: { id: string; status: string; requestedPercent: string; resolution: string | null; projected: { total: string } | null }[];
}

describe('Global discount of quotes and its approval requests (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', finishA: '', finishB: '', supplier: '', customer: '' };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  // Own client IP per request: the global rate limit never mixes in.
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.47.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const statuses = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b).join('/');

  let call = 0;
  const together = async <T>(requests: (() => Promise<T>)[]) => {
    barrierAtTransactionStart(prisma, requests.length, createBarrier(requests.length));
    const order = requests.map((_, index) => index);
    if (call++ % 2 === 1) order.reverse();
    const pending: Promise<T>[] = Array.from({ length: requests.length });
    for (const index of order) pending[index] = requests[index]();
    try {
      return await Promise.all(pending);
    } finally {
      vi.restoreAllMocks();
    }
  };

  // Two lines with different VAT: 10 × price with 10 % line discount and 19 %
  // VAT, and 3 × price without discount and 0 % VAT.
  const lines = [
    { referenceId: '', finishId: '', origin: 'NATIONAL', quantity: 10, discountPercent: '10', taxRatePercent: '19' },
    { referenceId: '', finishId: '', origin: 'NATIONAL', quantity: 3, discountPercent: '0', taxRatePercent: '0' },
  ];
  const body = (globalDiscountPercent?: string) => ({
    customerId: ids.customer,
    paymentMethod: 'CASH',
    ...(globalDiscountPercent === undefined ? {} : { globalDiscountPercent }),
    lines: lines.map((line, index) => ({ ...line, referenceId: ids.ref, finishId: index === 0 ? ids.finishA : ids.finishB })),
  });
  const create = (who: string, globalDiscountPercent?: string) => http().post('/quotes').set(as(who)).send(body(globalDiscountPercent));
  const newQuote = async (who = 'SALES') => (await create(who).expect(201)).body as QuoteBody;
  const save = (id: string, globalDiscountPercent: string, who = 'SALES') => http().patch(`/quotes/${id}`).set(as(who)).send(body(globalDiscountPercent));
  const get = async (id: string, who = 'SALES') => (await http().get(`/quotes/${id}`).set(as(who)).expect(200)).body as QuoteBody;
  const ask = (id: string, percent: string, approver = 'ADMIN', who = 'SALES') =>
    http().post(`/quotes/${id}/discount-requests`).set(as(who)).send({ percent, approverId: U[approver], reason: 'Cliente frecuente' });
  const answer = (id: string, requestId: string, action: 'approve' | 'reject' | 'cancel', who = 'ADMIN', send: object = {}) =>
    http().post(`/quotes/${id}/discount-requests/${requestId}/${action}`).set(as(who)).send(send);
  const pendingOf = async (quoteId: string) => (await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId, status: 'PENDING' } })).id;
  const convert = (id: string) => http().post(`/quotes/${id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() });

  // total = subtotal − line discounts − global discount + VAT = Σ line totals,
  // and the global amount is the rounded percentage of the base.
  const expectConsistent = (q: QuoteBody) => {
    const d = (value: string) => new Decimal(value);
    const base = d(q.subtotal).minus(q.discountTotal);
    expect(d(q.globalDiscountAmount).equals(base.times(q.globalDiscountPercent).dividedBy(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP))).toBe(true);
    expect(base.minus(q.globalDiscountAmount).plus(q.taxTotal).equals(q.total)).toBe(true);
    expect(q.lines.reduce((total, line) => total.plus(line.lineTotal), d('0')).equals(q.total)).toBe(true);
    expect(q.lines.reduce((total, line) => total.plus(line.globalDiscountAmount), d('0')).equals(q.globalDiscountAmount)).toBe(true);
  };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role, suffix] of [
      ['ADMIN', 'ADMIN', `QD${S}A`],
      ['ADMIN2', 'ADMIN', `QD${S}B`],
      ['SALES', 'SALES', `QD${S}A`],
      ['SALES2', 'SALES', `QD${S}B`],
      ['WAREHOUSE', 'WAREHOUSE', `QD${S}A`],
    ] as const) {
      const user = await createTestUser(app, role, suffix);
      H[key] = user.headers;
      U[key] = user.id;
    }
    ids.ref = (await prisma.reference.create({ data: { code: `QDISC-REF-${S}` } })).id;
    ids.finishA = (await prisma.finish.create({ data: { code: `QDISC-A-${S}` } })).id;
    ids.finishB = (await prisma.finish.create({ data: { code: `QDISC-B-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `QDISC-${S}`, name: 'Proveedor descuentos', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente descuentos ${S}`, createdById: U.SALES } })).id;
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `QDISC-${S}`,
        documentDate: '2026-10-20',
        lines: [ids.finishA, ids.finishB].map((finishId) => ({ referenceId: ids.ref, finishId, origin: 'NATIONAL', quantity: 7, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' })),
      })
      .expect(201);
    const confirmed = await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200);
    for (const purchaseLine of confirmed.body.lines as { id: string }[]) {
      await http().post('/sale-prices').set(as('ADMIN')).send({ purchaseId: purchase.body.id, purchaseLineId: purchaseLine.id, markupPercent: '30', enabled: true }).expect(201);
    }
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      const users = Object.values(U);
      const quotes = (await prisma.quote.findMany({ where: { createdById: { in: users } }, select: { id: true } })).map((q) => q.id);
      const orders = (await prisma.salesOrder.findMany({ where: { quoteId: { in: quotes } }, select: { id: true } })).map((o) => o.id);
      await prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } });
      await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } });
      await prisma.quoteDiscountRequest.deleteMany({ where: { quoteId: { in: quotes } } });
      await prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orders } } });
      await prisma.salesOrder.deleteMany({ where: { id: { in: orders } } });
      await prisma.quote.deleteMany({ where: { id: { in: quotes } } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.salePrice.deleteMany({ where: { referenceId: ids.ref } });
      await prisma.purchase.deleteMany({ where: { createdById: { in: users } } });
      await prisma.supplier.deleteMany({ where: { id: ids.supplier } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.reference.deleteMany({ where: { id: ids.ref } });
      await prisma.finish.deleteMany({ where: { id: { in: [ids.finishA, ids.finishB] } } });
    }
    await app?.close();
  });

  it('SALES applies from 0.1 % to 3 % alone; ADMIN applies more', async () => {
    const q = (await create('SALES', '3').expect(201)).body as QuoteBody;
    expect(Number(q.globalDiscountPercent)).toBe(3);
    expect(Number(q.globalDiscountLimit)).toBe(3);
    expectConsistent(q);
    await create('SALES', '0.1').expect(201);
    expect((await create('SALES', '0.05').expect(400)).body.message).toMatch(/0,1 %/);
    expect((await create('SALES', '3.5').expect(403)).body.message).toMatch(/solicitud de autorización/);
    await create('SALES', '2.555').expect(400);
    await save(q.id, '3.01').expect(403);
    // ADMIN: directly, also on a seller's quote.
    expect(Number(((await create('ADMIN', '12.5').expect(201)).body as QuoteBody).globalDiscountPercent)).toBe(12.5);
    const edited = (await save(q.id, '10', 'ADMIN').expect(200)).body as QuoteBody;
    expect(Number(edited.globalDiscountPercent)).toBe(10);
    expectConsistent(edited);
    // Without the field the quote has no global discount.
    expect(Number((await newQuote()).globalDiscountPercent)).toBe(0);
  });

  it('applies after the line discounts and before VAT; the order copies it', async () => {
    const q = (await create('SALES', '2.5').expect(201)).body as QuoteBody;
    expectConsistent(q);
    expect(Number(q.discountTotal)).toBeGreaterThan(0);
    expect(Number(q.globalDiscountAmount)).toBeGreaterThan(0);
    const order = (await convert(q.id).expect(200)).body as QuoteBody;
    for (const field of ['subtotal', 'discountTotal', 'globalDiscountPercent', 'globalDiscountAmount', 'taxTotal', 'total'] as const) {
      expect(Number(order[field]), field).toBe(Number(q[field]));
    }
    expect(order.lines.map((line) => line.globalDiscountAmount)).toEqual(q.lines.map((line) => line.globalDiscountAmount));
    await http().get(`/quotes/${q.id}/pdf`).set(as('SALES')).expect(200);
  });

  it('a request goes to the chosen administrator as a task; only that administrator answers and approving applies it', async () => {
    const approvers = (await http().get('/sales/discount-approvers').set(as('SALES')).expect(200)).body as { id: string }[];
    expect(approvers.map((a) => a.id)).toEqual(expect.arrayContaining([U.ADMIN, U.ADMIN2]));
    expect(approvers.map((a) => a.id)).not.toContain(U.SALES);

    const q = await newQuote();
    const asked = (await ask(q.id, '5').expect(200)).body as QuoteBody;
    expect(Number(asked.globalDiscountPercent)).toBe(0);
    expect(asked.discountRequests[0]).toMatchObject({ status: 'PENDING' });
    const projected = asked.discountRequests[0].projected!.total;
    // The same request again (double click): nothing new; another one: refused.
    await ask(q.id, '5').expect(200);
    expect((await ask(q.id, '6').expect(409)).body.message).toMatch(/pendiente/);
    const requestId = await pendingOf(q.id);
    expect(await prisma.quoteDiscountRequest.count({ where: { quoteId: q.id } })).toBe(1);

    // Task of the chosen administrator (and a push notice queued for them).
    const tasks = (await http().get('/tasks?status=pending').set(as('ADMIN')).expect(200)).body.items as { id: string; kind: string; discountRequest: { quote: { number: string } } | null }[];
    const task = tasks.find((t) => t.discountRequest?.quote.number === q.number);
    expect(task?.kind).toBe('DISCOUNT_APPROVAL');
    expect(await prisma.notificationOutbox.count({ where: { userId: U.ADMIN, kind: 'discount-requested', dedupeKey: { contains: requestId } } })).toBe(1);
    // It is answered from the quote, not marked done by hand.
    await http().patch(`/tasks/${task!.id}/complete`).set(as('ADMIN')).expect(409);

    // While pending: no conversion, and the seller still cannot apply 5 %.
    expect((await convert(q.id).expect(409)).body.message).toMatch(/pendiente/);
    await save(q.id, '5').expect(403);
    // Only the chosen administrator answers.
    expect((await answer(q.id, requestId, 'approve', 'ADMIN2').expect(403)).body.message).toMatch(/elegido/);
    await answer(q.id, requestId, 'approve', 'SALES').expect(403);

    const approved = (await answer(q.id, requestId, 'approve').expect(200)).body as QuoteBody;
    expect(Number(approved.globalDiscountPercent)).toBe(5);
    expect(approved.total).toBe(projected);
    expectConsistent(approved);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task!.id } })).completedAt).not.toBeNull();
    expect(await prisma.notificationOutbox.count({ where: { userId: U.SALES, kind: 'discount-resolved', dedupeKey: { contains: requestId } } })).toBe(1);
    // Repeated approval: same answer, applied once; a later rejection: refused.
    await answer(q.id, requestId, 'approve').expect(200);
    expect(await prisma.auditEvent.count({ where: { entityId: q.id, action: 'DISCOUNT_APPROVED' } })).toBe(1);
    await answer(q.id, requestId, 'reject').expect(409);

    // Up to the approved percentage the seller may now edit the quote.
    expect(Number((await get(q.id)).globalDiscountLimit)).toBe(5);
    await save(q.id, '4').expect(200);
    await save(q.id, '5').expect(200);
    await save(q.id, '6').expect(403);
    await ask(q.id, '5').expect(400);
    const order = (await convert(q.id).expect(200)).body as QuoteBody;
    expect(Number(order.globalDiscountPercent)).toBe(5);
  });

  it('rejection and withdrawal keep the quote as it was', async () => {
    const q = await newQuote();
    await ask(q.id, '8', 'ADMIN2').expect(200);
    const rejectedId = await pendingOf(q.id);
    const rejected = (await answer(q.id, rejectedId, 'reject', 'ADMIN2', { resolution: 'Margen insuficiente' }).expect(200)).body as QuoteBody;
    expect(Number(rejected.globalDiscountPercent)).toBe(0);
    expect(rejected.discountRequests[0]).toMatchObject({ status: 'REJECTED', resolution: 'Margen insuficiente' });
    expect((await prisma.task.findUniqueOrThrow({ where: { discountRequestId: rejectedId } })).completedAt).not.toBeNull();
    await save(q.id, '8').expect(403);

    // The seller withdraws a new request: its task leaves the pending list.
    await ask(q.id, '7').expect(200);
    const withdrawnId = await pendingOf(q.id);
    await answer(q.id, withdrawnId, 'cancel', 'SALES').expect(200);
    await answer(q.id, withdrawnId, 'cancel', 'SALES').expect(200);
    const withdrawnTask = await prisma.task.findUniqueOrThrow({ where: { discountRequestId: withdrawnId } });
    expect(withdrawnTask.cancelledAt).not.toBeNull();
    const pending = (await http().get('/tasks?status=pending').set(as('ADMIN')).expect(200)).body.items as { id: string }[];
    expect(pending.map((t) => t.id)).not.toContain(withdrawnTask.id);
    await answer(q.id, withdrawnId, 'approve').expect(409);

    // Cancelling the quote withdraws its open request too.
    await ask(q.id, '7').expect(200);
    const openId = await pendingOf(q.id);
    await http().post(`/quotes/${q.id}/cancel`).set(as('SALES')).expect(200);
    expect((await prisma.quoteDiscountRequest.findUniqueOrThrow({ where: { id: openId } })).status).toBe('CANCELLED');
    expect((await prisma.task.findUniqueOrThrow({ where: { discountRequestId: openId } })).cancelledAt).not.toBeNull();
  });

  it('refuses requests within the seller limit, to non-administrators, from ADMIN or on another seller’s quote', async () => {
    const q = await newQuote();
    expect((await ask(q.id, '3').expect(400)).body.message).toMatch(/tú mismo/);
    await ask(q.id, '101').expect(400);
    expect((await ask(q.id, '5', 'WAREHOUSE').expect(400)).body.message).toMatch(/administrador activo/);
    await ask(q.id, '5', 'SALES').expect(400);
    await ask(q.id, '5', 'ADMIN', 'ADMIN2').expect(400);
    await ask(q.id, '5', 'ADMIN', 'SALES2').expect(404);
    await http().post(`/quotes/${q.id}/discount-requests`).set(as('SALES')).send({ percent: '5' }).expect(400);
    expect(await prisma.quoteDiscountRequest.count({ where: { quoteId: q.id } })).toBe(0);
    // Another seller cannot see or withdraw it either.
    await ask(q.id, '5').expect(200);
    await answer(q.id, await pendingOf(q.id), 'cancel', 'SALES2').expect(404);
  });

  // --- Races ---------------------------------------------------------------------

  it('approval racing withdrawal: exactly one wins and the quote matches it', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await newQuote();
      await ask(q.id, '5').expect(200);
      const requestId = await pendingOf(q.id);
      const [approve, cancel] = await together([() => answer(q.id, requestId, 'approve'), () => answer(q.id, requestId, 'cancel', 'SALES')]);
      const stored = await prisma.quoteDiscountRequest.findUniqueOrThrow({ where: { id: requestId }, include: { task: true } });
      const quote = await get(q.id);
      expectConsistent(quote);
      outcomes.add(`${approve.status}/${cancel.status}:${stored.status}:${Number(quote.globalDiscountPercent)}:${stored.task?.completedAt ? 'done' : ''}${stored.task?.cancelledAt ? 'cancelled' : ''}`);
    }
    for (const outcome of outcomes) expect(['200/409:APPROVED:5:done', '409/200:CANCELLED:0:cancelled']).toContain(outcome);
  });

  it('two different requests at once: one is kept, with one task', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await newQuote();
      const results = await together([() => ask(q.id, '5', 'ADMIN'), () => ask(q.id, '6', 'ADMIN2')]);
      expect(statuses(results)).toBe('200/409');
      expect(await prisma.quoteDiscountRequest.count({ where: { quoteId: q.id, status: 'PENDING' } })).toBe(1);
      expect(await prisma.task.count({ where: { discountRequest: { quoteId: q.id } } })).toBe(1);
    }
  });

  it('approval racing an edit of the seller: totals always match the stored lines', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await newQuote();
      await ask(q.id, '5').expect(200);
      const requestId = await pendingOf(q.id);
      const [approve, edit] = await together([() => answer(q.id, requestId, 'approve'), () => save(q.id, '2')]);
      const quote = await get(q.id);
      expectConsistent(quote);
      outcomes.add(`${approve.status}/${edit.status}:${Number(quote.globalDiscountPercent)}`);
    }
    // Edit first → approval applies 5 %; approval first → the edit sets 2 %.
    for (const outcome of outcomes) expect(['200/200:5', '200/200:2']).toContain(outcome);
  });

  it('approval racing the conversion: the order never misses the decided discount', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await newQuote();
      await ask(q.id, '5').expect(200);
      const requestId = await pendingOf(q.id);
      const [approve, converted] = await together([() => answer(q.id, requestId, 'approve'), () => convert(q.id)]);
      const order = await prisma.salesOrder.findUnique({ where: { quoteId: q.id } });
      outcomes.add(`${approve.status}/${converted.status}:${order ? Number(order.globalDiscountPercent) : 'none'}`);
    }
    for (const outcome of outcomes) expect(['200/200:5', '200/409:none']).toContain(outcome);
  });
});
