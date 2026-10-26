import { createECDH, randomBytes } from 'node:crypto';
import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import webpush from 'web-push';
import type { UserRole } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import {
  PushDeliveryError,
  PushSender,
  type PushMessageOptions,
  type PushTarget,
} from '../src/modules/push/push.sender.js';
import { PushService } from '../src/modules/push/push.service.js';
import { PUSH_RETRY_DELAYS_MS, VAPID_CONFIG } from '../src/modules/push/push.tokens.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Outcome of one delivery attempt in the fake push service: 'ok', an HTTP
// status, or 'net' (no response).
type Outcome = 'ok' | number | 'net';

// Records every message instead of contacting a real push service.
class FakePushSender extends PushSender {
  readonly calls: { endpoint: string; payload: string; options: PushMessageOptions }[] = [];
  readonly script = new Map<string, Outcome[]>();
  failAll: Outcome | null = null;

  async send(target: PushTarget, payload: string, options: PushMessageOptions): Promise<void> {
    this.calls.push({ endpoint: target.endpoint, payload, options });
    const outcome = this.failAll ?? this.script.get(target.endpoint)?.shift() ?? 'ok';
    if (outcome === 'ok') return;
    throw new PushDeliveryError(outcome === 'net' ? null : outcome);
  }

  to(endpoint: string) {
    return this.calls.filter((call) => call.endpoint === endpoint);
  }
}

