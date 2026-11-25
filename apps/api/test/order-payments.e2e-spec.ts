import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { businessToday } from '../src/shared/db.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Payments of sales orders: contado in one or two media (recorded with the
// conversion, adding up to the total), abonos on different days, corrections
// of an abono, the balance computed by the system, duplicates and races, and
// orders made before payments existed.
interface Payment {
  id: string;
  medium: 'CASH' | 'TRANSFER';
  transferEntity: { id: string; name: string } | null;
  amount: string;
  paidOn: string;
  note: string | null;
  atSale: boolean;
  edited: boolean;
  changes: { changed: Record<string, { from: string | null; to: string | null }> }[];
}
interface Order {
  id: string;
  number: string;
  total: string;
  paymentMethod: string;
  paymentStatus: 'PENDING' | 'PAID' | null;
  payments?: Payment[];
  paymentSummary?: { recorded: boolean; total: string; paid: string; balance: string; complete: boolean };
}

describe('Order payments (e2e)', () => {
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
    return { ...H[who], 'X-Forwarded-For': `10.76.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const yesterday = () => new Date(Date.parse(`${businessToday()}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  // Price 10.000 per unit (cost 8.000 + 25 %), no VAT: totals are round.
  const order = async (quantity: number, paymentMethod: string, split: Record<string, string> = {}, status = 200) => {
    const quote = (
      await http()
        .post('/quotes')
        .set(as('SALES'))
        .send({ customerId: ids.customer, lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity, discountPercent: '0', taxRatePercent: '0' }] })
        .expect(201)
    ).body as { id: string; total: string };
    const converted = await http().post(`/quotes/${quote.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID(), paymentMethod, ...split }).expect(status);
    return { quoteId: quote.id, body: converted.body as Order & { message?: string } };
  };
  const get = async (id: string, who = 'SALES') => (await http().get(`/sales-orders/${id}`).set(as(who)).expect(200)).body as Order;
  const add = (id: string, body: Record<string, unknown>, who = 'SALES') =>
    http().post(`/sales-orders/${id}/payments`).set(as(who)).send({ operationKey: randomUUID(), medium: 'CASH', paidOn: businessToday(), ...body });
  const edit = (id: string, paymentId: string, body: Record<string, unknown>, who = 'SALES') =>
    http().patch(`/sales-orders/${id}/payments/${paymentId}`).set(as(who)).send(body);
  const amounts = (o: Order) => (o.payments ?? []).map((p) => [p.medium, Number(p.amount)]);

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'SALES', 'SALES2', 'BILLING', 'WAREHOUSE'] as const) {
      const user = await createTestUser(app, role === 'SALES2' ? 'SALES' : role, `OP${role}${S}`);
      H[role] = user.headers;
      U[role] = user.id;
    }
    ids.ref = (await prisma.reference.create({ data: { code: `OPAY-REF-${S}` } })).id;
    ids.finish = (await prisma.finish.create({ data: { code: `OPAY-A-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `OPAY-${S}`, name: 'Proveedor pagos', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente pagos ${S}`, taxId: `8${S.replace(/\D/g, '').padEnd(8, '2').slice(0, 8)}`, email: `pagos-${S.toLowerCase()}@test.local`, createdById: U.SALES } })).id;
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier,
        documentNumber: `OPAY-${S}`,
        documentDate: '2026-11-03',
        lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 10, grossAmount: '80000', discountPercent: '0', taxRatePercent: '0' }],
      })
      .expect(201);
    const confirmed = await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200);
    await http().post('/sale-prices').set(as('ADMIN')).send({ purchaseId: purchase.body.id, purchaseLineId: confirmed.body.lines[0].id, markupPercent: '25', enabled: true }).expect(201);
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await app?.close();
  });

  it('contado in a single medium records the whole total, dated today', async () => {
    const { body } = await order(1, 'CASH');
    expect(Number(body.total)).toBe(10000);
    expect(body.paymentStatus).toBeNull();
    expect(amounts(body)).toEqual([['CASH', 10000]]);
    expect(body.payments![0]).toMatchObject({ atSale: true, paidOn: businessToday() });
    expect(body.paymentSummary).toMatchObject({ recorded: true, paid: '10000.00', balance: '0.00', complete: true });

    const transfer = (await order(1, 'TRANSFER', { transferEntityId: 'NEQUI' })).body;
    expect(amounts(transfer)).toEqual([['TRANSFER', 10000]]);
    expect(transfer.payments![0].transferEntity).toEqual({ id: 'NEQUI', name: 'Nequi' });
    expect(body.payments![0].transferEntity).toBeNull();
    // A single medium must cover the total.
    const short = await order(1, 'CASH', { cashAmount: '9000' }, 400);
    expect(short.body.message).toMatch(/Abono/);
    // A contado order does not take abonos.
    await add(body.id, { amount: '1' }).expect(409);
  });

  it('mixed contado accepts any split that adds up to the total and refuses one that does not', async () => {
    const { body } = await order(10, 'CASH_TRANSFER', { cashAmount: '35000', transferAmount: '65000', transferEntityId: 'NEQUI' });
    expect(Number(body.total)).toBe(100000);
    expect(body.paymentMethod).toBe('CASH_TRANSFER');
    expect(amounts(body)).toEqual([['CASH', 35000], ['TRANSFER', 65000]]);
    expect(body.paymentSummary).toMatchObject({ paid: '100000.00', balance: '0.00', complete: true });
    expect(await prisma.salesOrder.count({ where: { quoteId: (await prisma.salesOrder.findUniqueOrThrow({ where: { id: body.id } })).quoteId } })).toBe(1);

    const missing = await order(10, 'CASH_TRANSFER', { cashAmount: '35000', transferAmount: '60000', transferEntityId: 'NEQUI' }, 400);
    expect(missing.body.message).toMatch(/faltan \$5\.000/);
    const over = await order(10, 'CASH_TRANSFER', { cashAmount: '35000', transferAmount: '70000', transferEntityId: 'NEQUI' }, 400);
    expect(over.body.message).toMatch(/sobran \$5\.000/);
    await order(10, 'CASH_TRANSFER', { cashAmount: '100000', transferEntityId: 'NEQUI' }, 400);
    expect(await prisma.salesOrder.findUnique({ where: { quoteId: missing.quoteId } })).toBeNull();

    // A contado amount is fixed; its medium, day and note can be corrected.
    const cash = body.payments![0];
    await edit(body.id, cash.id, { amount: '30000' }).expect(409);
    // Becoming a transfer requires its entity.
    await edit(body.id, cash.id, { medium: 'TRANSFER', note: 'Era transferencia' }).expect(400);
    const fixed = (await edit(body.id, cash.id, { medium: 'TRANSFER', transferEntityId: 'BANCO_CAJA_SOCIAL', note: 'Era transferencia' }).expect(200)).body as Order;
    expect(amounts(fixed)).toEqual([['TRANSFER', 35000], ['TRANSFER', 65000]]);
    expect(fixed.paymentSummary?.balance).toBe('0.00');
  });

  it('abonos on different days add up; the second one does not replace the first', async () => {
    const { body } = await order(1, 'PARTIAL');
    expect(body.paymentStatus).toBe('PENDING');
    expect(body.paymentSummary).toMatchObject({ recorded: false, paid: '0.00', balance: '10000.00', complete: false });

    const first = (await add(body.id, { amount: '5000', medium: 'CASH', paidOn: yesterday() }).expect(201)).body as Order;
    expect(first.paymentSummary).toMatchObject({ paid: '5000.00', balance: '5000.00' });
    const second = (await add(body.id, { amount: '1000', medium: 'TRANSFER', transferEntityId: 'NEQUI', paidOn: businessToday(), note: 'Desde Bancolombia del cliente' }).expect(201)).body as Order;
    expect(second.payments!.map((p) => [p.paidOn, p.medium, Number(p.amount)])).toEqual([
      [yesterday(), 'CASH', 5000],
      [businessToday(), 'TRANSFER', 1000],
    ]);
    expect(second.paymentSummary).toMatchObject({ paid: '6000.00', balance: '4000.00', complete: false });
    expect(second.paymentStatus).toBe('PENDING');

    // Correcting the second abono replaces its amount (6.500 / 3.500).
    const secondId = second.payments![1].id;
    const corrected = (await edit(body.id, secondId, { amount: '1500' }).expect(200)).body as Order;
    expect(corrected.payments!.length).toBe(2);
    expect(corrected.paymentSummary).toMatchObject({ paid: '6500.00', balance: '3500.00' });
    expect(corrected.payments![1]).toMatchObject({ edited: true });
    expect(corrected.payments![1].changes[0].changed).toEqual({ amount: { from: '1000.00', to: '1500.00' } });
    const auditRow = await prisma.auditEvent.findFirst({ where: { entity: 'SalesOrderPayment', entityId: secondId, action: 'PAYMENT_EDITED' } });
    expect(auditRow).toMatchObject({ userId: U.SALES });
    // The same correction again changes nothing (no second audit row).
    await edit(body.id, secondId, { amount: '1500' }).expect(200);
    expect(await prisma.auditEvent.count({ where: { entity: 'SalesOrderPayment', entityId: secondId, action: 'PAYMENT_EDITED' } })).toBe(1);

    // Zero, negative, above the balance, future day: refused.
    await add(body.id, { amount: '0' }).expect(400);
    await add(body.id, { amount: '-5' }).expect(400);
    expect((await add(body.id, { amount: '3501' }).expect(400)).body.message).toMatch(/supera el saldo pendiente \(\$3\.500\)/);
    await add(body.id, { amount: '100', paidOn: '2999-01-01' }).expect(400);
    // Editing above the room: the old amount is replaced, not added.
    await edit(body.id, secondId, { amount: '5001' }).expect(400);
    expect((await edit(body.id, secondId, { amount: '5000' }).expect(200)).body.paymentSummary.balance).toBe('0.00');
    await edit(body.id, secondId, { amount: '1500' }).expect(200);

    // The last abono leaves the balance at zero: paid, by the abonos.
    const last = (await add(body.id, { amount: '3500', medium: 'TRANSFER', transferEntityId: 'BANCO_CAJA_SOCIAL' }).expect(201)).body as Order;
    expect(last.paymentSummary).toMatchObject({ paid: '10000.00', balance: '0.00', complete: true });
    expect(last.paymentStatus).toBe('PAID');
    await add(body.id, { amount: '1' }).expect(400);
    // With abonos, the status is not changed by hand.
    await http().patch(`/sales-orders/${body.id}/payment-status`).set(as('SALES')).send({ status: 'PENDING' }).expect(409);
    // Lowering an abono reopens the balance.
    const reopened = (await edit(body.id, secondId, { amount: '1000' }).expect(200)).body as Order;
    expect(reopened).toMatchObject({ paymentStatus: 'PENDING', paymentSummary: { balance: '500.00' } });
  });

  it('a double click or a retry never duplicates an abono, and two at once never pass the balance', async () => {
    const { body } = await order(1, 'CREDIT');
    const key = randomUUID();
    const send = () => http().post(`/sales-orders/${body.id}/payments`).set(as('SALES')).send({ operationKey: key, amount: '2000', medium: 'CASH', paidOn: businessToday() });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([201, 201]);
    expect(await prisma.salesOrderPayment.count({ where: { salesOrderId: body.id } })).toBe(1);
    await send().expect(201);
    expect(await prisma.salesOrderPayment.count({ where: { salesOrderId: body.id } })).toBe(1);
    // Same key, other data: refused.
    await http().post(`/sales-orders/${body.id}/payments`).set(as('SALES')).send({ operationKey: key, amount: '2500', medium: 'CASH', paidOn: businessToday() }).expect(409);

    // Balance 8.000: two abonos of 6.000 at the same time, only one fits.
    const race = await Promise.all([add(body.id, { amount: '6000' }), add(body.id, { amount: '6000', medium: 'TRANSFER', transferEntityId: 'NEQUI' })]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 400]);
    const after = await get(body.id);
    expect(after.paymentSummary).toMatchObject({ paid: '8000.00', balance: '2000.00' });
  });

  it('only the seller of the order and the administrator record payments; billing reads the order without them', async () => {
    const { body } = await order(1, 'PARTIAL');
    await add(body.id, { amount: '1000' }, 'SALES2').expect(404);
    await add(body.id, { amount: '1000' }, 'WAREHOUSE').expect(403);
    await add(body.id, { amount: '1000' }, 'BILLING').expect(403);
    const byAdmin = (await add(body.id, { amount: '1000' }, 'ADMIN').expect(201)).body as Order & { payments: (Payment & { createdBy?: { id: string } })[] };
    expect(byAdmin.payments[0].createdBy?.id).toBe(U.ADMIN);
    const seller = await get(body.id);
    expect(seller.payments![0]).not.toHaveProperty('createdBy');
    await edit(body.id, seller.payments![0].id, { amount: '900' }, 'BILLING').expect(403);

    await http().patch(`/sales-orders/${body.id}/billing`).set(as('SALES')).send({ required: true }).expect(200);
    const billing = await get(body.id, 'BILLING');
    expect(billing).not.toHaveProperty('payments');
    expect(billing).not.toHaveProperty('paymentSummary');
    expect(billing.paymentStatus).toBe('PENDING');

    await http().post(`/sales-orders/${body.id}/cancel`).set(as('SALES')).send({ reason: 'Prueba de pagos' }).expect(200);
    await add(body.id, { amount: '100' }).expect(409);
    await edit(body.id, seller.payments![0].id, { amount: '900' }).expect(409);
  });

  it('orders made before payments existed open with their original values and keep the manual status', async () => {
    // As before the migration: no payment records.
    const cash = (await order(1, 'CASH')).body;
    const abono = (await order(1, 'PARTIAL')).body;
    await prisma.auditEvent.deleteMany({ where: { entity: 'SalesOrderPayment', data: { path: ['orderId'], equals: cash.id } } });
    await prisma.salesOrderPayment.deleteMany({ where: { salesOrderId: cash.id } });

    const oldCash = await get(cash.id);
    expect(oldCash).toMatchObject({ total: cash.total, paymentMethod: 'CASH', paymentStatus: null, payments: [] });
    expect(oldCash.paymentSummary).toMatchObject({ recorded: false, complete: false });

    await http().patch(`/sales-orders/${abono.id}/payment-status`).set(as('SALES')).send({ status: 'PAID' }).expect(200);
    const oldAbono = await get(abono.id);
    expect(oldAbono).toMatchObject({ paymentStatus: 'PAID', payments: [] });
    // Marked paid by hand: to record abonos, back to pending first.
    expect((await add(abono.id, { amount: '1000' }).expect(409)).body.message).toMatch(/vuélvela primero/);
    await http().patch(`/sales-orders/${abono.id}/payment-status`).set(as('SALES')).send({ status: 'PENDING' }).expect(200);
    await add(abono.id, { amount: '1000' }).expect(201);
  });

  it('stores where each transfer was received: 65.000 to Banco Caja Social, not the order total', async () => {
    const list = (await http().get('/transfer-entities').set(as('SALES')).expect(200)).body as { id: string; name: string }[];
    expect(list).toEqual(expect.arrayContaining([{ id: 'NEQUI', name: 'Nequi' }, { id: 'BANCO_CAJA_SOCIAL', name: 'Banco Caja Social' }]));
    await http().get('/transfer-entities').set(as('WAREHOUSE')).expect(403);

    const { body } = await order(10, 'CASH_TRANSFER', { cashAmount: '35000', transferAmount: '65000', transferEntityId: 'BANCO_CAJA_SOCIAL' });
    expect(body.payments!.map((p) => [p.medium, Number(p.amount), p.transferEntity?.id ?? null])).toEqual([
      ['CASH', 35000, null],
      ['TRANSFER', 65000, 'BANCO_CAJA_SOCIAL'],
    ]);
    // What a future report reads: amount per entity, never the order total.
    const perEntity = await prisma.salesOrderPayment.groupBy({
      by: ['transferEntityId'],
      where: { salesOrderId: body.id, medium: 'TRANSFER' },
      _sum: { amount: true },
    });
    expect(perEntity.map((row) => [row.transferEntityId, Number(row._sum.amount)])).toEqual([['BANCO_CAJA_SOCIAL', 65000]]);

    // The entity is required, must be one of the list and never goes with cash.
    expect((await order(1, 'TRANSFER', {}, 400)).body.message).toMatch(/dónde se recibió/);
    await order(10, 'CASH_TRANSFER', { cashAmount: '35000', transferAmount: '65000' }, 400);
    await order(1, 'TRANSFER', { transferEntityId: 'BANCOLOMBIA' }, 400);
    await order(1, 'CASH', { transferEntityId: 'NEQUI' }, 400);
  });

  it('two abonos of one order keep their own day, amount and entity; a transfer without entity is refused', async () => {
    const { body } = await order(1, 'PARTIAL');
    await add(body.id, { amount: '3000', medium: 'TRANSFER' }).expect(400);
    await add(body.id, { amount: '3000', medium: 'TRANSFER', transferEntityId: 'DAVIPLATA' }).expect(400);
    await add(body.id, { amount: '3000', medium: 'CASH', transferEntityId: 'NEQUI' }).expect(400);
    await add(body.id, { amount: '3000', medium: 'TRANSFER', transferEntityId: 'NEQUI', paidOn: yesterday() }).expect(201);
    const both = (await add(body.id, { amount: '2000', medium: 'TRANSFER', transferEntityId: 'BANCO_CAJA_SOCIAL' }).expect(201)).body as Order;
    expect(both.payments!.map((p) => [p.paidOn, Number(p.amount), p.transferEntity?.name])).toEqual([
      [yesterday(), 3000, 'Nequi'],
      [businessToday(), 2000, 'Banco Caja Social'],
    ]);
    expect(both.paymentSummary).toMatchObject({ paid: '5000.00', balance: '5000.00' });

    // A correction to cash removes the entity; back to transfer requires one.
    const second = both.payments![1];
    const cash = (await edit(body.id, second.id, { medium: 'CASH' }).expect(200)).body as Order;
    expect(cash.payments![1]).toMatchObject({ medium: 'CASH', transferEntity: null });
    expect(cash.payments![1].changes.at(-1)!.changed).toEqual({
      medium: { from: 'TRANSFER', to: 'CASH' },
      transferEntityId: { from: 'BANCO_CAJA_SOCIAL', to: null },
    });
    await edit(body.id, second.id, { medium: 'CASH', transferEntityId: 'NEQUI' }).expect(400);
    await edit(body.id, second.id, { medium: 'TRANSFER' }).expect(400);
    const back = (await edit(body.id, second.id, { medium: 'TRANSFER', transferEntityId: 'NEQUI' }).expect(200)).body as Order;
    expect(back.payments![1].transferEntity?.id).toBe('NEQUI');
    // Another entity of the list replaces it; the change is audited.
    const moved = (await edit(body.id, second.id, { transferEntityId: 'BANCO_CAJA_SOCIAL' }).expect(200)).body as Order;
    expect(moved.payments![1].changes.at(-1)!.changed).toEqual({ transferEntityId: { from: 'NEQUI', to: 'BANCO_CAJA_SOCIAL' } });
    await edit(body.id, second.id, { transferEntityId: '' }).expect(400);
  });

  it('a transfer recorded before the entity was asked stays «Sin especificar» and is never assigned one', async () => {
    const { body } = await order(1, 'PARTIAL');
    // As before the migration: written with the triggers off (local superuser).
    const old = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
      return tx.salesOrderPayment.create({
        data: { salesOrderId: body.id, medium: 'TRANSFER', amount: '4000', paidOn: new Date(`${yesterday()}T00:00:00.000Z`), operationKey: randomUUID(), createdById: U.SALES },
      });
    });
    const seen = await get(body.id);
    expect(seen.payments![0]).toMatchObject({ id: old.id, medium: 'TRANSFER', transferEntity: null });
    // Its day or note can be corrected without inventing an entity.
    const noted = (await edit(body.id, old.id, { note: 'Destino desconocido' }).expect(200)).body as Order;
    expect(noted.payments![0]).toMatchObject({ transferEntity: null, note: 'Destino desconocido' });
    // The database refuses a new transfer without entity, even outside the API.
    await expect(
      prisma.salesOrderPayment.create({
        data: { salesOrderId: body.id, medium: 'TRANSFER', amount: '1', paidOn: new Date(), operationKey: randomUUID(), createdById: U.SALES },
      }),
    ).rejects.toThrow();
  });
});
