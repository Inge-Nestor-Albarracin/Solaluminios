import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { barrierAtTransactionStart, createBarrier, ledgerProblems } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Opened bundles and loose profiles, on the real PostgreSQL test database:
// opening keeps the total, deliveries discount automatically at the
// confirmation, existing loose profiles are used before any closed bundle,
// incompatible material is never offered, and two dispatches cannot take the
// same loose profiles.
const ROUNDS = 20;

interface LooseLine {
  id: string;
  authorised: number;
  pending: number;
  loose: { assigned: number; prepared: number; toTake: number; missing: number; places: string[] };
  suggested: { bundleId: string; epc: string; quantity: number; bundleQuantity: number; needsOpening: boolean }[];
}

describe('Opened bundles and loose profiles (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { branch: '', loc: '', aisle: '', rack: '', ref: '', finishA: '', finishB: '', finishC: '', n1: '', n2: '', cn: '', customer: '' };
  let n = 0;
  let ip = 0;
  const epc = () => `LOOSE${S}${String(++n).padStart(5, '0')}`;
  const http = () => request(app.getHttpServer());
  // Each request is its own client (own IP behind the trusted proxy).
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.32.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  const register = async (quantity: number, options: { finishId?: string; supplierId?: string | null } = {}) => {
    const supplierId = options.supplierId === undefined ? ids.n1 : options.supplierId;
    const res = await http()
      .post('/inventory/bundles')
      .set(as('WAREHOUSE'))
      .send({
        epc: epc(),
        referenceId: ids.ref,
        finishId: options.finishId ?? ids.finishA,
        quantity,
        inventoryLocationId: ids.loc,
        rackId: ids.rack,
        registrationType: 'ENTRY',
        arrivalDatePrecision: 'UNKNOWN',
        ...(supplierId ? { origin: 'NATIONAL', supplierId } : {}),
      })
      .expect(201);
    return res.body as { id: string; epc: string };
  };
  const open = (bundleId: string, operationKey = randomUUID(), who = 'WAREHOUSE') =>
    http().post(`/inventory/bundles/${bundleId}/open`).set(as(who)).send({ operationKey });
  const bundle = (id: string) => prisma.bundle.findUniqueOrThrow({ where: { id } });
  const active = async (where: object) => (await prisma.stockReservation.aggregate({ where: { status: 'ACTIVE', ...where }, _sum: { quantity: true } }))._sum.quantity ?? 0;

  const order = async (quantity: number, options: { finishId?: string; supplierId?: string } = {}) => {
    const quote = await http()
      .post('/quotes')
      .set(as('SALES'))
      .send({
        customerId: ids.customer,
        paymentMethod: 'CASH',
        lines: [{ referenceId: ids.ref, finishId: options.finishId ?? ids.finishA, origin: 'NATIONAL', quantity, discountPercent: '0', taxRatePercent: '19', ...(options.supplierId ? { supplierId: options.supplierId } : {}) }],
      })
      .expect(201);
    const converted = (await http().post(`/quotes/${quote.body.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }).expect(200)).body as { id: string; lines: { id: string }[] };
    const confirmed = await http().post(`/sales-orders/${converted.id}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.loc }).expect(200);
    expect(confirmed.body.confirmed).toBe(true);
    return converted;
  };
  const createDispatch = (o: { id: string; lines: { id: string }[] }, quantity: number) =>
    http()
      .post(`/sales-orders/${o.id}/dispatches`)
      .set(as('SALES'))
      .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(4), lines: [{ salesOrderLineId: o.lines[0].id, quantity }] });
  const detail = async (dispatchId: string) => (await http().get(`/dispatches/${dispatchId}`).set(as('WAREHOUSE')).expect(200)).body as { lines: LooseLine[]; progress: { readyToConfirm: boolean } };
  const prepareLoose = (dispatchId: string, lineId: string, quantity: number) =>
    http().post(`/dispatches/${dispatchId}/loose/prepare`).set(as('WAREHOUSE')).send({ lines: [{ dispatchLineId: lineId, quantity }] });
  const confirm = (dispatchId: string, operationKey: string) => http().post(`/dispatches/${dispatchId}/confirm`).set(as('WAREHOUSE')).send({ operationKey });
  const summary = async () =>
    (await http().get(`/inventory/summary?referenceId=${ids.ref}&finishId=${ids.finishA}&inventoryLocationId=${ids.loc}`).set(as('WAREHOUSE')).expect(200)).body.totals as {
      profiles: number;
      bundles: number;
      looseProfiles: number;
    };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role] of [['ADMIN', 'ADMIN'], ['SALES', 'SALES'], ['WAREHOUSE', 'WAREHOUSE'], ['WAREHOUSE2', 'WAREHOUSE']] as const) {
      const user = await createTestUser(app, role, `LS${key === 'WAREHOUSE2' ? '2' : ''}${S}`);
      H[key] = user.headers;
      U[key] = user.id;
    }
    const branch = await prisma.branch.create({ data: { code: `LOOSE-${S}`, name: 'Sueltos' } });
    const loc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `LOOSE-${S}`, name: 'Almacén sueltos' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: loc.id, number: 3 } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 4 } });
    Object.assign(ids, { branch: branch.id, loc: loc.id, aisle: aisle.id, rack: rack.id });
    await prisma.user.updateMany({ where: { id: { in: [U.WAREHOUSE, U.WAREHOUSE2] } }, data: { defaultInventoryLocationId: loc.id } });
    ids.ref = (await prisma.reference.create({ data: { code: `LOOSE-REF-${S}` } })).id;
    ids.finishA = (await prisma.finish.create({ data: { code: `LOOSE-A-${S}`, description: 'Champaña' } })).id;
    ids.finishB = (await prisma.finish.create({ data: { code: `LOOSE-B-${S}`, description: 'Negro' } })).id;
    ids.finishC = (await prisma.finish.create({ data: { code: `LOOSE-C-${S}`, description: 'Bronce' } })).id;
    ids.n1 = (await prisma.supplier.create({ data: { code: `LOOSE-N1-${S}`, name: 'Nacional uno sueltos', origins: ['NATIONAL'] } })).id;
    ids.n2 = (await prisma.supplier.create({ data: { code: `LOOSE-N2-${S}`, name: 'Nacional dos sueltos', origins: ['NATIONAL'] } })).id;
    ids.cn = (await prisma.supplier.create({ data: { code: `LOOSE-CN-${S}`, name: 'China sueltos', origins: ['CHINA'] } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente sueltos ${S}`, createdById: U.SALES } })).id;
    // Enabled national sale prices of the three colours (this run's purchase).
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.n1,
        documentNumber: `LOOSE-${S}`,
        documentDate: '2026-10-20',
        lines: [ids.finishA, ids.finishB, ids.finishC].map((finishId) => ({ referenceId: ids.ref, finishId, origin: 'NATIONAL', quantity: 10, grossAmount: '10000', discountPercent: '0', taxRatePercent: '0' })),
      })
      .expect(201);
    const confirmed = await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200);
    for (const line of confirmed.body.lines as { id: string }[]) {
      await http().post('/sale-prices').set(as('ADMIN')).send({ purchaseId: purchase.body.id, purchaseLineId: line.id, markupPercent: '30', enabled: true }).expect(201);
    }
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      const users = Object.values(U);
      const oIds = (await prisma.salesOrder.findMany({ where: { createdById: { in: users } }, select: { id: true } })).map((o) => o.id);
      const dIds = (await prisma.dispatch.findMany({ where: { salesOrderId: { in: oIds } }, select: { id: true } })).map((d) => d.id);
      const bIds = (await prisma.bundle.findMany({ where: { referenceId: ids.ref }, select: { id: true } })).map((b) => b.id);
      const steps: (() => Promise<unknown>)[] = [
        () => prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } }),
        () => prisma.dispatchIncident.deleteMany({ where: { dispatchId: { in: dIds } } }),
        () => prisma.readerObservation.deleteMany({ where: { dispatchId: { in: dIds } } }),
        () => prisma.dispatchPick.deleteMany({ where: { dispatchId: { in: dIds } } }),
        () => prisma.stockReservation.deleteMany({ where: { bundleId: { in: bIds } } }),
        () => prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } }),
        () => prisma.inventoryMovement.deleteMany({ where: { bundleId: { in: bIds } } }),
        () => prisma.dispatchLine.deleteMany({ where: { dispatchId: { in: dIds } } }),
        () => prisma.dispatch.deleteMany({ where: { id: { in: dIds } } }),
        () => prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: oIds } } }),
        () => prisma.salesOrder.deleteMany({ where: { id: { in: oIds } } }),
        () => prisma.quote.deleteMany({ where: { createdById: { in: users } } }),
        () => prisma.customer.deleteMany({ where: { id: ids.customer } }),
        () => prisma.bundle.deleteMany({ where: { id: { in: bIds } } }),
        () => prisma.stockLot.deleteMany({ where: { referenceId: ids.ref } }),
        () => prisma.salePrice.deleteMany({ where: { referenceId: ids.ref } }),
        () => prisma.purchase.deleteMany({ where: { createdById: { in: users } } }),
        () => prisma.supplier.deleteMany({ where: { id: { in: [ids.n1, ids.n2, ids.cn] } } }),
        () => prisma.auditEvent.deleteMany({ where: { userId: { in: users } } }),
        () => prisma.user.deleteMany({ where: { id: { in: users } } }),
        () => prisma.reference.deleteMany({ where: { id: ids.ref } }),
        () => prisma.finish.deleteMany({ where: { id: { in: [ids.finishA, ids.finishB, ids.finishC] } } }),
        () => prisma.rack.deleteMany({ where: { id: ids.rack } }),
        () => prisma.aisle.deleteMany({ where: { id: ids.aisle } }),
        () => prisma.inventoryLocation.deleteMany({ where: { id: ids.loc } }),
        () => prisma.branch.deleteMany({ where: { id: ids.branch } }),
      ];
      for (const step of steps) await step();
    }
    await app?.close();
  });

  // Shared between the ordered tests of the scenario.
  const s = {} as Record<string, { id: string; epc: string }>;

  it('1-2 opening a bundle of 30 gives 30 loose profiles, keeps the total and is never repeated', async () => {
    s.l1 = await register(30);
    expect(await summary()).toEqual({ profiles: 30, bundles: 1, looseProfiles: 0 });
    const key = randomUUID();
    const opened = await open(s.l1.id, key).expect(201);
    expect(opened.body.movement).toMatchObject({ type: 'OPENING', quantity: 30, quantityBefore: 30, quantityAfter: 30, performedBy: { id: U.WAREHOUSE } });
    expect(opened.body.bundle).toMatchObject({ epc: s.l1.epc, quantity: 30, openedBy: { id: U.WAREHOUSE } });
    expect(opened.body.bundle.openedAt).not.toBeNull();
    // Same total, now loose; the bundle is no longer counted as closed.
    expect(await summary()).toEqual({ profiles: 30, bundles: 0, looseProfiles: 30 });
    // Retry with the same key: same answer, nothing new.
    expect((await open(s.l1.id, key).expect(200)).body.replayed).toBe(true);
    // Another opening of the same bundle is refused, by the API and the database.
    expect((await open(s.l1.id).expect(409)).body.message).toMatch(/ya fue abierto/);
    await expect(prisma.bundle.update({ where: { id: s.l1.id }, data: { openedAt: null, openedById: null } })).rejects.toThrow();
    expect(await prisma.inventoryMovement.count({ where: { bundleId: s.l1.id, type: 'OPENING' } })).toBe(1);
    expect(await summary()).toEqual({ profiles: 30, bundles: 0, looseProfiles: 30 });
    expect(await ledgerProblems(prisma, [s.l1.id])).toEqual([]);
    // An empty bundle has nothing to open; SALES cannot open bundles.
    const other = await register(3);
    await open(other.id, randomUUID(), 'SALES').expect(403);
    await http().post(`/inventory/bundles/${other.id}/exit`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), quantity: 3 }).expect(201);
    expect((await open(other.id).expect(409)).body.message).toMatch(/agotado/);
  });

  it('2 two openings of the same bundle at once with different keys: one opening (20 rounds)', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const b = await register(12);
      barrierAtTransactionStart(prisma, 2, createBarrier(2));
      const results = await Promise.all([open(b.id, randomUUID(), 'WAREHOUSE'), open(b.id, randomUUID(), 'WAREHOUSE2')]).finally(() => vi.restoreAllMocks());
      const statuses = results.map((r) => r.status).sort((a, b) => a - b).join('/');
      outcomes.push(`${statuses}:${await prisma.inventoryMovement.count({ where: { bundleId: b.id, type: 'OPENING' } })}:${(await bundle(b.id)).quantity}`);
      // Out of later scenarios (test fixture only).
      await prisma.bundle.update({ where: { id: b.id }, data: { quantity: 0 } });
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('201/409:1:12'));
  });

  it('3 + 8 delivering 25 of the 30 loose profiles discounts them at the confirmation, once', async () => {
    const o = await order(25);
    // Reserved on the loose profiles (loose first).
    expect(await active({ bundleId: s.l1.id, salesOrderLine: { salesOrderId: o.id } })).toBe(25);
    const dispatch = (await createDispatch(o, 25).expect(201)).body as { id: string };
    const [line] = (await detail(dispatch.id)).lines;
    expect(line.loose).toMatchObject({ assigned: 25, prepared: 0, toTake: 25, missing: 0 });
    expect(line.loose.places).toEqual(['Pasillo 3 · Burro 4']);
    expect(line.suggested).toEqual([]);
    // Preparing or reserving is not delivering.
    expect((await bundle(s.l1.id)).quantity).toBe(30);
    // The screen must send what it showed: a different amount prepares nothing.
    await prepareLoose(dispatch.id, line.id, 20).expect(409);
    const prepared = (await prepareLoose(dispatch.id, line.id, 25).expect(200)).body as { lines: LooseLine[]; progress: { readyToConfirm: boolean } };
    expect(prepared.lines[0]).toMatchObject({ pending: 0, loose: { assigned: 25, prepared: 25, toTake: 0, missing: 0 } });
    expect(prepared.progress.readyToConfirm).toBe(true);
    await prepareLoose(dispatch.id, line.id, 25).expect(200); // repeated: nothing changes
    expect(await prisma.dispatchPick.count({ where: { dispatchId: dispatch.id } })).toBe(1);
    expect((await bundle(s.l1.id)).quantity).toBe(30);

    const key = randomUUID();
    await confirm(dispatch.id, key).expect(200);
    expect((await bundle(s.l1.id)).quantity).toBe(5);
    // Repeated confirmation (same key): previous result, no second discount.
    await confirm(dispatch.id, key).expect(200);
    expect((await bundle(s.l1.id)).quantity).toBe(5);
    expect(await prisma.inventoryMovement.count({ where: { dispatchId: dispatch.id, type: 'EXIT' } })).toBe(1);
    expect(await summary()).toEqual({ profiles: 5, bundles: 0, looseProfiles: 5 });
    expect((await prisma.task.findUniqueOrThrow({ where: { dispatchId: dispatch.id } })).completedAt).not.toBeNull();
    expect(await ledgerProblems(prisma, [s.l1.id])).toEqual([]);
  });

  it('4 the next order of 5 uses those 5 loose profiles and does not open another bundle', async () => {
    s.c30 = await register(30); // closed, older loose profiles must go first
    const o = await order(5);
    expect(await active({ bundleId: s.l1.id, salesOrderLine: { salesOrderId: o.id } })).toBe(5);
    expect(await active({ bundleId: s.c30.id })).toBe(0);
    const dispatch = (await createDispatch(o, 5).expect(201)).body as { id: string };
    const [line] = (await detail(dispatch.id)).lines;
    expect(line.loose).toMatchObject({ assigned: 5, missing: 0 });
    await prepareLoose(dispatch.id, line.id, 5).expect(200);
    await confirm(dispatch.id, randomUUID()).expect(200);
    expect((await bundle(s.l1.id)).quantity).toBe(0);
    expect(await bundle(s.c30.id)).toMatchObject({ quantity: 30, openedAt: null });
  });

  it('5 an order of 25 with 5 loose profiles uses them first and shows 20 missing; opening a bundle of 30 leaves 10 loose', async () => {
    s.d5 = await register(5);
    await open(s.d5.id).expect(201);
    const o = await order(25);
    expect(await active({ bundleId: s.d5.id, salesOrderLine: { salesOrderId: o.id } })).toBe(5);
    expect(await active({ bundleId: s.c30.id, salesOrderLine: { salesOrderId: o.id } })).toBe(20);
    const dispatch = (await createDispatch(o, 25).expect(201)).body as { id: string };
    let [line] = (await detail(dispatch.id)).lines;
    expect(line.loose).toMatchObject({ assigned: 5, toTake: 5, missing: 20 });
    expect(line.suggested).toEqual([expect.objectContaining({ bundleId: s.c30.id, quantity: 20, bundleQuantity: 30, needsOpening: true })]);
    // A closed bundle read now only covers the missing 20, never the 5 loose.
    const scan = await http().post(`/dispatches/${dispatch.id}/scan`).set(as('WAREHOUSE')).send({ epc: s.c30.epc }).expect(200);
    expect(scan.body).toMatchObject({ result: 'PREPARED', quantity: 20 });
    await http().patch(`/dispatches/${dispatch.id}/picks/${s.c30.id}`).set(as('WAREHOUSE')).send({ quantity: 0 }).expect(200);
    // Open the bundle (traslado ya hecho: está en el almacén del despacho).
    await open(s.c30.id).expect(201);
    expect(await active({ bundleId: s.c30.id, salesOrderLine: { salesOrderId: o.id } })).toBe(20); // reservation kept, never released
    [line] = ((await http().post(`/dispatches/${dispatch.id}/loose/refresh`).set(as('WAREHOUSE')).expect(200)).body as { lines: LooseLine[] }).lines;
    expect(line.loose).toMatchObject({ assigned: 25, toTake: 25, missing: 0 });
    expect(line.suggested).toEqual([]);
    // Scanning an opened bundle does not prepare anything: its profiles are loose.
    expect((await http().post(`/dispatches/${dispatch.id}/scan`).set(as('WAREHOUSE')).send({ epc: s.c30.epc }).expect(200)).body.result).toBe('OPENED');
    await prepareLoose(dispatch.id, line.id, 25).expect(200);
    await confirm(dispatch.id, randomUUID()).expect(200);
    expect((await bundle(s.d5.id)).quantity).toBe(0);
    expect((await bundle(s.c30.id)).quantity).toBe(10);
    expect(await summary()).toEqual({ profiles: 10, bundles: 0, looseProfiles: 10 });
    expect(await ledgerProblems(prisma, [s.d5.id, s.c30.id])).toEqual([]);
  });

  it('6 another colour, unknown or Chinese origin and another supplier are never offered', async () => {
    // Loose profiles that do NOT fit a national order of colour A from any supplier.
    const otherColour = await register(40, { finishId: ids.finishB });
    const unknown = await register(20, { supplierId: null });
    const chinese = await register(15, { supplierId: null });
    const chinaLot = await http()
      .post('/lots/opening')
      .set(as('ADMIN'))
      .send({ referenceId: ids.ref, finishId: ids.finishA, origin: 'CHINA', supplierId: ids.cn, notes: 'Clasificado como China (prueba)' })
      .expect(201);
    await http().post(`/lots/${chinaLot.body.id}/bundles`).set(as('ADMIN')).send({ bundleIds: [chinese.id] }).expect((res) => expect([200, 201]).toContain(res.status));
    // Loose profiles of colour A from supplier N2 (fit only orders without supplier or N2).
    const fromN2 = await register(7, { supplierId: ids.n2 });
    for (const b of [otherColour, unknown, chinese, fromN2]) await open(b.id).expect(201);
    const closedN1 = await register(20);

    // Requires supplier N2: only N2's loose profiles, never N1's (C30 has 10 loose).
    const n2Only = await order(5, { supplierId: ids.n2 });
    expect(await active({ salesOrderLine: { salesOrderId: n2Only.id } })).toBe(5);
    expect(await active({ bundleId: fromN2.id, salesOrderLine: { salesOrderId: n2Only.id } })).toBe(5);
    // Any national supplier, 15: the 10 of C30 and the 2 left of N2 (loose), then 3 from a closed bundle.
    const any = await order(15);
    expect(await active({ bundleId: s.c30.id, salesOrderLine: { salesOrderId: any.id } })).toBe(10);
    expect(await active({ bundleId: fromN2.id, salesOrderLine: { salesOrderId: any.id } })).toBe(2);
    expect(await active({ bundleId: closedN1.id, salesOrderLine: { salesOrderId: any.id } })).toBe(3);
    for (const b of [otherColour, unknown, chinese]) expect(await active({ bundleId: b.id })).toBe(0);
    const dispatch = (await createDispatch(any, 15).expect(201)).body as { id: string };
    const [line] = (await detail(dispatch.id)).lines;
    expect(line.loose).toMatchObject({ assigned: 12, missing: 3 });
    expect(line.suggested).toEqual([expect.objectContaining({ bundleId: closedN1.id, quantity: 3, needsOpening: true })]);
    // Free up for the next scenario.
    for (const o of [n2Only, any]) await http().post(`/sales-orders/${o.id}/cancel`).set(as('SALES')).send({ reason: 'Fin del escenario' }).expect(200);
    for (const b of [otherColour, unknown, chinese, fromN2, closedN1]) await prisma.bundle.update({ where: { id: b.id }, data: { quantity: 0 } });
    await prisma.bundle.update({ where: { id: s.c30.id }, data: { quantity: 0 } });
  });

  it('a closed bundle that leaves only in part is opened at the confirmation; the rest stays loose', async () => {
    const z = await register(10, { finishId: ids.finishC });
    const o = await order(4, { finishId: ids.finishC });
    const dispatch = (await createDispatch(o, 4).expect(201)).body as { id: string };
    const scan = await http().post(`/dispatches/${dispatch.id}/scan`).set(as('WAREHOUSE')).send({ epc: z.epc }).expect(200);
    expect(scan.body).toMatchObject({ result: 'PREPARED', quantity: 4 });
    expect(scan.body.message).toMatch(/queda abierto/);
    const key = randomUUID();
    await confirm(dispatch.id, key).expect(200);
    await confirm(dispatch.id, key).expect(200);
    const after = await bundle(z.id);
    expect(after.quantity).toBe(6);
    expect(after.openedAt).not.toBeNull();
    const movements = await prisma.inventoryMovement.findMany({ where: { bundleId: z.id }, orderBy: { createdAt: 'asc' } });
    expect(movements.map((m) => m.type)).toEqual(['ENTRY', 'OPENING', 'EXIT']);
    expect(await ledgerProblems(prisma, [z.id])).toEqual([]);
  });

  it('7 two dispatches created at once cannot take the same loose profiles (20 rounds)', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      // Both orders reserve closed bundles; then 5 free loose profiles appear.
      const c1 = await register(5);
      const c2 = await register(5);
      const p = await order(5);
      const q = await order(5);
      const loose = await register(5);
      await open(loose.id).expect(201);
      barrierAtTransactionStart(prisma, 2, createBarrier(2));
      const results = await Promise.all([createDispatch(p, 5), createDispatch(q, 5)]).finally(() => vi.restoreAllMocks());
      const onLoose = await active({ bundleId: loose.id });
      const holders = (await prisma.stockReservation.findMany({ where: { bundleId: loose.id, status: 'ACTIVE' }, select: { salesOrderLine: { select: { salesOrderId: true } } } })).map(
        (r) => r.salesOrderLine.salesOrderId,
      );
      const totalP = await active({ salesOrderLine: { salesOrderId: p.id } });
      const totalQ = await active({ salesOrderLine: { salesOrderId: q.id } });
      outcomes.push(`${results.map((r) => r.status).join('/')}:${onLoose}:${new Set(holders).size}:${totalP}/${totalQ}`);
      for (const o of [p, q]) await http().post(`/sales-orders/${o.id}/cancel`).set(as('SALES')).send({ reason: 'Fin de ronda' }).expect(200);
      for (const b of [c1, c2, loose]) await prisma.bundle.update({ where: { id: b.id }, data: { quantity: 0 } });
    }
    // Both dispatches exist, the 5 loose profiles belong to ONE of them, and
    // each order keeps exactly its 5 reserved profiles.
    expect(outcomes).toEqual(Array(ROUNDS).fill('201/201:5:1:5/5'));
  });
});
