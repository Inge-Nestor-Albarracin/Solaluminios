import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Billing: the seller marks that an order needs an electronic invoice (made
// in another software); a BILLING task goes to the billing user, who only
// sees those orders, downloads the PDF and records the invoice number.
interface Order {
  id: string;
  number: string;
  requiresBilling: boolean;
  invoiceNumber: string | null;
  billedAt: string | null;
  billedBy?: { id: string; name: string } | null;
}

describe('Order billing (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { ref: '', finish: '', supplier: '', customer: '' };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.73.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };

  const quote = async () =>
    (
      await http()
        .post('/quotes')
        .set(as('SALES'))
        .send({ customerId: ids.customer, paymentMethod: 'CASH', lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 2, discountPercent: '0', taxRatePercent: '19' }] })
        .expect(201)
    ).body as { id: string };
  const convert = (quoteId: string, requiresBilling?: boolean) =>
    http().post(`/quotes/${quoteId}/convert`).set(as('SALES')).send({ operationKey: randomUUID(), ...(requiresBilling === undefined ? {} : { requiresBilling }) });
  const billingTask = (orderId: string) => prisma.task.findUnique({ where: { salesOrderId_kind: { salesOrderId: orderId, kind: 'BILLING' } }, include: { assignee: true } });
  const outbox = (kind: string) => prisma.notificationOutbox.count({ where: { kind, userId: { in: Object.values(U) } } });

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'SALES', 'BILLING'] as const) {
      const user = await createTestUser(app, role, `OB${S}`);
      H[role] = user.headers;
      U[role] = user.id;
    }
    ids.ref = (await prisma.reference.create({ data: { code: `OBIL-REF-${S}` } })).id;
    ids.finish = (await prisma.finish.create({ data: { code: `OBIL-A-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `OBIL-${S}`, name: 'Proveedor facturación', origins: ['NATIONAL'] } })).id;
    // NIT but no e-mail: billing needs both.
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente facturación ${S}`, taxId: `9${S.replace(/\D/g, '').padEnd(8, '1').slice(0, 8)}`, createdById: U.SALES } })).id;
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `OBIL-${S}`,
        documentDate: '2026-11-03',
        lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 7, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' }],
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
      const orderIds = (await prisma.salesOrder.findMany({ where: { quoteId: { in: quotes } }, select: { id: true } })).map((o) => o.id);
      await prisma.task.deleteMany({ where: { OR: [{ salesOrderId: { in: orderIds } }, { assigneeId: { in: users } }, { createdById: { in: users } }] } });
      await prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } });
      await prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orderIds } } });
      await prisma.salesOrderPayment.deleteMany({ where: { salesOrderId: { in: orderIds } } });
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

  it('converting with billing needs the customer NIT and e-mail; then the billing user gets a task', async () => {
    const q = await quote();
    const refused = await convert(q.id, true).expect(400);
    expect(refused.body.message).toContain('correo electrónico');
    // Nothing was created: the quote can still be converted.
    expect(await prisma.salesOrder.count({ where: { quoteId: q.id } })).toBe(0);
    await http().patch(`/customers/${ids.customer}/billing-data`).set(as('SALES')).send({ taxId: '', email: 'x' }).expect(400);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: ids.customer } });
    await http().patch(`/customers/${ids.customer}/billing-data`).set(as('SALES')).send({ taxId: customer.taxId, email: `facturas-${S.toLowerCase()}@cliente.test` }).expect(200);

    const order = (await convert(q.id, true).expect(200)).body as Order;
    expect(order.requiresBilling).toBe(true);
    const task = await billingTask(order.id);
    expect(task).toMatchObject({ kind: 'BILLING', title: `Facturar ${order.number}`, completedAt: null, cancelledAt: null });
    expect(task!.assignee.role).toBe('BILLING');
    expect(await prisma.notificationOutbox.count({ where: { kind: 'billing-requested', userId: task!.assigneeId } })).toBeGreaterThan(0);
  });

  it('billing sees only the orders sent to billing (and their PDF); nothing else of sales or inventory', async () => {
    const plain = (await convert((await quote()).id).expect(200)).body as Order;
    expect(plain.requiresBilling).toBe(false);
    const pending = (await http().get('/sales-orders?billing=PENDING&pageSize=100').set(as('BILLING')).expect(200)).body.items as Order[];
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((o) => o.requiresBilling && !o.billedAt)).toBe(true);
    expect(pending.some((o) => o.id === plain.id)).toBe(false);
    await http().get(`/sales-orders/${plain.id}`).set(as('BILLING')).expect(404);
    await http().get(`/sales-orders/${plain.id}/pdf`).set(as('BILLING')).expect(404);
    const mine = pending[0];
    await http().get(`/sales-orders/${mine.id}/pdf`).set(as('BILLING')).expect(200).expect('Content-Type', /pdf/);
    await http().get('/quotes').set(as('BILLING')).expect(403);
    await http().get('/inventory/bundles').set(as('BILLING')).expect(403);
    await http().get('/sales-orders/summary').set(as('BILLING')).expect(403);
    await http().post(`/sales-orders/${mine.id}/cancel`).set(as('BILLING')).send({ reason: 'x' }).expect(403);
    await http().patch(`/sales-orders/${mine.id}/billing`).set(as('BILLING')).send({ required: false }).expect(403);
  });

  it('recording the invoice completes the task, notifies the seller and locks the mark; same number twice is harmless', async () => {
    const order = (await convert((await quote()).id, true).expect(200)).body as Order;
    const task = await billingTask(order.id);
    // The task is completed by the invoice, not by hand.
    await http().patch(`/tasks/${task!.id}/complete`).set(as('ADMIN')).expect((res) => expect([403, 404, 409]).toContain(res.status));
    await http().post(`/sales-orders/${order.id}/invoice`).set(as('SALES')).send({ invoiceNumber: 'FE-1' }).expect(403);
    await http().post(`/sales-orders/${order.id}/invoice`).set(as('BILLING')).send({ invoiceNumber: '   ' }).expect(400);
    const sellerNotices = await outbox('order-billed');
    const billed = (await http().post(`/sales-orders/${order.id}/invoice`).set(as('BILLING')).send({ invoiceNumber: ` FE-${S} ` }).expect(200)).body as Order;
    expect(billed).toMatchObject({ invoiceNumber: `FE-${S}`, billedBy: { id: U.BILLING } });
    expect((await billingTask(order.id))!.completedAt).not.toBeNull();
    expect(await outbox('order-billed')).toBe(sellerNotices + 1);
    await http().post(`/sales-orders/${order.id}/invoice`).set(as('BILLING')).send({ invoiceNumber: `FE-${S}` }).expect(200);
    const other = await http().post(`/sales-orders/${order.id}/invoice`).set(as('BILLING')).send({ invoiceNumber: 'FE-OTRA' }).expect(409);
    expect(other.body.message).toContain(`FE-${S}`);
    await http().patch(`/sales-orders/${order.id}/billing`).set(as('SALES')).send({ required: false }).expect(409);
    // The seller sees who invoiced it.
    expect(((await http().get(`/sales-orders/${order.id}`).set(as('SALES')).expect(200)).body as Order).invoiceNumber).toBe(`FE-${S}`);
    expect(((await http().get('/sales-orders?billing=BILLED&pageSize=100').set(as('BILLING')).expect(200)).body.items as Order[]).some((o) => o.id === order.id)).toBe(true);

    // Cancelling an invoiced order: billing gets a task to void the invoice.
    await http().post(`/sales-orders/${order.id}/cancel`).set(as('SALES')).send({ reason: 'Cliente desistió' }).expect(200);
    const voidTask = await prisma.task.findFirst({ where: { kind: 'GENERAL', title: { contains: `FE-${S}` } } });
    expect(voidTask).toMatchObject({ assigneeId: U.BILLING, completedAt: null });
    expect(await prisma.notificationOutbox.count({ where: { kind: 'billing-void-needed', userId: U.BILLING } })).toBe(1);
  });

  it('marking after conversion, unmarking and marking again reuse one task; cancelling an unbilled order cancels it', async () => {
    const order = (await convert((await quote()).id).expect(200)).body as Order;
    expect(await billingTask(order.id)).toBeNull();
    expect(((await http().patch(`/sales-orders/${order.id}/billing`).set(as('SALES')).send({ required: true }).expect(200)).body as Order).requiresBilling).toBe(true);
    const first = await billingTask(order.id);
    await http().patch(`/sales-orders/${order.id}/billing`).set(as('SALES')).send({ required: true }).expect(200);
    await http().patch(`/sales-orders/${order.id}/billing`).set(as('SALES')).send({ required: false }).expect(200);
    expect((await billingTask(order.id))!.cancelledAt).not.toBeNull();
    // Unmarked: billing no longer sees it.
    await http().get(`/sales-orders/${order.id}`).set(as('BILLING')).expect(404);
    await http().patch(`/sales-orders/${order.id}/billing`).set(as('ADMIN')).send({ required: true }).expect(200);
    const again = await billingTask(order.id);
    expect(again).toMatchObject({ id: first!.id, cancelledAt: null, completedAt: null });
    await http().post(`/sales-orders/${order.id}/cancel`).set(as('SALES')).send({ reason: 'Ya no lo quiere' }).expect(200);
    expect((await billingTask(order.id))!.cancelledAt).not.toBeNull();
    await http().post(`/sales-orders/${order.id}/invoice`).set(as('BILLING')).send({ invoiceNumber: 'FE-X' }).expect(409);
    await http().patch(`/sales-orders/${order.id}/billing`).set(as('SALES')).send({ required: false }).expect(409);
  });

  it('the billing user sees and manages its own tasks', async () => {
    const tasks = (await http().get('/tasks?status=pending').set(as('BILLING')).expect(200)).body as { items?: { kind: string }[] } | { kind: string }[];
    const list = Array.isArray(tasks) ? tasks : (tasks.items ?? []);
    expect(list.some((t) => t.kind === 'GENERAL')).toBe(true);
    await http().get('/tasks/summary').set(as('BILLING')).expect(200);
  });
});
