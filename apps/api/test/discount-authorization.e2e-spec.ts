import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { Decimal } from '../src/shared/money.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Discounts above the seller's 3 % need an administrator, and the
// authorisation covers only what was authorised (QA finding SEC-01 of
// 27/11/2026): a proposal not authorised, a rejected request or older data
// never let a seller issue an order with that discount.
interface Line {
  id: string;
  lineNo: number;
  quantity: number;
  discountPercent: string;
  discountApprovedById: string | null;
  discountApprovedBy: { id: string; name: string } | null;
}
interface QuoteBody {
  id: string;
  subtotal: string;
  discountTotal: string;
  globalDiscountPercent: string;
  globalDiscountLimit: string;
  globalDiscountApprovedPercent: string | null;
  globalDiscountApprovedBase: string | null;
  globalDiscountApprovedById: string | null;
  globalDiscountApprovedBy: { id: string; name: string } | null;
  lines: Line[];
}

describe('Authorisation of discounts above the seller limit (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', finish: '', supplier: '', customer: '' };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  // Own client IP per request: the global rate limit never mixes in.
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.94.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const line = (extra: Record<string, unknown> = {}) => ({ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 10, discountPercent: '0', taxRatePercent: '19', ...extra });
  const body = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({ customerId: ids.customer, paymentMethod: 'CASH', lines, ...extra });
  const manual = { manualUnitPrice: '5000', priceReason: 'Precio especial acordado con el cliente frecuente' };
  const create = (who: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => http().post('/quotes').set(as(who)).send(body(lines, extra));
  const save = (id: string, who: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => http().patch(`/quotes/${id}`).set(as(who)).send(body(lines, extra));
  const convert = (id: string, who = 'SALES') => http().post(`/quotes/${id}/convert`).set(as(who)).send({ operationKey: randomUUID() });
  // A quote of the seller made by an administrator (as when ADMIN edits it).
  const sellersQuoteByAdmin = async (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => {
    const q = (await create('ADMIN', lines, extra).expect(201)).body as QuoteBody;
    await prisma.quote.update({ where: { id: q.id }, data: { createdById: U.SALES } });
    return q;
  };
  const orderOf = (quoteId: string) => prisma.salesOrder.findUniqueOrThrow({ where: { quoteId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
  const actions = async (quoteId: string) => (await prisma.auditEvent.findMany({ where: { entityId: quoteId }, select: { action: true } })).map((a) => a.action);

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role] of [
      ['ADMIN', 'ADMIN'],
      ['SALES', 'SALES'],
    ] as const) {
      const user = await createTestUser(app, role, `DAUTH${S}`);
      H[key] = user.headers;
      U[key] = user.id;
    }
    ids.ref = (await prisma.reference.create({ data: { code: `DAUTH-REF-${S}` } })).id;
    ids.finish = (await prisma.finish.create({ data: { code: `DAUTH-F-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `DAUTH-${S}`, name: 'Proveedor autorizaciones', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente autorizaciones ${S}`, createdById: U.SALES } })).id;
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `DAUTH-${S}`,
        documentDate: '2026-10-20',
        lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 7, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' }],
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
      const orders = (await prisma.salesOrder.findMany({ where: { createdById: { in: users } }, select: { id: true } })).map((o) => o.id);
      await prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } });
      await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } });
      await prisma.quoteDiscountRequest.deleteMany({ where: { quoteId: { in: quotes } } });
      await prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orders } } });
      await prisma.salesOrderPayment.deleteMany({ where: { salesOrderId: { in: orders } } });
      await prisma.salesOrder.deleteMany({ where: { id: { in: orders } } });
      await prisma.quote.deleteMany({ where: { id: { in: quotes } } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.salePrice.deleteMany({ where: { referenceId: ids.ref } });
      await prisma.purchase.deleteMany({ where: { createdById: { in: users } } });
      await prisma.supplier.deleteMany({ where: { id: ids.supplier } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.loginEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.reference.deleteMany({ where: { id: ids.ref } });
      await prisma.finish.deleteMany({ where: { id: ids.finish } });
    }
    await app?.close();
  });

  it('a manual price nobody authorised does not authorise its discount on the enabled price', async () => {
    const q = (await create('SALES', [line({ ...manual, discountPercent: '50' })]).expect(201)).body as QuoteBody;
    expect((await convert(q.id).expect(409)).body.message).toMatch(/precios manuales sin autorizar/);
    // The audit case: same line with the enabled price and the same 50 %.
    expect((await save(q.id, 'SALES', [line({ discountPercent: '50' })]).expect(400)).body.message).toMatch(/hasta 3 % de descuento por renglón/);
    await convert(q.id).expect(409);
    expect(await prisma.salesOrder.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it('a rejected request authorises nothing', async () => {
    const q = (await create('SALES', [line({ ...manual, discountPercent: '40' })]).expect(201)).body as QuoteBody;
    await http().post(`/quotes/${q.id}/price-requests`).set(as('SALES')).send({ approverId: U.ADMIN, reason: 'Cliente frecuente' }).expect(200);
    const pending = await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId: q.id, status: 'PENDING' } });
    await http().post(`/quotes/${q.id}/price-requests/${pending.id}/reject`).set(as('ADMIN')).send({ resolution: 'No se autoriza' }).expect(200);
    await save(q.id, 'SALES', [line({ discountPercent: '40' })]).expect(400);
    await convert(q.id).expect(409);
    expect(await prisma.salesOrder.count({ where: { quoteId: q.id } })).toBe(0);
  });

  it('an administrator discount: the seller keeps it for the same material and discount with no more profiles; the order records it', async () => {
    const q = await sellersQuoteByAdmin([line({ discountPercent: '10' })]);
    expect(q.lines[0]).toMatchObject({ discountPercent: '10', discountApprovedById: U.ADMIN, discountApprovedBy: { id: U.ADMIN } });
    expect(await actions(q.id)).toContain('LINE_DISCOUNT_AUTHORISED');
    // Kept (other changes, same line): who authorised it stays.
    const kept = (await save(q.id, 'SALES', [line({ discountPercent: '10' })], { notes: 'Entrega en obra' }).expect(200)).body as QuoteBody;
    expect(kept.lines[0].discountApprovedById).toBe(U.ADMIN);
    // More profiles, another material or a second line with it: refused.
    expect((await save(q.id, 'SALES', [line({ discountPercent: '10', quantity: 1000 })]).expect(400)).body.message).toMatch(/para hasta 10 perfiles/);
    await save(q.id, 'SALES', [line({ discountPercent: '10', origin: 'CHINA' })]).expect(400);
    expect((await save(q.id, 'SALES', [line({ discountPercent: '10' }), line({ discountPercent: '10' })]).expect(400)).body.message).toMatch(/^Renglón 2/);
    // A higher discount on it is the seller's limit again.
    await save(q.id, 'SALES', [line({ discountPercent: '12' })]).expect(400);
    // Fewer profiles keep it; the seller converts and the order records it.
    const fewer = (await save(q.id, 'SALES', [line({ discountPercent: '10', quantity: 8 })]).expect(200)).body as QuoteBody;
    expect(fewer.lines[0].discountApprovedById).toBe(U.ADMIN);
    const order = (await convert(q.id).expect(200)).body as { lines: { discountApprovedBy: { id: string } | null }[] };
    expect(order.lines[0].discountApprovedBy?.id).toBe(U.ADMIN);
    expect((await orderOf(q.id)).lines[0]).toMatchObject({ discountApprovedById: U.ADMIN });
  });

  it('older discounts nobody authorised: the seller can neither keep nor convert them; an administrator converting authorises them', async () => {
    const q = (await create('SALES', [line({ discountPercent: '3' })]).expect(201)).body as QuoteBody;
    await prisma.quoteLine.update({ where: { id: q.lines[0].id }, data: { discountPercent: '10' } });
    await save(q.id, 'SALES', [line({ discountPercent: '10' })]).expect(400);
    expect((await convert(q.id).expect(409)).body.message).toMatch(/El renglón 1 tiene más de 3 % de descuento sin autorización/);
    await convert(q.id, 'ADMIN').expect(200);
    expect((await orderOf(q.id)).lines[0]).toMatchObject({ discountApprovedById: U.ADMIN });
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { entityId: q.id, action: 'LINE_DISCOUNT_AUTHORISED' } });
    expect(event).toMatchObject({ userId: U.ADMIN, reason: 'Autorizado al convertir la cotización en orden' });
  });

  it('global discount: an approval covers its percentage at the base approved, not a larger one', async () => {
    const q = (await create('SALES', [line()]).expect(201)).body as QuoteBody;
    await http().post(`/quotes/${q.id}/discount-requests`).set(as('SALES')).send({ percent: '5', approverId: U.ADMIN, reason: 'Cliente frecuente' }).expect(200);
    const pending = await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId: q.id, status: 'PENDING' } });
    const approved = (await http().post(`/quotes/${q.id}/discount-requests/${pending.id}/approve`).set(as('ADMIN')).send({}).expect(200)).body as QuoteBody;
    const base = new Decimal(approved.subtotal).minus(approved.discountTotal);
    expect(approved).toMatchObject({ globalDiscountPercent: '5', globalDiscountApprovedPercent: '5', globalDiscountApprovedById: U.ADMIN, globalDiscountApprovedBy: { id: U.ADMIN } });
    expect(new Decimal(approved.globalDiscountApprovedBase!).equals(base)).toBe(true);
    expect((await http().get(`/quotes/${q.id}`).set(as('SALES')).expect(200)).body.globalDiscountLimit).toBe('5');
    // More profiles (a larger base) with the same 5 %: refused, it says why.
    const refused = await save(q.id, 'SALES', [line({ quantity: 20 })], { globalDiscountPercent: '5' }).expect(403);
    expect(refused.body.message).toMatch(/autorizó 5 % de descuento global para un valor de materiales de hasta/);
    // With 3 % it saves; the 5 % no longer applies at that base.
    const larger = (await save(q.id, 'SALES', [line({ quantity: 20 })], { globalDiscountPercent: '3' }).expect(200)).body as QuoteBody;
    expect(larger.globalDiscountLimit).toBe('3');
    // A smaller base keeps the 5 %; the order records who authorised it.
    await save(q.id, 'SALES', [line({ quantity: 8 })], { globalDiscountPercent: '5' }).expect(200);
    await save(q.id, 'SALES', [line({ quantity: 8 })], { globalDiscountPercent: '5.5' }).expect(403);
    await convert(q.id).expect(200);
    expect(await orderOf(q.id)).toMatchObject({ globalDiscountApprovedById: U.ADMIN });
  });

  it('global discount saved by an administrator is authorised by it; older ones nobody authorised need an administrator to convert', async () => {
    const byAdmin = await sellersQuoteByAdmin([line()], { globalDiscountPercent: '12' });
    expect(byAdmin).toMatchObject({ globalDiscountApprovedPercent: '12', globalDiscountApprovedById: U.ADMIN });
    expect(await actions(byAdmin.id)).toContain('GLOBAL_DISCOUNT_AUTHORISED');
    await convert(byAdmin.id).expect(200);
    expect(await orderOf(byAdmin.id)).toMatchObject({ globalDiscountApprovedById: U.ADMIN });

    const older = (await create('SALES', [line()], { globalDiscountPercent: '3' }).expect(201)).body as QuoteBody;
    await prisma.quote.update({ where: { id: older.id }, data: { globalDiscountPercent: '8' } });
    expect((await convert(older.id).expect(409)).body.message).toMatch(/El descuento global de 8 % no está autorizado/);
    await convert(older.id, 'ADMIN').expect(200);
    expect(await orderOf(older.id)).toMatchObject({ globalDiscountApprovedById: U.ADMIN });
    // Up to 3 % the order needs no authorisation (and records none).
    const plain = (await create('SALES', [line({ discountPercent: '3' })], { globalDiscountPercent: '3' }).expect(201)).body as QuoteBody;
    await convert(plain.id).expect(200);
    expect(await orderOf(plain.id)).toMatchObject({ globalDiscountApprovedById: null });
    expect((await orderOf(plain.id)).lines[0]).toMatchObject({ discountApprovedById: null });
  });

  // QA SEC-02: when an administrator approves manual prices and the base
  // grows, the new base is authorised only with the percentage applied (what
  // that administrator saw), never with a higher one approved before.
  const withManual = (unitPrice: string) => [line({ quantity: 10 }), line({ quantity: 1, manualUnitPrice: unitPrice, priceReason: 'Precio especial acordado con el cliente' })];
  const globalThenManual = async (applied: string) => {
    const q = (await create('SALES', withManual('5000')).expect(201)).body as QuoteBody;
    await http().post(`/quotes/${q.id}/price-requests`).set(as('SALES')).send({ approverId: U.ADMIN }).expect(200);
    await http().post(`/quotes/${q.id}/discount-requests`).set(as('SALES')).send({ percent: '10', approverId: U.ADMIN }).expect(200);
    const global = await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId: q.id, kind: 'GLOBAL_DISCOUNT', status: 'PENDING' } });
    const approved = (await http().post(`/quotes/${q.id}/discount-requests/${global.id}/approve`).set(as('ADMIN')).send({}).expect(200)).body as QuoteBody;
    if (applied !== '10') await save(q.id, 'SALES', withManual('5000'), { globalDiscountPercent: applied }).expect(200);
    const price = await prisma.quoteDiscountRequest.findFirstOrThrow({ where: { quoteId: q.id, kind: 'MANUAL_PRICE', status: 'PENDING' } });
    // The administrator corrects the manual price upwards: the base grows.
    const after = (await http().post(`/quotes/${q.id}/price-requests/${price.id}/approve`).set(as('ADMIN')).send({ lines: [{ lineNo: 2, unitPrice: '500000' }] }).expect(200))
      .body as QuoteBody;
    return { q, approved, after };
  };

  it('SEC-02: a larger base is authorised with the percentage applied, not with a higher one approved before', async () => {
    const { q, approved, after } = await globalThenManual('5');
    const base = new Decimal(after.subtotal).minus(after.discountTotal);
    expect(base.greaterThan(approved.globalDiscountApprovedBase!)).toBe(true);
    // Percentage and base move together, by the administrator who approved the prices.
    expect(after).toMatchObject({ globalDiscountPercent: '5', globalDiscountApprovedPercent: '5', globalDiscountApprovedById: U.ADMIN });
    expect(new Decimal(after.globalDiscountApprovedBase!).equals(base)).toBe(true);
    // The audit trail says the same as the control.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { entityId: q.id, action: 'GLOBAL_DISCOUNT_AUTHORISED', reason: { contains: 'precios manuales' } },
    });
    expect(event.data).toMatchObject({ percent: '5', base: base.toFixed(2), previousPercent: '10' });
    // The old 10 % no longer applies: refused at the new base, and at the old one too.
    expect((await save(q.id, 'SALES', withManual('500000'), { globalDiscountPercent: '10' }).expect(403)).body.message).toMatch(/Puedes aplicar hasta 5 %/);
    // The 5 % authorised converts, and the order carries exactly it.
    await save(q.id, 'SALES', withManual('500000'), { globalDiscountPercent: '5' }).expect(200);
    await convert(q.id).expect(200);
    expect(await orderOf(q.id)).toMatchObject({ globalDiscountApprovedById: U.ADMIN });
    expect((await orderOf(q.id)).globalDiscountPercent.toString()).toBe('5');
  });

  it('SEC-02: the percentage approved and applied follows a larger base the administrator set, up to the order', async () => {
    const { q, after } = await globalThenManual('10');
    const base = new Decimal(after.subtotal).minus(after.discountTotal);
    expect(after).toMatchObject({ globalDiscountPercent: '10', globalDiscountApprovedPercent: '10', globalDiscountApprovedById: U.ADMIN });
    expect(new Decimal(after.globalDiscountApprovedBase!).equals(base)).toBe(true);
    await convert(q.id).expect(200);
    const order = await orderOf(q.id);
    expect(order.globalDiscountPercent.toString()).toBe('10');
    expect(order.globalDiscountApprovedById).toBe(U.ADMIN);
  });

  it('the database refuses inserting an order with a discount nobody authorised', async () => {
    const q = (await create('SALES', [line()]).expect(201)).body as QuoteBody;
    await convert(q.id).expect(200);
    const order = await orderOf(q.id);
    const { id: _id, salesOrderId: _order, discountApprovedById: _by, discountApprovedAt: _at, ...copy } = order.lines[0];
    await expect(prisma.salesOrderLine.create({ data: { ...copy, salesOrderId: order.id, lineNo: 2, discountPercent: '10' } })).rejects.toThrow(/no tiene autorización/);
    await prisma.salesOrderLine.create({ data: { ...copy, salesOrderId: order.id, lineNo: 2, discountPercent: '3' } });
    await expect(
      prisma.salesOrder.create({
        data: {
          number: `DAUTH-${S}`,
          customerId: ids.customer,
          customerName: 'Cliente autorizaciones',
          subtotal: '100',
          discountTotal: '0',
          globalDiscountPercent: '8',
          globalDiscountAmount: '8',
          taxTotal: '0',
          total: '92',
          convertOperationKey: randomUUID(),
          createdById: U.SALES,
        },
      }),
    ).rejects.toThrow(/no tiene autorización/);
    // Orders made before are still updated as usual (the check is on insert).
    await prisma.salesOrderLine.updateMany({ where: { salesOrderId: order.id, lineNo: 2 }, data: { discountPercent: '10' } });
  });
});
