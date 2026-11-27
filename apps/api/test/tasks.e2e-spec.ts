import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { UserRole } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Tasks: employees create their own, ADMIN (the boss) assigns to anyone,
// only the assignee completes, and a task not completed by its deadline
// leaves the pending list and stays in the incomplete list.
describe('Tasks (e2e)', () => {
  const suffix = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const headers = {} as Record<UserRole | 'INACTIVE', Record<string, string>>;
  const ids = {} as Record<UserRole | 'INACTIVE', string>;

  const http = () => request(app.getHttpServer());
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const post = (body: Record<string, unknown>, role: UserRole = 'WAREHOUSE') =>
    http().post('/tasks').set(headers[role]).send(body);
  const list = (query: string, role: UserRole = 'WAREHOUSE') =>
    http().get(`/tasks${query}`).set(headers[role]);

  // Expired tasks cannot be created through the API (deadline must be in the
  // future), so they are inserted directly with past dates.
  const insertExpired = (assignee: UserRole, title: string) =>
    prisma.task.create({
      data: {
        title,
        dueAt: new Date(Date.now() - 3_600_000),
        createdAt: new Date(Date.now() - 2 * 3_600_000),
        assigneeId: ids[assignee],
        createdById: ids[assignee],
      },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY'] as const) {
      const user = await createTestUser(app, role, suffix);
      headers[role] = user.headers;
      ids[role] = user.id;
    }
    const inactive = await createTestUser(app, 'WAREHOUSE', `${suffix}X`);
    await prisma.user.update({ where: { id: inactive.id }, data: { active: false } });
    ids.INACTIVE = inactive.id;
  });

  afterAll(async () => {
    if (prisma) {
      const users = Object.values(ids);
      const removed = await prisma.task.deleteMany({
        where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      console.info('E2E tasks removed:', removed.count, 'users:', users.length);
    }
    await app?.close();
  });

  it('any employee creates their own tasks; the creator comes from the session', async () => {
    for (const role of ['WAREHOUSE', 'SALES', 'READ_ONLY'] as const) {
      const res = await post({ title: `  Contar burro 7 ${role}  `, dueAt: inHours(5) }, role).expect(201);
      expect(res.body).toMatchObject({
        title: `Contar burro 7 ${role}`,
        status: 'pending',
        completedAt: null,
        assigneeId: ids[role],
        createdById: ids[role],
      });
      expect(Object.keys(res.body.assignee).sort()).toEqual(['id', 'name', 'role']);
    }
    // Explicitly assigning to oneself is the same as omitting it.
    await post({ title: 'Propia', dueAt: inHours(5), assigneeId: ids.WAREHOUSE }).expect(201);
  });

  it('only ADMIN assigns tasks to other people', async () => {
    const res = await post(
      { title: 'Revisar pasillo 12', description: 'Antes del inventario', dueAt: inHours(30), assigneeId: ids.WAREHOUSE },
      'ADMIN',
    ).expect(201);
    expect(res.body).toMatchObject({ assigneeId: ids.WAREHOUSE, createdById: ids.ADMIN, status: 'pending' });

    await post({ title: 'No permitido', dueAt: inHours(5), assigneeId: ids.SALES }, 'WAREHOUSE').expect(403);
    await post({ title: 'No permitido', dueAt: inHours(5), assigneeId: ids.WAREHOUSE }, 'READ_ONLY').expect(403);
    await post({ title: 'Inactivo', dueAt: inHours(5), assigneeId: ids.INACTIVE }, 'ADMIN').expect(400);
    await post({ title: 'No existe', dueAt: inHours(5), assigneeId: `missing-${suffix}` }, 'ADMIN').expect(404);
  });

  it('validates title, deadline and unknown fields', async () => {
    const bad: Record<string, unknown>[] = [
      { title: '   ', dueAt: inHours(2) },
      { title: 'x'.repeat(121), dueAt: inHours(2) },
      { title: 'Pasada', dueAt: inHours(-1) },
      { title: 'Ya mismo', dueAt: new Date(Date.now() + 10_000).toISOString() },
      { title: 'Sin zona', dueAt: '2027-01-10T10:00:00' },
      { title: 'Texto', dueAt: 'mañana' },
      { title: 'Muy lejos', dueAt: inHours(24 * 400) },
      { title: 'Suplantar', dueAt: inHours(2), createdById: ids.ADMIN },
      { title: 'Ya hecha', dueAt: inHours(2), completedAt: new Date().toISOString() },
      { title: 'Desc', dueAt: inHours(2), description: 'd'.repeat(1001) },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(`${JSON.stringify(body).slice(0, 40)}:${res.status}`).toMatch(/:400$/);
    }
    // Explicit offset of Bogotá is accepted.
    const bogota = new Date(Date.now() + 26 * 3_600_000).toISOString().slice(0, 19) + '-05:00';
    await post({ title: 'Con zona Bogotá', dueAt: bogota }).expect(201);
  });

  it('employees only see their own tasks; ADMIN sees everyone or one employee', async () => {
    const mine = await list('?status=pending&pageSize=100').expect(200);
    expect(mine.body.items.length).toBeGreaterThan(0);
    expect(mine.body.items.every((t: { assigneeId: string }) => t.assigneeId === ids.WAREHOUSE)).toBe(true);
    // Sorted by deadline, soonest first.
    const due = mine.body.items.map((t: { dueAt: string }) => t.dueAt);
    expect([...due].sort((a: string, b: string) => a.localeCompare(b))).toEqual(due);

    await list(`?assigneeId=${ids.WAREHOUSE}`, 'SALES').expect(403);
    const warehouseTask = mine.body.items[0];
    await http().get(`/tasks/${warehouseTask.id}`).set(headers.SALES).expect(404);
    await http().get(`/tasks/${warehouseTask.id}`).set(headers.WAREHOUSE).expect(200);

    // ADMIN sees every employee's tasks. Checked per employee: without a
    // filter it lists the whole shared test database, where these may fall
    // beyond the first page.
    const all = await list('?status=pending&pageSize=100', 'ADMIN').expect(200);
    const ofWarehouse = await list(`?status=pending&assigneeId=${ids.WAREHOUSE}`, 'ADMIN').expect(200);
    const one = await list(`?status=pending&assigneeId=${ids.SALES}`, 'ADMIN').expect(200);
    expect(ofWarehouse.body.items.length).toBeGreaterThan(0);
    expect(one.body.items.length).toBeGreaterThan(0);
    expect(all.body.total).toBeGreaterThanOrEqual(ofWarehouse.body.total + one.body.total);
    expect(ofWarehouse.body.items.every((t: { assigneeId: string }) => t.assigneeId === ids.WAREHOUSE)).toBe(true);
    expect(one.body.items.every((t: { assigneeId: string }) => t.assigneeId === ids.SALES)).toBe(true);

    for (const bad of ['?status=done', '?pageSize=101', '?assigneeId=', '?foo=1']) {
      await list(bad, 'ADMIN').expect(400);
    }
  });

  it('only the assignee completes; completing twice changes nothing', async () => {
    const task = (await post({ title: 'Etiquetar paquetes', dueAt: inHours(4) }, 'ADMIN').expect(201)).body;
    const assigned = (
      await post({ title: 'Asignada a bodega', dueAt: inHours(4), assigneeId: ids.WAREHOUSE }, 'ADMIN').expect(201)
    ).body;

    // ADMIN created it but is not the assignee.
    await http().patch(`/tasks/${assigned.id}/complete`).set(headers.ADMIN).expect(403);
    await http().patch(`/tasks/${assigned.id}/complete`).set(headers.SALES).expect(404);
    const done = await http().patch(`/tasks/${assigned.id}/complete`).set(headers.WAREHOUSE).expect(200);
    expect(done.body.status).toBe('completed');
    const again = await http().patch(`/tasks/${assigned.id}/complete`).set(headers.WAREHOUSE).expect(200);
    expect(again.body.completedAt).toBe(done.body.completedAt);

    const pending = await list('?status=pending&pageSize=100').expect(200);
    expect(pending.body.items.map((t: { id: string }) => t.id)).not.toContain(assigned.id);
    const completed = await list('?status=completed&pageSize=100').expect(200);
    expect(completed.body.items.map((t: { id: string }) => t.id)).toContain(assigned.id);

    // Concurrent clicks: both succeed with the same completion time.
    const results = await Promise.all([1, 2, 3].map(() => http().patch(`/tasks/${task.id}/complete`).set(headers.ADMIN)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map((r) => r.body.completedAt)).size).toBe(1);
  });

  it('a task not completed by its deadline leaves the pending list and stays as incomplete', async () => {
    const expired = await insertExpired('WAREHOUSE', 'Vencida ayer');
    const pending = await list('?status=pending&pageSize=100').expect(200);
    expect(pending.body.items.map((t: { id: string }) => t.id)).not.toContain(expired.id);
    const incomplete = await list('?status=incomplete&pageSize=100').expect(200);
    const row = incomplete.body.items.find((t: { id: string }) => t.id === expired.id);
    expect(row).toMatchObject({ status: 'incomplete', completedAt: null });

    const res = await http().patch(`/tasks/${expired.id}/complete`).set(headers.WAREHOUSE).expect(409);
    expect(res.body.message).toMatch(/venció/);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: expired.id } })).completedAt).toBeNull();

    // A task that expires while in the list moves on its own (no job needed).
    const soon = await prisma.task.create({
      data: {
        title: 'Vence en segundos',
        dueAt: new Date(Date.now() + 1500),
        assigneeId: ids.WAREHOUSE,
        createdById: ids.WAREHOUSE,
      },
    });
    let ids1 = (await list('?status=pending&pageSize=100').expect(200)).body.items.map((t: { id: string }) => t.id);
    expect(ids1).toContain(soon.id);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    ids1 = (await list('?status=pending&pageSize=100').expect(200)).body.items.map((t: { id: string }) => t.id);
    expect(ids1).not.toContain(soon.id);
    const ids2 = (await list('?status=incomplete&pageSize=100').expect(200)).body.items.map((t: { id: string }) => t.id);
    expect(ids2).toContain(soon.id);
  });

  it('summary counts match the lists', async () => {
    const summary = await http().get('/tasks/summary').set(headers.WAREHOUSE).expect(200);
    for (const status of ['pending', 'completed', 'incomplete'] as const) {
      const res = await list(`?status=${status}&pageSize=1`).expect(200);
      expect(summary.body[status]).toBe(res.body.total);
    }
    await http().get(`/tasks/summary?assigneeId=${ids.SALES}`).set(headers.WAREHOUSE).expect(403);
    await http().get(`/tasks/summary?assigneeId=${ids.WAREHOUSE}`).set(headers.ADMIN).expect(200);
  });

  it('the database refuses completing after the deadline (CHECK constraint)', async () => {
    const expired = await insertExpired('SALES', 'Intento directo');
    await expect(
      prisma.task.update({ where: { id: expired.id }, data: { completedAt: new Date() } }),
    ).rejects.toThrow();
  });

  it('requires a session', async () => {
    await http().get('/tasks').expect(401);
    await http().post('/tasks').send({ title: 'x', dueAt: inHours(2) }).expect(401);
    await http().get('/tasks/summary').expect(401);
  });
});
