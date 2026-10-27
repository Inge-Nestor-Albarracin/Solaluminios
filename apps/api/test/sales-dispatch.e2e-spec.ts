import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import webpush from 'web-push';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { OutboxService } from '../src/modules/notifications/outbox.service.js';
import { PushDeliveryError, PushSender } from '../src/modules/push/push.sender.js';
import { PUSH_RETRY_DELAYS_MS, VAPID_CONFIG } from '../src/modules/push/push.tokens.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// End-to-end acceptance of origin, purchases, quotes, orders, reservations,
// dispatches with RFID validation, outbox notices and fixed readers, on the
// dedicated PostgreSQL test database. Codes "17.30"/"17.39" are FIXTURES of
// this run (the real catalog has no such references yet); nothing here
// touches real data. Push delivery uses a fake sender.

class FakeSender extends PushSender {
  calls = 0;
  failWith: number | 'net' | null = null;
  async send(): Promise<void> {
    this.calls += 1;
    if (this.failWith !== null) throw new PushDeliveryError(this.failWith === 'net' ? null : this.failWith);
  }
}

type Role = 'ADMIN' | 'SALES' | 'SALES2' | 'WAREHOUSE' | 'WAREHOUSE_B' | 'READ_ONLY' | 'CHINA' | 'CHINA2';

