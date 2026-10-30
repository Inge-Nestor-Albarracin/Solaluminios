import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createE2eApp, uniqueSuffix } from './support/e2e.js';
import { createInventoryFixtures } from './support/inventory-fixtures.js';

type Fixtures = Awaited<ReturnType<typeof createInventoryFixtures>>;

describe('Inventory list, summary and history (e2e)', () => {
  const suffix = uniqueSuffix();
  let app: INestApplication<App>;
  let fx: Fixtures;
  const bundles: Record<string, { id: string }> = {};

  const get = (path: string, role: 'READ_ONLY' | 'ADMIN' = 'READ_ONLY') =>
    request(app.getHttpServer()).get(path).set(fx.headers[role]);

  beforeAll(async () => {
    app = await createE2eApp();
    fx = await createInventoryFixtures(app, suffix);
    const { ids } = fx;

    bundles.b1 = await fx.register({ quantity: 10 });
    bundles.b2 = await fx.register({ quantity: 5, rackId: ids.rack2 });
    bundles.b3 = await fx.register({
      quantity: 7,
      inventoryLocationId: ids.location2,
      rackId: ids.rack4,
      registrationType: 'ENTRY',
    });
    bundles.b4 = await fx.register({ quantity: 4, finishId: ids.finishB, rackId: ids.rack3 });
    bundles.b5 = await fx.register({ quantity: 6, referenceId: ids.referenceB });
    bundles.b6 = await fx.register({ quantity: 3 });

    // b6 becomes an empty bundle (agotado).
    await request(app.getHttpServer())
      .post(`/inventory/bundles/${bundles.b6.id}/exit`)
      .set(fx.headers.WAREHOUSE)
      .send({ operationKey: randomUUID(), quantity: 3 })
      .expect(201);
  });

  afterAll(async () => {
    await fx?.cleanup();
    await app?.close();
  });

  const idsOf = (body: { items: { id: string }[] }) => body.items.map((i) => i.id).sort();
  const expectIds = (body: { items: { id: string }[] }, keys: string[]) =>
    expect(idsOf(body)).toEqual(keys.map((k) => bundles[k].id).sort());

  it('lists bundles with filters', async () => {
    const { ids } = fx;
    const branch = `branchId=${ids.branch}`;
    const all = await get(`/inventory/bundles?${branch}&pageSize=100`).expect(200);
    expect(all.body.total).toBe(6);
    expectIds(all.body, ['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    expect(all.body.items[0].reference.family).toBeDefined();
    expect(all.body.items[0].movements).toBeUndefined();

    const cases: [string, string[]][] = [
      [`${branch}&available=true`, ['b1', 'b2', 'b3', 'b4', 'b5']],
      [`${branch}&available=false`, ['b6']],
      [`referenceId=${ids.referenceB}`, ['b5']],
      [`${branch}&finishId=${ids.finishB}`, ['b4']],
      [`familyId=${ids.familyB}`, ['b5']],
      [`inventoryLocationId=${ids.location2}`, ['b3']],
      [`aisleId=${ids.aisle1}`, ['b1', 'b2', 'b5', 'b6']],
      [`rackId=${ids.rack1}`, ['b1', 'b5', 'b6']],
      [`rackId=${ids.rack1}&referenceId=${ids.referenceA}&available=true`, ['b1']],
    ];
    for (const [query, expected] of cases) {
      const res = await get(`/inventory/bundles?${query}`).expect(200);
      expectIds(res.body, expected);
    }
  });

  it('paginates with a stable order and enforces limits', async () => {
    const branch = `branchId=${fx.ids.branch}`;
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/inventory/bundles?${branch}&pageSize=2&page=${page}`).expect(200);
      expect(res.body).toMatchObject({ page, pageSize: 2, total: 6, totalPages: 3 });
      seen.push(...res.body.items.map((i: { id: string }) => i.id));
    }
    expect(new Set(seen).size).toBe(6);
    // Newest first.
    expect(seen[0]).toBe(bundles.b6.id);

    const empty = await get(`/inventory/bundles?${branch}&page=99`).expect(200);
    expect(empty.body.items).toEqual([]);

    for (const bad of ['pageSize=101', 'pageSize=0', 'page=0', 'page=abc', 'available=maybe', 'color=BM', 'familyId=']) {
      await get(`/inventory/bundles?${bad}`).expect(400);
    }
    await get(`/inventory/bundles?familyId=missing-${suffix}`).expect(404);
    await get(`/inventory/bundles?rackId=missing-${suffix}`).expect(404);
  });

  it('summarizes by reference and finish from current bundles, excluding empty ones', async () => {
    const { ids } = fx;
    const res = await get(`/inventory/summary?branchId=${ids.branch}`).expect(200);
    expect(res.body.total).toBe(3);
    expect(res.body.totals).toEqual({ profiles: 32, bundles: 5, looseProfiles: 0 });

    const [aa, ab, ba] = res.body.items;
    expect([aa.reference.id, aa.finish.id]).toEqual([ids.referenceA, ids.finishA]);
    expect(aa.reference.family.id).toBe(ids.familyA);
    expect(aa.profiles).toBe(22); // 10 + 5 + 7; the empty b6 adds nothing
    expect(aa.bundles).toBe(3); // b6 has quantity 0 and is not counted
    expect(
      aa.locations.map((l: { inventoryLocation: { id: string }; aisle: { number: number }; rack: { number: number }; profiles: number; bundles: number }) => [
        l.inventoryLocation.id, l.aisle.number, l.rack.number, l.profiles, l.bundles,
      ]),
    ).toEqual([
      [ids.location1, 1, 1, 10, 1],
      [ids.location1, 1, 2, 5, 1],
      [ids.location2, 4, 1, 7, 1],
    ]);
    expect([ab.reference.id, ab.finish.id, ab.profiles, ab.bundles]).toEqual([ids.referenceA, ids.finishB, 4, 1]);
    expect([ba.reference.id, ba.finish.id, ba.profiles, ba.bundles]).toEqual([ids.referenceB, ids.finishA, 6, 1]);

    const family = await get(`/inventory/summary?familyId=${ids.familyA}`).expect(200);
    expect(family.body.totals).toEqual({ profiles: 26, bundles: 4, looseProfiles: 0 });

    const warehouse = await get(`/inventory/summary?inventoryLocationId=${ids.location2}`).expect(200);
    expect(warehouse.body.items).toHaveLength(1);
    expect(warehouse.body.items[0].profiles).toBe(7);

    const page2 = await get(`/inventory/summary?branchId=${ids.branch}&pageSize=1&page=2`).expect(200);
    expect(page2.body).toMatchObject({ total: 3, totalPages: 3 });
    expect(page2.body.items[0].finish.id).toBe(ids.finishB);
    // Totals describe the whole filtered result, not only the page.
    expect(page2.body.totals).toEqual({ profiles: 32, bundles: 5, looseProfiles: 0 });

    await get(`/inventory/summary?familyId=missing-${suffix}`).expect(404);
    await get('/inventory/summary?aisleId=x').expect(400);
  });

  it('returns the paginated movement history of a bundle, newest first', async () => {
    const res = await get(`/inventory/bundles/${bundles.b6.id}/movements?pageSize=1`).expect(200);
    expect(res.body).toMatchObject({ total: 2, totalPages: 2, page: 1 });
    const [latest] = res.body.items;
    expect(latest).toMatchObject({ type: 'EXIT', quantityBefore: 3, quantityAfter: 0 });
    expect(Object.keys(latest.performedBy).sort()).toEqual(['id', 'name', 'role']);
    expect(latest.sourceLocation.id).toBe(fx.ids.location1);
    expect(latest.sourceRack.aisle.number).toBe(1);

    const older = await get(`/inventory/bundles/${bundles.b6.id}/movements?pageSize=1&page=2`).expect(200);
    expect(older.body.items[0].type).toBe('INITIAL_STOCK');

    await get(`/inventory/bundles/missing-${suffix}/movements`).expect(404);
    await get(`/inventory/bundles/${bundles.b6.id}/movements?pageSize=500`).expect(400);
  });

  it('never exposes password hashes or emails', async () => {
    const responses = await Promise.all([
      get(`/inventory/bundles?branchId=${fx.ids.branch}`),
      get(`/inventory/summary?branchId=${fx.ids.branch}`),
      get(`/inventory/bundles/${bundles.b6.id}`),
      get(`/inventory/bundles/${bundles.b6.id}/movements`),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/passwordHash|scrypt|"email"|@test\.local/);
    }
  });

  it('requires a session (401) for every query', async () => {
    const server = app.getHttpServer();
    await request(server).get('/inventory/bundles').expect(401);
    await request(server).get('/inventory/summary').expect(401);
    await request(server).get(`/inventory/bundles/${bundles.b1.id}/movements`).expect(401);
  });
});
