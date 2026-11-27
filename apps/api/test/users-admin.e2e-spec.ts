import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// User administration used by the "Administración" screen: create users with
// a role and change roles later. Only test users are touched.
describe('User administration (e2e)', () => {
  const suffix = uniqueSuffix().toLowerCase();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: { id: string; headers: Record<string, string> };
  let warehouse: { id: string; headers: Record<string, string> };
  const created: string[] = [];

  // Each request from its own address: the per-IP limit on creating users
  // (10 per minute) is not what these cases check.
  let ip = 0;
  const http = () => {
    ip += 1;
    return { post: (path: string) => request(app.getHttpServer()).post(path).set('X-Forwarded-For', `10.89.0.${ip % 250}`), get: (path: string) => request(app.getHttpServer()).get(path), patch: (path: string) => request(app.getHttpServer()).patch(path) };
  };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    admin = await createTestUser(app, 'ADMIN', suffix);
    warehouse = await createTestUser(app, 'WAREHOUSE', suffix);
    created.push(admin.id, warehouse.id);
  });

  afterAll(async () => {
    if (prisma) await prisma.user.deleteMany({ where: { id: { in: created } } });
    delete process.env.TRUST_PROXY;
    await app?.close();
  });

  it('ADMIN creates a user with a user name and the ID number as initial password; the response never includes it', async () => {
    const idNumber = `9${String(Date.now()).slice(-8)}`;
    const username = `e2e.ana.${suffix}`;
    const res = await http()
      .post('/users')
      .set(admin.headers)
      .send({ name: '  Ana Ventas  ', username: ` E2E.Ana.${suffix.toUpperCase()} `, idNumber, email: ` E2E-Ana-${suffix}@TEST.local `, role: 'SALES' })
      .expect(201);
    created.push(res.body.id);
    expect(res.body).toMatchObject({ name: 'Ana Ventas', username, email: `e2e-ana-${suffix}@test.local`, role: 'SALES', active: true, mustChangePassword: true });
    expect(JSON.stringify(res.body)).not.toMatch(/"password"|scrypt|passwordHash/i);
    expect(JSON.stringify(res.body)).not.toContain(idNumber);

    // The new account logs in with its user name and ID number.
    const login = await http().post('/auth/login').send({ username, password: idNumber }).expect(200);
    expect(login.body.user).toMatchObject({ role: 'SALES', username, mustChangePassword: true });

    for (const duplicate of [
      { name: 'Duplicado', username, idNumber, role: 'SALES' },
      { name: 'Duplicado', username: `e2e.otro.${suffix}`, idNumber, email: `e2e-ana-${suffix}@test.local`, role: 'SALES' },
    ]) {
      await http().post('/users').set(admin.headers).send(duplicate).expect(409);
    }
    for (const bad of [
      { name: 'Corta', username: `e2e.c.${suffix}`, idNumber: '123', role: 'SALES' },
      { name: 'Letras', username: `e2e.l.${suffix}`, idNumber: '12AB5678', role: 'SALES' },
      { name: 'Rol', username: `e2e.r.${suffix}`, idNumber, role: 'JEFE' },
      { name: '', username: `e2e.v.${suffix}`, idNumber },
      { name: 'Usuario', username: 'Pedro Álvarez', idNumber },
      { name: 'Usuario', username: 'ab', idNumber },
      { name: 'Usuario', username: `pedro..${suffix}`, idNumber },
      { name: 'Correo', username: `e2e.m.${suffix}`, idNumber, email: 'no-es-correo' },
      { name: 'Clave', username: `e2e.k.${suffix}`, idNumber, password: 'Algo12345678' },
    ]) {
      await http().post('/users').set(admin.headers).send(bad).expect(400);
    }
  });

  it('ADMIN changes the role of another user; it applies to the existing session', async () => {
    const target = await createTestUser(app, 'READ_ONLY', `${suffix}t`);
    created.push(target.id);
    await http().post('/inventory/bundles/batch').set(target.headers).send({}).expect(403);

    const res = await http().patch(`/users/${target.id}/role`).set(admin.headers).send({ role: 'WAREHOUSE' }).expect(200);
    expect(res.body.role).toBe('WAREHOUSE');
    // Same token, new permissions: the guard reads the role on every request.
    const me = await http().get('/auth/me').set(target.headers).expect(200);
    expect(me.body.role).toBe('WAREHOUSE');
    await http().post('/inventory/bundles/batch').set(target.headers).send({}).expect(400);

    await http().patch(`/users/${target.id}/role`).set(admin.headers).send({ role: 'JEFE' }).expect(400);
    await http().patch(`/users/${target.id}/role`).set(admin.headers).send({}).expect(400);
    await http().patch(`/users/missing-${suffix}/role`).set(admin.headers).send({ role: 'SALES' }).expect(404);
  });

  it('nobody changes their own role and only ADMIN manages users', async () => {
    await http().patch(`/users/${admin.id}/role`).set(admin.headers).send({ role: 'READ_ONLY' }).expect(400);
    await http().patch(`/users/${admin.id}/role`).set(warehouse.headers).send({ role: 'READ_ONLY' }).expect(403);
    await http().patch(`/users/${warehouse.id}/role`).set(warehouse.headers).send({ role: 'ADMIN' }).expect(403);
    await http().get('/users').set(warehouse.headers).expect(403);
    await http()
      .post('/users')
      .set(warehouse.headers)
      .send({ name: 'X', username: `e2e.x.${suffix}`, idNumber: '1234567890' })
      .expect(403);
    await http().patch(`/users/${admin.id}/role`).send({ role: 'READ_ONLY' }).expect(401);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: warehouse.id } });
    expect(row.role).toBe('WAREHOUSE');
  });
});
