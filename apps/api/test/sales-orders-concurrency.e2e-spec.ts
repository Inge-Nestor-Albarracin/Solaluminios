import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { barrierAtTransactionStart, createBarrier } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Races of quotes, sales orders and their reservations, repeated with fresh
// data on the real PostgreSQL test database. When both requests open an
// interactive transaction, a test-only barrier releases them together so the
// transactions really overlap; otherwise they are fired at the same time.
// Each round records the HTTP answers and the final rows; every round must
// end in one of the valid outcomes (no retries hide a failure).
const ROUNDS = 20;

describe('Quotes, orders and reservations under concurrency (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { branch: '', loc: '', aisle: '', rack: '', ref: '', finishA: '', finishB: '', supplier1: '', supplier2: '', customer: '' };
  let n = 0;
  let ip = 0;
  const epc = () => `SORACE${S}${String(++n).padStart(5, '0')}`;
  // Each request is its own client (own IP behind the trusted proxy), so the
  // global rate limit never mixes into the results.
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.31.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const statuses = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b).join('/');
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  // Both requests enter their transaction together. The start order
  // alternates on every call; who takes the lock first is still decided by
  // the server (work done before the transaction), so some races always end
  // the same way. Every outcome is checked against the valid ones; results
  // keep the order in which the requests were given.
  let call = 0;
  const together = async <T>(requests: (() => Promise<T>)[]) => {
    barrierAtTransactionStart(prisma, requests.length, createBarrier(requests.length));
    const reversed = call++ % 2 === 1;
    const order = requests.map((_, index) => index);
    if (reversed) order.reverse();
    const pending: Promise<T>[] = Array.from({ length: requests.length });
    for (const index of order) pending[index] = requests[index]();
    try {
      return await Promise.all(pending);
    } finally {
      vi.restoreAllMocks();
    }
  };

  const register = async (quantity: number, finishId = ids.finishA, supplierId = ids.supplier1) => {
    const res = await http()
      .post('/inventory/bundles')
      .set(as('WAREHOUSE'))
      .send({ epc: epc(), referenceId: ids.ref, finishId, quantity, inventoryLocationId: ids.loc, rackId: ids.rack, registrationType: 'ENTRY', arrivalDatePrecision: 'UNKNOWN', origin: 'NATIONAL', supplierId })
      .expect(201);
    return res.body as { id: string; epc: string };
  };
  // Leaves a bundle out of later rounds (test fixture only).
  const retire = (bundleId: string) => prisma.bundle.update({ where: { id: bundleId }, data: { quantity: 0 } });

  const line = (quantity: number, finishId = ids.finishA) => ({ referenceId: ids.ref, finishId, origin: 'NATIONAL', quantity, discountPercent: '0', taxRatePercent: '19' });
  const quote = async (lines: ReturnType<typeof line>[]) =>
    (await http().post('/quotes').set(as('SALES')).send({ customerId: ids.customer, paymentMethod: 'CASH', lines }).expect(201)).body as { id: string };
  const order = async (lines: ReturnType<typeof line>[]) => {
    const q = await quote(lines);
    return (await http().post(`/quotes/${q.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }).expect(200)).body as { id: string; lines: { id: string }[] };
  };
  const confirm = (orderId: string) => http().post(`/sales-orders/${orderId}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.loc });
  const cancelOrder = (orderId: string) => http().post(`/sales-orders/${orderId}/cancel`).set(as('SALES')).send({ reason: 'Prueba de concurrencia' });
  const active = async (where: object) =>
    (await prisma.stockReservation.aggregate({ where: { status: 'ACTIVE', ...where }, _sum: { quantity: true } }))._sum.quantity ?? 0;

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role] of [['ADMIN', 'ADMIN'], ['SALES', 'SALES'], ['WAREHOUSE', 'WAREHOUSE']] as const) {
      const user = await createTestUser(app, role, `SO${S}`);
      H[key] = user.headers;
      U[key] = user.id;
    }
    const branch = await prisma.branch.create({ data: { code: `SORACE-${S}`, name: 'Carreras de ventas' } });
    const loc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `SORACE-${S}`, name: 'Bodega carreras de ventas' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: loc.id, number: 1 } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } });
    Object.assign(ids, { branch: branch.id, loc: loc.id, aisle: aisle.id, rack: rack.id });
    await prisma.user.update({ where: { id: U.WAREHOUSE }, data: { defaultInventoryLocationId: loc.id } });
    ids.ref = (await prisma.reference.create({ data: { code: `SORACE-REF-${S}` } })).id;
    ids.finishA = (await prisma.finish.create({ data: { code: `SORACE-A-${S}` } })).id;
    ids.finishB = (await prisma.finish.create({ data: { code: `SORACE-B-${S}` } })).id;
    ids.supplier1 = (await prisma.supplier.create({ data: { code: `SORACE-N1-${S}`, name: 'Nacional 1 carreras', origins: ['NATIONAL'] } })).id;
    ids.supplier2 = (await prisma.supplier.create({ data: { code: `SORACE-N2-${S}`, name: 'Nacional 2 carreras', origins: ['NATIONAL'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente carreras ventas ${S}`, createdById: U.SALES } })).id;
    // Enabled sale prices for both finishes, from this run's own purchase.
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.supplier1,
        documentNumber: `SORACE-${S}`,
        documentDate: '2026-10-20',
        lines: [ids.finishA, ids.finishB].map((finishId) => ({ referenceId: ids.ref, finishId, origin: 'NATIONAL', quantity: 10, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' })),
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
      const orders = await prisma.salesOrder.findMany({ where: { createdById: { in: users } }, select: { id: true } });
      const oIds = orders.map((o) => o.id);
      const dIds = (await prisma.dispatch.findMany({ where: { salesOrderId: { in: oIds } }, select: { id: true } })).map((d) => d.id);
      const bIds = (await prisma.bundle.findMany({ where: { referenceId: ids.ref }, select: { id: true } })).map((b) => b.id);
      const steps: [string, () => Promise<{ count: number }>][] = [
        ['outbox', () => prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } })],
        ['incidents', () => prisma.dispatchIncident.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['observations', () => prisma.readerObservation.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['picks', () => prisma.dispatchPick.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['reservations', () => prisma.stockReservation.deleteMany({ where: { bundleId: { in: bIds } } })],
        ['tasks', () => prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } })],
        ['movements', () => prisma.inventoryMovement.deleteMany({ where: { bundleId: { in: bIds } } })],
        ['dispatchLines', () => prisma.dispatchLine.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['dispatches', () => prisma.dispatch.deleteMany({ where: { id: { in: dIds } } })],
        ['orderLines', () => prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: oIds } } })],
        ['orders', () => prisma.salesOrder.deleteMany({ where: { id: { in: oIds } } })],
        ['quotes', () => prisma.quote.deleteMany({ where: { createdById: { in: users } } })],
        ['customer', () => prisma.customer.deleteMany({ where: { id: ids.customer } })],
        ['bundles', () => prisma.bundle.deleteMany({ where: { id: { in: bIds } } })],
        ['lots', () => prisma.stockLot.deleteMany({ where: { referenceId: ids.ref } })],
        ['salePrices', () => prisma.salePrice.deleteMany({ where: { referenceId: ids.ref } })],
        ['purchases', () => prisma.purchase.deleteMany({ where: { createdById: { in: users } } })],
        ['suppliers', () => prisma.supplier.deleteMany({ where: { id: { in: [ids.supplier1, ids.supplier2] } } })],
        ['audit', () => prisma.auditEvent.deleteMany({ where: { userId: { in: users } } })],
        ['users', () => prisma.user.deleteMany({ where: { id: { in: users } } })],
        ['reference', () => prisma.reference.deleteMany({ where: { id: ids.ref } })],
        ['finishes', () => prisma.finish.deleteMany({ where: { id: { in: [ids.finishA, ids.finishB] } } })],
        ['rack', () => prisma.rack.deleteMany({ where: { id: ids.rack } })],
        ['aisle', () => prisma.aisle.deleteMany({ where: { id: ids.aisle } })],
        ['location', () => prisma.inventoryLocation.deleteMany({ where: { id: ids.loc } })],
        ['branch', () => prisma.branch.deleteMany({ where: { id: ids.branch } })],
      ];
      for (const [, step] of steps) await step();
    }
    await app?.close();
  });

  // --- Quotes ------------------------------------------------------------------

  it('the same conversion sent twice (double click / retry with the same key): one order, same answer', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await quote([line(1)]);
      const key = randomUUID();
      const results = await together([1, 2].map(() => () => http().post(`/quotes/${q.id}/convert`).set(as('SALES')).send({ operationKey: key })));
      const same = results[0].body.id === results[1].body.id;
      outcomes.push(`${statuses(results)}:${await prisma.salesOrder.count({ where: { quoteId: q.id } })}:${same}`);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/200:1:true'));
  });

  it('editing a quote while it is converted: the order always carries the quote it was made from', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await quote([line(3)]);
      const [converted, edited] = await together([
        () => http().post(`/quotes/${q.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }),
        () => http().patch(`/quotes/${q.id}`).set(as('SALES')).send({ customerId: ids.customer, paymentMethod: 'CASH', lines: [line(7)] }),
      ]);
      expect(converted.status).toBe(200);
      const saved = await prisma.quote.findUniqueOrThrow({ where: { id: q.id }, include: { lines: true } });
      const made = await prisma.salesOrder.findUniqueOrThrow({ where: { quoteId: q.id }, include: { lines: true } });
      // The quote is frozen once converted, and the order equals it.
      expect(saved.status).toBe('CONVERTED');
      expect(made.lines.map((l) => l.quantity)).toEqual(saved.lines.map((l) => l.quantity));
      expect(made.total.toString()).toBe(saved.total.toString());
      // Edit first (7 profiles, 200) or conversion first (3 profiles, 409).
      expect([`200:7`, `409:3`]).toContain(`${edited.status}:${made.lines[0].quantity}`);
      outcomes.add(`${edited.status}:${made.lines[0].quantity}`);
    }
    console.info('edit vs convert outcomes:', [...outcomes].join(', '));
  });

  it('cancelling a quote while it is converted: never a cancelled quote with an order', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const q = await quote([line(1)]);
      const [converted, cancelled] = await Promise.all([
        http().post(`/quotes/${q.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }),
        http().post(`/quotes/${q.id}/cancel`).set(as('SALES')),
      ]);
      const status = (await prisma.quote.findUniqueOrThrow({ where: { id: q.id } })).status;
      const orders = await prisma.salesOrder.count({ where: { quoteId: q.id } });
      expect([`200/409:CONVERTED:1`, `409/200:CANCELLED:0`]).toContain(`${converted.status}/${cancelled.status}:${status}:${orders}`);
    }
  });

  // --- Order confirmation (reservations) ---------------------------------------------

  it('the same order confirmed twice at once: profiles reserved exactly once', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(10);
      const o = await order([line(6)]);
      const results = await together([() => confirm(o.id), () => confirm(o.id)]);
      const status = (await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).status;
      outcomes.push(`${statuses(results)}:${status}:${await active({ salesOrderLine: { salesOrderId: o.id } })}`);
      await cancelOrder(o.id).expect(200);
      await retire(bundle.id);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/200:CONFIRMED:6'));
  });

  it('confirming and cancelling the same order at once: a cancelled order never keeps reservations', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(10);
      const o = await order([line(6)]);
      const [confirmed, cancelled] = await together([() => confirm(o.id), () => cancelOrder(o.id)]);
      const status = (await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).status;
      expect(cancelled.status).toBe(200);
      expect(status).toBe('CANCELLED');
      expect(await active({ bundleId: bundle.id })).toBe(0);
      // Cancel first: the confirmation is refused. Confirm first: it reserved,
      // then the cancellation released it.
      expect([200, 409]).toContain(confirmed.status);
      outcomes.add(String(confirmed.status));
      await retire(bundle.id);
    }
    console.info('confirm vs cancel outcomes (confirm status):', [...outcomes].join(', '));
  });

  it('confirming an order while the same bundle has a manual exit: never more committed than exists', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(10);
      const o = await order([line(8)]);
      const [confirmed, exited] = await together([
        () => confirm(o.id),
        () => http().post(`/inventory/bundles/${bundle.id}/exit`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), quantity: 5 }),
      ]);
      const left = (await prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity;
      const reserved = await active({ bundleId: bundle.id });
      expect(reserved).toBeLessThanOrEqual(left);
      // Reservation first (exit refused, 2 free < 5) or exit first (order
      // waits for supply: 5 left < 8).
      const outcome = `${confirmed.status}:${confirmed.body.confirmed}/${exited.status}:${left}:${reserved}`;
      expect(['200:true/409:10:8', '200:false/201:5:0']).toContain(outcome);
      outcomes.add(outcome);
      await cancelOrder(o.id).expect(200);
      await retire(bundle.id);
    }
    console.info('confirm vs manual exit outcomes:', [...outcomes].join(', '));
  });

  it('changing the required supplier while the order is confirmed: reservations always match the line', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const from1 = await register(10, ids.finishA, ids.supplier1);
      const from2 = await register(10, ids.finishA, ids.supplier2);
      const o = await order([line(4)]);
      const [confirmed, changed] = await together([
        () => confirm(o.id),
        () =>
          http()
            .patch(`/sales-orders/${o.id}/lines/${o.lines[0].id}`)
            .set(as('SALES'))
            .send({ origin: 'NATIONAL', supplierId: ids.supplier2, reason: 'El cliente exige el proveedor 2' }),
      ]);
      const orderLine = await prisma.salesOrderLine.findUniqueOrThrow({ where: { id: o.lines[0].id } });
      const reservations = await prisma.stockReservation.findMany({ where: { salesOrderLineId: orderLine.id, status: 'ACTIVE' }, include: { bundle: { include: { lot: true } } } });
      expect(confirmed.status).toBe(200);
      expect(reservations.reduce((total, r) => total + r.quantity, 0)).toBe(4);
      // Every reserved bundle satisfies the line as it is now.
      if (orderLine.supplierId) expect(reservations.every((r) => r.bundle.lot?.supplierId === orderLine.supplierId)).toBe(true);
      // Change first (reserved from supplier 2) or confirmation first (change refused).
      const outcome = `${changed.status}:${orderLine.supplierId === ids.supplier2 ? 'proveedor2' : 'cualquiera'}`;
      expect(['200:proveedor2', '409:cualquiera']).toContain(outcome);
      outcomes.add(outcome);
      await cancelOrder(o.id).expect(200);
      await retire(from1.id);
      await retire(from2.id);
    }
    console.info('supplier change vs confirm outcomes:', [...outcomes].join(', '));
  });

  it('two orders with the same two materials in opposite order: no deadlock, nothing over-committed', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const a = await register(10, ids.finishA);
      const b = await register(10, ids.finishB);
      const first = await order([line(6, ids.finishA), line(6, ids.finishB)]);
      const second = await order([line(6, ids.finishB), line(6, ids.finishA)]);
      const results = await together([() => confirm(first.id), () => confirm(second.id)]);
      const confirmed = results.filter((r) => r.body.confirmed).length;
      outcomes.push(`${statuses(results)}:${confirmed}c:${await active({ bundleId: a.id })}/${await active({ bundleId: b.id })}`);
      for (const o of [first, second]) await cancelOrder(o.id).expect(200);
      await retire(a.id);
      await retire(b.id);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/200:1c:6/6'));
  });

  // --- Dispatches created from an order -----------------------------------------------

  it('the same dispatch creation sent twice (same key): one dispatch, same answer', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(5);
      const o = await order([line(5)]);
      await confirm(o.id).expect(200);
      const body = { operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(4), lines: [{ salesOrderLineId: o.lines[0].id, quantity: 5 }] };
      const results = await together([1, 2].map(() => () => http().post(`/sales-orders/${o.id}/dispatches`).set(as('SALES')).send(body)));
      const same = results[0].body.id === results[1].body.id;
      outcomes.push(`${statuses(results)}:${await prisma.dispatch.count({ where: { salesOrderId: o.id } })}:${same}`);
      await cancelOrder(o.id).expect(200);
      await retire(bundle.id);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('201/201:1:true'));
  });

  it('two different dispatches for the whole order at once: only one is authorised', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(5);
      const o = await order([line(5)]);
      await confirm(o.id).expect(200);
      const results = await together(
        [1, 2].map(() => () =>
          http()
            .post(`/sales-orders/${o.id}/dispatches`)
            .set(as('SALES'))
            .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(4), lines: [{ salesOrderLineId: o.lines[0].id, quantity: 5 }] }),
        ),
      );
      const authorised = (await prisma.dispatchLine.aggregate({ where: { dispatch: { salesOrderId: o.id } }, _sum: { quantity: true } }))._sum.quantity;
      outcomes.push(`${statuses(results)}:${await prisma.dispatch.count({ where: { salesOrderId: o.id } })}:${authorised}`);
      await cancelOrder(o.id).expect(200);
      await retire(bundle.id);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('201/400:1:5'));
  });

  it('cancelling the order while its partial dispatch is confirmed: a confirmed exit is never marked cancelled', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(10);
      const o = await order([line(10)]);
      await confirm(o.id).expect(200);
      // Half of the order: the order stays open after this exit.
      const dispatch = (
        await http()
          .post(`/sales-orders/${o.id}/dispatches`)
          .set(as('SALES'))
          .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(4), lines: [{ salesOrderLineId: o.lines[0].id, quantity: 5 }] })
          .expect(201)
      ).body as { id: string };
      await http().post(`/dispatches/${dispatch.id}/scan`).set(as('WAREHOUSE')).send({ epc: bundle.epc }).expect(200);
      const [exited, cancelled] = await together([
        () => http().post(`/dispatches/${dispatch.id}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }),
        () => cancelOrder(o.id),
      ]);
      const final = await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id }, include: { picks: true } });
      const exits = await prisma.inventoryMovement.count({ where: { dispatchId: dispatch.id, type: 'EXIT' } });
      const left = (await prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity;
      const orderStatus = (await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).status;
      // Exit first (dispatch confirmed, 5 left, order then cancelled with its
      // delivered half) or cancellation first (no exit, dispatch cancelled).
      const outcome = `${exited.status}/${cancelled.status}:${final.status}:${exits}x:${left}:${final.picks.length}p:${orderStatus}:${await active({ bundleId: bundle.id })}r`;
      expect(['200/200:CONFIRMED:1x:5:1p:CANCELLED:0r', '409/200:CANCELLED:0x:10:0p:CANCELLED:0r']).toContain(outcome);
      outcomes.add(outcome);
      await retire(bundle.id);
    }
    console.info('partial dispatch confirm vs order cancel outcomes:', [...outcomes].join(', '));
  });

  it('cancelling the order while its full dispatch is confirmed: one wins cleanly, no deadlock', async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const bundle = await register(5);
      const o = await order([line(5)]);
      await confirm(o.id).expect(200);
      const dispatch = (
        await http()
          .post(`/sales-orders/${o.id}/dispatches`)
          .set(as('SALES'))
          .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(4), lines: [{ salesOrderLineId: o.lines[0].id, quantity: 5 }] })
          .expect(201)
      ).body as { id: string };
      await http().post(`/dispatches/${dispatch.id}/scan`).set(as('WAREHOUSE')).send({ epc: bundle.epc }).expect(200);
      const [exited, cancelled] = await together([
        () => http().post(`/dispatches/${dispatch.id}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }),
        () => cancelOrder(o.id),
      ]);
      const final = await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } });
      const exits = await prisma.inventoryMovement.count({ where: { dispatchId: dispatch.id, type: 'EXIT' } });
      const orderStatus = (await prisma.salesOrder.findUniqueOrThrow({ where: { id: o.id } })).status;
      // Exit first (order delivered, cancellation refused) or cancellation first.
      const outcome = `${exited.status}/${cancelled.status}:${final.status}:${exits}x:${orderStatus}`;
      expect(['200/409:CONFIRMED:1x:COMPLETED', '409/200:CANCELLED:0x:CANCELLED']).toContain(outcome);
      outcomes.add(outcome);
      await retire(bundle.id);
    }
    console.info('full dispatch confirm vs order cancel outcomes:', [...outcomes].join(', '));
  });
});
