import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Critical races of the sales/dispatch flow repeated with fresh data on the
// real PostgreSQL test database (no retries hide failures). Every round must
// produce exactly the expected outcome.
const ROUNDS = 20;

describe('Sales and dispatch races repeated 20 times (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { branch: '', loc: '', aisle: '', rack: '', ref: '', finish: '', supplier: '', customer: '' };
  let n = 0;
  const epc = () => `RACE${S}${String(++n).padStart(5, '0')}`;
  const http = () => request(app.getHttpServer());
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const sorted = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b).join('/');

  const registerNational = async (quantity: number) => {
    const code = epc();
    const res = await http()
      .post('/inventory/bundles')
      .set(H.WAREHOUSE)
      .send({ epc: code, referenceId: ids.ref, finishId: ids.finish, quantity, inventoryLocationId: ids.loc, rackId: ids.rack, registrationType: 'ENTRY', arrivalDatePrecision: 'UNKNOWN', origin: 'NATIONAL', supplierId: ids.supplier })
      .expect(201);
    return res.body as { id: string; epc: string };
  };

  const order = async (quantity: number) => {
    const quote = await http()
      .post('/quotes')
      .set(H.SALES)
      .send({ customerId: ids.customer, lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity, pricingMethod: 'MANUAL', unitPrice: '1000', priceReason: 'carrera', discountPercent: '0', taxRatePercent: '0' }] })
      .expect(201);
    const converted = await http().post(`/quotes/${quote.body.id}/convert`).set(H.SALES).send({ operationKey: randomUUID() }).expect(200);
    return converted.body as { id: string; lines: { id: string }[] };
  };

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role] of [['ADMIN', 'ADMIN'], ['SALES', 'SALES'], ['WAREHOUSE', 'WAREHOUSE'], ['WAREHOUSE2', 'WAREHOUSE']] as const) {
      const user = await createTestUser(app, role, `${S}${key === 'WAREHOUSE2' ? '2' : ''}`);
      H[key] = user.headers;
      U[key] = user.id;
    }
    const branch = await prisma.branch.create({ data: { code: `RACE-${S}`, name: 'Carreras' } });
    const loc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `RACE-${S}`, name: 'Bodega carreras' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: loc.id, number: 1 } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } });
    Object.assign(ids, { branch: branch.id, loc: loc.id, aisle: aisle.id, rack: rack.id });
    await prisma.user.updateMany({ where: { id: { in: [U.WAREHOUSE, U.WAREHOUSE2] } }, data: { defaultInventoryLocationId: loc.id } });
    ids.ref = (await prisma.reference.create({ data: { code: `RACE-REF-${S}` } })).id;
    ids.finish = (await prisma.finish.create({ data: { code: `RACE-FIN-${S}` } })).id;
    ids.supplier = (await prisma.supplier.create({ data: { code: `RACE-N-${S}`, name: 'Nacional carreras', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente carreras ${S}`, createdById: U.SALES } })).id;
  });

  afterAll(async () => {
    if (prisma) {
      const users = Object.values(U);
      const orders = await prisma.salesOrder.findMany({ where: { createdById: { in: users } }, select: { id: true } });
      const dispatches = await prisma.dispatch.findMany({ where: { salesOrderId: { in: orders.map((o) => o.id) } }, select: { id: true } });
      const dIds = dispatches.map((d) => d.id);
      const bIds = (await prisma.bundle.findMany({ where: { referenceId: ids.ref }, select: { id: true } })).map((b) => b.id);
      await prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } });
      await prisma.readerObservation.deleteMany({ where: { dispatchId: { in: dIds } } });
      await prisma.dispatchIncident.deleteMany({ where: { dispatchId: { in: dIds } } });
      await prisma.dispatchPick.deleteMany({ where: { dispatchId: { in: dIds } } });
      await prisma.stockReservation.deleteMany({ where: { bundleId: { in: bIds } } });
      await prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } });
      await prisma.inventoryMovement.deleteMany({ where: { bundleId: { in: bIds } } });
      await prisma.dispatchLine.deleteMany({ where: { dispatchId: { in: dIds } } });
      await prisma.dispatch.deleteMany({ where: { id: { in: dIds } } });
      await prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orders.map((o) => o.id) } } });
      await prisma.salesOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
      await prisma.quote.deleteMany({ where: { createdById: { in: users } } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.bundle.deleteMany({ where: { id: { in: bIds } } });
      await prisma.stockLot.deleteMany({ where: { referenceId: ids.ref } });
      await prisma.supplier.deleteMany({ where: { id: ids.supplier } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.reference.deleteMany({ where: { id: ids.ref } });
      await prisma.finish.deleteMany({ where: { id: ids.finish } });
      await prisma.rack.deleteMany({ where: { id: ids.rack } });
      await prisma.aisle.deleteMany({ where: { id: ids.aisle } });
      await prisma.inventoryLocation.deleteMany({ where: { id: ids.loc } });
      await prisma.branch.deleteMany({ where: { id: ids.branch } });
    }
    await app?.close();
  });

  it('two orders competing for the same 10 profiles: one reserves 8, the other reports the shortage', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await registerNational(10);
      const [a, b] = await Promise.all([order(8), order(8)]);
      const results = await Promise.all([a, b].map((o) => http().post(`/sales-orders/${o.id}/confirm`).set(H.SALES).send({ inventoryLocationId: ids.loc })));
      const confirmed = results.filter((r) => r.body.confirmed).length;
      const reserved = (await prisma.stockReservation.aggregate({ where: { bundleId: bundle.id, status: 'ACTIVE' }, _sum: { quantity: true } }))._sum.quantity;
      outcomes.push(`${sorted(results)}:${confirmed}c:${reserved}r`);
      // Free the stock of this round for the next ones.
      for (const o of [a, b]) await http().post(`/sales-orders/${o.id}/cancel`).set(H.SALES).send({ reason: 'fin de ronda' }).expect(200);
      await prisma.bundle.update({ where: { id: bundle.id }, data: { quantity: 0 } });
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/200:1c:8r'));
  });

  it('two confirmations of the same dispatch with different keys: one exit, one refusal', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await registerNational(5);
      const o = await order(5);
      await http().post(`/sales-orders/${o.id}/confirm`).set(H.SALES).send({ inventoryLocationId: ids.loc }).expect(200);
      const dispatch = await http()
        .post(`/sales-orders/${o.id}/dispatches`)
        .set(H.SALES)
        .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(2), lines: [{ salesOrderLineId: o.lines[0].id, quantity: 5 }] })
        .expect(201);
      await http().post(`/dispatches/${dispatch.body.id}/scan`).set(H.WAREHOUSE).send({ epc: bundle.epc }).expect(200);
      const results = await Promise.all(
        ['WAREHOUSE', 'WAREHOUSE2'].map((who) => http().post(`/dispatches/${dispatch.body.id}/confirm`).set(H[who]).send({ operationKey: randomUUID() })),
      );
      const exits = await prisma.inventoryMovement.count({ where: { dispatchId: dispatch.body.id, type: 'EXIT' } });
      const left = (await prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity;
      outcomes.push(`${sorted(results)}:${exits}x:${left}`);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/409:1x:0'));
  });

  it('the same quote converted twice at once with different keys: one order', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const quote = await http()
        .post('/quotes')
        .set(H.SALES)
        .send({ customerId: ids.customer, lines: [{ referenceId: ids.ref, finishId: ids.finish, origin: 'NATIONAL', quantity: 1, pricingMethod: 'MANUAL', unitPrice: '1', priceReason: 'carrera', discountPercent: '0', taxRatePercent: '0' }] })
        .expect(201);
      const results = await Promise.all([1, 2].map(() => http().post(`/quotes/${quote.body.id}/convert`).set(H.SALES).send({ operationKey: randomUUID() })));
      outcomes.push(`${sorted(results)}:${await prisma.salesOrder.count({ where: { quoteId: quote.body.id } })}`);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/409:1'));
  });
});