// A browser-like subscription: real P-256 key and auth secret.
function device(host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://${host}/fcm/send/e2e-${randomBytes(12).toString('hex')}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

async function eventually(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timeout waiting for push');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('Web Push (e2e)', () => {
  const suffix = uniqueSuffix();
  const vapid = { subject: 'mailto:e2e@test.local', ...webpush.generateVAPIDKeys() };
  const sender = new FakePushSender();
  const logs: string[] = [];
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const headers = {} as Record<UserRole | 'WAREHOUSE2', Record<string, string>>;
  const ids = {} as Record<UserRole | 'WAREHOUSE2', string>;

  const http = () => request(app.getHttpServer());
  const subscribe = (role: keyof typeof headers, body: unknown) =>
    http().post('/push/subscriptions').set(headers[role]).send(body as object);
  const rows = (userId: string) => prisma.pushSubscription.findMany({ where: { userId } });
  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  beforeAll(async () => {
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logs.push(String(message));
      });
    }
    app = await createE2eApp((builder) =>
      builder
        .overrideProvider(VAPID_CONFIG)
        .useValue(vapid)
        .overrideProvider(PushSender)
        .useValue(sender)
        .overrideProvider(PUSH_RETRY_DELAYS_MS)
        .useValue([5, 5]),
    );
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY'] as const) {
      const user = await createTestUser(app, role, suffix);
      headers[role] = user.headers;
      ids[role] = user.id;
    }
    const second = await createTestUser(app, 'WAREHOUSE', `${suffix}B`);
    headers.WAREHOUSE2 = second.headers;
    ids.WAREHOUSE2 = second.id;
  });

  afterAll(async () => {
    if (prisma) {
      const users = Object.values(ids);
      const subscriptions = await prisma.pushSubscription.deleteMany({ where: { userId: { in: users } } });
      const tasks = await prisma.task.deleteMany({
        where: { OR: [{ assigneeId: { in: users } }, { createdById: { in: users } }] },
      });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
      console.info('E2E push removed subscriptions:', subscriptions.count, 'tasks:', tasks.count, 'users:', users.length);
    }
    await app?.close();
    vi.restoreAllMocks();
  });

  it('gives only the public key, and only to signed-in users', async () => {
    const res = await http().get('/push/config').set(headers.READ_ONLY).expect(200);
    expect(res.body).toEqual({ enabled: true, publicKey: vapid.publicKey });
    expect(JSON.stringify(res.body)).not.toContain(vapid.privateKey);
    await http().get('/push/config').expect(401);
    await http().post('/push/subscriptions').send(device()).expect(401);
    await http().post('/push/test').expect(401);
  });

  it('stores one row per device, linked to the session user, without duplicates', async () => {
    const phone = device();
    const tablet = device('updates.push.services.mozilla.com');
    await subscribe('WAREHOUSE', phone).expect(200, { subscribed: true });
    await subscribe('WAREHOUSE', phone).expect(200); // same device again
    await subscribe('WAREHOUSE', tablet).expect(200);
    const stored = await rows(ids.WAREHOUSE);
    expect(stored.map((row) => row.endpoint).sort()).toEqual([phone.endpoint, tablet.endpoint].sort());

    await http().post('/push/subscriptions/check').set(headers.WAREHOUSE).send({ endpoint: phone.endpoint }).expect(200, { linked: true });
    // Another account only learns "not yours", never the owner.
    await http().post('/push/subscriptions/check').set(headers.SALES).send({ endpoint: phone.endpoint }).expect(200, { linked: false });
  });

  it('refuses destinations outside the browser push services and malformed keys', async () => {
    const good = device();
    const bad = [
      { ...good, endpoint: 'http://fcm.googleapis.com/fcm/send/x' },
      { ...good, endpoint: 'https://169.254.169.254/latest/meta-data' },
      { ...good, endpoint: 'https://fcm.googleapis.com.evil.example/x' },
      { ...good, endpoint: 'https://localhost:3000/inventory' },
      { ...good, keys: { ...good.keys, p256dh: 'AAAA' } },
      { ...good, keys: { ...good.keys, auth: randomBytes(4).toString('base64url') } },
      { ...good, userId: ids.ADMIN }, // the owner always comes from the session
      { endpoint: good.endpoint },
    ];
    for (const body of bad) await subscribe('SALES', body).expect(400);
    expect(await rows(ids.SALES)).toHaveLength(0);
    expect(await rows(ids.ADMIN)).toHaveLength(0);
  });

  it('a device belongs to one account: the next account takes it over, other devices stay', async () => {
    const shared = device();
    const own = device();
    await subscribe('WAREHOUSE2', shared).expect(200);
    await subscribe('WAREHOUSE2', own).expect(200);
    // SALES signs in on the shared tablet and activates notifications.
    await subscribe('SALES', shared).expect(200);
    expect((await rows(ids.WAREHOUSE2)).map((row) => row.endpoint)).toEqual([own.endpoint]);
    expect((await rows(ids.SALES)).map((row) => row.endpoint)).toEqual([shared.endpoint]);

    // WAREHOUSE2 cannot unlink the device that now belongs to SALES.
    await http().post('/push/subscriptions/remove').set(headers.WAREHOUSE2).send({ endpoint: shared.endpoint }).expect(200, { removed: false });
    expect(await rows(ids.SALES)).toHaveLength(1);

    // Logging out on the shared tablet unlinks only that device.
    await http().post('/push/subscriptions/remove').set(headers.SALES).send({ endpoint: shared.endpoint }).expect(200, { removed: true });
    await http().post('/push/subscriptions/remove').set(headers.SALES).send({ endpoint: shared.endpoint }).expect(200, { removed: false });
    expect(await rows(ids.SALES)).toHaveLength(0);
    expect(await rows(ids.WAREHOUSE2)).toHaveLength(1);
  });

  it('sends a test only to the own devices, with a cooldown, and drops expired subscriptions', async () => {
    const [phone, tablet] = (await rows(ids.WAREHOUSE)).map((row) => row.endpoint);
    const other = (await rows(ids.WAREHOUSE2))[0].endpoint;
    sender.script.set(tablet, [410]); // the browser unsubscribed: gone
    const before = sender.calls.length;

    const res = await http().post('/push/test').set(headers.WAREHOUSE).expect(200);
    expect(res.body).toEqual({ devices: 2, delivered: 1, removed: 1, failed: 0 });
    const sent = sender.calls.slice(before);
    expect(sent.map((call) => call.endpoint).sort()).toEqual([phone, tablet].sort());
    expect(sent.every((call) => call.payload === JSON.stringify({ type: 'test' }))).toBe(true);
    expect(sender.to(other)).toHaveLength(0);
    expect((await rows(ids.WAREHOUSE)).map((row) => row.endpoint)).toEqual([phone]);
    expect((await rows(ids.WAREHOUSE))[0].lastSuccessAt).not.toBeNull();

    const again = await http().post('/push/test').set(headers.WAREHOUSE).expect(429);
    expect(again.body.message).toMatch(/Espera \d+ s/);
    // No devices: nothing to test.
    await http().post('/push/test').set(headers.READ_ONLY).expect(400);
  });

  it('retries temporary failures a limited number of times and keeps the device', async () => {
    const [own] = await rows(ids.WAREHOUSE2);
    sender.script.set(own.endpoint, [503, 'net', 503, 503]);
    const before = sender.calls.length;
    const res = await http().post('/push/test').set(headers.WAREHOUSE2).expect(200);
    expect(res.body).toEqual({ devices: 1, delivered: 0, removed: 0, failed: 1 });
    expect(sender.calls.length - before).toBe(3); // 1 + 2 retries
    expect(await rows(ids.WAREHOUSE2)).toHaveLength(1);
  });

  it('notifies the assignee after an ADMIN assigns a task; own tasks are not notified', async () => {
    const [phone] = await rows(ids.WAREHOUSE);
    const before = sender.to(phone.endpoint).length;
    const task = await http()
      .post('/tasks')
      .set(headers.ADMIN)
      .send({ title: 'Inventario pasillo 12', dueAt: inHours(4), assigneeId: ids.WAREHOUSE })
      .expect(201);
    await eventually(() => sender.to(phone.endpoint).length === before + 1);
    const last = sender.to(phone.endpoint).at(-1)!;
    // Discreet: no title, names or ids in the payload.
    expect(last.payload).toBe(JSON.stringify({ type: 'task-assigned' }));
    expect(last.payload).not.toContain('pasillo');
    expect(last.payload).not.toContain(task.body.id);
    expect(last.options).toMatchObject({ urgency: 'normal', topic: 'task-assigned' });

    const total = sender.calls.length;
    await http().post('/tasks').set(headers.WAREHOUSE).send({ title: 'Propia', dueAt: inHours(4) }).expect(201);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sender.calls.length).toBe(total);
  });

  it('a failing push service never changes or repeats the task', async () => {
    sender.failAll = 'net';
    try {
      const before = await prisma.task.count({ where: { assigneeId: ids.WAREHOUSE } });
      const res = await http()
        .post('/tasks')
        .set(headers.ADMIN)
        .send({ title: 'Contar burro 7', dueAt: inHours(4), assigneeId: ids.WAREHOUSE })
        .expect(201);
      expect(res.body).toMatchObject({ title: 'Contar burro 7', status: 'pending', assigneeId: ids.WAREHOUSE });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await prisma.task.count({ where: { assigneeId: ids.WAREHOUSE } })).toBe(before + 1);
      expect(await rows(ids.WAREHOUSE)).toHaveLength(1); // network errors keep the device
    } finally {
      sender.failAll = null;
    }
  });

  it('does not notify inactive users and drops rows with a forbidden destination', async () => {
    const forbidden = await prisma.pushSubscription.create({
      data: { userId: ids.READ_ONLY, endpoint: 'https://evil.example/x', ...device().keys },
    });
    const before = sender.calls.length;
    await http()
      .post('/tasks')
      .set(headers.ADMIN)
      .send({ title: 'Revisar', dueAt: inHours(4), assigneeId: ids.READ_ONLY })
      .expect(201);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await prisma.pushSubscription.findUnique({ where: { id: forbidden.id } })).toBeNull();
    expect(sender.calls.length).toBe(before); // never contacted

    // A deactivated account keeps its rows but receives nothing.
    await prisma.user.update({ where: { id: ids.WAREHOUSE2 }, data: { active: false } });
    const report = await app.get(PushService).sendToUser(ids.WAREHOUSE2, 'task-assigned');
    expect(report).toEqual({ devices: 0, delivered: 0, removed: 0, failed: 0 });
    expect(sender.calls.length).toBe(before);
  });

  it('never logs endpoints or keys', () => {
    expect(logs.length).toBeGreaterThan(0);
    const text = logs.join('\n');
    expect(text).not.toMatch(/\/fcm\/send\//);
    expect(text).not.toMatch(/e2e-[0-9a-f]{24}/);
    expect(text).not.toContain(vapid.privateKey);
  });
});
