import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { ledgerProblems } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Retail stores (almacenes) have no aisles or racks and sell loose: every
// bundle placed in one (registered, received or transferred) is opened in
// the same operation. Warehouses (bodegas) keep aisle and rack. Several
// bundles can be transferred at once, all or none.
describe('Retail stores: loose profiles and multiple transfers (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { branch: '', store: '', branch2: '', warehouse: '', aisle: '', rack: '', ref: '', finish: '' };
  let n = 0;
  let ip = 0;
  const epc = () => `STORE${S}${String(++n).padStart(4, '0')}`;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.33.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };

  const register = (quantity: number, place: { inventoryLocationId: string; rackId?: string }) =>
    http()
      .post('/inventory/bundles')
      .set(as('WAREHOUSE'))
      .send({
        epc: epc(),
        referenceId: ids.ref,
        finishId: ids.finish,
        quantity,
        ...place,
        registrationType: 'INITIAL_STOCK',
        arrivalDatePrecision: 'UNKNOWN',
      });
  const inWarehouse = async (quantity: number) =>
    (await register(quantity, { inventoryLocationId: ids.warehouse, rackId: ids.rack }).expect(201)).body as { id: string; epc: string };
  const transferMany = (body: Record<string, unknown>, who = 'WAREHOUSE') =>
    http().post('/inventory/bundles/transfer').set(as(who)).send(body);
  const bundle = (id: string) => prisma.bundle.findUniqueOrThrow({ where: { id } });
  const movements = (bundleId: string) =>
    prisma.inventoryMovement.findMany({ where: { bundleId }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
  const storeTotals = async () =>
    (await http().get(`/inventory/summary?referenceId=${ids.ref}&finishId=${ids.finish}&inventoryLocationId=${ids.store}`).set(as('WAREHOUSE')).expect(200)).body
      .totals as { profiles: number; bundles: number; looseProfiles: number };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'WAREHOUSE', 'SALES'] as const) {
      const user = await createTestUser(app, role, `ST${S}`);
      H[role] = user.headers;
      U[role] = user.id;
    }
    const main = await prisma.branch.create({ data: { code: `ST116-${S}`, name: `Principal ${S}` } });
    const other = await prisma.branch.create({ data: { code: `ST7A-${S}`, name: `7 de agosto ${S}` } });
    const warehouse = await prisma.inventoryLocation.create({ data: { branchId: main.id, code: `BOD-${S}`, name: 'Bodega 116', type: 'WAREHOUSE' } });
    const store = await prisma.inventoryLocation.create({ data: { branchId: other.id, code: `ALM-${S}`, name: 'Almacén 7 de agosto', type: 'RETAIL_STORE' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: warehouse.id, number: 1 } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 2 } });
    Object.assign(ids, { branch: main.id, branch2: other.id, warehouse: warehouse.id, store: store.id, aisle: aisle.id, rack: rack.id });
    ids.ref = (await prisma.reference.create({ data: { code: `STORE-REF-${S}` } })).id;
    ids.finish = (await prisma.finish.create({ data: { code: `STORE-F-${S}`, description: 'Natural' } })).id;
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      const users = Object.values(U);
      const bIds = (await prisma.bundle.findMany({ where: { referenceId: ids.ref }, select: { id: true } })).map((b) => b.id);
      await prisma.inventoryMovement.deleteMany({ where: { bundleId: { in: bIds } } });
      await prisma.bundle.deleteMany({ where: { id: { in: bIds } } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      await prisma.reference.deleteMany({ where: { id: ids.ref } });
      await prisma.finish.deleteMany({ where: { id: ids.finish } });
      await prisma.rack.deleteMany({ where: { id: ids.rack } });
      await prisma.aisle.deleteMany({ where: { inventoryLocationId: { in: [ids.warehouse, ids.store] } } });
      await prisma.inventoryLocation.deleteMany({ where: { id: { in: [ids.warehouse, ids.store] } } });
      await prisma.branch.deleteMany({ where: { id: { in: [ids.branch, ids.branch2] } } });
    }
    await app?.close();
  });

  it('a warehouse requires its rack; a retail store refuses a rack and cannot have aisles', async () => {
    expect((await register(5, { inventoryLocationId: ids.warehouse }).expect(400)).body.message).toMatch(/pasillo y el burro/);
    expect((await register(5, { inventoryLocationId: ids.store, rackId: ids.rack }).expect(400)).body.message).toMatch(/almacén: no maneja pasillo ni burro/);
    expect(
      (await http().post('/locations/aisles').set(as('ADMIN')).send({ inventoryLocationId: ids.store, number: 1 }).expect(400)).body.message,
    ).toMatch(/no manejan pasillos ni burros/);
    expect(await prisma.bundle.count({ where: { referenceId: ids.ref } })).toBe(0);
  });

  it('a bundle registered in a retail store is loose from the start (registration + opening)', async () => {
    const res = await register(12, { inventoryLocationId: ids.store, rackId: '' }).expect(201);
    expect(res.body).toMatchObject({ quantity: 12, rackId: null, openedBy: { id: U.WAREHOUSE } });
    expect(res.body.openedAt).not.toBeNull();
    const history = await movements(res.body.id);
    expect(history.map((m) => m.type)).toEqual(['INITIAL_STOCK', 'OPENING']);
    expect(history[1]).toMatchObject({ quantity: 12, quantityBefore: 12, quantityAfter: 12, sourceLocationId: ids.store, sourceRackId: null });
    expect(history[1].reason).toMatch(/Abierto al registrarse: Almacén 7 de agosto es un almacén/);
    expect(await storeTotals()).toEqual({ profiles: 12, bundles: 0, looseProfiles: 12 });
    expect(await ledgerProblems(prisma, [res.body.id])).toEqual([]);
  });

  it('several bundles go to the store at once: all opened on arrival, their loose profiles add up; a retry changes nothing', async () => {
    const closed = [await inWarehouse(20), await inWarehouse(20), await inWarehouse(20)];
    // One already opened in the warehouse: it moves, it is not opened again.
    const loose = await inWarehouse(10);
    await http().post(`/inventory/bundles/${loose.id}/open`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(201);
    const list = [...closed, loose].map((b) => b.id);
    const key = randomUUID();
    const body = { operationKey: key, bundleIds: list, inventoryLocationId: ids.store, reason: 'Remisión 116 → 7 de agosto' };

    const res = await transferMany(body).expect(201);
    expect(res.body).toMatchObject({ replayed: false, count: 4, profiles: 70, opened: 3 });
    expect(res.body.bundles.map((b: { id: string }) => b.id)).toEqual(list);
    for (const id of list) {
      const moved = await bundle(id);
      expect(moved).toMatchObject({ inventoryLocationId: ids.store, rackId: null });
      expect(moved.openedAt).not.toBeNull();
    }
    const first = await movements(closed[0].id);
    expect(first.map((m) => m.type)).toEqual(['INITIAL_STOCK', 'TRANSFER', 'OPENING']);
    expect(first[1]).toMatchObject({
      sourceLocationId: ids.warehouse,
      sourceRackId: ids.rack,
      destinationLocationId: ids.store,
      destinationRackId: null,
      reason: 'Remisión 116 → 7 de agosto',
      performedById: U.WAREHOUSE,
    });
    expect(first[2].reason).toMatch(/Abierto al llegar por traslado: Almacén 7 de agosto es un almacén/);
    expect((await movements(loose.id)).filter((m) => m.type === 'OPENING')).toHaveLength(1);
    // 12 registered there + 3×20 + 10: all loose, summed by reference and colour.
    expect(await storeTotals()).toEqual({ profiles: 82, bundles: 0, looseProfiles: 82 });

    // Same key and data: the saved result, nothing new. Other data: refused.
    const again = await transferMany(body).expect(200);
    expect(again.body).toMatchObject({ replayed: true, count: 4, opened: 3 });
    expect(await prisma.inventoryMovement.count({ where: { bundleId: { in: list } } })).toBe(4 + 4 + 3 + 1);
    await transferMany({ ...body, reason: 'Otra' }).expect(409);
    expect(await ledgerProblems(prisma, list)).toEqual([]);
  });

  it('all or none: every problem is reported and no bundle moves', async () => {
    const good = await inWarehouse(15);
    const empty = await inWarehouse(4);
    await http().post(`/inventory/bundles/${empty.id}/exit`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), quantity: 4 }).expect(201);
    const there = (await register(6, { inventoryLocationId: ids.store }).expect(201)).body as { id: string; epc: string };

    const res = await transferMany({ operationKey: randomUUID(), bundleIds: [good.id, empty.id, there.id], inventoryLocationId: ids.store }).expect(409);
    expect(res.body.message).toMatch(/No se trasladó ningún paquete/);
    expect((res.body.problems as { epc: string; message: string }[]).map((p) => p.epc)).toEqual([empty.epc, there.epc]);
    expect(await bundle(good.id)).toMatchObject({ inventoryLocationId: ids.warehouse, rackId: ids.rack, openedAt: null });
    expect(await prisma.inventoryMovement.count({ where: { bundleId: good.id, type: 'TRANSFER' } })).toBe(0);

    await transferMany({ operationKey: randomUUID(), bundleIds: [good.id, `NOPE${S}`], inventoryLocationId: ids.store }).expect(404);
    await transferMany({ operationKey: randomUUID(), bundleIds: [good.id, good.id], inventoryLocationId: ids.store }).expect(400);
    await transferMany({ operationKey: randomUUID(), bundleIds: [], inventoryLocationId: ids.store }).expect(400);
    // To a warehouse the rack is required; SALES cannot transfer.
    await transferMany({ operationKey: randomUUID(), bundleIds: [there.id], inventoryLocationId: ids.warehouse }).expect(400);
    await transferMany({ operationKey: randomUUID(), bundleIds: [good.id], inventoryLocationId: ids.store }, 'SALES').expect(403);
    expect(await bundle(good.id)).toMatchObject({ inventoryLocationId: ids.warehouse, openedAt: null });
  });

  it('a single transfer to the store also opens; back to a warehouse it needs a rack and stays loose', async () => {
    const one = await inWarehouse(8);
    const key = randomUUID();
    const res = await http().post(`/inventory/bundles/${one.id}/transfer`).set(as('WAREHOUSE')).send({ operationKey: key, inventoryLocationId: ids.store }).expect(201);
    expect(res.body.movement).toMatchObject({ type: 'TRANSFER', destinationLocationId: ids.store, destinationRackId: null });
    expect(res.body.bundle.openedAt).not.toBeNull();
    expect((await movements(one.id)).map((m) => m.type)).toEqual(['INITIAL_STOCK', 'TRANSFER', 'OPENING']);
    // Retry: replayed, no second opening.
    expect((await http().post(`/inventory/bundles/${one.id}/transfer`).set(as('WAREHOUSE')).send({ operationKey: key, inventoryLocationId: ids.store }).expect(200)).body.replayed).toBe(true);
    await http().post(`/inventory/bundles/${one.id}/transfer`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), inventoryLocationId: ids.store }).expect(400);

    await http().post(`/inventory/bundles/${one.id}/transfer`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), inventoryLocationId: ids.warehouse }).expect(400);
    await http()
      .post(`/inventory/bundles/${one.id}/transfer`)
      .set(as('WAREHOUSE'))
      .send({ operationKey: randomUUID(), inventoryLocationId: ids.warehouse, rackId: ids.rack })
      .expect(201);
    const back = await bundle(one.id);
    expect(back).toMatchObject({ inventoryLocationId: ids.warehouse, rackId: ids.rack });
    expect(back.openedAt).not.toBeNull();
    expect(await prisma.inventoryMovement.count({ where: { bundleId: one.id, type: 'OPENING' } })).toBe(1);
    expect(await ledgerProblems(prisma, [one.id])).toEqual([]);
  });
});
