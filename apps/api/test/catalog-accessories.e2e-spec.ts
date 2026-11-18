import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { PrismaService } from '../src/infrastructure/database/prisma.service.js';
import { importCatalog, parseCatalogCsv } from '../src/modules/catalog/catalog-import.js';
import { createE2eApp, createTestUser, uniqueSuffix } from './support/e2e.js';

// Accessory catalog: families of kind ACCESSORY whose references keep an
// internal code, the supplier's code (may repeat or be missing) and the
// brand. Catalog only for now: operations refuse them. Rows are synthetic
// with this run's suffix; the real accessories file is parsed and simulated.
describe('Accessory catalog (e2e)', () => {
  const S = uniqueSuffix();
  const source = `prueba-accesorios-${S}.csv`;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const H: Record<string, Record<string, string>> = {};
  const users: string[] = [];
  const ids = { finish: '', customer: '', profileFamily: '' };
  let ip = 0;
  const http = () => request(app.getHttpServer());
  const as = (who: string) => {
    ip += 1;
    return { ...H[who], 'X-Forwarded-For': `10.72.${Math.floor(ip / 250)}.${(ip % 250) + 1}` };
  };

  const HEADER = 'familyCode,familyName,referenceCode,description,familyHint,familyToValidate,familyKind,supplierCode,brand';
  const rows = (lines: string[]) => {
    const parsed = parseCatalogCsv([HEADER, ...lines].join('\n'));
    expect(parsed.errors).toEqual([]);
    return parsed.rows;
  };
  const catalog = rows([
    `AC-${S},"Accesorios ${S}",AC${S}-001,EMPAQUE U POR METRO,,,ACCESSORY,U${S},PACKLINE`,
    `AC-${S},"Accesorios ${S}",AC${S}-002,EMPAQUE U ROLLO 50 METROS,,,ACCESSORY,U${S},PACKLINE`,
    `AC-${S},"Accesorios ${S}",AC${S}-003,"BRAZOS DE 8""",,,ACCESSORY,,ADU`,
  ]);
  const reference = (code: string) => prisma.reference.findUniqueOrThrow({ where: { code }, include: { family: true } });

  beforeAll(async () => {
    process.env.TRUST_PROXY = '1';
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    for (const role of ['ADMIN', 'WAREHOUSE', 'SALES'] as const) {
      const user = await createTestUser(app, role, `AC${S}`);
      H[role] = user.headers;
      users.push(user.id);
    }
    ids.finish = (await prisma.finish.create({ data: { code: `AC-F-${S}`, description: 'Color de prueba' } })).id;
    ids.customer = (await prisma.customer.create({ data: { name: `Cliente accesorios ${S}`, createdById: users[2] } })).id;
    ids.profileFamily = (await prisma.productFamily.create({ data: { code: `AC-P-${S}`, name: `Perfiles ${S}` } })).id;
    await importCatalog(prisma, catalog, { apply: true, source });
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    if (prisma) {
      await prisma.quote.deleteMany({ where: { createdById: { in: users } } });
      await prisma.customer.deleteMany({ where: { id: ids.customer } });
      await prisma.reference.deleteMany({ where: { code: { startsWith: `AC${S}-` } } });
      await prisma.productFamily.deleteMany({ where: { code: { in: [`AC-${S}`, `AC-P-${S}`] } } });
      await prisma.finish.deleteMany({ where: { id: ids.finish } });
      await prisma.auditEvent.deleteMany({ where: { entity: 'Catalog', action: 'CATALOG_IMPORTED', reason: { contains: source } } });
      await prisma.auditEvent.deleteMany({ where: { userId: { in: users } } });
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    await app?.close();
  });

  it('the real accessories file is valid: 2 accessory families, 128 references, 61 without supplier code', async () => {
    const parsed = parseCatalogCsv(readFileSync(new URL('../prisma/data/catalog-accessories.csv', import.meta.url), 'utf8'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(128);
    expect([...new Set(parsed.rows.map((r) => `${r.familyCode}|${r.familyName}|${r.familyKind}`))]).toEqual([
      'ACCESORIOS|Accesorios|ACCESSORY',
      'ACCESORIOS-YALE|Accesorios Yale|ACCESSORY',
    ]);
    expect(parsed.rows.filter((r) => !r.supplierCode)).toHaveLength(61);
    expect(parsed.rows.find((r) => r.referenceCode === 'ACC-002')).toMatchObject({ description: 'BRAZOS DE 8"', supplierCode: null, brand: 'ADU' });
    // Leading zeros of supplier codes are kept.
    expect(parsed.rows.find((r) => r.supplierCode === '0226')?.description).toBe('BRAZOS DE 16"');
    const report = await importCatalog(prisma, parsed.rows, { apply: false });
    expect(report.errors).toEqual([]);
  });

  it('imports accessory families and references with supplier code (may repeat) and brand; a second run changes nothing', async () => {
    const first = await reference(`AC${S}-001`);
    expect(first.family?.kind).toBe('ACCESSORY');
    expect(first).toMatchObject({ supplierCode: `U${S}`, brand: 'PACKLINE', description: 'EMPAQUE U POR METRO' });
    expect((await reference(`AC${S}-002`)).supplierCode).toBe(`U${S}`);
    expect(await reference(`AC${S}-003`)).toMatchObject({ supplierCode: null, brand: 'ADU' });
    const again = await importCatalog(prisma, catalog, { apply: true, source });
    expect(again.families).toMatchObject({ create: [], kind: [], unchanged: 1 });
    expect(again.references).toMatchObject({ create: [], fill: [], conflicts: [], unchanged: 3 });
  });

  it('a different supplier code or brand is a conflict; the family kind of an existing family changes only with overwrite', async () => {
    const changed = rows([
      `AC-${S},"Accesorios ${S}",AC${S}-001,EMPAQUE U POR METRO,,,ACCESSORY,U${S}X,JIMMY`,
      `AC-P-${S},"Perfiles ${S}",AC${S}-P1,PERFIL,,,ACCESSORY,,`,
    ]);
    const report = await importCatalog(prisma, changed, { apply: false });
    expect(report.references.conflicts.map((c) => c.field).sort()).toEqual(['brand', 'supplierCode']);
    expect(report.families.kind).toEqual([{ code: `AC-P-${S}`, from: 'PROFILE', to: 'ACCESSORY' }]);
    expect((await prisma.productFamily.findUniqueOrThrow({ where: { id: ids.profileFamily } })).kind).toBe('PROFILE');
    // Mixed kinds for one family in the file: invalid, nothing written.
    const mixed = parseCatalogCsv([HEADER, `AC-${S},"Accesorios ${S}",AC${S}-009,X,,,ACCESSORY,,`, `AC-${S},"Accesorios ${S}",AC${S}-010,Y,,,PROFILE,,`].join('\n'));
    expect((await importCatalog(prisma, mixed.rows, { apply: true, source })).errors[0].message).toContain('dos tipos');
  });

  it('search finds accessories by supplier code, description or brand', async () => {
    const search = async (term: string) =>
      ((await http().get(`/catalog/references?search=${encodeURIComponent(term)}`).set(as('WAREHOUSE')).expect(200)).body as { code: string }[]).map((r) => r.code);
    expect((await search(`U${S}`)).slice(0, 2).sort()).toEqual([`AC${S}-001`, `AC${S}-002`]);
    expect(await search('packline')).toEqual(expect.arrayContaining([`AC${S}-001`, `AC${S}-002`]));
  });

  it('operations refuse accessories (catalog only): bundle registration and quotes', async () => {
    const accessory = await reference(`AC${S}-003`);
    const bundle = await http()
      .post('/inventory/bundles')
      .set(as('WAREHOUSE'))
      .send({
        epc: `E2E${S}ACC`,
        referenceId: accessory.id,
        finishId: ids.finish,
        quantity: 10,
        inventoryLocationId: 'sin-ubicacion',
        rackId: 'sin-burro',
        registrationType: 'INITIAL_STOCK',
        arrivalDatePrecision: 'UNKNOWN',
      })
      .expect(400);
    expect(bundle.body.message).toContain('accesorio');
    const quote = await http()
      .post('/quotes')
      .set(as('SALES'))
      .send({ customerId: ids.customer, lines: [{ referenceId: accessory.id, finishId: ids.finish, origin: 'NATIONAL', quantity: 1, discountPercent: '0', taxRatePercent: '19' }] })
      .expect(400);
    expect(quote.body.message).toContain('accesorio');
  });

  it('ADMIN creates accessory families and edits supplier code and brand', async () => {
    const family = await http().post('/catalog/families').set(as('ADMIN')).send({ code: `AC-N-${S}`, name: 'Nueva', kind: 'ACCESSORY' }).expect(201);
    expect(family.body.kind).toBe('ACCESSORY');
    await http().post('/catalog/families').set(as('ADMIN')).send({ code: `AC-M-${S}`, name: 'Mala', kind: 'OTHER' }).expect(400);
    const accessory = await reference(`AC${S}-003`);
    const edited = await http().patch(`/catalog/references/${accessory.id}`).set(as('ADMIN')).send({ supplierCode: ' 0226 ', brand: 'VIMALUM' }).expect(200);
    expect(edited.body).toMatchObject({ supplierCode: '0226', brand: 'VIMALUM' });
    const cleared = await http().patch(`/catalog/references/${accessory.id}`).set(as('ADMIN')).send({ supplierCode: '' }).expect(200);
    expect(cleared.body).toMatchObject({ supplierCode: null, brand: 'VIMALUM' });
    await prisma.productFamily.delete({ where: { id: family.body.id } });
  });
});