describe('Origin, purchases, sales, reservations and dispatch (e2e)', () => {
  const S = uniqueSuffix();
  const sender = new FakeSender();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H = {} as Record<Role, Record<string, string>>;
  const U = {} as Record<Role, string>;
  const ids = {
    branch: '', locA: '', locB: '', aisleA: '', aisleB: '', rackA: '', rackB: '',
    r1730: '', r1739: '', bm: '', np: '',
    cn: '', n1: '', n2: '', n3: '', shipment: '', customer: '',
  };
  let epcCounter = 0;
  const epc = () => `E2E${S}${String(++epcCounter).padStart(4, '0')}`;
  const http = () => request(app.getHttpServer());
  const as = (role: Role) => H[role];

  const register = (role: Role, data: { epc: string; referenceId: string; finishId: string; quantity: number; origin?: string; supplierId?: string; loc?: 'A' | 'B' }) =>
    http()
      .post('/inventory/bundles')
      .set(as(role))
      .send({
        epc: data.epc,
        referenceId: data.referenceId,
        finishId: data.finishId,
        quantity: data.quantity,
        inventoryLocationId: data.loc === 'B' ? ids.locB : ids.locA,
        rackId: data.loc === 'B' ? ids.rackB : ids.rackA,
        registrationType: 'ENTRY',
        arrivalDatePrecision: 'UNKNOWN',
        ...(data.origin ? { origin: data.origin } : {}),
        ...(data.supplierId ? { supplierId: data.supplierId } : {}),
      });

  const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
  const quoteLine = (line: Record<string, unknown>) => ({ discountPercent: '0', taxRatePercent: '19', ...line });

  // Bundles of this run (by EPC prefix of the suffix: exact list kept).
  const bundles = {} as Record<string, { id: string; epc: string }>;

  beforeAll(async () => {
    const vapid = { subject: 'mailto:e2e@test.local', ...webpush.generateVAPIDKeys() };
    app = await createE2eApp((builder) =>
      builder.overrideProvider(VAPID_CONFIG).useValue(vapid).overrideProvider(PushSender).useValue(sender).overrideProvider(PUSH_RETRY_DELAYS_MS).useValue([1, 1]),
    );
    prisma = app.get(PrismaService);
    const user = async (key: Role, role: Parameters<typeof createTestUser>[1], sfx: string) => {
      const created = await createTestUser(app, role, sfx);
      H[key] = created.headers;
      U[key] = created.id;
    };
    await user('ADMIN', 'ADMIN', S);
    await user('SALES', 'SALES', S);
    await user('SALES2', 'SALES', `${S}2`);
    await user('WAREHOUSE', 'WAREHOUSE', S);
    await user('WAREHOUSE_B', 'WAREHOUSE', `${S}B`);
    await user('READ_ONLY', 'READ_ONLY', S);
    await user('CHINA', 'CHINA_OPERATOR', S);
    await user('CHINA2', 'CHINA_OPERATOR', `${S}2`);

    const branch = await prisma.branch.create({ data: { code: `E2E-SD-${S}`, name: 'Sucursal ventas' } });
    ids.branch = branch.id;
    for (const key of ['A', 'B'] as const) {
      const loc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `E2E-SD${key}-${S}`, name: `Bodega ${key}` } });
      const aisle = await prisma.aisle.create({ data: { inventoryLocationId: loc.id, number: 1 } });
      const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } });
      ids[`loc${key}`] = loc.id;
      ids[`aisle${key}`] = aisle.id;
      ids[`rack${key}`] = rack.id;
    }
    await prisma.user.update({ where: { id: U.WAREHOUSE }, data: { defaultInventoryLocationId: ids.locA } });
    await prisma.user.update({ where: { id: U.WAREHOUSE_B }, data: { defaultInventoryLocationId: ids.locB } });
    ids.r1730 = (await prisma.reference.create({ data: { code: `17.30-E2E${S}`, description: 'Fixture 17.30' } })).id;
    ids.r1739 = (await prisma.reference.create({ data: { code: `17.39-E2E${S}`, description: 'Fixture 17.39' } })).id;
    ids.bm = (await prisma.finish.create({ data: { code: `BM-E2E${S}`, description: 'Blanco mate' } })).id;
    ids.np = (await prisma.finish.create({ data: { code: `NPL-E2E${S}`, description: 'Negro perla' } })).id;
  });

  afterAll(async () => {
    if (prisma) {
      const userIds = Object.values(U);
      const refIds = [ids.r1730, ids.r1739].filter(Boolean);
      const orders = await prisma.salesOrder.findMany({ where: { createdById: { in: userIds } }, select: { id: true } });
      const dispatches = await prisma.dispatch.findMany({ where: { salesOrderId: { in: orders.map((o) => o.id) } }, select: { id: true } });
      const dIds = dispatches.map((d) => d.id);
      const devices = await prisma.readerDevice.findMany({ where: { createdById: { in: userIds } }, select: { id: true } });
      const bundleRows = await prisma.bundle.findMany({ where: { referenceId: { in: refIds } }, select: { id: true } });
      const bIds = bundleRows.map((b) => b.id);
      const steps: [string, () => Promise<{ count: number }>][] = [
        ['outbox', () => prisma.notificationOutbox.deleteMany({ where: { userId: { in: userIds } } })],
        ['observations', () => prisma.readerObservation.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['readerEvents', () => prisma.readerEvent.deleteMany({ where: { deviceId: { in: devices.map((d) => d.id) } } })],
        ['readerSessions', () => prisma.readerSession.deleteMany({ where: { deviceId: { in: devices.map((d) => d.id) } } })],
        ['readers', () => prisma.readerDevice.deleteMany({ where: { id: { in: devices.map((d) => d.id) } } })],
        ['incidents', () => prisma.dispatchIncident.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['picks', () => prisma.dispatchPick.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['reservations', () => prisma.stockReservation.deleteMany({ where: { bundleId: { in: bIds } } })],
        ['tasks', () => prisma.task.deleteMany({ where: { OR: [{ assigneeId: { in: userIds } }, { createdById: { in: userIds } }] } })],
        ['movements', () => prisma.inventoryMovement.deleteMany({ where: { bundleId: { in: bIds } } })],
        ['dispatchLines', () => prisma.dispatchLine.deleteMany({ where: { dispatchId: { in: dIds } } })],
        ['dispatches', () => prisma.dispatch.deleteMany({ where: { id: { in: dIds } } })],
        ['orderLines', () => prisma.salesOrderLine.deleteMany({ where: { salesOrderId: { in: orders.map((o) => o.id) } } })],
        ['orders', () => prisma.salesOrder.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } })],
        ['quotes', () => prisma.quote.deleteMany({ where: { createdById: { in: userIds } } })],
        ['customers', () => prisma.customer.deleteMany({ where: { createdById: { in: userIds } } })],
        ['preRegistrations', () => prisma.inboundPreRegistration.deleteMany({ where: { referenceId: { in: refIds } } })],
        ['bundles', () => prisma.bundle.deleteMany({ where: { id: { in: bIds } } })],
        ['lots', () => prisma.stockLot.deleteMany({ where: { referenceId: { in: refIds } } })],
        ['purchases', () => prisma.purchase.deleteMany({ where: { createdById: { in: userIds } } })],
        ['shipments', () => prisma.inboundShipment.deleteMany({ where: { createdById: { in: userIds } } })],
        ['suppliers', () => prisma.supplier.deleteMany({ where: { code: { endsWith: `-${S}` } } })],
        ['settings', () => prisma.setting.deleteMany({ where: { updatedById: { in: userIds } } })],
        ['audit', () => prisma.auditEvent.deleteMany({ where: { userId: { in: userIds } } })],
        ['pushSubscriptions', () => prisma.pushSubscription.deleteMany({ where: { userId: { in: userIds } } })],
        ['users', () => prisma.user.deleteMany({ where: { id: { in: userIds } } })],
        ['references', () => prisma.reference.deleteMany({ where: { id: { in: refIds } } })],
        ['finishes', () => prisma.finish.deleteMany({ where: { id: { in: [ids.bm, ids.np].filter(Boolean) } } })],
        ['racks', () => prisma.rack.deleteMany({ where: { id: { in: [ids.rackA, ids.rackB] } } })],
        ['aisles', () => prisma.aisle.deleteMany({ where: { id: { in: [ids.aisleA, ids.aisleB] } } })],
        ['locations', () => prisma.inventoryLocation.deleteMany({ where: { id: { in: [ids.locA, ids.locB] } } })],
        ['branch', () => prisma.branch.deleteMany({ where: { id: ids.branch } })],
      ];
      const removed: Record<string, number> = {};
      for (const [name, step] of steps) removed[name] = (await step()).count;
      console.info('E2E sales-dispatch removed:', JSON.stringify(removed));
    }
    delete process.env.READER_CAPTURE_ENABLED;
    await app?.close();
  });

  // --- 1. Suppliers, configuration and the China operator ----------------------

  it('#1 China pre-registration: supplier and origin from configuration; no stock in Colombia', async () => {
    const supplier = (code: string, origins: string[]) =>
      http().post('/suppliers').set(as('ADMIN')).send({ code: `${code}-${S}`, name: `Proveedor ${code}`, origins }).expect(201);
    ids.cn = (await supplier('CN', ['CHINA'])).body.id;
    ids.n1 = (await supplier('N1', ['NATIONAL'])).body.id;
    ids.n2 = (await supplier('N2', ['NATIONAL'])).body.id;
    ids.n3 = (await supplier('N3', ['NATIONAL'])).body.id;
    await http().patch(`/suppliers/${ids.n3}`).set(as('ADMIN')).send({ active: false }).expect(200);

    // Without configuration: useful error, nothing saved.
    const first = epc();
    const unconfigured = await http()
      .post('/china/pre-registrations')
      .set(as('CHINA'))
      .send({ epc: first, referenceId: ids.r1730, finishId: ids.bm, quantity: 25, shipmentId: 'none', operationKey: randomUUID() })
      .expect(409);
    expect(unconfigured.body.message).toMatch(/not configured/i);

    await http().patch('/supply/settings').set(as('ADMIN')).send({ chinaSupplierId: ids.cn, dispatchSupervisorId: U.ADMIN }).expect(200);
    ids.shipment = (await http().post('/china/shipments').set(as('ADMIN')).send({ code: `SHIP-${S}` }).expect(201)).body.id;
    const context = await http().get('/china/context').set(as('CHINA')).expect(200);
    expect(context.body).toMatchObject({ supplier: { code: `CN-${S}` }, shipment: { id: ids.shipment }, problem: null });

    const key = randomUUID();
    const body = { epc: first.toLowerCase(), referenceId: ids.r1730, finishId: ids.bm, quantity: 25, shipmentId: ids.shipment, operationKey: key };
    const created = await http().post('/china/pre-registrations').set(as('CHINA')).send(body).expect(201);
    expect(created.body.preRegistration).toMatchObject({ epc: first, quantity: 25, status: 'PENDING' });
    expect(JSON.stringify(created.body)).not.toMatch(/cost|supplier|location|rack/i);
    const replay = await http().post('/china/pre-registrations').set(as('CHINA')).send(body).expect(201);
    expect(replay.body.replayed).toBe(true);
    const pre = await prisma.inboundPreRegistration.findFirstOrThrow({ where: { epc: first }, include: { lot: true } });
    expect(pre.lot).toMatchObject({ origin: 'CHINA', supplierId: ids.cn, kind: 'CHINA_SHIPMENT' });
    expect(await prisma.bundle.count({ where: { epc: first } })).toBe(0);
    bundles.china = { id: '', epc: first };
  });

  it('#2 China operator cannot override provenance nor read internal data', async () => {
    const base = { referenceId: ids.r1730, finishId: ids.bm, quantity: 5, shipmentId: ids.shipment, operationKey: randomUUID() };
    await http().post('/china/pre-registrations').set(as('CHINA')).send({ ...base, epc: epc(), supplierId: ids.n1 }).expect(400);
    await http().post('/china/pre-registrations').set(as('CHINA')).send({ ...base, epc: epc(), origin: 'NATIONAL' }).expect(400);
    const moved = await http().post('/china/pre-registrations').set(as('CHINA')).send({ ...base, epc: epc(), shipmentId: 'other' }).expect(409);
    expect(moved.body.message).toMatch(/shipment changed/i);
    for (const path of ['/inventory/bundles', '/lots', '/purchases', `/sales/availability?referenceId=${ids.r1730}&finishId=${ids.bm}`, '/tasks', '/quotes', '/suppliers', '/catalog/references', '/dispatches', '/users']) {
      await http().get(path).set(as('CHINA')).expect(403);
    }
    expect((await http().get('/china/pre-registrations').set(as('CHINA2')).expect(200)).body.total).toBe(0);
    expect((await http().get('/china/pre-registrations').set(as('CHINA')).expect(200)).body.total).toBe(1);
    // Only the operator role pre-registers.
    await http().post('/china/pre-registrations').set(as('WAREHOUSE')).send({ ...base, epc: epc() }).expect(403);
  });

  it('#3 national entry requires an active, admissible supplier; nothing partial is saved', async () => {
    const tries = [
      { origin: 'NATIONAL' },
      { origin: 'NATIONAL', supplierId: ids.cn },
      { origin: 'NATIONAL', supplierId: ids.n3 },
      { supplierId: ids.n1 },
    ];
    for (const extra of tries) {
      const code = epc();
      await register('WAREHOUSE', { epc: code, referenceId: ids.r1730, finishId: ids.bm, quantity: 3, ...extra }).expect(400);
      expect(await prisma.bundle.count({ where: { epc: code } })).toBe(0);
    }
    // An announced Chinese chip goes through reception, not manual entry.
    const manual = await register('WAREHOUSE', { epc: bundles.china.epc, referenceId: ids.r1730, finishId: ids.bm, quantity: 25, origin: 'CHINA' }).expect(409);
    expect(manual.body.message).toMatch(/Recepción/);
  });

  it('#5 #6 reception: single, keeps expected vs received, needs a reason for differences', async () => {
    const found = await http().get(`/inbound/pre-registrations/epc/${bundles.china.epc}`).set(as('WAREHOUSE')).expect(200);
    expect(found.body).toMatchObject({ expectedQuantity: 25, lot: { origin: 'CHINA', supplier: { id: ids.cn } } });
    await http().get(`/inbound/pre-registrations/epc/${bundles.china.epc}`).set(as('CHINA')).expect(403);
    const body = { epc: bundles.china.epc, quantity: 24, inventoryLocationId: ids.locA, rackId: ids.rackA, operationKey: randomUUID() };
    await http().post('/inbound/receive').set(as('WAREHOUSE')).send(body).expect(400);
    const received = await http().post('/inbound/receive').set(as('WAREHOUSE')).send({ ...body, discrepancyReason: 'Un perfil dañado en tránsito' }).expect(201);
    expect(received.body.bundle).toMatchObject({ quantity: 24, lot: { origin: 'CHINA' } });
    bundles.china.id = received.body.bundle.id;
    const replay = await http().post('/inbound/receive').set(as('WAREHOUSE')).send({ ...body, discrepancyReason: 'Un perfil dañado en tránsito' }).expect(201);
    expect(replay.body.replayed).toBe(true);
    const again = await http().post('/inbound/receive').set(as('WAREHOUSE')).send({ ...body, operationKey: randomUUID(), discrepancyReason: 'x' }).expect(409);
    expect(again.body.message).toMatch(/ya fue recibido/);
    const pre = await prisma.inboundPreRegistration.findFirstOrThrow({ where: { epc: bundles.china.epc } });
    expect(pre).toMatchObject({ status: 'RECEIVED', expectedQuantity: 25, receivedQuantity: 24, receivedBundleId: bundles.china.id });
    expect(await prisma.inventoryMovement.count({ where: { bundleId: bundles.china.id, type: 'ENTRY' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { entityId: pre.id, action: 'RECEIVED_WITH_DIFFERENCE' } })).toBe(1);
  });

  // Races that need the (global) China configuration run here, in sequence
  // with the rest of this file, 20 rounds each with fresh chips.
  const sorted = (results: { status: number }[]) => results.map((r) => r.status).sort((a, b) => a - b).join('/');

  it('#5 the same pre-registered EPC received by two workers at once (20 rounds): one bundle, one ENTRY', async () => {
    await prisma.user.update({ where: { id: U.WAREHOUSE_B }, data: { defaultInventoryLocationId: ids.locA } });
    const outcomes: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const code = epc();
      await http()
        .post('/china/pre-registrations')
        .set(as('CHINA'))
        .send({ epc: code, referenceId: ids.r1739, finishId: ids.bm, quantity: 6, shipmentId: ids.shipment, operationKey: randomUUID() })
        .expect(201);
      const results = await Promise.all(
        (['WAREHOUSE', 'WAREHOUSE_B'] as const).map((who) =>
          http().post('/inbound/receive').set(as(who)).send({ epc: code, quantity: 6, inventoryLocationId: ids.locA, rackId: ids.rackA, operationKey: randomUUID() }),
        ),
      );
      const rows = await prisma.bundle.findMany({ where: { epc: code }, include: { _count: { select: { movements: true } } } });
      outcomes.push(`${sorted(results)}:${rows.length}b${rows[0]?._count.movements ?? 0}m`);
    }
    await prisma.user.update({ where: { id: U.WAREHOUSE_B }, data: { defaultInventoryLocationId: ids.locB } });
    expect(outcomes).toEqual(Array(20).fill('201/409:1b1m'));
  });

  it('#5 pre-registration and manual entry of the same chip at once (20 rounds): never both', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 20; round += 1) {
      const code = epc();
      const results = await Promise.all([
        http().post('/china/pre-registrations').set(as('CHINA')).send({ epc: code, referenceId: ids.r1739, finishId: ids.bm, quantity: 4, shipmentId: ids.shipment, operationKey: randomUUID() }),
        register('WAREHOUSE', { epc: code, referenceId: ids.r1739, finishId: ids.bm, quantity: 4, origin: 'NATIONAL', supplierId: ids.n1 }),
      ]);
      const total =
        (await prisma.bundle.count({ where: { epc: code } })) +
        (await prisma.inboundPreRegistration.count({ where: { epc: code, status: { not: 'CANCELLED' } } }));
      outcomes.push(`${sorted(results)}:${total}`);
    }
    expect(outcomes).toEqual(Array(20).fill('201/409:1'));
  });

  it('#4 same reference and finish from China and National with several suppliers stay separate', async () => {
    const reg = async (name: string, data: Omit<Parameters<typeof register>[1], 'epc'>) => {
      const code = epc();
      const res = await register('WAREHOUSE', { epc: code, ...data }).expect(201);
      bundles[name] = { id: res.body.id, epc: code };
      return res.body;
    };
    const n1a = await reg('n1a', { referenceId: ids.r1730, finishId: ids.bm, quantity: 30, origin: 'NATIONAL', supplierId: ids.n1 });
    expect(n1a.lot).toMatchObject({ origin: 'NATIONAL', supplier: { id: ids.n1 } });
    await reg('n1b', { referenceId: ids.r1730, finishId: ids.bm, quantity: 10, origin: 'NATIONAL', supplierId: ids.n1 });
    await reg('n2a', { referenceId: ids.r1730, finishId: ids.bm, quantity: 15, origin: 'NATIONAL', supplierId: ids.n2 });
    await reg('n1c', { referenceId: ids.r1739, finishId: ids.np, quantity: 12, origin: 'NATIONAL', supplierId: ids.n1 });
    const cn2 = await reg('cn2', { referenceId: ids.r1739, finishId: ids.np, quantity: 20, origin: 'CHINA' });
    expect(cn2.lot).toMatchObject({ origin: 'CHINA', supplier: { id: ids.cn } });
    const unknown = await reg('unknown', { referenceId: ids.r1730, finishId: ids.bm, quantity: 50 });
    expect(unknown.lot).toBeNull();

    const availability = await http().get(`/sales/availability?referenceId=${ids.r1730}&finishId=${ids.bm}&inventoryLocationId=${ids.locA}`).set(as('SALES')).expect(200);
    const summary = Object.fromEntries(availability.body.map((g: { origin: string; supplier: { code: string } | null; physical: number }) => [`${g.origin}:${g.supplier?.code ?? '-'}`, g.physical]));
    expect(summary).toEqual({ [`CHINA:CN-${S}`]: 24, [`NATIONAL:N1-${S}`]: 40, [`NATIONAL:N2-${S}`]: 15, 'UNKNOWN:-': 50 });
  });

  // --- 2. Purchases and costs ---------------------------------------------------

  it('#7 purchase of 1.000.000 COP with a 3 % general discount: 30.000 allocated exactly; cost per profile on the lots', async () => {
    const lotN1 = (await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.n1a.id } })).lotId!;
    const lotN1c = (await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.n1c.id } })).lotId!;
    const line = (referenceId: string, finishId: string, lotIds: string[], extra: Record<string, unknown> = {}) => ({
      referenceId, finishId, origin: 'NATIONAL', unitName: 'perfil', profilesPerUnit: '1', quantity: '0', unitPrice: '10000',
      lineDiscountType: 'NONE', lineDiscountValue: '0', taxRatePercent: '19', taxRecoverable: true, lotIds, ...extra,
    });
    const purchase = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({
        supplierId: ids.n1, documentNumber: `F-${S}`, documentDate: '2026-10-20', currency: 'COP',
        globalDiscountType: 'PERCENT', globalDiscountValue: '3',
        lines: [line(ids.r1730, ids.bm, [lotN1], { quantity: '60' }), line(ids.r1739, ids.np, [lotN1c], { quantity: '40' })],
        charges: [],
      })
      .expect(201);
    expect(purchase.body.issues).toEqual([]);
    expect(Number(purchase.body.globalDiscountTotal)).toBe(30000);
    expect(purchase.body.lines.map((l: { globalDiscountAmount: string }) => Number(l.globalDiscountAmount))).toEqual([18000, 12000]);
    expect(purchase.body.lines.map((l: { netAmount: string }) => Number(l.netAmount))).toEqual([582000, 388000]);
    expect(Number(purchase.body.netTotal)).toBe(970000);
    expect((await prisma.stockLot.findUniqueOrThrow({ where: { id: lotN1 } })).unitCost).toBeNull(); // draft: cost still pending
    await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(200);
    expect(Number((await prisma.stockLot.findUniqueOrThrow({ where: { id: lotN1 } })).unitCost)).toBe(9700);
    expect(Number((await prisma.stockLot.findUniqueOrThrow({ where: { id: lotN1c } })).unitCost)).toBe(9700);
    await http().post(`/purchases/${purchase.body.id}/confirm`).set(as('ADMIN')).expect(409);

    // Draft without explicit tax data cannot be confirmed; nothing is invented.
    const draft = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({ supplierId: ids.n2, documentNumber: `F2-${S}`, documentDate: '2026-10-20', currency: 'USD', globalDiscountType: 'NONE', globalDiscountValue: '0', lines: [line(ids.r1730, ids.bm, [], { quantity: '5', taxRatePercent: null, taxRecoverable: null })], charges: [] })
      .expect(201);
    expect(draft.body.issues.join(' ')).toMatch(/tasa de cambio/);
    const refused = await http().post(`/purchases/${draft.body.id}/confirm`).set(as('ADMIN')).expect(400);
    expect(refused.body.issues.length).toBeGreaterThan(0);
    for (const role of ['SALES', 'WAREHOUSE', 'READ_ONLY'] as const) await http().get('/purchases').set(as(role)).expect(403);
    await http().get('/lots').set(as('SALES')).expect(403);
  });

  it('#8 markup on cost vs gross margin on sale with cost 9.700', async () => {
    const q = (method: string, percent: string) =>
      http().get(`/sales/price-suggestion?referenceId=${ids.r1739}&finishId=${ids.np}&origin=NATIONAL&method=${method}&percent=${percent}`).set(as('SALES'));
    expect((await q('MARKUP_ON_COST', '30').expect(200)).body).toMatchObject({ suggestedUnitPrice: '12610.00', costBasis: '9700.000000' });
    expect((await q('GROSS_MARGIN', '30').expect(200)).body.suggestedUnitPrice).toBe('13857.14');
    await q('GROSS_MARGIN', '100').expect(400);
    const noCost = await http().get(`/sales/price-suggestion?referenceId=${ids.r1730}&finishId=${ids.bm}&origin=CHINA&method=MARKUP_ON_COST&percent=30`).set(as('SALES')).expect(200);
    expect(noCost.body.available).toBe(false);
    await http().get(`/sales/price-suggestion?referenceId=${ids.r1739}&finishId=${ids.np}&origin=NATIONAL&method=MARKUP_ON_COST&percent=30`).set(as('WAREHOUSE')).expect(403);
  });

  // --- 3. Quotes and orders ---------------------------------------------------------

  let order1 = '';
  let order2 = '';

  it('#9 #10 quote keeps its conditions; conversion is idempotent and single', async () => {
    ids.customer = (await http().post('/customers').set(as('SALES')).send({ name: `Cliente ${S}` }).expect(201)).body.id;
    const quote = await http()
      .post('/quotes')
      .set(as('SALES'))
      .send({
        customerId: ids.customer,
        lines: [
          quoteLine({ referenceId: ids.r1730, finishId: ids.bm, origin: 'CHINA', quantity: 20, pricingMethod: 'MANUAL', unitPrice: '15000', priceReason: 'Precio de lista China' }),
          quoteLine({ referenceId: ids.r1739, finishId: ids.np, origin: 'NATIONAL', quantity: 10, pricingMethod: 'MARKUP_ON_COST', pricingPercent: '30' }),
        ],
      })
      .expect(201);
    expect(quote.body.lines[1]).toMatchObject({ unitPrice: '12610', costBasis: '9700', referenceCode: `17.39-E2E${S}`, origin: 'NATIONAL' });
    expect(await prisma.stockReservation.count({ where: { bundle: { referenceId: { in: [ids.r1730, ids.r1739] } } } })).toBe(0);

    // A later, more expensive purchase does not recalculate the quote.
    const newer = epc();
    const later = await register('WAREHOUSE', { epc: newer, referenceId: ids.r1739, finishId: ids.np, quantity: 30, origin: 'NATIONAL', supplierId: ids.n1 }).expect(201);
    bundles.n1d = { id: later.body.id, epc: newer };
    const p2 = await http()
      .post('/purchases')
      .set(as('ADMIN'))
      .send({ supplierId: ids.n1, documentNumber: `F3-${S}`, documentDate: '2026-10-25', currency: 'COP', globalDiscountType: 'NONE', globalDiscountValue: '0', lines: [{ referenceId: ids.r1739, finishId: ids.np, origin: 'NATIONAL', unitName: 'perfil', profilesPerUnit: '1', quantity: '30', unitPrice: '20000', lineDiscountType: 'NONE', lineDiscountValue: '0', taxRatePercent: '19', taxRecoverable: true, lotIds: [later.body.lot.id] }], charges: [] })
      .expect(201);
    await http().post(`/purchases/${p2.body.id}/confirm`).set(as('ADMIN')).expect(200);
    const kept = await http().get(`/quotes/${quote.body.id}`).set(as('SALES')).expect(200);
    expect(kept.body.lines[1]).toMatchObject({ unitPrice: '12610', costBasis: '9700' });
    await http().get(`/quotes/${quote.body.id}`).set(as('SALES2')).expect(404);

    const key = randomUUID();
    const [a, b] = await Promise.all([1, 2].map(() => http().post(`/quotes/${quote.body.id}/convert`).set(as('SALES')).send({ operationKey: key })));
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.id).toBe(b.body.id);
    order1 = a.body.id;
    const other = await http().post(`/quotes/${quote.body.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }).expect(409);
    expect(other.body.message).toMatch(/ya se convirtió/);
    expect(await prisma.salesOrder.count({ where: { quoteId: quote.body.id } })).toBe(1);
  });

  it('#12 #13 shortage is reported without reservations; a partial dispatch reserves only what is authorised', async () => {
    const quote = await http()
      .post('/quotes')
      .set(as('SALES'))
      .send({ customerId: ids.customer, lines: [quoteLine({ referenceId: ids.r1730, finishId: ids.bm, origin: 'NATIONAL', quantity: 100, pricingMethod: 'MARKUP_ON_COST', pricingPercent: '25' })] })
      .expect(201);
    order2 = (await http().post(`/quotes/${quote.body.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }).expect(200)).body.id;
    const confirm = await http().post(`/sales-orders/${order2}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.locA }).expect(200);
    expect(confirm.body.confirmed).toBe(false);
    expect(confirm.body.shortages[0]).toMatchObject({ required: 100, available: 55, missing: 45 });
    expect(confirm.body.order.status).toBe('PENDING_SUPPLY');
    expect(await prisma.stockReservation.count({ where: { salesOrderLine: { salesOrderId: order2 } } })).toBe(0);
    const lineId = confirm.body.order.lines[0].id;
    // No hidden partial: an explicit authorisation is required.
    await http()
      .post(`/sales-orders/${order2}/dispatches`)
      .set(as('SALES'))
      .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(5), lines: [{ salesOrderLineId: lineId, quantity: 30 }] })
      .expect(409);
    const partial = await http()
      .post(`/sales-orders/${order2}/dispatches`)
      .set(as('SALES'))
      .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(5), partial: true, lines: [{ salesOrderLineId: lineId, quantity: 30 }] })
      .expect(201);
    expect(partial.body).toMatchObject({ partial: true, status: 'OPEN' });
    const reserved = await prisma.stockReservation.aggregate({ where: { salesOrderLine: { salesOrderId: order2 }, status: 'ACTIVE' }, _sum: { quantity: true } });
    expect(reserved._sum.quantity).toBe(30);
    const detail = await http().get(`/sales-orders/${order2}`).set(as('SALES')).expect(200);
    expect(detail.body.lines[0]).toMatchObject({ authorisedQuantity: 30, dispatchedQuantity: 0, pendingQuantity: 100, unauthorisedQuantity: 70 });
  });

  it('#24 manual exit, transfer and adjustment cannot consume reserved profiles', async () => {
    // FIFO reserved the 30 profiles of n1a for the partial dispatch.
    const key = () => randomUUID();
    const exit = await http().post(`/inventory/bundles/${bundles.n1a.id}/exit`).set(as('WAREHOUSE')).send({ operationKey: key(), quantity: 1 }).expect(409);
    expect(exit.body.message).toMatch(/reservados/);
    await http().post(`/inventory/bundles/${bundles.n1a.id}/transfer`).set(as('WAREHOUSE')).send({ operationKey: key(), inventoryLocationId: ids.locB, rackId: ids.rackB }).expect(409);
    await http().post(`/inventory/bundles/${bundles.n1a.id}/adjustments`).set(as('ADMIN')).send({ operationKey: key(), type: 'ADJUSTMENT_OUT', quantity: 1, reason: 'Conteo' }).expect(409);
    await http().post(`/inventory/bundles/${bundles.n1b.id}/exit`).set(as('WAREHOUSE')).send({ operationKey: key(), quantity: 1 }).expect(201);
    expect((await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.n1a.id } })).quantity).toBe(30);
  });

  it('#11 #29 confirming reserves every line; other sellers and roles cannot see or change it', async () => {
    await http().get(`/sales-orders/${order1}`).set(as('SALES2')).expect(404);
    await http().post(`/sales-orders/${order1}/confirm`).set(as('SALES2')).send({ inventoryLocationId: ids.locA }).expect(404);
    await http().get('/sales-orders').set(as('READ_ONLY')).expect(403);
    await http().get('/quotes').set(as('WAREHOUSE')).expect(403);
    const confirmed = await http().post(`/sales-orders/${order1}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.locA }).expect(200);
    expect(confirmed.body).toMatchObject({ confirmed: true, order: { status: 'CONFIRMED' } });
    expect(confirmed.body.order.lines.map((l: { reservedQuantity: number }) => l.reservedQuantity)).toEqual([20, 10]);
    const again = await http().post(`/sales-orders/${order1}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.locA }).expect(200);
    expect(again.body.order.lines.map((l: { reservedQuantity: number }) => l.reservedQuantity)).toEqual([20, 10]);
  });

  // --- 4. Dispatch with the handheld ------------------------------------------------

  let dispatch1 = '';

  it('creates the dispatch, its DISPATCH task and the notice (outbox) for an eligible worker', async () => {
    const order = await http().get(`/sales-orders/${order1}`).set(as('SALES')).expect(200);
    const lines = order.body.lines.map((l: { id: string; quantity: number }) => ({ salesOrderLineId: l.id, quantity: l.quantity }));
    await http().post(`/sales-orders/${order1}/dispatches`).set(as('SALES')).send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE_B, dueAt: inHours(5), lines }).expect(400);
    await http().post(`/sales-orders/${order1}/dispatches`).set(as('SALES2')).send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(5), lines }).expect(404);
    const created = await http().post(`/sales-orders/${order1}/dispatches`).set(as('SALES')).send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(5), lines }).expect(201);
    dispatch1 = created.body.id;
    expect(created.body.task).toBeTruthy();
    const task = await prisma.task.findUniqueOrThrow({ where: { dispatchId: dispatch1 } });
    expect(task).toMatchObject({ kind: 'DISPATCH', assigneeId: U.WAREHOUSE });
    expect(await prisma.notificationOutbox.count({ where: { dispatchId: dispatch1, kind: 'dispatch-assigned', userId: U.WAREHOUSE } })).toBe(1);
    const view = await http().get(`/dispatches/${dispatch1}`).set(as('WAREHOUSE')).expect(200);
    expect(JSON.stringify(view.body)).not.toMatch(/unitPrice|lineTotal|unitCost|costBasis/);
    expect(view.body.lines.map((l: { authorised: number; origin: string }) => [l.origin, l.authorised])).toEqual([['CHINA', 20], ['NATIONAL', 10]]);
    await http().get(`/dispatches/${dispatch1}`).set(as('WAREHOUSE_B')).expect(404);
    await http().get(`/dispatches/${dispatch1}`).set(as('READ_ONLY')).expect(403);
  });

  it('#14 #17 #18 #30 scanning: incompatible bundles open incidents; repeats never add twice; partial exit with explicit quantity', async () => {
    const scan = (code: string) => http().post(`/dispatches/${dispatch1}/scan`).set(as('WAREHOUSE')).send({ epc: code });
    const wrongOrigin = await scan(bundles.cn2.epc).expect(200);
    expect(wrongOrigin.body.result).toBe('INCIDENT');
    expect(wrongOrigin.body.message).toBe(
      `No coincide: este despacho requiere 10 perfiles nacionales de referencia 17.39-E2E${S}, negro perla. El paquete leído es de origen China.`,
    );
    for (let i = 0; i < 3; i += 1) await scan(bundles.cn2.epc).expect(200);
    const incident = await prisma.dispatchIncident.findFirstOrThrow({ where: { dispatchId: dispatch1, epc: bundles.cn2.epc } });
    expect(incident).toMatchObject({ kind: 'WRONG_ORIGIN', occurrences: 4, status: 'OPEN' });
    expect(await prisma.notificationOutbox.count({ where: { dispatchId: dispatch1, kind: 'dispatch-incident', dedupeKey: { startsWith: `dispatch-incident:${incident.id}` } } })).toBe(2); // assignee + supervisor, once
    expect((await scan(`ZZ${S}UNKNOWN`).expect(200)).body.incident.kind).toBe('UNKNOWN_EPC');
    expect((await scan(bundles.unknown.epc).expect(200)).body.incident.kind).toBe('UNKNOWN_ORIGIN');
    expect((await scan(bundles.n1b.epc).expect(200)).body.incident.kind).toBe('WRONG_ORIGIN');

    const prepared = await scan(bundles.china.epc).expect(200);
    expect(prepared.body).toMatchObject({ result: 'PREPARED', quantity: 20 });
    for (let i = 0; i < 3; i += 1) expect((await scan(bundles.china.epc).expect(200)).body.result).toBe('ALREADY_PREPARED');
    expect(await prisma.dispatchPick.count({ where: { dispatchId: dispatch1, bundleId: bundles.china.id } })).toBe(1);
    const observation = await prisma.readerObservation.findFirstOrThrow({ where: { dispatchId: dispatch1, epc: bundles.china.epc } });
    expect(observation.count).toBe(4);
    expect((await scan(bundles.n1c.epc).expect(200)).body).toMatchObject({ result: 'PREPARED', quantity: 10 });
    expect(await prisma.dispatchPick.count({ where: { dispatchId: dispatch1 } })).toBe(2);
    expect(await prisma.inventoryMovement.count({ where: { dispatchId: dispatch1 } })).toBe(0); // preparing is not dispatching
  });

  it('#19 the generic "complete" route cannot close a dispatch task; open incidents block the exit', async () => {
    const task = await prisma.task.findUniqueOrThrow({ where: { dispatchId: dispatch1 } });
    const res = await http().patch(`/tasks/${task.id}/complete`).set(as('WAREHOUSE')).expect(409);
    expect(res.body.message).toMatch(/confirmar la salida/);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).completedAt).toBeNull();
    const blocked = await http().post(`/dispatches/${dispatch1}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(409);
    expect(blocked.body.message).toMatch(/incidencia/);
    const incidents = await prisma.dispatchIncident.findMany({ where: { dispatchId: dispatch1, status: 'OPEN' } });
    for (const item of incidents) {
      await http().post(`/dispatches/${dispatch1}/incidents/${item.id}/resolve`).set(as('ADMIN')).send({ resolution: 'Paquete retirado de la zona de despacho' }).expect(200);
    }
  });

  it('#21 #32 concurrent or repeated confirmation applies the exit once; reservations, task and order follow', async () => {
    const key = randomUUID();
    const results = await Promise.all([1, 2].map(() => http().post(`/dispatches/${dispatch1}/confirm`).set(as('WAREHOUSE')).send({ operationKey: key })));
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await prisma.inventoryMovement.count({ where: { dispatchId: dispatch1, type: 'EXIT' } })).toBe(2);
    await http().post(`/dispatches/${dispatch1}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(409);
    const china = await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.china.id }, include: { lot: true } });
    expect(china.quantity).toBe(4); // 24 − 20; remaining profiles stay in the same lot
    expect(china.lot?.origin).toBe('CHINA');
    expect(await prisma.stockReservation.count({ where: { salesOrderLine: { salesOrderId: order1 }, status: 'ACTIVE' } })).toBe(0);
    expect((await prisma.task.findUniqueOrThrow({ where: { dispatchId: dispatch1 } })).completedAt).not.toBeNull();
    const order = await http().get(`/sales-orders/${order1}`).set(as('SALES')).expect(200);
    expect(order.body.status).toBe('COMPLETED');
    expect(order.body.lines.map((l: { dispatchedQuantity: number }) => l.dispatchedQuantity)).toEqual([20, 10]);
    expect(await prisma.notificationOutbox.count({ where: { dispatchId: dispatch1, kind: 'dispatch-confirmed', userId: U.SALES } })).toBe(1);
    await http().post(`/sales-orders/${order1}/cancel`).set(as('SALES')).send({ reason: 'x' }).expect(409);
  });

  let dispatch3 = '';

  it('#15 #16 #22 supplier restriction; a failure in the middle of the confirmation rolls everything back', async () => {
    const quote = await http()
      .post('/quotes')
      .set(as('SALES'))
      .send({ customerId: ids.customer, lines: [quoteLine({ referenceId: ids.r1730, finishId: ids.bm, origin: 'NATIONAL', supplierId: ids.n2, quantity: 5, pricingMethod: 'MANUAL', unitPrice: '14000', priceReason: 'Cliente exige proveedor' })] })
      .expect(201);
    const order = (await http().post(`/quotes/${quote.body.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }).expect(200)).body;
    await http().post(`/sales-orders/${order.id}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.locA }).expect(200);
    const created = await http()
      .post(`/sales-orders/${order.id}/dispatches`)
      .set(as('SALES'))
      .send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(3), lines: [{ salesOrderLineId: order.lines[0].id, quantity: 5 }] })
      .expect(201);
    dispatch3 = created.body.id;
    const wrong = await http().post(`/dispatches/${dispatch3}/scan`).set(as('WAREHOUSE')).send({ epc: bundles.n1b.epc }).expect(200);
    expect(wrong.body.incident.kind).toBe('WRONG_SUPPLIER');
    await prisma.dispatchIncident.updateMany({ where: { dispatchId: dispatch3 }, data: { status: 'RESOLVED', resolution: 'test', resolvedAt: new Date() } });
    expect((await http().post(`/dispatches/${dispatch3}/scan`).set(as('WAREHOUSE')).send({ epc: bundles.n2a.epc }).expect(200)).body).toMatchObject({ result: 'PREPARED', quantity: 5 });

    // Failure after the stock and reservation updates: the task update throws.
    const original = prisma.$transaction.bind(prisma);
    const spy = vi.spyOn(prisma, '$transaction').mockImplementation(((fn: unknown, options?: unknown) =>
      typeof fn === 'function'
        ? original(
            (tx: Prisma.TransactionClient) =>
              (fn as (t: Prisma.TransactionClient) => Promise<unknown>)(
                new Proxy(tx, {
                  get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver) as unknown;
                    if (property !== 'task') return value;
                    return new Proxy(value as object, {
                      get(d, m, r) {
                        if (m === 'updateMany') return () => Promise.reject(new Error('Fallo simulado al cerrar la tarea'));
                        return Reflect.get(d, m, r) as unknown;
                      },
                    });
                  },
                }),
              ),
            options as never,
          )
        : original(fn as never, options as never)) as never);
    await http().post(`/dispatches/${dispatch3}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(500);
    spy.mockRestore();
    expect((await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.n2a.id } })).quantity).toBe(15);
    expect(await prisma.inventoryMovement.count({ where: { dispatchId: dispatch3 } })).toBe(0);
    expect(await prisma.stockReservation.count({ where: { dispatchLine: { dispatchId: dispatch3 }, status: 'ACTIVE' } })).toBe(1);
    expect((await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch3 } })).status).toBe('OPEN');
    expect((await prisma.task.findUniqueOrThrow({ where: { dispatchId: dispatch3 } })).completedAt).toBeNull();
    expect(await prisma.notificationOutbox.count({ where: { dispatchId: dispatch3, kind: 'dispatch-confirmed' } })).toBe(0);
    await http().post(`/dispatches/${dispatch3}/confirm`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(200);
    expect((await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.n2a.id } })).quantity).toBe(10);
  });

  it('#20 an overdue dispatch task stays pending and visible; nothing is released or confirmed', async () => {
    const dispatch2 = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: order2, status: 'OPEN' } });
    const past = new Date(Date.now() - 3_600_000);
    await prisma.dispatch.update({ where: { id: dispatch2.id }, data: { dueAt: past } });
    await prisma.$executeRaw`UPDATE tasks SET "dueAt" = ${past}, "createdAt" = ${new Date(past.getTime() - 3_600_000)} WHERE "dispatchId" = ${dispatch2.id}`;
    const tasks = await http().get('/tasks?status=pending').set(as('WAREHOUSE')).expect(200);
    const item = tasks.body.items.find((t: { dispatchId: string }) => t.dispatchId === dispatch2.id);
    expect(item).toMatchObject({ status: 'pending', overdue: true, kind: 'DISPATCH' });
    const incomplete = await http().get('/tasks?status=incomplete').set(as('WAREHOUSE')).expect(200);
    expect(incomplete.body.items.some((t: { dispatchId: string }) => t.dispatchId === dispatch2.id)).toBe(false);
    expect(await prisma.stockReservation.count({ where: { dispatchLine: { dispatchId: dispatch2.id }, status: 'ACTIVE' } })).toBeGreaterThan(0);
    const outbox = app.get(OutboxService);
    await outbox.enqueueOverdue();
    await outbox.enqueueOverdue();
    expect(await prisma.notificationOutbox.count({ where: { dispatchId: dispatch2.id, kind: 'dispatch-overdue' } })).toBe(2); // assignee + supervisor, once per day
    expect((await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch2.id } })).status).toBe('OPEN');
  });

  it('#23 cancelling an order releases pending reservations and work, never confirmed exits', async () => {
    const dispatch2 = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: order2, status: 'OPEN' } });
    const scan = await http().post(`/dispatches/${dispatch2.id}/scan`).set(as('WAREHOUSE')).send({ epc: `NOTREG${S}` }).expect(200);
    expect(scan.body.result).toBe('INCIDENT');
    await http().post(`/sales-orders/${order2}/cancel`).set(as('SALES2')).send({ reason: 'x' }).expect(404);
    const cancelled = await http().post(`/sales-orders/${order2}/cancel`).set(as('SALES')).send({ reason: 'Cliente desistió' }).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(await prisma.stockReservation.count({ where: { salesOrderLine: { salesOrderId: order2 }, status: 'ACTIVE' } })).toBe(0);
    expect((await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch2.id } })).status).toBe('CANCELLED');
    expect((await prisma.task.findUniqueOrThrow({ where: { dispatchId: dispatch2.id } })).cancelledAt).not.toBeNull();
    // Open incidents of a cancelled dispatch are closed with the cancellation.
    const incidents = await prisma.dispatchIncident.findMany({ where: { dispatchId: dispatch2.id } });
    expect(incidents.length).toBeGreaterThan(0);
    expect(incidents.every((i) => i.status === 'RESOLVED' && i.resolution === 'Despacho cancelado: Cliente desistió')).toBe(true);
    const pending = await http().get('/tasks?status=pending').set(as('WAREHOUSE')).expect(200);
    expect(pending.body.items.some((t: { dispatchId: string }) => t.dispatchId === dispatch2.id)).toBe(false);
    // Released stock can be moved again; confirmed exits of other orders stay.
    await http().post(`/inventory/bundles/${bundles.n1a.id}/exit`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), quantity: 1 }).expect(201);
    expect(await prisma.inventoryMovement.count({ where: { dispatchId: dispatch1 } })).toBe(2);
  });

  it('#30 historical stock is never assumed Chinese; classification uses an opening lot without new stock', async () => {
    const lot = await http()
      .post('/lots/opening')
      .set(as('ADMIN'))
      .send({ referenceId: ids.r1730, finishId: ids.bm, origin: 'NATIONAL', notes: 'Inventario físico de apertura, proveedor no documentado' })
      .expect(201);
    expect(lot.body).toMatchObject({ kind: 'OPENING', origin: 'NATIONAL', supplierId: null, unitCost: null });
    const movementsBefore = await prisma.inventoryMovement.count({ where: { bundleId: bundles.unknown.id } });
    await http().post(`/lots/${lot.body.id}/bundles`).set(as('ADMIN')).send({ bundleIds: [bundles.unknown.id] }).expect(200);
    expect((await prisma.bundle.findUniqueOrThrow({ where: { id: bundles.unknown.id } })).lotId).toBe(lot.body.id);
    expect(await prisma.inventoryMovement.count({ where: { bundleId: bundles.unknown.id } })).toBe(movementsBefore);
    // A correction needs a reason.
    const other = await http().post('/lots/opening').set(as('ADMIN')).send({ referenceId: ids.r1730, finishId: ids.bm, origin: 'CHINA', notes: 'x' }).expect(201);
    await http().post(`/lots/${other.body.id}/bundles`).set(as('ADMIN')).send({ bundleIds: [bundles.unknown.id] }).expect(400);
    await http().post(`/lots/opening`).set(as('SALES')).send({ referenceId: ids.r1730, finishId: ids.bm, origin: 'NATIONAL', notes: 'x' }).expect(403);
  });

  // --- 5. Fixed readers (simulated device, same contract) --------------------------

  it('#25 #26 reader observations: authentication, session, monitoring only, grouped repeats', async () => {
    delete process.env.READER_CAPTURE_ENABLED;
    await http().post('/reader/observations').send({ sessionId: 'x', events: [] }).expect(503);
    process.env.READER_CAPTURE_ENABLED = 'true';
    const device = await http().post('/readers').set(as('ADMIN')).send({ code: `SIM-${S}`, name: 'Portal simulado', inventoryLocationId: ids.locA, simulator: true }).expect(201);
    const secret: string = device.body.secret;
    const reader = (key = secret) => ({ 'X-Reader-Id': `SIM-${S}`, Authorization: `Reader ${key}` });
    await http().post('/reader/observations').set(reader('wrong')).send({ sessionId: 'x', events: [{ eventId: 'e', epc: 'AA', observedAt: new Date().toISOString() }] }).expect(401);
    await http().post('/reader/observations').set(reader()).send({ sessionId: 'nope', events: [{ eventId: 'e', epc: 'AA', observedAt: new Date().toISOString() }] }).expect(409);

    // Open dispatch for one national 17.39 profile.
    const quote = await http().post('/quotes').set(as('SALES')).send({ customerId: ids.customer, lines: [quoteLine({ referenceId: ids.r1739, finishId: ids.np, origin: 'NATIONAL', quantity: 2, pricingMethod: 'MANUAL', unitPrice: '13000', priceReason: 'Prueba' })] }).expect(201);
    const order = (await http().post(`/quotes/${quote.body.id}/convert`).set(as('SALES')).send({ operationKey: randomUUID() }).expect(200)).body;
    await http().post(`/sales-orders/${order.id}/confirm`).set(as('SALES')).send({ inventoryLocationId: ids.locA }).expect(200);
    const dispatch = (await http().post(`/sales-orders/${order.id}/dispatches`).set(as('SALES')).send({ operationKey: randomUUID(), assigneeId: U.WAREHOUSE, dueAt: inHours(2), lines: [{ salesOrderLineId: order.lines[0].id, quantity: 2 }] }).expect(201)).body;
    await http().post(`/readers/${device.body.device.id}/sessions`).set(as('WAREHOUSE_B')).send({ dispatchId: dispatch.id }).expect(403);
    const session = (await http().post(`/readers/${device.body.device.id}/sessions`).set(as('WAREHOUSE')).send({ dispatchId: dispatch.id }).expect(201)).body;
    // Readers available on the dispatch screen: same location only.
    const options = (await http().get(`/dispatches/${dispatch.id}/readers`).set(as('WAREHOUSE')).expect(200)).body;
    expect(options.captureEnabled).toBe(true);
    expect(options.readers.find((r: { id: string }) => r.id === device.body.device.id).sessions[0].dispatch.id).toBe(dispatch.id);
    await http().get(`/dispatches/${dispatch.id}/readers`).set(as('WAREHOUSE_B')).expect(404);
    await http().get(`/dispatches/${dispatch.id}/readers`).set(as('SALES')).expect(403);

    const now = Date.now();
    const events = [
      ...Array.from({ length: 50 }, (_, i) => ({ eventId: `w-${i}`, epc: bundles.cn2.epc, observedAt: new Date(now - i * 100).toISOString(), antenna: 1, rssi: -50 })),
      ...Array.from({ length: 10 }, (_, i) => ({ eventId: `g-${i}`, epc: bundles.n1d.epc, observedAt: new Date(now - i * 100).toISOString() })),
      { eventId: 'u-1', epc: `UNKNOWN${S}`, observedAt: new Date(now).toISOString() },
      { eventId: 'f-1', epc: bundles.n1d.epc, observedAt: new Date(now + 3_600_000).toISOString() },
    ];
    const first = await http().post('/reader/observations').set(reader()).send({ sessionId: session.id, events }).expect(200);
    expect(first.body).toMatchObject({ mode: 'MONITOR', simulator: true, accepted: 61, duplicates: 0, rejected: 1 });
    const byEpc = Object.fromEntries(first.body.results.map((r: { epc: string; result: string }) => [r.epc, r.result]));
    expect(byEpc).toEqual({ [bundles.cn2.epc]: 'INCIDENT', [bundles.n1d.epc]: 'MATCH', [`UNKNOWN${S}`]: 'INCIDENT' });
    const wrong = await prisma.dispatchIncident.findFirstOrThrow({ where: { dispatchId: dispatch.id, epc: bundles.cn2.epc } });
    expect(wrong).toMatchObject({ kind: 'WRONG_ORIGIN', occurrences: 50, source: 'SIMULATOR' });
    expect(await prisma.notificationOutbox.count({ where: { dispatchId: dispatch.id, kind: 'dispatch-incident' } })).toBe(4); // 2 incidents × (assignee + supervisor)
    // Monitoring never prepares nor moves stock.
    expect(await prisma.dispatchPick.count({ where: { dispatchId: dispatch.id } })).toBe(0);
    expect(await prisma.inventoryMovement.count({ where: { dispatchId: dispatch.id } })).toBe(0);
    // The same events again (adapter retry) are ignored.
    const retry = await http().post('/reader/observations').set(reader()).send({ sessionId: session.id, events }).expect(200);
    expect(retry.body).toMatchObject({ accepted: 0, duplicates: 62 - 1, rejected: 1 });
    expect((await prisma.dispatchIncident.findUniqueOrThrow({ where: { id: wrong.id } })).occurrences).toBe(50);
    // Without sessionId the device's open session is used.
    const implicit = await http().post('/reader/observations').set(reader()).send({ events: [{ eventId: 'i-1', epc: bundles.cn2.epc, observedAt: new Date().toISOString() }] }).expect(200);
    expect(implicit.body).toMatchObject({ sessionId: session.id, dispatch: dispatch.number, accepted: 1 });
    expect((await prisma.dispatchIncident.findUniqueOrThrow({ where: { id: wrong.id } })).occurrences).toBe(51);
    await http().post(`/reader-sessions/${session.id}/close`).set(as('WAREHOUSE')).expect(200);
    await http().post('/reader/observations').set(reader()).send({ sessionId: session.id, events: [{ eventId: 'z', epc: bundles.n1d.epc, observedAt: new Date().toISOString() }] }).expect(409);
    await http().post('/reader/observations').set(reader()).send({ events: [{ eventId: 'z', epc: bundles.n1d.epc, observedAt: new Date().toISOString() }] }).expect(409);
  });

  // --- 6. Notifications outbox -------------------------------------------------------

  it('#27 #28 push failure after commit keeps the business result; pending notices survive a worker restart', async () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    await prisma.pushSubscription.create({
      data: {
        userId: U.WAREHOUSE,
        endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${randomBytes(8).toString('hex')}`,
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: randomBytes(16).toString('base64url'),
      },
    });
    const outbox = app.get(OutboxService);
    // Only this run's rows: earlier ones are marked done to isolate the check.
    await prisma.notificationOutbox.updateMany({ where: { userId: { in: Object.values(U) }, status: 'PENDING' }, data: { status: 'SKIPPED' } });
    const row = await prisma.notificationOutbox.create({ data: { userId: U.WAREHOUSE, kind: 'dispatch-confirmed', dedupeKey: `e2e-${S}-1:${U.WAREHOUSE}` } });

    sender.failWith = 503;
    const now = new Date();
    await outbox.processOnce(now);
    let current = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(current).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(current.nextAttemptAt.getTime()).toBeGreaterThan(now.getTime());
    expect((await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch3 } })).status).toBe('CONFIRMED'); // business unaffected

    // "Restart": a new pass after the retry time delivers it once.
    sender.failWith = null;
    await outbox.processOnce(new Date(now.getTime() + 10 * 60_000));
    current = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(current.status).toBe('SENT');
    const calls = sender.calls;
    await outbox.processOnce(new Date(now.getTime() + 20 * 60_000));
    expect(sender.calls).toBe(calls);

    // Claimed by a worker that died: invisible until its lease expires.
    const claimed = await prisma.notificationOutbox.create({
      data: { userId: U.WAREHOUSE, kind: 'dispatch-confirmed', dedupeKey: `e2e-${S}-2:${U.WAREHOUSE}`, attempts: 1, nextAttemptAt: new Date(now.getTime() + 120_000) },
    });
    await outbox.processOnce(now);
    expect((await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: claimed.id } })).status).toBe('PENDING');
    await outbox.processOnce(new Date(now.getTime() + 121_000));
    expect((await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: claimed.id } })).status).toBe('SENT');

    // A notice that no longer matches the state is skipped, not sent late.
    const cancelledDispatch = await prisma.dispatch.findFirstOrThrow({ where: { salesOrderId: order2 } });
    const stale = await prisma.notificationOutbox.create({
      data: { userId: U.WAREHOUSE, kind: 'dispatch-assigned', dedupeKey: `e2e-${S}-3:${U.WAREHOUSE}`, dispatchId: cancelledDispatch.id },
    });
    await outbox.processOnce(new Date(now.getTime() + 30 * 60_000));
    expect((await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('SKIPPED');
  });
});
