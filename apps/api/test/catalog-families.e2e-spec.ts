import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Integration test against the local database. Every record uses a unique
// E2E-<suffix> code and is deleted by exact ID in afterAll.
describe('Catalog families (e2e)', () => {
  const suffix = uniqueSuffix();
  const created = {
    users: [] as string[],
    families: [] as string[],
    references: [] as string[],
  };

  let app: INestApplication<App>;
  let prisma: PrismaService;
  let admin: Record<string, string>;
  let readOnly: Record<string, string>;
  let familyA: { id: string; code: string };
  let familyB: { id: string };
  let refA: { id: string };
  let refB: { id: string };

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = app.get(PrismaService);

    const adminUser = await createTestUser(app, 'ADMIN', suffix);
    const readOnlyUser = await createTestUser(app, 'READ_ONLY', suffix);
    created.users.push(adminUser.id, readOnlyUser.id);
    admin = adminUser.headers;
    readOnly = readOnlyUser.headers;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.reference.deleteMany({
        where: { id: { in: created.references } },
      });
      await prisma.productFamily.deleteMany({
        where: { id: { in: created.families } },
      });
      await prisma.user.deleteMany({ where: { id: { in: created.users } } });
      console.info('E2E records removed:', JSON.stringify(created));
    }
    await app?.close();
  });

  it('ADMIN creates families with normalized code and lists them', async () => {
    const resA = await http()
      .post('/catalog/families')
      .set(admin)
      .send({ code: ` e2e-a-${suffix} `, name: '  Ventana prueba  ' })
      .expect(201);
    familyA = resA.body;
    created.families.push(familyA.id);
    expect(familyA.code).toBe(`E2E-A-${suffix}`);
    expect(resA.body.name).toBe('Ventana prueba');
    expect(resA.body.active).toBe(true);

    const resB = await http()
      .post('/catalog/families')
      .set(admin)
      .send({ code: `E2E-B-${suffix}`, name: 'Puerta prueba' })
      .expect(201);
    familyB = resB.body;
    created.families.push(familyB.id);

    const list = await http().get('/catalog/families').set(admin).expect(200);
    const ids = (list.body as { id: string }[]).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([familyA.id, familyB.id]));
  });

  it('rejects duplicate code (409) and invalid bodies (400)', async () => {
    await http()
      .post('/catalog/families')
      .set(admin)
      .send({ code: familyA.code.toLowerCase(), name: 'Otra' })
      .expect(409);
    await http()
      .post('/catalog/families')
      .set(admin)
      .send({ code: `E2E-C-${suffix}`, name: '   ' })
      .expect(400);
    await http()
      .post('/catalog/families')
      .set(admin)
      .send({ code: '', name: 'Sin código' })
      .expect(400);
    await http()
      .post('/catalog/families')
      .set(admin)
      .send({ code: `E2E-D-${suffix}`, name: 'x'.repeat(101) })
      .expect(400);
    await http()
      .patch(`/catalog/families/${familyA.id}`)
      .set(admin)
      .send({})
      .expect(400);
    await http()
      .patch(`/catalog/families/${familyA.id}`)
      .set(admin)
      .send({ code: 'NUEVO' })
      .expect(400);
    await http()
      .get('/catalog/families?active=maybe')
      .set(admin)
      .expect(400);
  });

  it('creates references associated to a family and filters by familyId', async () => {
    const a = await http()
      .post('/catalog/references')
      .set(admin)
      .send({ code: `E2E-RA-${suffix}`, familyId: familyA.id })
      .expect(201);
    refA = a.body;
    created.references.push(refA.id);
    expect(a.body.familyId).toBe(familyA.id);

    const b = await http()
      .post('/catalog/references')
      .set(admin)
      .send({ code: `E2E-RB-${suffix}`, description: 'Jamba', familyId: familyB.id })
      .expect(201);
    refB = b.body;
    created.references.push(refB.id);

    const filtered = await http()
      .get(`/catalog/references?familyId=${familyA.id}`)
      .set(readOnly)
      .expect(200);
    const ids = (filtered.body as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual([refA.id]);

    await http()
      .post('/catalog/references')
      .set(admin)
      .send({ code: `E2E-RA-${suffix}` })
      .expect(409);
    await http()
      .post('/catalog/references')
      .set(admin)
      .send({ code: `E2E-RX-${suffix}`, familyId: `missing-${suffix}` })
      .expect(404);
    await http()
      .get(`/catalog/references?familyId=missing-${suffix}`)
      .set(admin)
      .expect(404);
    await http()
      .get('/catalog/references?familyId=')
      .set(admin)
      .expect(400);
  });

  it('PATCH reference: omitted keeps, null removes, ID changes family', async () => {
    const kept = await http()
      .patch(`/catalog/references/${refA.id}`)
      .set(admin)
      .send({ description: 'Sillar prueba' })
      .expect(200);
    expect(kept.body.familyId).toBe(familyA.id);
    expect(kept.body.description).toBe('Sillar prueba');

    const removed = await http()
      .patch(`/catalog/references/${refA.id}`)
      .set(admin)
      .send({ familyId: null })
      .expect(200);
    expect(removed.body.familyId).toBeNull();

    const changed = await http()
      .patch(`/catalog/references/${refA.id}`)
      .set(admin)
      .send({ familyId: familyB.id })
      .expect(200);
    expect(changed.body.familyId).toBe(familyB.id);

    await http()
      .patch(`/catalog/references/${refA.id}`)
      .set(admin)
      .send({ familyId: `missing-${suffix}` })
      .expect(404);
    await http()
      .patch(`/catalog/references/missing-${suffix}`)
      .set(admin)
      .send({ familyId: familyA.id })
      .expect(404);
    await http()
      .patch(`/catalog/references/${refA.id}`)
      .set(admin)
      .send({})
      .expect(400);
  });

  it('inactive family keeps references but rejects new associations (400)', async () => {
    const deactivated = await http()
      .patch(`/catalog/families/${familyA.id}`)
      .set(admin)
      .send({ active: false, name: 'Ventana prueba inactiva' })
      .expect(200);
    expect(deactivated.body.active).toBe(false);

    await http()
      .post('/catalog/references')
      .set(admin)
      .send({ code: `E2E-RY-${suffix}`, familyId: familyA.id })
      .expect(400);
    await http()
      .patch(`/catalog/references/${refB.id}`)
      .set(admin)
      .send({ familyId: familyA.id })
      .expect(400);

    // refB stays in family B; deactivating B must not detach or deactivate it.
    await http()
      .patch(`/catalog/families/${familyB.id}`)
      .set(admin)
      .send({ active: false })
      .expect(200);
    const refBNow = await http()
      .get(`/catalog/references/${refB.id}`)
      .set(admin)
      .expect(200);
    expect(refBNow.body.familyId).toBe(familyB.id);
    expect(refBNow.body.active).toBe(true);

    // Re-sending the current (inactive) family is not a new association.
    await http()
      .patch(`/catalog/references/${refB.id}`)
      .set(admin)
      .send({ familyId: familyB.id })
      .expect(200);

    const inactive = await http()
      .get('/catalog/families?active=false')
      .set(admin)
      .expect(200);
    const inactiveIds = (inactive.body as { id: string }[]).map((f) => f.id);
    expect(inactiveIds).toEqual(expect.arrayContaining([familyA.id, familyB.id]));
    const active = await http()
      .get('/catalog/families?active=true')
      .set(admin)
      .expect(200);
    expect((active.body as { active: boolean }[]).every((f) => f.active)).toBe(true);

    await http()
      .patch(`/catalog/families/missing-${suffix}`)
      .set(admin)
      .send({ active: true })
      .expect(404);
  });

  it('READ_ONLY can read but not modify; no token gets 401', async () => {
    await http().get('/catalog/families').set(readOnly).expect(200);
    await http()
      .post('/catalog/families')
      .set(readOnly)
      .send({ code: `E2E-RO-${suffix}`, name: 'No permitido' })
      .expect(403);
    await http()
      .patch(`/catalog/families/${familyA.id}`)
      .set(readOnly)
      .send({ name: 'No permitido' })
      .expect(403);
    await http()
      .patch(`/catalog/references/${refA.id}`)
      .set(readOnly)
      .send({ familyId: null })
      .expect(403);

    await http().get('/catalog/families').expect(401);
    await http()
      .post('/catalog/families')
      .send({ code: `E2E-NT-${suffix}`, name: 'Sin token' })
      .expect(401);
    await http().get(`/catalog/references?familyId=${familyA.id}`).expect(401);
  });

  it('regression: references without filter and finishes still work', async () => {
    // Counted before and after: suites running in parallel create and delete
    // their own references meanwhile. The list is complete (not paginated).
    const before = await prisma.reference.count();
    const all = await http().get('/catalog/references').set(readOnly).expect(200);
    const after = await prisma.reference.count();
    expect(Array.isArray(all.body)).toBe(true);
    const ids = (all.body as { id: string }[]).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([refA.id, refB.id]));
    expect(all.body.length).toBeGreaterThanOrEqual(Math.min(before, after));
    expect(all.body.length).toBeLessThanOrEqual(Math.max(before, after));

    const finishes = await http().get('/catalog/finishes').set(readOnly).expect(200);
    expect(Array.isArray(finishes.body)).toBe(true);
    await http()
      .post('/catalog/finishes')
      .set(readOnly)
      .send({ code: `E2E-F-${suffix}`, description: 'No permitido' })
      .expect(403);
    await http()
      .patch(`/catalog/finishes/missing-${suffix}`)
      .set(admin)
      .send({})
      .expect(400);
  });
});
