import type { INestApplication } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Login by user name with the ID number as initial password
// (docs/usuarios-y-contrasenas.md): the forced change at the first login,
// password rules, old sessions ending, the administrator's reset, user name
// changes, e-mails still accepted, generic errors, the per-account lock and
// the login log. Test users only (unique suffix).
describe('Login by user name and initial password (e2e)', () => {
  const S = uniqueSuffix().toLowerCase();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: { id: string; headers: Record<string, string> };
  let seller: { id: string; headers: Record<string, string> };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  // Its own address per request: the per-IP throttler is not under test here.
  const from = (headers: Record<string, string> = {}) => {
    ip += 1;
    return { ...headers, 'X-Forwarded-For': `10.88.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const login = (body: Record<string, string>) => http().post('/auth/login').set(from()).send(body);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const idNumber = (n: number) => `8${String(Date.now()).slice(-7)}${n}`;

  const createUser = async (name: string, username: string, cedula: string, extra: Record<string, string> = {}) => {
    const res = await http().post('/users').set(from(admin.headers)).send({ name, username, idNumber: cedula, role: 'SALES', ...extra }).expect(201);
    return res.body as { id: string; username: string; mustChangePassword: boolean };
  };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    admin = await createTestUser(app, 'ADMIN', `LG${S}`);
    seller = await createTestUser(app, 'SALES', `LG${S}`);
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await app?.close();
  });

  it('first login with the ID number: only changing it is allowed, with its rules; then the old session ends', async () => {
    const cedula = idNumber(1);
    const username = `pedro.alvarez.${S}`;
    await createUser('Pedro Álvarez', username, cedula);

    const first = await login({ username, password: cedula }).expect(200);
    expect(first.body.user).toMatchObject({ username, mustChangePassword: true });
    const t1 = first.body.access_token as string;

    // Nothing but «me» and the change.
    const blocked = await http().get('/quotes').set(from(bearer(t1))).expect(403);
    expect(blocked.body).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    await http().get('/tasks').set(from(bearer(t1))).expect(403);
    expect((await http().get('/auth/me').set(from(bearer(t1))).expect(200)).body).toMatchObject({ username, mustChangePassword: true });

    const change = (token: string, currentPassword: string, newPassword: string) =>
      http().post('/auth/change-password').set(from(bearer(token))).send({ currentPassword, newPassword });
    expect((await change(t1, 'otra-cosa', 'Nueva2026x').expect(400)).body.message).toMatch(/actual no es correcta/);
    // The ID number again, too short, without a digit, with the user name.
    expect((await change(t1, cedula, cedula).expect(400)).body.message).toMatch(/una letra y un número/);
    expect((await change(t1, cedula, 'Ab1').expect(400)).body.message).toMatch(/al menos 8/);
    expect((await change(t1, cedula, 'SoloLetras').expect(400)).body.message).toMatch(/una letra y un número/);
    expect((await change(t1, cedula, `x${username}9`).expect(400)).body.message).toMatch(/usuario/);
    await http().post('/auth/change-password').set(from(bearer(t1))).send({ currentPassword: cedula }).expect(400);

    // Issued in an earlier second, so it must stop working after the change.
    await sleep(1100);
    const changed = await change(t1, cedula, 'Aluminio2026').expect(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    const t2 = changed.body.access_token as string;
    expect((await http().get('/auth/me').set(from(bearer(t1))).expect(401)).body.message).toMatch(/contraseña cambió/);
    await http().get('/quotes').set(from(bearer(t2))).expect(200);

    // The ID number no longer opens the account; the new password does.
    await login({ username, password: cedula }).expect(401);
    expect((await login({ username, password: 'Aluminio2026' }).expect(200)).body.user.mustChangePassword).toBe(false);
    // A voluntary change must be different from the current password.
    expect((await change(t2, 'Aluminio2026', 'Aluminio2026').expect(400)).body.message).toMatch(/distinta de la actual/);
  }, 60000);

  it('the same answer for an unknown user, a wrong password and an inactive user; hostile names never break the login', async () => {
    const cedula = idNumber(2);
    const username = `ines.mora.${S}`;
    const user = await createUser('Inés Mora', username, cedula);
    const wrong = await login({ username, password: 'no-es' }).expect(401);
    const unknown = await login({ username: `nadie.${S}`, password: cedula }).expect(401);
    expect(unknown.body.message).toBe(wrong.body.message);
    await http().patch(`/users/${user.id}/active`).set(from(admin.headers)).send({ active: false }).expect(200);
    expect((await login({ username, password: cedula }).expect(401)).body.message).toBe(wrong.body.message);
    for (const hostile of ["' OR '1'='1", "x'; DROP TABLE users;--", 'a'.repeat(254)]) {
      await login({ username: hostile, password: 'x' }).expect(401);
    }
    await login({ username: 'a'.repeat(255), password: 'x' }).expect(400);
    await login({ password: 'x' }).expect(400);
    await login({ username: `nadie.${S}`, password: 'x', extra: 'y' }).expect(400);
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });

  it('an e-mail is still accepted during the change, and the lock counts the account whichever name is typed', async () => {
    const cedula = idNumber(3);
    const username = `luis.rey.${S}`;
    await createUser('Luis Rey', username, cedula, { email: `luis.rey.${S}@test.local` });
    await login({ email: `luis.rey.${S}@test.local`, password: cedula }).expect(200);
    await login({ username: `LUIS.REY.${S}@TEST.LOCAL`, password: cedula }).expect(200);

    // On the service: the per-IP throttler would answer 429 first.
    const auth = app.get(AuthService);
    const status = (body: { username?: string; email?: string; password: string }) =>
      auth.login(body).then(
        () => 200,
        (error: unknown) => (error instanceof HttpException ? error.getStatus() : 500),
      );
    for (let i = 0; i < 3; i += 1) expect(await status({ username, password: 'mala' })).toBe(401);
    for (let i = 0; i < 2; i += 1) expect(await status({ email: `luis.rey.${S}@test.local`, password: 'mala' })).toBe(401);
    // 5 failures on the account (3 by name, 2 by e-mail): locked even with the right password.
    expect(await status({ username, password: cedula })).toBe(429);
    expect(await status({ email: `luis.rey.${S}@test.local`, password: cedula })).toBe(429);
  });

  it('the administrator resets a forgotten password back to the ID number and changes user names', async () => {
    const cedula = idNumber(4);
    const username = `ana.gil.${S}`;
    const user = await createUser('Ana Gil', username, cedula);
    const first = (await login({ username, password: cedula }).expect(200)).body.access_token as string;
    const own = (await http().post('/auth/change-password').set(from(bearer(first))).send({ currentPassword: cedula, newPassword: 'Perfiles77' }).expect(200)).body
      .access_token as string;

    // Only an administrator, never on themselves, with a valid ID number.
    await http().post(`/users/${user.id}/reset-password`).set(from(seller.headers)).send({ idNumber: cedula }).expect(403);
    await http().post(`/users/${admin.id}/reset-password`).set(from(admin.headers)).send({ idNumber: cedula }).expect(400);
    await http().post(`/users/${user.id}/reset-password`).set(from(admin.headers)).send({ idNumber: '12ab' }).expect(400);
    await http().post(`/users/nadie-${S}/reset-password`).set(from(admin.headers)).send({ idNumber: cedula }).expect(404);
    await sleep(1100);
    const reset = await http().post(`/users/${user.id}/reset-password`).set(from(admin.headers)).send({ idNumber: cedula }).expect(200);
    expect(reset.body).toMatchObject({ mustChangePassword: true });
    // Its open session ends; the ID number works again, with the forced change.
    await http().get('/auth/me').set(from(bearer(own))).expect(401);
    await login({ username, password: 'Perfiles77' }).expect(401);
    expect((await login({ username, password: cedula }).expect(200)).body.user.mustChangePassword).toBe(true);

    // New user name: the old one stops working; repeated or invalid ones are refused.
    await http().patch(`/users/${user.id}/username`).set(from(admin.headers)).send({ username: ` Ana.Gil.Nueva.${S.toUpperCase()} ` }).expect(200);
    await login({ username: `ana.gil.nueva.${S}`, password: cedula }).expect(200);
    await login({ username, password: cedula }).expect(401);
    const other = await createUser('Otra Persona', `otra.persona.${S}`, idNumber(5));
    await http().patch(`/users/${other.id}/username`).set(from(admin.headers)).send({ username: `ana.gil.nueva.${S}` }).expect(409);
    for (const bad of ['Con Espacio', 'ñandú', 'ab', '.punto', 'doble..punto']) {
      await http().patch(`/users/${other.id}/username`).set(from(admin.headers)).send({ username: bad }).expect(400);
    }
    await http().patch(`/users/${other.id}/username`).set(from(seller.headers)).send({ username: `x.${S}` }).expect(403);
  }, 60000);

  it('the login log keeps logins, failures (also of unknown names), changes and resets, never passwords; only for ADMIN', async () => {
    const cedula = idNumber(6);
    const username = `log.user.${S}`;
    const user = await createUser('Log User', username, cedula);
    await login({ username, password: 'equivocada' }).expect(401);
    const token = (await login({ username, password: cedula }).expect(200)).body.access_token as string;
    await http().post('/auth/change-password').set(from(bearer(token))).send({ currentPassword: cedula, newPassword: 'Bodega2026' }).expect(200);
    await http().post(`/users/${user.id}/reset-password`).set(from(admin.headers)).send({ idNumber: cedula }).expect(200);
    await login({ username: `fantasma.${S}`, password: 'x' }).expect(401);

    const mine = await http().get(`/users/login-events?userId=${user.id}`).set(from(admin.headers)).expect(200);
    const types = (mine.body.items as { type: string }[]).map((e) => e.type);
    expect(types).toEqual(['PASSWORD_RESET', 'PASSWORD_CHANGED', 'LOGIN_OK', 'LOGIN_FAILED']);
    expect((mine.body.items as { type: string; actor: { id: string } | null }[])[0].actor?.id).toBe(admin.id);
    expect((mine.body.items as { ip: string | null }[])[0].ip).toBeNull();
    expect((mine.body.items as { ip: string | null }[])[1].ip).toMatch(/^10\.88\./);
    const text = JSON.stringify(mine.body);
    for (const secret of [cedula, 'Bodega2026', 'equivocada', 'passwordHash']) expect(text).not.toContain(secret);

    const ghosts = await http().get('/users/login-events?type=LOGIN_FAILED&pageSize=100').set(from(admin.headers)).expect(200);
    expect((ghosts.body.items as { identifier: string; user: unknown }[]).find((e) => e.identifier === `fantasma.${S}`)).toMatchObject({ user: null });
    await http().get('/users/login-events').set(from(seller.headers)).expect(403);
    await http().get("/users/login-events?type=LOGIN_OK' OR 1=1--").set(from(admin.headers)).expect(400);
    await http().get('/users/login-events?pageSize=1000').set(from(admin.headers)).expect(400);

    // The user list shows the last login and the pending initial password.
    const list = (await http().get('/users').set(from(admin.headers)).expect(200)).body as { id: string; lastLoginAt: string | null; mustChangePassword: boolean }[];
    expect(list.find((u) => u.id === user.id)).toMatchObject({ mustChangePassword: true, lastLoginAt: expect.any(String) });
  }, 60000);

  it('users created without a user name get a valid random one; the database refuses invalid names', async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: seller.id } });
    expect(row.username).toMatch(/^usuario\.[0-9a-f]{10}$/);
    await expect(prisma.user.update({ where: { id: seller.id }, data: { username: 'Con Mayúsculas' } })).rejects.toThrow();
    await expect(prisma.user.update({ where: { id: seller.id }, data: { email: 'MAYUS@TEST.LOCAL' } })).rejects.toThrow();
  });
});
