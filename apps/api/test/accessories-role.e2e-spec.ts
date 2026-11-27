import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Accessories role (docs/accesorios-fase-1.md): created before its screens.
// Like BILLING it only reaches routes that name it: today its own tasks and
// push notifications; never profiles, inventory, sales, costs nor users.
describe('Accessories role (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.74.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const inHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    for (const role of ['ADMIN', 'ACCESSORIES', 'SALES'] as const) {
      const user = await createTestUser(app, role, `AR${S}`);
      H[role] = user.headers;
      U[role] = user.id;
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the administrator creates an accessories user and can assign the role to another user', async () => {
    const created = (
      await http()
        .post('/users')
        .set(as('ADMIN'))
        .send({ name: 'Accesorios E2E', username: `e2e.acc.new.${S.toLowerCase()}`, idNumber: '1234567890', role: 'ACCESSORIES' })
        .expect(201)
    ).body as { id: string; role: string };
    expect(created.role).toBe('ACCESSORIES');

    const changed = (await http().patch(`/users/${U.SALES}/role`).set(as('ADMIN')).send({ role: 'ACCESSORIES' }).expect(200)).body as { role: string };
    expect(changed.role).toBe('ACCESSORIES');
    // The role applies from the next request: no more quotes for that user.
    await http().get('/quotes').set(as('SALES')).expect(403);
    await http().patch(`/users/${U.SALES}/role`).set(as('ADMIN')).send({ role: 'SALES' }).expect(200);
    await http().get('/quotes').set(as('SALES')).expect(200);

    const invalid = await http().patch(`/users/${U.SALES}/role`).set(as('ADMIN')).send({ role: 'ACCESORIOS' }).expect(400);
    expect(JSON.stringify(invalid.body)).toContain('ACCESSORIES');
  });

  it('manages its own tasks and notifications', async () => {
    const task = (await http().post('/tasks').set(as('ACCESSORIES')).send({ title: `Contar canastas ${S}`, dueAt: inHours(2) }).expect(201)).body as {
      id: string;
      assignee: { id: string };
    };
    expect(task.assignee.id).toBe(U.ACCESSORIES);
    await http().get('/tasks').set(as('ACCESSORIES')).expect(200);
    await http().get('/tasks/summary').set(as('ACCESSORIES')).expect(200);
    await http().get('/push/config').set(as('ACCESSORIES')).expect(200);
    // Assigning to someone else stays an administrator's decision.
    await http().post('/tasks').set(as('ACCESSORIES')).send({ title: `Otra ${S}`, dueAt: inHours(2), assigneeId: U.ADMIN }).expect(403);
  });

  it('cannot read nor write profiles, inventory, sales, costs or users', async () => {
    const forbiddenReads = [
      '/inventory/bundles',
      '/inventory/summary',
      '/catalog/references',
      '/catalog/families',
      '/catalog/finishes',
      '/locations/inventory-locations',
      '/quotes',
      '/sales-orders',
      '/dispatches',
      '/material-requests',
      '/suppliers',
      '/sale-prices',
      '/lots',
      '/users',
    ];
    for (const path of forbiddenReads) {
      const response = await http().get(path).set(as('ACCESSORIES'));
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
    }
    await http().post('/inventory/bundles').set(as('ACCESSORIES')).send({}).expect(403);
    await http().post('/inventory/bundles/lookup').set(as('ACCESSORIES')).send({ epcs: ['E2E'] }).expect(403);
    await http().post('/quotes').set(as('ACCESSORIES')).send({}).expect(403);
    await http().post('/users').set(as('ACCESSORIES')).send({}).expect(403);
  });
});
