import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { ledgerProblems } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Material requests: Sales asks Bodega for profiles for the 7 de agosto store
// without chips; the worker in turn prepares whole bundles by chip (each one
// reserved entirely), the shipment transfers and opens them at the store
// once, and the store marks the request received.
interface RequestBody {
  id: string;
  number: string;
  status: string;
  assignee: { id: string };
  lines: { id: string; requested: number; prepared: number; shipped: number; pending: number; suggestions: { bundleId: string; loose: boolean }[] }[];
  picks: { id: string; quantity: number; bundle: { id: string; epc: string; loose: boolean } }[];
  totals: { requested: number; prepared: number; shipped: number; bundles: number };
  can: Record<string, boolean>;
}

describe('Material requests (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { b116: '', b7: '', bodega: '', store: '', aisle: '', rack: '', ref: '', finishA: '', finishB: '', n1: '', cn: '' };
  let n = 0;
  let ip = 0;
  const epc = () => `MR${S}${String(++n).padStart(4, '0')}`;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.34.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const line = (quantity: number, extra: object = {}) => ({ referenceId: ids.ref, finishId: ids.finishA, origin: 'NATIONAL', quantity, ...extra });
  const send = (body: object, who = 'SALES') =>
    http()
      .post('/material-requests')
      .set(as(who))
      .send({ operationKey: randomUUID(), sourceLocationId: ids.bodega, destinationLocationId: ids.store, lines: [line(30)], ...body });
  const get = async (id: string, who = 'SALES') => (await http().get(`/material-requests/${id}`).set(as(who)).expect(200)).body as RequestBody;
  const pick = (id: string, body: object, who: string) => http().post(`/material-requests/${id}/picks`).set(as(who)).send(body);
  // A Chinese bundle with its own lot, created directly: registering one
  // through the API needs the global «China supplier» setting, which other
  // suites running in parallel check.
  const chineseBundle = async (quantity: number) => {
    const lot = await prisma.stockLot.create({
      data: { code: `MR-LOT-${S}-${n}`, kind: 'MANUAL_ENTRY', referenceId: ids.ref, finishId: ids.finishA, origin: 'CHINA', supplierId: ids.cn, createdById: U.ADMIN },
    });
    const bundle = await prisma.bundle.create({
      data: { epc: epc(), referenceId: ids.ref, finishId: ids.finishA, quantity, inventoryLocationId: ids.bodega, rackId: ids.rack, lotId: lot.id, arrivalDatePrecision: 'UNKNOWN' },
    });
    await prisma.inventoryMovement.create({
      data: { bundleId: bundle.id, type: 'INITIAL_STOCK', quantity, quantityBefore: 0, quantityAfter: quantity, destinationLocationId: ids.bodega, destinationRackId: ids.rack, occurredAt: new Date(), performedById: U.ADMIN, operationKey: `mr-test:${bundle.epc}` },
    });
    return bundle;
  };
  const register = async (quantity: number, origin: 'NATIONAL' | 'CHINA' = 'NATIONAL', finishId = ids.finishA) => {
    const res = await http()
      .post('/inventory/bundles')
      .set(as('ADMIN'))
      .send({
        epc: epc(),
        referenceId: ids.ref,
        finishId,
        quantity,
        inventoryLocationId: ids.bodega,
        rackId: ids.rack,
        registrationType: 'INITIAL_STOCK',
        arrivalDatePrecision: 'UNKNOWN',
        origin,
        ...(origin === 'NATIONAL' ? { supplierId: ids.n1 } : {}),
      })
      .expect(201);
    return res.body as { id: string; epc: string };
  };
  const active = async (where: object) => (await prisma.stockReservation.aggregate({ where: { status: 'ACTIVE', ...where }, _sum: { quantity: true } }))._sum.quantity ?? 0;

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const [key, role, suffix] of [
      ['ADMIN', 'ADMIN', `MRA${S}`],
      ['SALES', 'SALES', `MRS${S}`],
      ['SALES2', 'SALES', `MRT${S}`],
      ['W1', 'WAREHOUSE', `MR1${S}`],
      ['W2', 'WAREHOUSE', `MR2${S}`],
      ['STORE', 'WAREHOUSE', `MR7${S}`],
    ] as const) {
      const user = await createTestUser(app, role, suffix);
      H[key] = user.headers;
      U[key] = user.id;
    }
    const b116 = await prisma.branch.create({ data: { code: `MR116-${S}`, name: `116 ${S}` } });
    const b7 = await prisma.branch.create({ data: { code: `MR7A-${S}`, name: `7 de agosto ${S}` } });
    const bodega = await prisma.inventoryLocation.create({ data: { branchId: b116.id, code: `MRB-${S}`, name: 'Bodega 116', type: 'WAREHOUSE' } });
    const store = await prisma.inventoryLocation.create({ data: { branchId: b7.id, code: `MRS-${S}`, name: 'Almacén 7 de agosto', type: 'RETAIL_STORE' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: bodega.id, number: 1 } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } });
    Object.assign(ids, { b116: b116.id, b7: b7.id, bodega: bodega.id, store: store.id, aisle: aisle.id, rack: rack.id });
    await prisma.user.updateMany({ where: { id: { in: [U.W1, U.W2] } }, data: { defaultInventoryLocationId: bodega.id } });
    await prisma.user.update({ where: { id: U.STORE }, data: { defaultInventoryLocationId: store.id } });
    ids.ref = (await prisma.reference.create({ data: { code: `MR-REF-${S}` } })).id;
    ids.finishA = (await prisma.finish.create({ data: { code: `MR-A-${S}`, description: 'Natural' } })).id;
    ids.finishB = (await prisma.finish.create({ data: { code: `MR-B-${S}`, description: 'Negro' } })).id;
    ids.n1 = (await prisma.supplier.create({ data: { code: `MR-N1-${S}`, name: 'Nacional solicitudes', origins: ['NATIONAL'] } })).id;
    ids.cn = (await prisma.supplier.create({ data: { code: `MR-CN-${S}`, name: 'China solicitudes', origins: ['CHINA'] } })).id;
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      const users = Object.values(U);
      const rIds = (await prisma.materialRequest.findMany({ where: { createdById: { in: users } }, select: { id: true } })).map((r) => r.id);
      const bIds = (await prisma.bundle.findMany({ where: { referenceId: ids.ref }, select: { id: true } })).map((b) => b.id);
      const steps: (() => Promise<unknown>)[] = [
        () => prisma.notificationOutbox.deleteMany({ where: { userId: { in: users } } }),
        () => prisma.stockReservation.deleteMany({ where: { bundleId: { in: bIds } } }),
        () => prisma.materialRequestPick.deleteMany({ where: { requestId: { in: rIds } } }),
        () => prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] } }),
        () => prisma.inventoryMovement.deleteMany({ where: { bundleId: { in: bIds } } }),
        () => prisma.materialRequestLine.deleteMany({ where: { requestId: { in: rIds } } }),
        () => prisma.materialRequest.deleteMany({ where: { id: { in: rIds } } }),
        () => prisma.bundle.deleteMany({ where: { id: { in: bIds } } }),
        () => prisma.stockLot.deleteMany({ where: { referenceId: ids.ref } }),
        () => prisma.supplier.deleteMany({ where: { id: { in: [ids.n1, ids.cn] } } }),
        () => prisma.auditEvent.deleteMany({ where: { userId: { in: users } } }),
        () => prisma.user.deleteMany({ where: { id: { in: users } } }),
        () => prisma.reference.deleteMany({ where: { id: ids.ref } }),
        () => prisma.finish.deleteMany({ where: { id: { in: [ids.finishA, ids.finishB] } } }),
        () => prisma.rack.deleteMany({ where: { id: ids.rack } }),
        () => prisma.aisle.deleteMany({ where: { id: ids.aisle } }),
        () => prisma.inventoryLocation.deleteMany({ where: { id: { in: [ids.bodega, ids.store] } } }),
        () => prisma.branch.deleteMany({ where: { id: { in: [ids.b116, ids.b7] } } }),
      ];
      for (const step of steps) await step();
    }
    await app?.close();
  });

  const s = {} as Record<string, string>;

  it('sending moves and reserves nothing; the warehouse workers take turns; a retry creates nothing new', async () => {
    const workers = (await http().get(`/material-requests/workers?sourceLocationId=${ids.bodega}`).set(as('SALES')).expect(200)).body as { workers: { id: string }[]; next: { id: string } };
    expect(workers.workers.map((w) => w.id)).toEqual([U.W1, U.W2]);
    expect(workers.next.id).toBe(U.W1);
    const key = randomUUID();
    const first = (await send({ operationKey: key, notes: 'Para la vitrina' }).expect(201)).body as RequestBody;
    expect(first).toMatchObject({ status: 'SENT', assignee: { id: U.W1 }, totals: { requested: 30, prepared: 0, shipped: 0, bundles: 0 } });
    expect(first.number).toMatch(/^SM-\d{6}$/);
    expect((await send({ operationKey: key }).expect(201)).body.id).toBe(first.id);
    const second = (await send({}).expect(201)).body as RequestBody;
    const third = (await send({ lines: [line(5, { finishId: ids.finishB })] }).expect(201)).body as RequestBody;
    expect([second.assignee.id, third.assignee.id]).toEqual([U.W2, U.W1]);
    Object.assign(s, { a: first.id, b: second.id, c: third.id });
    // No movement and no reservation: it is only a need. Each worker has its task and notice.
    expect(await prisma.inventoryMovement.count({ where: { materialRequestId: { in: [first.id, second.id, third.id] } } })).toBe(0);
    expect(await prisma.stockReservation.count({ where: { materialRequestLine: { requestId: { in: [first.id, second.id, third.id] } } } })).toBe(0);
    expect(await prisma.task.findFirstOrThrow({ where: { materialRequestId: first.id } })).toMatchObject({ kind: 'MATERIAL_REQUEST', assigneeId: U.W1, completedAt: null });
    expect(await prisma.notificationOutbox.count({ where: { userId: U.W1, kind: 'material-request-assigned' } })).toBe(2);
  });

  it('refuses a wrong source or destination, repeated lines, a worker of another place and other roles', async () => {
    expect((await send({ destinationLocationId: ids.bodega, sourceLocationId: ids.store }).expect(400)).body.message).toMatch(/bodega activa/);
    expect((await send({ destinationLocationId: ids.bodega }).expect(400)).body.message).toMatch(/almacén activo/);
    expect((await send({ lines: [line(5), line(6)] }).expect(400)).body.message).toMatch(/repite el material/);
    expect((await send({ assigneeId: U.STORE }).expect(400)).body.message).toMatch(/bodeguero activo/);
    await send({ lines: [line(0)] }).expect(400);
    await send({}, 'W1').expect(403);
    // Another seller does not see it.
    await http().get(`/material-requests/${s.a}`).set(as('SALES2')).expect(404);
    expect(((await http().get('/material-requests').set(as('SALES2')).expect(200)).body.items as unknown[]).length).toBe(0);
  });

  it('Sales changes the worker (e.g. absent); only the assigned worker prepares', async () => {
    const moved = (await http().post(`/material-requests/${s.a}/assignee`).set(as('SALES')).send({ assigneeId: U.W2 }).expect(200)).body as RequestBody;
    expect(moved.assignee.id).toBe(U.W2);
    expect((await prisma.task.findFirstOrThrow({ where: { materialRequestId: s.a, kind: 'MATERIAL_REQUEST' } })).assigneeId).toBe(U.W2);
    await http().post(`/material-requests/${s.a}/assignee`).set(as('SALES2')).send({ assigneeId: U.W1 }).expect(404);
    const bundle = await register(20);
    expect((await pick(s.a, { epc: bundle.epc }, 'W1').expect(403)).body.message).toMatch(/bodeguero asignado/);
    s.bundle1 = bundle.id;
    s.epc1 = bundle.epc;
  });

  it('preparing by chip checks the material and reserves whole bundles; prepared may exceed asked', async () => {
    const china = await chineseBundle(25);
    expect((await pick(s.a, { epc: china.epc }, 'W2').expect(409)).body.message).toMatch(/origen China/);
    const other = await register(10, 'NATIONAL', ids.finishB);
    expect((await pick(s.a, { epc: other.epc }, 'W2').expect(409)).body.message).toMatch(/Esta solicitud requiere/);
    await pick(s.a, { epc: 'NOEXISTE' + S }, 'W2').expect(404);

    const first = (await pick(s.a, { epc: s.epc1.toLowerCase() }, 'W2').expect(200)).body as { message: string; request: RequestBody };
    expect(first.request).toMatchObject({ status: 'PREPARING', totals: { prepared: 20 } });
    expect(await active({ bundleId: s.bundle1 })).toBe(20);
    // Reading it again adds nothing.
    expect((await pick(s.a, { epc: s.epc1 }, 'W2').expect(200)).body.message).toMatch(/ya está preparado/);
    const second = await register(20);
    const over = (await pick(s.a, { epc: second.epc }, 'W2').expect(200)).body as { message: string; request: RequestBody };
    expect(over.message).toMatch(/sobran 10: viaja el paquete completo/);
    expect(over.request.lines[0]).toMatchObject({ requested: 30, prepared: 40, pending: 0 });
    expect(await active({ bundleId: second.id })).toBe(20);
    const third = await register(20);
    expect((await pick(s.a, { epc: third.epc }, 'W2').expect(409)).body.message).toMatch(/ya tiene preparada toda la cantidad/);
    // A reserved bundle cannot go to another request.
    expect((await pick(s.b, { epc: s.epc1 }, 'W2').expect(409)).body.message).toMatch(/reservados para otra orden o solicitud/);
    // Loose profiles (opened bundle) are taken without a chip; a closed bundle needs it.
    const loose = await register(8);
    await http().post(`/inventory/bundles/${loose.id}/open`).set(as('ADMIN')).send({ operationKey: randomUUID() }).expect(201);
    const view = await get(s.b, 'W2');
    expect(view.lines[0].suggestions[0]).toMatchObject({ bundleId: loose.id, loose: true });
    await pick(s.b, { bundleId: third.id }, 'W2').expect(400);
    const took = (await pick(s.b, { bundleId: loose.id }, 'W2').expect(200)).body as { request: RequestBody };
    expect(took.request.picks[0].bundle).toMatchObject({ id: loose.id, loose: true });
    // Taking it out releases its reservation.
    await http().post(`/material-requests/${s.b}/picks/${took.request.picks[0].id}/remove`).set(as('W2')).expect(200);
    expect(await active({ bundleId: loose.id })).toBe(0);
    expect((await get(s.b)).status).toBe('SENT');
    s.bundle2 = second.id;
  });

  it('the shipment transfers and opens each bundle at the store once; a repeated confirmation changes nothing', async () => {
    const key = randomUUID();
    const [one, two] = await Promise.all([
      http().post(`/material-requests/${s.a}/ship`).set(as('W2')).send({ operationKey: key }),
      http().post(`/material-requests/${s.a}/ship`).set(as('W2')).send({ operationKey: key }),
    ]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const shipped = await get(s.a);
    expect(shipped).toMatchObject({ status: 'SHIPPED', totals: { requested: 30, prepared: 40, shipped: 40, bundles: 2 } });
    await http().post(`/material-requests/${s.a}/ship`).set(as('W2')).send({ operationKey: key }).expect(200);
    expect((await http().post(`/material-requests/${s.a}/ship`).set(as('W2')).send({ operationKey: randomUUID() }).expect(409)).body.message).toMatch(/ya fue despachada/);
    for (const id of [s.bundle1, s.bundle2]) {
      const bundle = await prisma.bundle.findUniqueOrThrow({ where: { id } });
      expect(bundle).toMatchObject({ inventoryLocationId: ids.store, rackId: null, quantity: 20 });
      expect(bundle.openedAt).not.toBeNull();
      const moves = await prisma.inventoryMovement.findMany({ where: { bundleId: id, materialRequestId: s.a } });
      expect(moves.map((m) => m.type).sort()).toEqual(['OPENING', 'TRANSFER']);
      // Available at the store from the shipment (no reservation left).
      expect(await active({ bundleId: id })).toBe(0);
    }
    expect(await prisma.stockReservation.count({ where: { materialRequestLine: { requestId: s.a }, status: 'CONSUMED' } })).toBe(2);
    expect(await ledgerProblems(prisma, [s.bundle1, s.bundle2])).toEqual([]);
    // Tasks: preparation done; reception for the store's staff. Notices to the store and the requester.
    expect((await prisma.task.findFirstOrThrow({ where: { materialRequestId: s.a, kind: 'MATERIAL_REQUEST' } })).completedAt).not.toBeNull();
    expect(await prisma.task.findFirstOrThrow({ where: { materialRequestId: s.a, kind: 'MATERIAL_RECEPTION' } })).toMatchObject({ assigneeId: U.STORE, completedAt: null });
    expect(await prisma.notificationOutbox.count({ where: { kind: 'material-request-shipped', userId: { in: [U.STORE, U.SALES] } } })).toBe(2);
    // The generic route cannot close these tasks.
    const task = await prisma.task.findFirstOrThrow({ where: { materialRequestId: s.a, kind: 'MATERIAL_RECEPTION' } });
    await http().patch(`/tasks/${task.id}/complete`).set(as('STORE')).expect(409);
  });

  it('the store marks it received (with a note); only its staff or ADMIN', async () => {
    await http().post(`/material-requests/${s.a}/receive`).set(as('W1')).send({}).expect(403);
    const received = (await http().post(`/material-requests/${s.a}/receive`).set(as('STORE')).send({ note: 'Llegó completo' }).expect(200)).body as RequestBody & {
      receptionNote: string;
      receivedBy: { id: string };
    };
    expect(received).toMatchObject({ status: 'RECEIVED', receptionNote: 'Llegó completo', receivedBy: { id: U.STORE } });
    await http().post(`/material-requests/${s.a}/receive`).set(as('STORE')).send({}).expect(200);
    expect((await prisma.task.findFirstOrThrow({ where: { materialRequestId: s.a, kind: 'MATERIAL_RECEPTION' } })).completedAt).not.toBeNull();
    expect(await prisma.notificationOutbox.count({ where: { kind: 'material-request-received', userId: U.SALES } })).toBe(1);
  });

  it('cancelling before the shipment releases what was prepared; nothing can be prepared afterwards', async () => {
    const bundle = await register(15, 'NATIONAL', ids.finishB);
    await pick(s.c, { epc: bundle.epc }, 'W1').expect(200);
    expect(await active({ bundleId: bundle.id })).toBe(15);
    await http().post(`/material-requests/${s.c}/cancel`).set(as('SALES')).send({ reason: '' }).expect(400);
    const cancelled = (await http().post(`/material-requests/${s.c}/cancel`).set(as('SALES')).send({ reason: 'El cliente desistió' }).expect(200)).body as RequestBody;
    expect(cancelled.status).toBe('CANCELLED');
    expect(await active({ bundleId: bundle.id })).toBe(0);
    expect((await prisma.task.findFirstOrThrow({ where: { materialRequestId: s.c } })).cancelledAt).not.toBeNull();
    await pick(s.c, { epc: bundle.epc }, 'W1').expect(409);
    await http().post(`/material-requests/${s.a}/cancel`).set(as('SALES')).send({ reason: 'Tarde' }).expect(409);
    // The database refuses a reservation without a need or with two.
    await expect(prisma.stockReservation.create({ data: { bundleId: bundle.id, quantity: 1, createdById: U.ADMIN } })).rejects.toThrow();
  });
});
