import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { ledgerProblems } from './support/concurrency.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Accessories, delivery 1 (docs/accesorios-fase-1.md): baskets with one chip
// (one per accessory and colour), entries with their support, exits without
// a sale, the administrator's notice and the walls against the profile flows.
interface Basket {
  id: string;
  epc: string;
  quantity: number;
  origin: string | null;
  reserved: number;
  replayed?: boolean;
}
interface Voucher {
  id: string;
  number: string;
  kind: string;
  totals: { baskets: number; units: number };
  movements: { type: string; quantity: number; quantityBefore: number; quantityAfter: number; bundle: { id: string } }[];
  replayed?: boolean;
}

describe('Accessories inventory (e2e)', () => {
  const S = uniqueSuffix();
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const U: Record<string, string> = {};
  const ids = { branch: '', acc: '', acc2: '', wh: '', aisle: '', rack: '', accFamily: '', profFamily: '', refA: '', refB: '', refProfile: '', finA: '', finB: '' };
  const baskets = { a: '', b: '', other: '' };
  const vouchers = { entry: '', exit: '' };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.75.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };
  const chip = (tag: string) => `ACC${tag}${S}`.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const register = (body: Record<string, unknown>, who = 'ACCESSORIES') =>
    http().post('/accessories/baskets').set(as(who)).send({ operationKey: randomUUID(), origin: 'NATIONAL', ...body });
  const entry = (body: Record<string, unknown>, who = 'ACCESSORIES') =>
    http().post('/accessories/vouchers/entries').set(as(who)).send({ operationKey: randomUUID(), supplierName: 'Herrajes de prueba', documentNumber: `FV-${S}`, ...body });
  const exit = (body: Record<string, unknown>, who = 'ACCESSORIES') =>
    http().post('/accessories/vouchers/exits').set(as(who)).send({ operationKey: randomUUID(), exitType: 'INTERNAL_USE', detail: 'Taller de ensamble', ...body });
  const quantity = async (id: string) => (await prisma.bundle.findUniqueOrThrow({ where: { id } })).quantity;
  const notice = (voucherId: string) => prisma.task.findUnique({ where: { accessoryVoucherId: voucherId }, include: { assignee: true } });

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'ACCESSORIES', 'WAREHOUSE'] as const) {
      const user = await createTestUser(app, role, `AI${S}`);
      H[role] = user.headers;
      U[role] = user.id;
    }
    const lost = await createTestUser(app, 'ACCESSORIES', `AI2${S}`);
    H.NO_PLACE = lost.headers;

    const branch = await prisma.branch.create({ data: { code: `AI-${S}`, name: `139 ${S}` } });
    const acc = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `ACC-${S}`, name: 'Bodega de accesorios', type: 'ACCESSORY_WAREHOUSE' } });
    const acc2 = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `ACC2-${S}`, name: 'Otra bodega de accesorios', type: 'ACCESSORY_WAREHOUSE' } });
    const wh = await prisma.inventoryLocation.create({ data: { branchId: branch.id, code: `WH-${S}`, name: 'Bodega de perfiles', type: 'WAREHOUSE' } });
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: wh.id, number: 1 } });
    const rack = await prisma.rack.create({ data: { aisleId: aisle.id, number: 1 } });
    const accFamily = await prisma.productFamily.create({ data: { code: `AIF-${S}`, name: `Accesorios ${S}`, kind: 'ACCESSORY' } });
    const profFamily = await prisma.productFamily.create({ data: { code: `AIP-${S}`, name: `Perfiles ${S}` } });
    const refA = await prisma.reference.create({ data: { code: `AI-A-${S}`, description: `RODACHIN ${S}`, supplierCode: `S1${S}`, familyId: accFamily.id } });
    const refB = await prisma.reference.create({ data: { code: `AI-B-${S}`, description: `FELPA ROLLO ${S}`, familyId: accFamily.id } });
    const refProfile = await prisma.reference.create({ data: { code: `AI-P-${S}`, description: `JAMBA ${S}`, familyId: profFamily.id } });
    const finA = await prisma.finish.create({ data: { code: `AIA-${S}` } });
    const finB = await prisma.finish.create({ data: { code: `AIB-${S}` } });
    Object.assign(ids, {
      branch: branch.id, acc: acc.id, acc2: acc2.id, wh: wh.id, aisle: aisle.id, rack: rack.id,
      accFamily: accFamily.id, profFamily: profFamily.id, refA: refA.id, refB: refB.id, refProfile: refProfile.id, finA: finA.id, finB: finB.id,
    });
    await prisma.user.update({ where: { id: U.ACCESSORIES }, data: { defaultInventoryLocationId: acc.id } });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('registers baskets: one chip and one basket per accessory and colour; retries change nothing', async () => {
    const key = randomUUID();
    const body = { operationKey: key, epc: chip('A').toLowerCase(), referenceId: ids.refA, finishId: ids.finA, origin: 'NATIONAL', quantity: 12 };
    const first = (await http().post('/accessories/baskets').set(as('ACCESSORIES')).send(body).expect(201)).body as Basket;
    expect(first).toMatchObject({ epc: chip('A'), quantity: 12, origin: 'NATIONAL', reserved: 0 });
    baskets.a = first.id;
    const again = (await http().post('/accessories/baskets').set(as('ACCESSORIES')).send(body).expect(201)).body as Basket;
    expect(again).toMatchObject({ id: first.id, replayed: true, quantity: 12 });
    await http().post('/accessories/baskets').set(as('ACCESSORIES')).send({ ...body, quantity: 13 }).expect(409);
    expect(await prisma.bundle.count({ where: { epc: chip('A') } })).toBe(1);

    const lot = await prisma.bundle.findUniqueOrThrow({ where: { id: first.id }, include: { lot: true, movements: true } });
    expect(lot).toMatchObject({ basket: true, rackId: null, openedAt: null, inventoryLocationId: ids.acc });
    expect(lot.lot).toMatchObject({ kind: 'ACCESSORY_BASKET', origin: 'NATIONAL', supplierId: null, unitCost: null });
    expect(lot.movements).toEqual([expect.objectContaining({ type: 'INITIAL_STOCK', quantity: 12, quantityBefore: 0, quantityAfter: 12, performedById: U.ACCESSORIES })]);

    const twin = await register({ epc: chip('TWIN'), referenceId: ids.refA, finishId: ids.finA, quantity: 1 }).expect(409);
    expect(twin.body.message).toMatch(/Ya hay una canasta/);
    const empty = (await register({ epc: chip('B'), referenceId: ids.refB, finishId: ids.finB, quantity: 0, origin: 'CHINA' }).expect(201)).body as Basket;
    expect(empty).toMatchObject({ quantity: 0, origin: 'CHINA' });
    baskets.b = empty.id;

    expect((await register({ epc: chip('P'), referenceId: ids.refProfile, finishId: ids.finA, quantity: 1 }).expect(400)).body.message).toMatch(/accesorio/);
    expect((await register({ epc: chip('A'), referenceId: ids.refB, finishId: ids.finA, quantity: 1 }).expect(409)).body.message).toMatch(/Ese chip ya es de la canasta/);
    expect((await register({ epc: chip('X'), referenceId: ids.refB, finishId: ids.finA, quantity: 1 }, 'NO_PLACE').expect(400)).body.message).toMatch(/bodega de accesorios/);
    expect(
      (await register({ epc: chip('W'), referenceId: ids.refB, finishId: ids.finA, quantity: 1, inventoryLocationId: ids.wh }, 'ADMIN').expect(400)).body.message,
    ).toMatch(/no es una bodega de accesorios/);
    await register({ epc: chip('R'), referenceId: ids.refB, finishId: ids.finA, quantity: 1 }, 'WAREHOUSE').expect(403);
  });

  it('an entry adds units to every basket with its support and tells the administrator', async () => {
    const key = randomUUID();
    const body = { operationKey: key, supplierName: ' Herrajes del Norte ', documentNumber: `FV-${S}`, arrivalDate: '2026-11-20', lines: [{ basketId: baskets.a, quantity: 10 }, { basketId: baskets.b, quantity: 5 }] };
    const saved = (await http().post('/accessories/vouchers/entries').set(as('ACCESSORIES')).send(body).expect(201)).body as Voucher;
    expect(saved.number).toMatch(/^IA-\d{6}$/);
    expect(saved).toMatchObject({ kind: 'ENTRY', supplierName: 'Herrajes del Norte', arrivalDate: '2026-11-20', totals: { baskets: 2, units: 15 } });
    expect(saved.movements.map((m) => [m.type, m.quantityBefore, m.quantityAfter])).toEqual([['ENTRY', 12, 22], ['ENTRY', 0, 5]]);
    vouchers.entry = saved.id;
    expect(await quantity(baskets.a)).toBe(22);
    expect(await quantity(baskets.b)).toBe(5);

    const again = (await http().post('/accessories/vouchers/entries').set(as('ACCESSORIES')).send(body).expect(201)).body as Voucher;
    expect(again).toMatchObject({ id: saved.id, number: saved.number, replayed: true });
    expect(await quantity(baskets.a)).toBe(22);
    await http().post('/accessories/vouchers/entries').set(as('ACCESSORIES')).send({ ...body, lines: [{ basketId: baskets.a, quantity: 11 }] }).expect(409);

    const task = await notice(saved.id);
    expect(task).toMatchObject({ kind: 'ACCESSORY_NOTICE', createdById: U.ACCESSORIES, completedAt: null });
    expect(task!.assignee.role).toBe('ADMIN');
    expect(task!.title).toContain(saved.number);
    expect(task!.description).toMatch(/Herrajes del Norte/);
    expect(await prisma.notificationOutbox.count({ where: { kind: 'accessory-entry', dedupeKey: { startsWith: `accessory-voucher:${saved.id}` } } })).toBe(1);

    await entry({ lines: [{ basketId: baskets.a, quantity: 1 }, { basketId: baskets.a, quantity: 2 }] }).expect(400);
    await entry({ documentNumber: '  ', lines: [{ basketId: baskets.a, quantity: 1 }] }).expect(400);
    await entry({ lines: [{ basketId: baskets.a, quantity: 0 }] }).expect(400);
    expect(await quantity(baskets.a)).toBe(22);
  });

  it('an exit without a sale never takes more than there is and keeps the history', async () => {
    const tooMuch = await exit({ lines: [{ basketId: baskets.a, quantity: 2 }, { basketId: baskets.b, quantity: 6 }] }).expect(409);
    expect(tooMuch.body.message).toMatch(/No se guardó nada/);
    expect(await quantity(baskets.a)).toBe(22);
    await exit({ detail: ' ', lines: [{ basketId: baskets.a, quantity: 1 }] }).expect(400);
    await exit({ exitType: 'GIFT', lines: [{ basketId: baskets.a, quantity: 1 }] }).expect(400);

    const saved = (
      await exit({ exitType: 'UNREGISTERED_SALE', detail: 'Venta de mostrador sin factura', receivedBy: 'Cliente de paso', lines: [{ basketId: baskets.a, quantity: 2 }, { basketId: baskets.b, quantity: 5 }] }).expect(201)
    ).body as Voucher & { exitTypeLabel: string };
    expect(saved.number).toMatch(/^SS-\d{6}$/);
    expect(saved).toMatchObject({ kind: 'EXIT', exitTypeLabel: 'Venta no registrada', totals: { baskets: 2, units: 7 } });
    vouchers.exit = saved.id;
    expect(await quantity(baskets.a)).toBe(20);
    expect(await quantity(baskets.b)).toBe(0);
    expect((await notice(saved.id))?.title).toMatch(/Venta no registrada/);
    expect(await prisma.notificationOutbox.count({ where: { kind: 'accessory-exit', dedupeKey: { startsWith: `accessory-voucher:${saved.id}` } } })).toBe(1);

    const kardex = (await http().get(`/accessories/baskets/${baskets.a}`).set(as('ACCESSORIES')).expect(200)).body as {
      quantity: number;
      movements: { type: string; accessoryVoucher: { number: string } | null }[];
    };
    expect(kardex.quantity).toBe(20);
    expect(kardex.movements.map((m) => [m.type, m.accessoryVoucher?.number ?? null])).toEqual([
      ['EXIT', saved.number],
      ['ENTRY', expect.stringMatching(/^IA-/)],
      ['INITIAL_STOCK', null],
    ]);
    expect((await http().get(`/accessories/baskets/epc/${chip('A').toLowerCase()}`).set(as('ACCESSORIES')).expect(200)).body.id).toBe(baskets.a);
    await http().get(`/accessories/baskets/epc/${chip('NOPE')}`).set(as('ACCESSORIES')).expect(404);
    const list = (await http().get('/accessories/vouchers?kind=EXIT').set(as('ACCESSORIES')).expect(200)).body as { items: { id: string }[] };
    expect(list.items.some((v) => v.id === saved.id)).toBe(true);
    expect(await ledgerProblems(prisma, [baskets.a, baskets.b])).toEqual([]);
  });

  it('the administrator marks the notice as seen; nobody else can', async () => {
    const task = (await notice(vouchers.entry))!;
    await http().patch(`/tasks/${task.id}/complete`).set(as('ACCESSORIES')).expect(403);
    const token = await app.get(JwtService).signAsync({ sub: task.assigneeId });
    const assignee = { Authorization: `Bearer ${token}`, 'X-Forwarded-For': '10.75.250.1' };
    const done = (await http().patch(`/tasks/${task.id}/complete`).set(assignee).expect(200)).body as { status: string };
    expect(done.status).toBe('completed');
    await http().patch(`/tasks/${task.id}/complete`).set(assignee).expect(200);
  });

  it('profile flows never move a basket nor place profiles in the accessories warehouse', async () => {
    const wall = /canasta de accesorios/;
    expect((await http().post(`/inventory/bundles/${baskets.a}/exit`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), quantity: 1 }).expect(400)).body.message).toMatch(wall);
    expect(
      (await http().post(`/inventory/bundles/${baskets.a}/transfer`).set(as('WAREHOUSE')).send({ operationKey: randomUUID(), inventoryLocationId: ids.wh, rackId: ids.rack }).expect(400)).body.message,
    ).toMatch(wall);
    expect((await http().post(`/inventory/bundles/${baskets.a}/open`).set(as('WAREHOUSE')).send({ operationKey: randomUUID() }).expect(400)).body.message).toMatch(wall);
    const batch = await http().post('/inventory/bundles/transfer').set(as('WAREHOUSE')).send({ operationKey: randomUUID(), bundleIds: [baskets.a], inventoryLocationId: ids.wh, rackId: ids.rack });
    expect(batch.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(batch.body)).toMatch(wall);
    expect(await quantity(baskets.a)).toBe(20);

    // The administrator still corrects a basket after a count.
    const adjusted = await http().post(`/inventory/bundles/${baskets.a}/adjustments`).set(as('ADMIN')).send({ operationKey: randomUUID(), type: 'ADJUSTMENT_OUT', quantity: 1, reason: 'Conteo de canastas' });
    expect(adjusted.status).toBeLessThan(300);
    expect(await quantity(baskets.a)).toBe(19);

    const profile = await http().post('/inventory/bundles').set(as('ADMIN')).send({
      epc: chip('PROF'), referenceId: ids.refProfile, finishId: ids.finA, quantity: 5, inventoryLocationId: ids.acc, rackId: ids.rack,
      registrationType: 'INITIAL_STOCK', arrivalDatePrecision: 'UNKNOWN',
    });
    expect(profile.status).toBe(400);
    expect(profile.body.message).toMatch(/bodega de accesorios/);
    await http().post('/locations/aisles').set(as('ADMIN')).send({ inventoryLocationId: ids.acc, number: 1 }).expect(400);

    const listed = (await http().get(`/inventory/bundles?referenceId=${ids.refA}`).set(as('ADMIN')).expect(200)).body as { items: unknown[] };
    expect(listed.items).toEqual([]);
    expect(await ledgerProblems(prisma, [baskets.a])).toEqual([]);
  });

  it('the accessories user only sees and moves the baskets of its own warehouse', async () => {
    const other = (await register({ epc: chip('O'), referenceId: ids.refA, finishId: ids.finA, quantity: 4, inventoryLocationId: ids.acc2 }, 'ADMIN').expect(201)).body as Basket;
    baskets.other = other.id;
    const mine = (await http().get('/accessories/baskets').set(as('ACCESSORIES')).expect(200)).body as { items: { id: string }[] };
    expect(mine.items.map((b) => b.id).sort()).toEqual([baskets.a, baskets.b].sort());
    await http().get(`/accessories/baskets/${other.id}`).set(as('ACCESSORIES')).expect(404);
    await entry({ lines: [{ basketId: other.id, quantity: 1 }] }).expect(403);
    await entry({ lines: [{ basketId: baskets.a, quantity: 1 }, { basketId: other.id, quantity: 1 }] }, 'ADMIN').expect(400);

    // A voucher of the administrator needs no notice.
    const own = (await entry({ lines: [{ basketId: other.id, quantity: 3 }] }, 'ADMIN').expect(201)).body as Voucher;
    expect(await notice(own.id)).toBeNull();
    expect(await quantity(other.id)).toBe(7);
    await http().get('/accessories/catalog').set(as('WAREHOUSE')).expect(403);
    const catalog = (await http().get('/accessories/catalog').set(as('ACCESSORIES')).expect(200)).body as { references: { id: string }[]; locations: { id: string }[] };
    expect(catalog.references.some((r) => r.id === ids.refA)).toBe(true);
    expect(catalog.references.some((r) => r.id === ids.refProfile)).toBe(false);
    expect(catalog.locations.map((l) => l.id)).toEqual([ids.acc]);
  });
});
