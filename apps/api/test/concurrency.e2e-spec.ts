import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { UserRole } from '../src/generated/prisma/client.js';
import {
  barrierAtTransactionStart,
  barrierBeforeBundleCreate,
  createBarrier,
  ledgerProblems,
} from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';
import { createInventoryFixtures } from './support/inventory-fixtures.js';

type Fixtures = Awaited<ReturnType<typeof createInventoryFixtures>>;

// Concurrency scenarios A–J and idempotency (operationKey), against the real
// PostgreSQL test database. Requests are released together by a barrier
// placed inside the server at the critical point (test-only hook), then both
// the HTTP answers and the final rows are checked.
describe('Concurrency and idempotency (e2e)', () => {
  const suffix = uniqueSuffix();
  let app: INestApplication<App>;
  let fx: Fixtures;
  let warehouse2: { id: string; headers: Record<string, string> };
  const extraUsers: string[] = [];
  const createdReferenceCodes: string[] = [];
  const bundleIds: string[] = [];
  let ip = 0;
  let epcCounter = 0;

  const http = () => request(app.getHttpServer());
  // Each simulated user is its own client (own IP behind the trusted proxy).
  const as = (who: UserRole | 'WAREHOUSE2') => {
    ip += 1;
    const base = who === 'WAREHOUSE2' ? warehouse2.headers : fx.headers[who];
    return { ...base, 'X-Forwarded-For': `10.20.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const epc = () => `E2EC${suffix}${String(++epcCounter).padStart(4, '0')}`;
  const item = (overrides: Record<string, unknown> = {}) => ({
    epc: epc(),
    referenceId: fx.ids.referenceA,
    finishId: fx.ids.finishA,
    quantity: 10,
    inventoryLocationId: fx.ids.location1,
    rackId: fx.ids.rack1,
    registrationType: 'INITIAL_STOCK',
    arrivalDatePrecision: 'UNKNOWN',
    ...overrides,
  });
  const register = async (quantity: number) => {
    const res = await http().post('/inventory/bundles').set(as('WAREHOUSE')).send(item({ quantity })).expect(201);
    bundleIds.push(res.body.id);
    return res.body as { id: string; epc: string };
  };
  const op = (bundleId: string, action: 'exit' | 'transfer' | 'adjustments', body: Record<string, unknown>, who: UserRole | 'WAREHOUSE2' = 'WAREHOUSE') =>
    http().post(`/inventory/bundles/${bundleId}/${action}`).set(as(who)).send(body);
  const statuses = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b);
  const movementsOf = (bundleId: string) =>
    fx.prisma.inventoryMovement.findMany({ where: { bundleId }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }] });

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    fx = await createInventoryFixtures(app, suffix, ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY']);
    warehouse2 = await createTestUser(app, 'WAREHOUSE', `${suffix}W2`);
    extraUsers.push(warehouse2.id);
  });

  afterAll(async () => {
    if (fx) {
      await fx.prisma.reference.deleteMany({ where: { code: { in: createdReferenceCodes } } });
      await fx.cleanup();
      await fx.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    }
    await app?.close();
    delete process.env.TRUST_PROXY;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Every bundle touched so far must have a valid history.
    expect(await ledgerProblems(fx.prisma, bundleIds)).toEqual([]);
  });

  it('A. same reference code at the same time: one 201, one 409, never 500', async () => {
    for (const [first, second] of [
      [`E2EC-REF-${suffix}-1`, `E2EC-REF-${suffix}-1`],
      [`  e2ec-ref-${suffix}-2 `, `E2EC-REF-${suffix}-2`],
    ]) {
      const code = second.trim().toUpperCase();
      createdReferenceCodes.push(code);
      const barrier = createBarrier(2);
      const original = fx.prisma.reference.create.bind(fx.prisma.reference);
      const spy = vi.spyOn(fx.prisma.reference, 'create').mockImplementation((async (args: unknown) => {
        await barrier();
        return original(args as never);
      }) as never);
      const results = await Promise.all([
        http().post('/catalog/references').set(as('ADMIN')).send({ code: first, description: 'Concurrencia A' }),
        http().post('/catalog/references').set(as('ADMIN')).send({ code: second, description: 'Concurrencia A' }),
      ]);
      spy.mockRestore();
      expect(statuses(results)).toEqual([201, 409]);
      expect(results.find((r) => r.status === 409)?.body.message).toBe('Ya existe una referencia con ese código');
      expect(await fx.prisma.reference.count({ where: { code } })).toBe(1);
    }
  });

  it('B. same EPC, two requests past the existence check: one bundle, one movement', async () => {
    // Single endpoint, both requests start their transaction at the same
    // time. Since the sales/dispatch change every flow that creates a record
    // for an EPC takes the same identity lock (lockEpc) BEFORE checking the
    // EPC, so the second request waits and then sees the first bundle (409);
    // the unique index stays as last line of defence.
    const shared = item({ quantity: 8 });
    const barrier = createBarrier(2);
    barrierAtTransactionStart(fx.prisma, 2, barrier);
    const results = await Promise.all([
      http().post('/inventory/bundles').set(as('WAREHOUSE')).send(shared),
      http().post('/inventory/bundles').set(as('WAREHOUSE2')).send({ ...shared, epc: ` ${shared.epc.toLowerCase()} ` }),
    ]);
    vi.restoreAllMocks();
    expect(statuses(results)).toEqual([201, 409]);
    const rows = await fx.prisma.bundle.findMany({ where: { epc: shared.epc }, include: { movements: true } });
    expect(rows).toHaveLength(1);
    expect(rows[0].movements).toHaveLength(1);
    expect(rows[0].quantity).toBe(8);
    bundleIds.push(rows[0].id);

    // Batch endpoint, different operation keys, lists sharing one EPC: the
    // losing list leaves nothing (its other bundle is not saved either).
    const common = item({ quantity: 5 });
    const onlyA = item();
    const onlyB = item();
    const barrier2 = createBarrier(2);
    barrierAtTransactionStart(fx.prisma, 2, barrier2);
    const batch = await Promise.all([
      http().post('/inventory/bundles/batch').set(as('WAREHOUSE')).send({ operationKey: randomUUID(), bundles: [common, onlyA] }),
      http().post('/inventory/bundles/batch').set(as('WAREHOUSE2')).send({ operationKey: randomUUID(), bundles: [common, onlyB] }),
    ]);
    vi.restoreAllMocks();
    expect(statuses(batch)).toEqual([201, 409]);
    const winner = batch.find((r) => r.status === 201)!;
    const loserOnly = winner.body.bundles.some((b: { epc: string }) => b.epc === onlyA.epc) ? onlyB : onlyA;
    expect(await fx.prisma.bundle.count({ where: { epc: common.epc } })).toBe(1);
    expect(await fx.prisma.bundle.count({ where: { epc: loserOnly.epc } })).toBe(0);
    bundleIds.push(...winner.body.bundles.map((b: { id: string }) => b.id));
  });

  it('C. same reference and finish, different EPCs at the same time: both saved', async () => {
    const before = await fx.prisma.bundle.aggregate({ where: { referenceId: fx.ids.referenceA, finishId: fx.ids.finishA }, _sum: { quantity: true } });
    const barrier = createBarrier(2);
    barrierBeforeBundleCreate(fx.prisma, 2, barrier);
    const results = await Promise.all([
      http().post('/inventory/bundles').set(as('WAREHOUSE')).send(item({ quantity: 4 })),
      http().post('/inventory/bundles').set(as('WAREHOUSE2')).send(item({ quantity: 9 })),
    ]);
    vi.restoreAllMocks();
    expect(statuses(results)).toEqual([201, 201]);
    bundleIds.push(...results.map((r) => r.body.id));
    for (const r of results) expect(await fx.prisma.inventoryMovement.count({ where: { bundleId: r.body.id } })).toBe(1);
    const after = await fx.prisma.bundle.aggregate({ where: { referenceId: fx.ids.referenceA, finishId: fx.ids.finishA }, _sum: { quantity: true } });
    expect((after._sum.quantity ?? 0) - (before._sum.quantity ?? 0)).toBe(13);
  });

  it('D. exits of 7 and 6 on 10 profiles: only one is applied, never negative', async () => {
    const bundle = await register(10);
    barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
    const results = await Promise.all([
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 7 }, 'WAREHOUSE'),
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 6 }, 'WAREHOUSE2'),
    ]);
    expect(statuses(results)).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)?.body.message).toMatch(/supera el saldo/);
    const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
    expect([3, 4]).toContain(row.quantity);
    const exits = (await movementsOf(bundle.id)).filter((m) => m.type === 'EXIT');
    expect(exits).toHaveLength(1);
    expect(exits[0].quantityBefore).toBe(10);
    expect(exits[0].quantityAfter).toBe(row.quantity);
  });

  it('E. exits of 4 and 6 on 10 profiles: both applied, balance 0', async () => {
    const bundle = await register(10);
    barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
    const results = await Promise.all([
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 4 }, 'WAREHOUSE'),
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 6 }, 'WAREHOUSE2'),
    ]);
    expect(statuses(results)).toEqual([201, 201]);
    expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(0);
    const exits = (await movementsOf(bundle.id)).filter((m) => m.type === 'EXIT');
    expect(exits).toHaveLength(2);
    const chain = exits.map((m) => [m.quantityBefore, m.quantityAfter]).sort((a, b) => b[0] - a[0]);
    expect([[[10, 6], [6, 0]], [[10, 4], [4, 0]]]).toContainEqual(chain);
  });

  it('F. exit and full transfer at the same time match a valid order', async () => {
    for (let round = 0; round < 3; round += 1) {
      const bundle = await register(10);
      barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
      const results = await Promise.all([
        op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 3 }, 'WAREHOUSE'),
        op(bundle.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 }, 'WAREHOUSE2'),
      ]);
      vi.restoreAllMocks();
      expect(statuses(results)).toEqual([201, 201]);
      const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
      expect(row).toMatchObject({ quantity: 7, inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 });
      const [, second] = await movementsOf(bundle.id);
      const transfer = (await movementsOf(bundle.id)).find((m) => m.type === 'TRANSFER')!;
      // The transfer moved exactly the balance current when it ran.
      expect([10, 7]).toContain(transfer.quantity);
      expect(second).toBeDefined();
    }
    // Exit of everything vs transfer: either "transfer then exit" (both ok)
    // or "exit then transfer" (transfer rejected: empty bundle, no changes).
    const bundle = await register(5);
    barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
    const results = await Promise.all([
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 5 }, 'WAREHOUSE'),
      op(bundle.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 }, 'WAREHOUSE2'),
    ]);
    const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
    expect(row.quantity).toBe(0);
    const transferStatus = results[1].status;
    expect([201, 409]).toContain(transferStatus);
    expect(row.inventoryLocationId).toBe(transferStatus === 201 ? fx.ids.location2 : fx.ids.location1);
  });

  it('G. two transfers to different destinations: the second starts where the first ended', async () => {
    const bundle = await register(6);
    barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
    const results = await Promise.all([
      op(bundle.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 }, 'WAREHOUSE'),
      op(bundle.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location1, rackId: fx.ids.rack3 }, 'WAREHOUSE2'),
    ]);
    expect(statuses(results)).toEqual([201, 201]);
    const transfers = (await movementsOf(bundle.id)).filter((m) => m.type === 'TRANSFER');
    expect(transfers).toHaveLength(2);
    const sources = transfers.map((m) => m.sourceRackId);
    // Not both from the original rack 1: one of them starts at the other's destination.
    expect(sources.filter((s) => s === fx.ids.rack1)).toHaveLength(1);
    const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
    const last = transfers.find((m) => m.sourceRackId !== fx.ids.rack1)!;
    expect(row.rackId).toBe(last.destinationRackId);

    // Same destination twice: one applied, the other refused (already there).
    const other = await register(6);
    barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
    const same = await Promise.all([
      op(other.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 }, 'WAREHOUSE'),
      op(other.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 }, 'WAREHOUSE2'),
    ]);
    expect(statuses(same)).toEqual([201, 400]);
    expect((await movementsOf(other.id)).filter((m) => m.type === 'TRANSFER')).toHaveLength(1);
  });

  it('H. adjustment and exit at the same time: no update is lost', async () => {
    const bundle = await register(10);
    barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
    const results = await Promise.all([
      op(bundle.id, 'adjustments', { operationKey: randomUUID(), type: 'ADJUSTMENT_IN', quantity: 5, reason: 'Conteo físico H' }, 'ADMIN'),
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 12 }, 'WAREHOUSE'),
    ]);
    const [adjust, exit] = results;
    expect(adjust.status).toBe(201);
    const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
    // adjust→exit: 10→15→3 ; exit→adjust: exit refused (12 > 10), 10→15.
    expect(exit.status === 201 ? row.quantity === 3 : row.quantity === 15 && exit.status === 409).toBe(true);
    const adjustRow = (await movementsOf(bundle.id)).find((m) => m.type === 'ADJUSTMENT_IN')!;
    expect(adjustRow).toMatchObject({ reason: 'Conteo físico H', performedById: fx.userIds.ADMIN });

    // A WAREHOUSE adjustment racing an exit is refused and changes nothing.
    const other = await register(10);
    barrierAtTransactionStart(fx.prisma, 1, createBarrier(1));
    const mixed = await Promise.all([
      op(other.id, 'adjustments', { operationKey: randomUUID(), type: 'ADJUSTMENT_OUT', quantity: 2, reason: 'x' }, 'WAREHOUSE'),
      op(other.id, 'exit', { operationKey: randomUUID(), quantity: 1 }, 'WAREHOUSE2'),
    ]);
    expect(mixed.map((r) => r.status)).toEqual([403, 201]);
    expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: other.id } })).quantity).toBe(9);
  });

  it('I. a failure after the balance changed rolls everything back (exit and batch)', async () => {
    const bundle = await register(10);
    const original = fx.prisma.$transaction.bind(fx.prisma) as (fn: unknown, o?: unknown) => Promise<unknown>;
    const failMovement = (fn: unknown, options?: unknown) =>
      original(
        (tx: object) =>
          (fn as (t: object) => Promise<unknown>)(
            new Proxy(tx, {
              get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver) as object;
                if (property !== 'inventoryMovement') return value;
                return new Proxy(value, {
                  get(d, m, r) {
                    if (m === 'create') return () => Promise.reject(new Error('Fallo controlado de prueba'));
                    return Reflect.get(d, m, r) as unknown;
                  },
                });
              },
            }),
          ),
        options,
      );
    const spy = vi.spyOn(fx.prisma, '$transaction').mockImplementationOnce(failMovement as never);
    const res = await op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 4 });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/Fallo controlado|prisma|stack/i);
    expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(10);
    expect(await movementsOf(bundle.id)).toHaveLength(1);

    // Batch: the first bundle is inserted, then the failure aborts the rest.
    const items = [item(), item()];
    vi.spyOn(fx.prisma, '$transaction').mockImplementationOnce(failMovement as never);
    const batch = await http().post('/inventory/bundles/batch').set(as('WAREHOUSE')).send({ operationKey: randomUUID(), bundles: items });
    vi.restoreAllMocks();
    expect(batch.status).toBe(500);
    expect(await fx.prisma.bundle.count({ where: { epc: { in: items.map((i) => i.epc) } } })).toBe(0);
  });

  it('J. batch with one invalid item saves nothing and names the item', async () => {
    const items = [item(), item({ rackId: fx.ids.rack4 }), item()];
    const res = await http().post('/inventory/bundles/batch').set(as('WAREHOUSE')).send({ operationKey: randomUUID(), bundles: items });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ itemIndex: 1 });
    expect(res.body.message).toMatch(/^Paquete 2/);
    expect(await fx.prisma.bundle.count({ where: { epc: { in: items.map((i) => i.epc) } } })).toBe(0);
  });

  describe('operationKey idempotency', () => {
    it('same key and content at the same time: one effective operation', async () => {
      const bundle = await register(10);
      const key = randomUUID();
      barrierAtTransactionStart(fx.prisma, 3, createBarrier(3));
      const results = await Promise.all([1, 2, 3].map(() => op(bundle.id, 'exit', { operationKey: key, quantity: 2 })));
      expect(statuses(results)).toEqual([200, 200, 201]);
      expect(new Set(results.map((r) => r.body.movement.id)).size).toBe(1);
      expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(8);
    });

    it('later retry replays; different content, operation, bundle or user is refused without changes', async () => {
      const bundle = await register(10);
      const key = randomUUID();
      const first = await op(bundle.id, 'exit', { operationKey: key, quantity: 3, reason: 'Pedido 9' }).expect(201);
      // Lost response: the client never saw `first` and retries.
      const retry = await op(bundle.id, 'exit', { operationKey: key, quantity: 3, reason: 'Pedido 9' }).expect(200);
      expect(retry.body).toMatchObject({ replayed: true, movement: { id: first.body.movement.id } });

      const other = await register(10);
      for (const [label, res] of [
        ['otra cantidad', await op(bundle.id, 'exit', { operationKey: key, quantity: 4, reason: 'Pedido 9' })],
        ['otra operación', await op(bundle.id, 'transfer', { operationKey: key, inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 })],
        ['otro paquete', await op(other.id, 'exit', { operationKey: key, quantity: 3, reason: 'Pedido 9' })],
        ['otro usuario', await op(bundle.id, 'exit', { operationKey: key, quantity: 3, reason: 'Pedido 9' }, 'WAREHOUSE2')],
      ] as const) {
        expect(`${label}:${res.status}`).toBe(`${label}:409`);
        // Another user's result is never returned.
        expect(res.body.movement).toBeUndefined();
        expect(res.body.bundle).toBeUndefined();
      }
      expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(7);
      expect(await movementsOf(bundle.id)).toHaveLength(2);
      expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: other.id } })).quantity).toBe(10);
    });

    it('batch: same key and list at the same time saves once; other order is a different list', async () => {
      const key = randomUUID();
      const items = [item({ quantity: 2 }), item({ quantity: 3 })];
      const barrier = createBarrier(3);
      barrierAtTransactionStart(fx.prisma, 3, barrier);
      const results = await Promise.all([1, 2, 3].map(() => http().post('/inventory/bundles/batch').set(as('WAREHOUSE')).send({ operationKey: key, bundles: items })));
      vi.restoreAllMocks();
      expect(statuses(results)).toEqual([200, 200, 201]);
      const saved = await fx.prisma.bundle.findMany({ where: { epc: { in: items.map((i) => i.epc) } } });
      expect(saved).toHaveLength(2);
      bundleIds.push(...saved.map((b) => b.id));
      await http().post('/inventory/bundles/batch').set(as('WAREHOUSE')).send({ operationKey: key, bundles: [items[1], items[0]] }).expect(409);
      await http().post('/inventory/bundles/batch').set(as('WAREHOUSE2')).send({ operationKey: key, bundles: items }).expect(409);
    });

    it('a request blocked by an operation still in progress gets a retryable answer and is applied once on retry', async () => {
      const bundle = await register(10);
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      // Simulates an operation still in progress holding the bundle row.
      const holder = fx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ${bundle.id} FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 30000 },
      );
      await isLocked;
      const key = randomUUID();
      const busy = await op(bundle.id, 'exit', { operationKey: key, quantity: 4 });
      release();
      await holder;

      // Not a definitive conflict: the client must keep the same key and retry.
      expect(busy.status).toBe(503);
      expect(busy.headers['retry-after']).toBeDefined();
      expect(busy.body).toMatchObject({ retryable: true });
      expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(10);

      await op(bundle.id, 'exit', { operationKey: key, quantity: 4 }).expect(201);
      await op(bundle.id, 'exit', { operationKey: key, quantity: 4 }).expect(200);
      expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(6);
      expect(await movementsOf(bundle.id)).toHaveLength(2);
    });
  });

  it('K. two admins editing the same reference/family: no silent overwrite', async () => {
    const admin2 = await createTestUser(app, 'ADMIN', `${suffix}A2`);
    extraUsers.push(admin2.id);
    const ip2 = () => ({ ...admin2.headers, 'X-Forwarded-For': `10.21.0.${(ip++ % 250) + 1}` });

    const code = `E2EC-EDIT-${suffix}`;
    createdReferenceCodes.push(code);
    const created = await http().post('/catalog/references').set(as('ADMIN')).send({ code, description: 'Original' }).expect(201);
    const seen = created.body.updatedAt as string; // both admins loaded this version

    await http()
      .patch(`/catalog/references/${created.body.id}`)
      .set(as('ADMIN'))
      .send({ description: 'Cambio de A', expectedUpdatedAt: seen })
      .expect(200);
    // B still has the old version on screen and only changes the family.
    const stale = await http()
      .patch(`/catalog/references/${created.body.id}`)
      .set(ip2())
      .send({ familyId: fx.ids.familyB, expectedUpdatedAt: seen });
    expect(stale.status).toBe(409);
    expect(stale.body.message).toMatch(/modificada por otra persona/);
    const row = await fx.prisma.reference.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row).toMatchObject({ description: 'Cambio de A', familyId: null });

    // Simultaneous edits with the same version: exactly one wins.
    const current = row.updatedAt.toISOString();
    const barrier = createBarrier(2);
    const original = fx.prisma.reference.updateMany.bind(fx.prisma.reference);
    vi.spyOn(fx.prisma.reference, 'updateMany').mockImplementation((async (args: unknown) => {
      await barrier();
      return original(args as never);
    }) as never);
    const both = await Promise.all([
      http().patch(`/catalog/references/${created.body.id}`).set(as('ADMIN')).send({ description: 'A2', expectedUpdatedAt: current }),
      http().patch(`/catalog/references/${created.body.id}`).set(ip2()).send({ description: 'B2', expectedUpdatedAt: current }),
    ]);
    vi.restoreAllMocks();
    expect(statuses(both)).toEqual([200, 409]);
    const winner = both.find((r) => r.status === 200)!.body.description;
    expect((await fx.prisma.reference.findUniqueOrThrow({ where: { id: created.body.id } })).description).toBe(winner);

    // Families: rename with a stale version is refused too.
    const family = await fx.prisma.productFamily.findUniqueOrThrow({ where: { id: fx.ids.familyA } });
    const familySeen = family.updatedAt.toISOString();
    await http().patch(`/catalog/families/${family.id}`).set(as('ADMIN')).send({ name: 'Nombre A', expectedUpdatedAt: familySeen }).expect(200);
    await http().patch(`/catalog/families/${family.id}`).set(ip2()).send({ active: false, expectedUpdatedAt: familySeen }).expect(409);
    expect((await fx.prisma.productFamily.findUniqueOrThrow({ where: { id: family.id } })).active).toBe(true);
    // A malformed version is a validation error.
    await http().patch(`/catalog/families/${family.id}`).set(as('ADMIN')).send({ name: 'x', expectedUpdatedAt: 'ayer' }).expect(400);
  });

  it('permissions: READ_ONLY and SALES cannot change inventory, even concurrently', async () => {
    const bundle = await register(10);
    const results = await Promise.all([
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 1 }, 'READ_ONLY'),
      op(bundle.id, 'exit', { operationKey: randomUUID(), quantity: 1 }, 'SALES'),
      op(bundle.id, 'transfer', { operationKey: randomUUID(), inventoryLocationId: fx.ids.location2, rackId: fx.ids.rack4 }, 'READ_ONLY'),
      http().post('/inventory/bundles').set(as('READ_ONLY')).send(item()),
      http().post('/inventory/bundles/batch').set(as('SALES')).send({ operationKey: randomUUID(), bundles: [item()] }),
    ]);
    expect(results.map((r) => r.status)).toEqual([403, 403, 403, 403, 403]);
    expect((await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } })).quantity).toBe(10);
    expect(await movementsOf(bundle.id)).toHaveLength(1);
  });
});
