import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { Decimal } from '../src/shared/money.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Who sold what and whether it is paid (commissions): the order list filters
// by seller (owner of the order), creation day and payment state, and the
// seller summary adds it up. ADMIN only for other sellers; SALES keeps
// seeing only its own orders.

interface OrderRow {
  id: string;
  number: string;
  total: string;
  paymentStatus: string | null;
  createdBy?: { id: string; name: string };
  convertedBy?: { id: string; name: string } | null;
}
interface Bucket {
  orders: number;
  base: string;
  total: string;
}
interface SummaryRow {
  seller: { id: string; name: string };
  all: Bucket;
  paid: Bucket;
  pending: Bucket;
  cash: Bucket;
}

describe('Sales by seller and payment state (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', finish: '', supplier: '', customer: '' };
  const orders: Record<string, OrderRow> = {};
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.61.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  // Quote of `seller` converted by `converter` (the seller unless said otherwise).
  const sell = async (seller: string, paymentMethod: string, quantity: number, converter = seller) => {
    const quote = await http()
      .post('/quotes')
      .set(as(seller))
      .send({ customerId: ids.customer, paymentMethod, lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity, discountPercent: '10', taxRatePercent: '19' }] })
      .expect(201);
    return (await http().post(`/quotes/${quote.body.id}/convert`).set(as(converter)).send({ operationKey: randomUUID() }).expect(200)).body as OrderRow;
  };
  const list = async (query: string, who = 'ADMIN') => ((await http().get(`/sales-orders?pageSize=100&${query}`).set(as(who)).expect(200)).body.items as OrderRow[]);
  const summary = async (query: string) => (await http().get(`/sales-orders/summary?${query}`).set(as('ADMIN')).expect(200)).body as SummaryRow[];
  const base = (order: OrderRow & { subtotal?: string; discountTotal?: string; globalDiscountAmount?: string }) =>
    new Decimal(order.subtotal!).minus(order.discountTotal!).minus(order.globalDiscountAmount!);

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role, suffix] of [
      ['ADMIN', 'ADMIN', `SC${S}A`],
      ['SALES', 'SALES', `SC${S}A`],
      ['SALES2', 'SALES', `SC${S}B`],
    ] as const) {
      const user = await createTestUser(app, role, suffix);
      H[key] = user.headers;
      U[key] = user.id;
    }
    ids.ref = (await prisma.reference.create({ data: { code: `SCOM-REF-${S}` } })).id;
    ids.finish = (await prisma.finish.create({ data: { code: `SCOM-A-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `SCOM-${S}`, name: 'Proveedor comisiones', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente comisiones ${S}`, createdById: U.SALES } })).id;
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `SCOM-${S}`,
        documentDate: '2026-11-03',
        lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 7, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' }],
      })
      .expect(201);
    const confirmed = await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200);
    await http().post('/sale-prices').set(as('ADMIN')).send({ purchaseId: purchase.body.id, purchaseLineId: confirmed.body.lines[0].id, markupPercent: '30', enabled: true }).expect(201);

    // SALES: cash, credit (paid later) and an abono converted by ADMIN.
    orders.cash = await sell('SALES', 'CASH', 3);
    orders.credit = await sell('SALES', 'CREDIT', 5);
    orders.byAdmin = await sell('SALES', 'PARTIAL', 2, 'ADMIN');
    await http().patch(`/sales-orders/${orders.credit.id}/payment-status`).set(as('SALES')).send({ status: 'PAID' }).expect(200);
    // SALES2: one pending credit and one cancelled order.
    orders.other = await sell('SALES2', 'CREDIT', 4);
    orders.cancelled = await sell('SALES2', 'TRANSFER', 6);
    await http().post(`/sales-orders/${orders.cancelled.id}/cancel`).set(as('SALES2')).send({ reason: 'Cliente desistió' }).expect(200);
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      const users = Object.values(U);
      const quotes = (await prisma.quote.findMany({ where: { createdById: { in: users } }, select: { id: true } })).map((q) => q.id);
      const orderIds = (await prisma.salesOrder.findMany({ where: { quoteId: { in: quotes } }, select: { id: true } })).map((o) => o.id);
      await prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } });
      await prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
      await prisma.salesOrder.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.quote.deleteMany({ where: { id: { in: quotes } } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.salePrice.deleteMany({ where: { referenceId: ids.ref } });
      await prisma.purchase.deleteMany({ where: { createdById: { in: users } } });
      await prisma.supplier.deleteMany({ where: { id: ids.supplier } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.reference.deleteMany({ where: { id: ids.ref } });
      await prisma.finish.deleteMany({ where: { id: ids.finish } });
    }
    await app?.close();
  });

  it('the seller is the owner of the order, also when someone else converted it', async () => {
    const [row] = await list(`sellerId=${U.SALES}&payment=PENDING`);
    expect(row.id).toBe(orders.byAdmin.id);
    expect(row.createdBy?.id).toBe(U.SALES);
    expect(row.convertedBy?.id).toBe(U.ADMIN);
  });

  it('filters combine: seller, payment state and creation day', async () => {
    const ofSeller = (await list(`sellerId=${U.SALES}`)).map((o) => o.id).sort();
    expect(ofSeller).toEqual([orders.cash.id, orders.credit.id, orders.byAdmin.id].sort());
    expect((await list(`sellerId=${U.SALES}&payment=PAID`)).map((o) => o.id)).toEqual([orders.credit.id]);
    expect((await list(`sellerId=${U.SALES}&payment=NONE`)).map((o) => o.id)).toEqual([orders.cash.id]);
    expect(await list(`sellerId=${U.SALES}&dateFrom=${today}&dateTo=${today}`)).toHaveLength(3);
    expect(await list(`sellerId=${U.SALES}&dateFrom=${tomorrow}`)).toHaveLength(0);
    expect(await list(`sellerId=${U.SALES2}&status=CANCELLED`)).toHaveLength(1);
    await http().get('/sales-orders?dateFrom=2026-02-30').set(as('ADMIN')).expect(400);
    await http().get(`/sales-orders?dateFrom=${tomorrow}&dateTo=${today}`).set(as('ADMIN')).expect(400);
    await http().get('/sales-orders?payment=MAYBE').set(as('ADMIN')).expect(400);
  });

  it('summary per seller: base before VAT and total, split into paid, pending and cash; cancelled left out', async () => {
    const full = async (order: OrderRow) => (await http().get(`/sales-orders/${order.id}`).set(as('ADMIN')).expect(200)).body as OrderRow & { subtotal: string; discountTotal: string; globalDiscountAmount: string };
    const [mine] = await summary(`sellerId=${U.SALES}`);
    expect(mine.seller).toEqual({ id: U.SALES, name: `E2E SALES SC${S}A` });
    expect(mine.all.orders).toBe(3);
    expect(mine.paid).toMatchObject({ orders: 1, total: new Decimal(orders.credit.total).toFixed(2), base: base(await full(orders.credit)).toFixed(2) });
    expect(mine.pending).toMatchObject({ orders: 1, total: new Decimal(orders.byAdmin.total).toFixed(2) });
    expect(mine.cash).toMatchObject({ orders: 1, total: new Decimal(orders.cash.total).toFixed(2) });
    const sum = [orders.cash, orders.credit, orders.byAdmin].reduce((total, o) => total.plus(o.total), new Decimal(0));
    expect(mine.all.total).toBe(sum.toFixed(2));
    const [other] = await summary(`sellerId=${U.SALES2}`);
    expect(other).toMatchObject({ all: { orders: 1 }, pending: { orders: 1 }, cash: { orders: 0 } });
    // Same filters as the list.
    expect(await summary(`sellerId=${U.SALES}&dateFrom=${tomorrow}`)).toEqual([]);
    expect((await summary(`sellerId=${U.SALES}&payment=PAID`))[0].all.orders).toBe(1);
  });

  it('sales only sees its own orders and no summary', async () => {
    await http().get('/sales-orders/summary').set(as('SALES')).expect(403);
    expect(await list(`sellerId=${U.SALES2}`, 'SALES')).toHaveLength(0);
    const own = await list('', 'SALES');
    expect(own.every((o) => o.createdBy === undefined)).toBe(true);
    expect(own.map((o) => o.id)).toEqual(expect.arrayContaining([orders.cash.id, orders.credit.id, orders.byAdmin.id]));
  });
});
