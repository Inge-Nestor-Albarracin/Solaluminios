import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  barrierAtTransactionStart,
  createBarrier,
  ledgerProblems,
} from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';
import { createInventoryFixtures } from './support/inventory-fixtures.js';

const ROUNDS = 20;

// The three critical races repeated with fresh data every round. No generic
// test retries: every round must pass on its own.
describe(`Critical races repeated ${ROUNDS} times (e2e)`, () => {
  const suffix = uniqueSuffix();
  let app: INestApplication<App>;
  let fx: Awaited<ReturnType<typeof createInventoryFixtures>>;
  let warehouse2: { id: string; headers: Record<string, string> };
  const bundleIds: string[] = [];
  let ip = 0;
  let n = 0;

  const as = (headers: Record<string, string>) => {
    ip += 1;
    return { ...headers, 'X-Forwarded-For': `10.30.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const body = (quantity: number) => ({
    epc: `E2ER${suffix}${String(++n).padStart(4, '0')}`,
    referenceId: fx.ids.referenceA,
    finishId: fx.ids.finishA,
    quantity,
    inventoryLocationId: fx.ids.location1,
    rackId: fx.ids.rack1,
    registrationType: 'INITIAL_STOCK',
    arrivalDatePrecision: 'UNKNOWN',
  });
  const register = async (quantity: number) => {
    const res = await request(app.getHttpServer()).post('/inventory/bundles').set(as(fx.headers.WAREHOUSE)).send(body(quantity)).expect(201);
    bundleIds.push(res.body.id);
    return res.body.id as string;
  };
  const sorted = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b);

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    fx = await createInventoryFixtures(app, suffix, ['WAREHOUSE']);
    warehouse2 = await createTestUser(app, 'WAREHOUSE', `${suffix}R2`);
  });

  afterAll(async () => {
    if (fx) {
      await fx.cleanup();
      await fx.prisma.user.deleteMany({ where: { id: warehouse2?.id } });
    }
    await app?.close();
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => vi.restoreAllMocks());

  it('same EPC from two users: always exactly one bundle and one movement', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const shared = body(5);
      // Both start at once; the EPC identity lock serialises them.
      barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
      const results = await Promise.all([
        request(app.getHttpServer()).post('/inventory/bundles').set(as(fx.headers.WAREHOUSE)).send(shared),
        request(app.getHttpServer()).post('/inventory/bundles').set(as(warehouse2.headers)).send(shared),
      ]);
      vi.restoreAllMocks();
      const rows = await fx.prisma.bundle.findMany({ where: { epc: shared.epc }, include: { _count: { select: { movements: true } } } });
      outcomes.push(`${sorted(results).join('/')}:${rows.length}b${rows[0]?._count.movements ?? 0}m`);
      bundleIds.push(...rows.map((r) => r.id));
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('201/409:1b1m'));
  });

  it('exits of 7 and 6 on 10 profiles: always one applied, balance 3 or 4', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await register(10);
      barrierAtTransactionStart(fx.prisma, 2, createBarrier(2));
      const results = await Promise.all([
        request(app.getHttpServer()).post(`/inventory/bundles/${id}/exit`).set(as(fx.headers.WAREHOUSE)).send({ operationKey: randomUUID(), quantity: 7 }),
        request(app.getHttpServer()).post(`/inventory/bundles/${id}/exit`).set(as(warehouse2.headers)).send({ operationKey: randomUUID(), quantity: 6 }),
      ]);
      vi.restoreAllMocks();
      const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id } });
      const exits = await fx.prisma.inventoryMovement.count({ where: { bundleId: id, type: 'EXIT' } });
      outcomes.push(`${sorted(results).join('/')}:${[3, 4].includes(row.quantity) ? 'ok' : row.quantity}:${exits}`);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('201/409:ok:1'));
  });

  it('same operationKey sent three times at once: always one movement', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const id = await register(10);
      const key = randomUUID();
      barrierAtTransactionStart(fx.prisma, 3, createBarrier(3));
      const results = await Promise.all(
        [1, 2, 3].map(() =>
          request(app.getHttpServer()).post(`/inventory/bundles/${id}/exit`).set(as(fx.headers.WAREHOUSE)).send({ operationKey: key, quantity: 2 }),
        ),
      );
      vi.restoreAllMocks();
      const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id } });
      const exits = await fx.prisma.inventoryMovement.count({ where: { bundleId: id, type: 'EXIT' } });
      outcomes.push(`${sorted(results).join('/')}:${row.quantity}:${exits}`);
    }
    expect(outcomes).toEqual(Array(ROUNDS).fill('200/200/201:8:1'));
    expect(await ledgerProblems(fx.prisma, bundleIds)).toEqual([]);
  });
});
