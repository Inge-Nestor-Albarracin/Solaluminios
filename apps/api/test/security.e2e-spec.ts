import { randomBytes, randomUUID } from 'node:crypto';
import { HttpException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { hashPassword } from '../src/infrastructure/security/password.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createE2eApp, uniqueSuffix } from './support/e2e.js';
import { createInventoryFixtures } from './support/inventory-fixtures.js';

type Fixtures = Awaited<ReturnType<typeof createInventoryFixtures>>;

// Security fixes from the audit of 15/10/2026.
describe('Security hardening (e2e)', () => {
  const suffix = uniqueSuffix();
  let app: INestApplication<App>;
  let fx: Fixtures;
  const extraUsers: string[] = [];

  beforeAll(async () => {
    app = await createE2eApp();
    fx = await createInventoryFixtures(app, suffix, ['ADMIN', 'WAREHOUSE']);
  });

  afterAll(async () => {
    if (fx) await fx.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    await fx?.cleanup();
    await app?.close();
  });

  it('sends defensive headers and hides the framework', async () => {
    for (const res of [
      await request(app.getHttpServer()).get('/inventory/summary').set(fx.headers.ADMIN),
      await request(app.getHttpServer()).get('/inventory/summary'),
    ]) {
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('locks an account after 5 failed logins, even with the right password', async () => {
    const password = randomBytes(12).toString('base64url');
    const email = `e2e-lock-${suffix.toLowerCase()}@test.local`;
    const user = await fx.prisma.user.create({
      data: { name: 'E2E lock', email, passwordHash: await hashPassword(password), role: 'READ_ONLY' },
    });
    extraUsers.push(user.id);
    // Called on the service: the per-IP throttler (5/min on /auth/login)
    // would otherwise answer 429 first and hide the per-account rule.
    const auth = app.get(AuthService);
    const status = async (pwd: string) => {
      try {
        await auth.login({ email, password: pwd });
        return 200;
      } catch (error) {
        return error instanceof HttpException ? error.getStatus() : 500;
      }
    };

    expect(await status(password)).toBe(200);
    for (let i = 0; i < 5; i += 1) expect(await status('wrong-password')).toBe(401);
    expect(await status(password)).toBe(429);
    // Unknown emails are counted the same way (no account enumeration).
    const ghost = `e2e-ghost-${suffix.toLowerCase()}@test.local`;
    for (let i = 0; i < 5; i += 1) {
      await auth.login({ email: ghost, password: 'x' }).catch(() => undefined);
    }
    await expect(auth.login({ email: ghost, password: 'x' })).rejects.toMatchObject({ status: 429 });
  }, 60000);

  it('answers 409 instead of waiting when a bundle stays locked', async () => {
    const bundle = await fx.register({ quantity: 5 });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));

    // Another transaction holds the row lock for longer than lock_timeout.
    const holder = fx.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ${bundle.id} FOR UPDATE`;
        locked();
        await released;
      },
      { timeout: 20000 },
    );
    await isLocked;

    const started = Date.now();
    const res = await request(app.getHttpServer())
      .post(`/inventory/bundles/${bundle.id}/exit`)
      .set(fx.headers.WAREHOUSE)
      .send({ operationKey: randomUUID(), quantity: 1 });
    release();
    await holder;

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/otra operación/);
    expect(Date.now() - started).toBeLessThan(9000);
    const row = await fx.prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
    expect(row.quantity).toBe(5);
  }, 30000);

  it('rejects an adjustment above the per-bundle maximum with 400, not 500', async () => {
    const bundle = await fx.register({ quantity: 999_999 });
    await request(app.getHttpServer())
      .post(`/inventory/bundles/${bundle.id}/adjustments`)
      .set(fx.headers.ADMIN)
      .send({ operationKey: randomUUID(), type: 'ADJUSTMENT_IN', quantity: 5, reason: 'Prueba tope' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/inventory/bundles/${bundle.id}/adjustments`)
      .set(fx.headers.ADMIN)
      .send({ operationKey: randomUUID(), type: 'ADJUSTMENT_IN', quantity: 1, reason: 'Prueba tope' })
      .expect(201);
  });

  it('bundle detail returns only the latest 20 movements, newest first', async () => {
    const bundle = await fx.register({ quantity: 30 });
    for (let i = 0; i < 22; i += 1) {
      await request(app.getHttpServer())
        .post(`/inventory/bundles/${bundle.id}/exit`)
        .set(fx.headers.WAREHOUSE)
        .send({ operationKey: randomUUID(), quantity: 1 })
        .expect(201);
    }
    const detail = await request(app.getHttpServer())
      .get(`/inventory/bundles/${bundle.id}`)
      .set(fx.headers.WAREHOUSE)
      .expect(200);
    expect(detail.body.movements).toHaveLength(20);
    expect(detail.body.movements[0].quantityAfter).toBe(8);
    const history = await request(app.getHttpServer())
      .get(`/inventory/bundles/${bundle.id}/movements?pageSize=100`)
      .set(fx.headers.WAREHOUSE)
      .expect(200);
    expect(history.body.total).toBe(23);
  });
});
