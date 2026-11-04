import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { Decimal } from '../src/shared/money.js';
import { barrierAtTransactionStart, createBarrier } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Manual prices on quote lines: always available (with or without an enabled
// price or stock), explained, and authorised by the administrator the seller
// chooses, who may correct them. Until then the quote is neither printable
// for the customer nor convertible. Every step leaves an audit record. Races
// repeat with fresh data on the real PostgreSQL test database.
const ROUNDS = 10;

interface Line {
  lineNo: number;
  manualPrice: boolean;
  unitPrice: string;
  lineTotal: string;
  priceReason: string | null;
  manualApprovedById: string | null;
  manualApprovedBy: { id: string; name: string } | null;
  pricingMethod?: string;
  costBasis?: string | null;
}
interface QuoteBody {
  id: string;
  number: string;
  total: string;
  subtotal: string;
  discountTotal: string;
  globalDiscountAmount: string;
  taxTotal: string;
  lines: Line[];
  discountRequests: { id: string; kind: string; status: string; replacedById: string | null; resolution: string | null }[];
}

describe('Manual prices of quotes and their authorisation (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', finishPriced: '', finishNew: '', supplier: '', customer: '' };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.53.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
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

  const REASON = 'No hay en bodega; Aluminios Vecino lo deja a 9.000, vendemos a 12.000 y ganamos 25 %';
  // Line 1: enabled price; line 2: manual price on a colour with no price (and no stock).
  const body = (manual: { price?: string; quantity?: number; reason?: string; cost?: string } = {}, extra: object = {}) => ({
    customerId: ids.customer,
    paymentMethod: 'CASH',
    lines: [
      { referenceId: ids.ref, finishId: ids.finishPriced, origin: 'NATIONAL', quantity: 4, discountPercent: '0', taxRatePercent: '19' },
      {
        referenceId: ids.ref,
        finishId: ids.finishNew,
        origin: 'NATIONAL',
        quantity: manual.quantity ?? 10,
        discountPercent: '0',
        taxRatePercent: '19',
        manualUnitPrice: manual.price ?? '12000',
        priceReason: manual.reason ?? REASON,
        ...(manual.cost === undefined ? { estimatedUnitCost: '9000' } : manual.cost ? { estimatedUnitCost: manual.cost } : {}),
      },
    ],
    ...extra,
  });
  const create = async (who = 'SALES', manual = {}) => (await http().post('/quotes').set(as(who)).send(body(manual)).expect(201)).body as QuoteBody;
  const save = (id: string, manual = {}, extra: object = {}, who = 'SALES') => http().patch(`/quotes/${id}`).set(as(who)).send(body(manual, extra));
  const get = async (id: string, who = 'SALES') => (await http().get(`/quotes/${id}`).set(as(who)).expect(200)).body as QuoteBody;
  const ask = (id: string, approver = 'ADMIN', extra: object = {}) =>
    http().post(`/quotes/${id}/price-requests`).set(as('SALES')).send({ approverId: U[approver], ...extra });
  const answer = (id: string, requestId: string, action: 'approve' | 'reject' | 'cancel', who = 'ADMIN', send: object = {}) =>
    http().post(`/quotes/${id}/price-requests/${requestId}/${action}`).set(as(who)).send(send);
  const pendingOf = async (quoteId: string) => (await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId, kind: 'MANUAL_PRICE', status: 'PENDING' } })).id;
  const convert = (id: string) => http().post(`/quotes/${id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() });
  const auditCount = (quoteId: string, action: string) => prisma.auditEvent.count({ where: { entityId: quoteId, action } });

  const expectConsistent = (q: QuoteBody) => {
    const d = (value: string) => new Decimal(value);
    expect(d(q.subtotal).minus(q.discountTotal).minus(q.globalDiscountAmount).plus(q.taxTotal).equals(q.total)).toBe(true);
    expect(q.lines.reduce((total, line) => total.plus(line.lineTotal), d('0')).equals(q.total)).toBe(true);
  };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role, suffix] of [
      ['ADMIN', 'ADMIN', `MP${S}A`],
      ['ADMIN2', 'ADMIN', `MP${S}B`],
      ['SALES', 'SALES', `MP${S}A`],
      ['SALES2', 'SALES', `MP${S}B`],
    ] as const) {
      const user = await createTestUser(app, role, suffix);
      H[key] = user.headers;
      U[key] = user.id;
    }
    ids.ref = (await prisma.reference.create({ data: { code: `QMAN-REF-${S}` } })).id;
    ids.finishPriced = (await prisma.finish.create({ data: { code: `QMAN-A-${S}` } })).id;
    ids.finishNew = (await prisma.finish.create({ data: { code: `QMAN-B-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `QMAN-${S}`, name: 'Proveedor precio manual', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente precio manual ${S}`, createdById: U.SALES } })).id;
    // Enabled price only for the first colour.
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `QMAN-${S}`,
        documentDate: '2026-11-03',
        lines: [{ referenceId: ids.ref, finishId: ids.finishPriced, origin: 'NATIONAL', quantity: 7, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' }],
      })
      .expect(201);
    const confirmed = await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200);
    await http().post('/sale-prices').set(as('ADMIN')).send({ purchaseId: purchase.body.id, purchaseLineId: confirmed.body.lines[0].id, markupPercent: '30', enabled: true }).expect(201);
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      const users = Object.values(U);
      const quotes = (await prisma.quote.findMany({ where: { createdById: { in: users } }, select: { id: true } })).map((q) => q.id);
      const orders = (await prisma.salesOrder.findMany({ where: { quoteId: { in: quotes } }, select: { id: true } })).map((o) => o.id);
      await prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } });
      await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } });
      await prisma.quoteDiscountRequest.updateMany({ where: { quoteId: { in: quotes } }, data: { replacedById: null } });
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
      await prisma.finish.deleteMany({ where: { id: { in: [ids.finishPriced, ids.finishNew] } } });
    }
    await app?.close();
  });

  it('sales only quotes existing references; only ADMIN creates them', async () => {
    await http().post('/catalog/references').set(as('SALES')).send({ code: `QMAN-NEW-${S}` }).expect(403);
    const missing = { ...body(), lines: [{ ...body().lines[1], referenceId: 'no-existe' }] };
    expect((await http().post('/quotes').set(as('SALES')).send(missing).expect(400)).body.message).toMatch(/referencia no existe/);
  });

  it('a manual price is always possible, but explained and with valid values', async () => {
    // Also on a colour with an enabled price.
    const onPriced = { ...body(), lines: [{ ...body().lines[0], manualUnitPrice: '15000', priceReason: REASON }] };
    expect(((await http().post('/quotes').set(as('SALES')).send(onPriced).expect(201)).body as QuoteBody).lines[0].manualPrice).toBe(true);
    await http().post('/quotes').set(as('SALES')).send(body({ reason: 'corto' })).expect(400);
    await http().post('/quotes').set(as('SALES')).send(body({ price: '0' })).expect(400);
    await http().post('/quotes').set(as('SALES')).send(body({ price: '12000.555' })).expect(400);
    await http().post('/quotes').set(as('SALES')).send(body({ cost: '0' })).expect(400);
    const reasonOnly = { ...body(), lines: [{ ...body().lines[0], priceReason: REASON }] };
    await http().post('/quotes').set(as('SALES')).send(reasonOnly).expect(400);
    // Without a manual price, a colour with no enabled price is refused.
    const noPrice = { ...body(), lines: [{ ...body().lines[0], finishId: ids.finishNew }] };
    expect((await http().post('/quotes').set(as('SALES')).send(noPrice).expect(400)).body.message).toMatch(/Usa precio manual/);
  });

  it('until authorised: no PDF for the customer, no conversion; the seller keeps its own reason, not the costs', async () => {
    const q = await create();
    const manual = q.lines[1];
    expect(manual).toMatchObject({ manualPrice: true, unitPrice: '12000', manualApprovedById: null, priceReason: REASON });
    expect(manual.pricingMethod).toBeUndefined();
    expect(manual.costBasis).toBeUndefined();
    expectConsistent(q);
    expect((await http().get(`/quotes/${q.id}/pdf`).set(as('SALES')).expect(409)).body.message).toMatch(/sin autorizar/);
    expect((await convert(q.id).expect(409)).body.message).toMatch(/sin autorizar/);
  });

  it('the chosen administrator gets a task, may correct the price, and approval enables PDF and conversion', async () => {
    const q = await create();
    const asked = (await ask(q.id, 'ADMIN', { reason: 'Cliente especial' }).expect(200)).body as QuoteBody;
    expect(asked.discountRequests[0]).toMatchObject({ kind: 'MANUAL_PRICE', status: 'PENDING' });
    const requestId = await pendingOf(q.id);
    // Same request again: nothing new.
    await ask(q.id).expect(200);
    expect(await prisma.quoteDiscountRequest.count({ where: { quoteId: q.id } })).toBe(1);
    const task = await prisma.task.findUniqueOrThrow({ where: { discountRequestId: requestId } });
    expect(task).toMatchObject({ assigneeId: U.ADMIN, kind: 'DISCOUNT_APPROVAL' });
    expect(task.title).toMatch(/precio manual/);
    expect(await prisma.notificationOutbox.count({ where: { userId: U.ADMIN, kind: 'price-requested', dedupeKey: { contains: requestId } } })).toBe(1);
    // Audit: the full request (proposed price, enabled price, cost, reason).
    const requested = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'MANUAL_PRICE_REQUESTED' } });
    expect(requested.data).toMatchObject({ approverId: U.ADMIN, lines: [{ lineNo: 2, proposedUnitPrice: '12000.00', enabledUnitPrice: null, estimatedUnitCost: '9000', priceReason: REASON }] });
    // While pending: no conversion.
    expect((await convert(q.id).expect(409)).body.message).toMatch(/en solicitud/);

    await answer(q.id, requestId, 'approve', 'ADMIN2').expect(403);
    await answer(q.id, requestId, 'approve', 'SALES').expect(403);
    await answer(q.id, requestId, 'approve', 'ADMIN', { lines: [{ lineNo: 1, unitPrice: '1' }] }).expect(400);
    const approved = (await answer(q.id, requestId, 'approve', 'ADMIN', { lines: [{ lineNo: 2, unitPrice: '12500' }] }).expect(200)).body as QuoteBody;
    expect(approved.lines[1]).toMatchObject({ unitPrice: '12500', manualApprovedById: U.ADMIN });
    expectConsistent(approved);
    expect(Number(approved.total)).toBeGreaterThan(Number(q.total));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).not.toBeNull();
    expect(await prisma.notificationOutbox.count({ where: { userId: U.SALES, kind: 'price-resolved' } })).toBeGreaterThan(0);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'MANUAL_PRICE_APPROVED' } });
    expect(event).toMatchObject({ userId: U.ADMIN, data: { corrected: true, lines: [{ lineNo: 2, proposedUnitPrice: '12000.00', approvedUnitPrice: '12500.00' }] } });
    // Repeated approval: same answer, applied once; a rejection now: refused.
    await answer(q.id, requestId, 'approve').expect(200);
    expect(await auditCount(q.id, 'MANUAL_PRICE_APPROVED')).toBe(1);
    await answer(q.id, requestId, 'reject').expect(409);

    await http().get(`/quotes/${q.id}/pdf`).set(as('SALES')).expect(200);
    const order = (await convert(q.id).expect(200)).body as { id: string; lines: { manualPrice: boolean; priceReason: string | null; manualApprovedById: string | null; unitPrice: string }[] };
    expect(order.lines[1]).toMatchObject({ manualPrice: true, priceReason: REASON, manualApprovedById: U.ADMIN, unitPrice: '12500' });
    expect(order.lines[0]).toMatchObject({ manualPrice: false, priceReason: null });
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'CONVERTED' } })).data).toMatchObject({ manualPrices: [{ lineNo: 2, unitPrice: '12500.00' }] });
  });

  it('editing an authorised manual line loses the authorisation (audited); other edits keep it', async () => {
    const q = await create();
    await ask(q.id).expect(200);
    await answer(q.id, await pendingOf(q.id), 'approve').expect(200);
    // Same manual line, other changes (e.g. notes): still authorised.
    expect(((await save(q.id, {}, { notes: 'Entregar en obra' }).expect(200)).body as QuoteBody).lines[1].manualApprovedById).toBe(U.ADMIN);
    const edited = (await save(q.id, { quantity: 12 }).expect(200)).body as QuoteBody;
    expect(edited.lines[1].manualApprovedById).toBeNull();
    const lost = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'MANUAL_PRICE_APPROVAL_LOST' } });
    expect(lost.data).toMatchObject({ before: [{ lineNo: 2, quantity: 10 }], after: [{ lineNo: 2, quantity: 12 }] });
    await convert(q.id).expect(409);
  });

  it('a pending request is only lost with consent: editing or sending another one replaces it', async () => {
    const q = await create();
    await ask(q.id).expect(200);
    const first = await pendingOf(q.id);
    // Unrelated edit: the request stays.
    await save(q.id, {}, { notes: 'Llamar antes' }).expect(200);
    expect(await pendingOf(q.id)).toBe(first);
    // Changing the manual price without consent: refused, nothing changes.
    expect((await save(q.id, { price: '11000' }).expect(409)).body.message).toMatch(/se pierde su avance/);
    expect((await get(q.id)).lines[1].unitPrice).toBe('12000');
    // With consent: saved, the request and its task are cancelled.
    await save(q.id, { price: '11000' }, { replacePendingPriceRequest: true }).expect(200);
    expect((await prisma.quoteDiscountRequest.findUniqueOrThrow({ where: { id: first } })).status).toBe('CANCELLED');
    expect((await prisma.task.findUniqueOrThrow({ where: { discountRequestId: first } })).cancelledAt).not.toBeNull();
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'MANUAL_PRICE_CANCELLED', reason: { contains: 'desactualizada' } } })).userId).toBe(U.SALES);

    // A new request to another administrator while one is open: needs `replace`.
    await ask(q.id).expect(200);
    const second = await pendingOf(q.id);
    expect((await ask(q.id, 'ADMIN2').expect(409)).body.message).toMatch(/se pierde su avance/);
    await ask(q.id, 'ADMIN2', { replace: true }).expect(200);
    const third = await pendingOf(q.id);
    expect(await prisma.quoteDiscountRequest.findUniqueOrThrow({ where: { id: second } })).toMatchObject({ status: 'CANCELLED', replacedById: third });
    expect((await prisma.task.findUniqueOrThrow({ where: { discountRequestId: second } })).cancelledAt).not.toBeNull();
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'MANUAL_PRICE_REQUESTED', data: { path: ['replaces'], equals: second } } })).userId).toBe(U.SALES);
    await answer(q.id, second, 'approve').expect(409);
    expect(await prisma.quoteDiscountRequest.count({ where: { quoteId: q.id, kind: 'MANUAL_PRICE', status: 'PENDING' } })).toBe(1);
  });

  it('rejection, withdrawal and validations', async () => {
    const q = await create();
    await ask(q.id, 'ADMIN2').expect(200);
    const requestId = await pendingOf(q.id);
    const rejected = (await answer(q.id, requestId, 'reject', 'ADMIN2', { resolution: 'Margen muy bajo' }).expect(200)).body as QuoteBody;
    expect(rejected.discountRequests[0]).toMatchObject({ status: 'REJECTED', resolution: 'Margen muy bajo' });
    expect(rejected.lines[1].manualApprovedById).toBeNull();
    expect(await auditCount(q.id, 'MANUAL_PRICE_REJECTED')).toBe(1);
    await convert(q.id).expect(409);
    // The seller withdraws a new one.
    await ask(q.id).expect(200);
    await answer(q.id, await pendingOf(q.id), 'cancel', 'SALES').expect(200);
    expect(await auditCount(q.id, 'MANUAL_PRICE_CANCELLED')).toBe(1);
    // Validations.
    await http().post(`/quotes/${q.id}/price-requests`).set(as('ADMIN')).send({ approverId: U.ADMIN2 }).expect(400);
    await ask(q.id, 'SALES2').expect(400);
    await http().post(`/quotes/${q.id}/price-requests`).set(as('SALES2')).send({ approverId: U.ADMIN }).expect(404);
    const plain = { ...body(), lines: [body().lines[0]] };
    const noManual = (await http().post('/quotes').set(as('SALES')).send(plain).expect(201)).body as QuoteBody;
    expect((await ask(noManual.id).expect(400)).body.message).toMatch(/no tiene precios manuales/);
    // Cancelling the quote withdraws an open request.
    await ask(q.id).expect(200);
    const open = await pendingOf(q.id);
    await http().post(`/quotes/${q.id}/cancel`).set(as('SALES')).expect(200);
    expect((await prisma.quoteDiscountRequest.findUniqueOrThrow({ where: { id: open } })).status).toBe('CANCELLED');
  });

  it('ADMIN manual prices are authorised on save (audited); old manual lines too', async () => {
    const q = await create('ADMIN');
    expect(q.lines[1]).toMatchObject({ manualPrice: true, manualApprovedById: U.ADMIN });
    expect(await auditCount(q.id, 'MANUAL_PRICE_APPLIED')).toBe(1);
    // A seller's line changed by ADMIN is authorised by that ADMIN.
    const s = await create();
    expect(((await save(s.id, { price: '13000' }, {}, 'ADMIN').expect(200)).body as QuoteBody).lines[1].manualApprovedById).toBe(U.ADMIN);
  });

  it('a global discount request and a manual price request coexist; both must be answered', async () => {
    const q = await create();
    await http().post(`/quotes/${q.id}/discount-requests`).set(as('SALES')).send({ percent: '5', approverId: U.ADMIN }).expect(200);
    await ask(q.id).expect(200);
    await convert(q.id).expect(409);
    const discount = (await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId: q.id, kind: 'GLOBAL_DISCOUNT', status: 'PENDING' } })).id;
    await http().post(`/quotes/${q.id}/discount-requests/${discount}/approve`).set(as('ADMIN')).expect(200);
    await convert(q.id).expect(409);
    const approved = (await answer(q.id, await pendingOf(q.id), 'approve', 'ADMIN', { lines: [{ lineNo: 2, unitPrice: '12345.67' }] }).expect(200)).body as QuoteBody;
    expectConsistent(approved);
    expect(Number(approved.globalDiscountAmount)).toBeGreaterThan(0);
    await convert(q.id).expect(200);
  });

  // --- Races ---------------------------------------------------------------------

  it('approval racing an edit with consent: a line is never authorised at a price nobody approved', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await create();
      await ask(q.id).expect(200);
      const requestId = await pendingOf(q.id);
      const [approve, edit] = await together([() => answer(q.id, requestId, 'approve'), () => save(q.id, { price: '11000' }, { replacePendingPriceRequest: true })]);
      const quote = await get(q.id);
      expectConsistent(quote);
      const stored = await prisma.quoteDiscountRequest.findUniqueOrThrow({ where: { id: requestId } });
      outcomes.add(`${approve.status}/${edit.status}:${stored.status}:${quote.lines[1].unitPrice}:${quote.lines[1].manualApprovedById ? 'auth' : 'none'}`);
    }
    // Approval first → the edit loses it; edit first → the request was cancelled.
    for (const outcome of outcomes) expect(['200/200:APPROVED:11000:none', '409/200:CANCELLED:11000:none']).toContain(outcome);
  });

  it('two replacing requests at once: one open request with one open task remains', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await create();
      await ask(q.id).expect(200);
      const results = await together([() => ask(q.id, 'ADMIN', { replace: true, reason: 'a' }), () => ask(q.id, 'ADMIN2', { replace: true })]);
      expect(statuses(results).startsWith('200')).toBe(true);
      expect(await prisma.quoteDiscountRequest.count({ where: { quoteId: q.id, kind: 'MANUAL_PRICE', status: 'PENDING' } })).toBe(1);
      expect(await prisma.task.count({ where: { discountRequest: { quoteId: q.id }, completedAt: null, cancelledAt: null } })).toBe(1);
    }
  });

  it('approval racing the conversion: an order never carries an unauthorised price', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await create();
      await ask(q.id).expect(200);
      const requestId = await pendingOf(q.id);
      const [approve, converted] = await together([() => answer(q.id, requestId, 'approve'), () => convert(q.id)]);
      const order = await prisma.salesOrder.findUnique({ where: { quoteId: q.id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
      outcomes.add(`${approve.status}/${converted.status}:${order ? (order.lines[1].manualApprovedById ? 'auth' : 'NONE') : 'no-order'}`);
    }
    for (const outcome of outcomes) expect(['200/200:auth', '200/409:no-order']).toContain(outcome);
  });
});
