import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { importCatalog, parseCatalogCsv } from '../src/modules/catalog/catalog-import.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Catalog import (families and references) and the reference search used by
// the phone picker. Rows are synthetic with this run's suffix; the real
// catalog file is only parsed and simulated (never written here).
describe('Catalog import and reference search (e2e)', () => {
  const S = uniqueSuffix();
  // In the reason of every import audit of this run, to remove them all.
  const source = `prueba-catalogo-${S}.csv`;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let headers: Record<string, string>;
  const users: string[] = [];
  let ip = 0;

  const csv = (lines: string[]) => ['familyCode,familyName,referenceCode,description,familyHint,familyToValidate', ...lines].join('\n');
  const rows = (lines: string[]) => {
    const parsed = parseCatalogCsv(csv(lines));
    expect(parsed.errors).toEqual([]);
    return parsed.rows;
  };
  const catalog = rows([
    `IMP-${S}-K,"KALIMA - KIMBAYA ${S}",R${S}1,"SILLAR ""F"" KALIMA",,`,
    `IMP-${S}-K,"KALIMA - KIMBAYA ${S}",R${S}2 CURVO,Jamba curva,VARIOS VITRAL,SI`,
    `IMP-${S}-V,"VARIOS ${S}",R${S}3,Ángulo de anclaje,,`,
  ]);
  const search = async (term: string, familyId?: string) => {
    ip += 1;
    const res = await request(app.getHttpServer())
      .get(`/catalog/references?search=${encodeURIComponent(term)}${familyId ? `&familyId=${familyId}` : ''}`)
      .set({ ...headers, 'X-Forwarded-For': `10.71.0.${(ip % 250) + 1}` })
      .expect(200);
    return (res.body as { code: string }[]).map((r) => r.code);
  };

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    const user = await createTestUser(app, 'WAREHOUSE', `CI${S}`);
    headers = user.headers;
    users.push(user.id);
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      await prisma.reference.deleteMany({ where: { code: { startsWith: `R${S}` } } });
      await prisma.productFamily.deleteMany({ where: { code: { startsWith: `IMP-${S}-` } } });
      await prisma.auditEvent.deleteMany({ where: { entity: 'Catalog', action: 'CATALOG_IMPORTED', reason: { contains: source } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    await app?.close();
  });

  it('the real catalog file is valid: 23 families, 218 references, 9 to validate', async () => {
    const parsed = parseCatalogCsv(readFileSync(new URL('../prisma/data/catalog-references.csv', import.meta.url), 'utf8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(218);
    expect(new Set(parsed.rows.map((r) => r.familyCode)).size).toBe(23);
    expect(parsed.rows.find((r) => r.familyCode === 'KALIMA-KIMBAYA')?.familyName).toBe('KALIMA - KIMBAYA');
    expect(parsed.rows.find((r) => r.referenceCode === '703 CURVO')).toBeDefined();
    expect(parsed.rows.filter((r) => r.familyHint)).toHaveLength(9);
    // Simulation only: validates against this database without writing.
    const report = await importCatalog(prisma, parsed.rows, { apply: false });
    expect(report.errors).toEqual([]);
    expect(report.toValidate).toHaveLength(9);
    expect(report.applied).toBe(false);
  });

  it('a dry run writes nothing; applying creates; a second run changes nothing', async () => {
    const dry = await importCatalog(prisma, catalog, { apply: false });
    expect(dry.families.create).toEqual([`IMP-${S}-K`, `IMP-${S}-V`]);
    expect(dry.references.create).toEqual([`R${S}1`, `R${S}2 CURVO`, `R${S}3`]);
    expect(await prisma.reference.count({ where: { code: { startsWith: `R${S}` } } })).toBe(0);

    const applied = await importCatalog(prisma, catalog, { apply: true, source });
    expect(applied.applied).toBe(true);
    const curved = await prisma.reference.findUniqueOrThrow({ where: { code: `R${S}2 CURVO` }, include: { family: true } });
    expect(curved).toMatchObject({ description: 'Jamba curva', familyHint: 'VARIOS VITRAL', family: { code: `IMP-${S}-K`, name: `KALIMA - KIMBAYA ${S}` } });
    expect((await prisma.reference.findUniqueOrThrow({ where: { code: `R${S}1` } })).description).toBe('SILLAR "F" KALIMA');
    expect(await prisma.auditEvent.count({ where: { entity: 'Catalog', action: 'CATALOG_IMPORTED', reason: { contains: source } } })).toBe(1);

    const again = await importCatalog(prisma, catalog, { apply: true, source });
    expect(again.families.create).toEqual([]);
    expect(again.references.create).toEqual([]);
    expect(again.references.fill).toEqual([]);
    expect(again.references.conflicts).toEqual([]);
    expect(again.references.unchanged).toBe(3);
  });

  it('existing data is kept: conflicts are reported and only replaced with overwrite; nothing is deleted', async () => {
    const other = await prisma.productFamily.findUniqueOrThrow({ where: { code: `IMP-${S}-V` } });
    await prisma.reference.update({ where: { code: `R${S}1` }, data: { familyId: other.id, description: 'Descripción local' } });
    const changed = rows([
      `IMP-${S}-K,"KALIMA - KIMBAYA ${S}",R${S}1,"SILLAR ""F"" KALIMA",,`,
      `IMP-${S}-K,"KALIMA - KIMBAYA ${S}",R${S}2 CURVO,Jamba curva,,SI`,
    ]);
    const kept = await importCatalog(prisma, changed, { apply: true, source });
    expect(kept.references.conflicts.map((c) => `${c.code}:${c.field}`).sort()).toEqual([`R${S}1:description`, `R${S}1:family`]);
    expect(await prisma.reference.findUniqueOrThrow({ where: { code: `R${S}1` } })).toMatchObject({ familyId: other.id, description: 'Descripción local' });
    // The hint follows the catalog (removed here); R…3 is not in the file and stays.
    expect((await prisma.reference.findUniqueOrThrow({ where: { code: `R${S}2 CURVO` } })).familyHint).toBeNull();
    expect(await prisma.reference.count({ where: { code: { startsWith: `R${S}` } } })).toBe(3);

    await importCatalog(prisma, changed, { apply: true, overwrite: true, source });
    expect(await prisma.reference.findUniqueOrThrow({ where: { code: `R${S}1` }, include: { family: true } })).toMatchObject({
      description: 'SILLAR "F" KALIMA',
      family: { code: `IMP-${S}-K` },
    });
  });

  it('an invalid file writes nothing', async () => {
    const bad = rows([
      `IMP-${S}-Z,"OTRA ${S}",R${S}9,Nueva,,`,
      `imp ${S} mal,"MAL ${S}",R${S}8,Mala,,`,
      `IMP-${S}-Z,"OTRA ${S}",R${S}9,Repetida,,`,
    ]);
    const report = await importCatalog(prisma, bad, { apply: true, source });
    expect(report.applied).toBe(false);
    expect(report.errors.map((e) => e.line)).toEqual([3, 4]);
    expect(await prisma.productFamily.count({ where: { code: `IMP-${S}-Z` } })).toBe(0);
    expect(parseCatalogCsv('codigo,nombre\nA,B').errors[0].message).toMatch(/Encabezado/);
  });

  it('search by code or description, ignoring case and accents; exact code first; within a family', async () => {
    expect(await search(`r${S}2 curvo`)).toEqual([`R${S}2 CURVO`]);
    // Codes that start with the text, shorter first.
    expect((await search(`R${S}`)).slice(0, 3)).toEqual([`R${S}1`, `R${S}3`, `R${S}2 CURVO`]);
    expect(await search(`angulo de anclaje`)).toContain(`R${S}3`);
    expect(await search(`sillar "f" kalima`)).toContain(`R${S}1`);
    const family = await prisma.productFamily.findUniqueOrThrow({ where: { code: `IMP-${S}-V` } });
    expect(await search(`R${S}`, family.id)).toEqual([`R${S}3`]);
    expect(await search(`%${S}`)).toEqual([]);
    // Families report their active references (for the phone picker).
    ip += 1;
    const families = (await request(app.getHttpServer()).get('/catalog/families').set({ ...headers, 'X-Forwarded-For': `10.71.0.${(ip % 250) + 1}` }).expect(200))
      .body as { code: string; activeReferences: number }[];
    expect(families.find((f) => f.code === `IMP-${S}-K`)?.activeReferences).toBe(2);
    expect(families.find((f) => f.code === `IMP-${S}-V`)?.activeReferences).toBe(1);
  });

  it('reference codes may have one space between parts; only ADMIN writes the catalog', async () => {
    const admin = await createTestUser(app, 'ADMIN', `CI${S}`);
    users.push(admin.id);
    const created = await request(app.getHttpServer())
      .post('/catalog/references')
      .set({ ...admin.headers, 'X-Forwarded-For': '10.71.1.1' })
      .send({ code: `  r${S}4   lenner `, familyHint: 'VARIOS' })
      .expect(201);
    expect(created.body).toMatchObject({ code: `R${S}4 LENNER`, familyHint: 'VARIOS' });
    await request(app.getHttpServer())
      .post('/catalog/references')
      .set({ ...admin.headers, 'X-Forwarded-For': '10.71.1.2' })
      .send({ code: `R${S}5 #X` })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/catalog/references/${created.body.id}`)
      .set({ ...admin.headers, 'X-Forwarded-For': '10.71.1.3' })
      .send({ familyHint: '' })
      .expect(200)
      .expect((res) => expect(res.body.familyHint).toBeNull());
    await request(app.getHttpServer())
      .post('/catalog/references')
      .set({ ...headers, 'X-Forwarded-For': '10.71.1.4' })
      .send({ code: `R${S}6` })
      .expect(403);
  });
});
