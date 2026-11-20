// Demo data for the user manual screenshots, ONLY in the local database
// solaluminios_ensayo_manual (fictitious people, customers and suppliers).
// It does not depend on any other database: it creates the six real finishes,
// the "7 de agosto" store and a demo "Bodega 116" if they are missing.
//
// Before: create the database, migrate and import the catalog (see README.md).
//   node seed-manual.mjs base   -> finishes, locations, users, suppliers, customers (Prisma)
//   node seed-manual.mjs http   -> settings, purchases + sale prices (ADMIN) and bundles (WAREHOUSE)
//                                  through the API at :3101 running on that database
// Passwords are random and saved only in seed-manual.json (git-ignored).
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = fileURLToPath(new URL('../../../apps/api/', import.meta.url));
const require = createRequire(join(API, 'package.json'));
const dotenv = require('dotenv');
const { PrismaPg } = require('@prisma/adapter-pg');
const { PrismaClient } = await import(pathToFileURL(join(API, 'dist/generated/prisma/client.js')).href);
const { hashPassword } = await import(pathToFileURL(join(API, 'dist/infrastructure/security/password.js')).href);

const url = new URL(dotenv.parse(readFileSync(join(API, '.env'))).DATABASE_URL);
url.pathname = '/solaluminios_ensayo_manual';
if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('not a local server');
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
const file = new URL('./seed-manual.json', import.meta.url);
const mode = process.argv[2];
const BASE = process.env.DEMO_API ?? 'http://localhost:3101';

if (mode === 'base') {
  if (existsSync(file)) throw new Error('seed-manual.json exists: this database was already seeded');
  const s = { users: {}, refs: {}, finishes: {} };
  for (const [code, description] of [['BM', 'Blanco mate'], ['BP', 'Blanco pintura'], ['BR', 'Brillo'], ['CH', 'Champaña'], ['CR', 'Crudo'], ['NP', 'Negro pintura']]) {
    s.finishes[code] = (await prisma.finish.upsert({ where: { code }, update: {}, create: { code, description } })).id;
  }
  let store7 = await prisma.inventoryLocation.findFirst({ where: { code: 'ALM-7-AGOSTO' } });
  if (!store7) {
    const b7 = await prisma.branch.create({ data: { code: '7-AGOSTO', name: '7 de agosto' } });
    store7 = await prisma.inventoryLocation.create({ data: { branchId: b7.id, code: 'ALM-7-AGOSTO', name: 'Almacén 7 de agosto', type: 'RETAIL_STORE' } });
  }
  const main = await prisma.branch.create({ data: { code: 'PRINCIPAL', name: 'Sede principal', address: 'Calle 116' } });
  const bodega = await prisma.inventoryLocation.create({ data: { branchId: main.id, code: 'BODEGA-116', name: 'Bodega 116', type: 'WAREHOUSE' } });
  const racks = {};
  for (const [aisleNumber, rackNumbers] of [[1, [1, 2, 3]], [2, [1, 2]]]) {
    const aisle = await prisma.aisle.create({ data: { inventoryLocationId: bodega.id, number: aisleNumber, floorNumber: 1 } });
    for (const n of rackNumbers) racks[`${aisleNumber}-${n}`] = (await prisma.rack.create({ data: { aisleId: aisle.id, number: n } })).id;
  }
  Object.assign(s, { bodega: bodega.id, store7: store7.id, racks });

  for (const [key, role, name, loc] of [
    ['admin', 'ADMIN', 'Paola Herrera', null],
    ['ventas', 'SALES', 'Laura Martínez', store7.id],
    ['ventas2', 'SALES', 'Camilo Torres', bodega.id],
    ['bodega', 'WAREHOUSE', 'Andrés Rojas', bodega.id],
    ['almacen7', 'WAREHOUSE', 'Sofía Gómez', store7.id],
    ['facturacion', 'BILLING', 'Diana Castro', null],
  ]) {
    const password = randomBytes(12).toString('base64url');
    const user = await prisma.user.create({
      data: { name, email: `${key}@demo.local`, role, defaultInventoryLocationId: loc, passwordHash: await hashPassword(password) },
    });
    s.users[key] = { id: user.id, email: user.email, password };
  }
  for (const code of ['387', '393', '392', '194', '193', '177']) s.refs[code] = (await prisma.reference.findUniqueOrThrow({ where: { code } })).id;
  s.china = (await prisma.supplier.create({ data: { code: 'CHINA-EJ', name: 'Proveedor China Ejemplo', origins: ['CHINA'] } })).id;
  s.national = (await prisma.supplier.create({ data: { code: 'NAL-EJ', name: 'Aluminios Nacionales Ejemplo S.A.S.', origins: ['NATIONAL'] } })).id;
  const by = s.users.ventas.id;
  s.customers = [
    (await prisma.customer.create({ data: { name: 'Constructora Ejemplo S.A.S.', taxId: '900.555.123-4', phone: '6017654321', email: 'compras@constructora.example.com', createdById: by } })).id,
    (await prisma.customer.create({ data: { name: 'Vidriería El Ejemplo', taxId: '901.222.333-5', phone: '3105550101', createdById: by } })).id,
    (await prisma.customer.create({ data: { name: 'Juan Pérez', taxId: '80.123.456', phone: '3205550202', createdById: by } })).id,
  ];
  writeFileSync(file, JSON.stringify(s, null, 1));
  console.log('base ok');
} else if (mode === 'http') {
  const s = JSON.parse(readFileSync(file));
  const login = async (key) => {
    const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: s.users[key].email, password: s.users[key].password }) });
    if (!res.ok) throw new Error(`login ${key}: ${res.status}`);
    const body = await res.json();
    return body.accessToken ?? body.token ?? body.access_token;
  };
  const call = async (token, method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
  if (!s.pricesDone) {
    const admin = await login('admin');
    await call(admin, 'PATCH', '/supply/settings', { chinaSupplierId: s.china, dispatchSupervisorId: s.users.bodega.id });
    // Unit costs per profile (without VAT): national and China.
    const cost = { '387': 98000, '393': 86000, '392': 104000, '194': 72000, '193': 64000, '177': 21000 };
    for (const [supplierId, origin, doc, factor] of [[s.national, 'NATIONAL', 'FV-20931', 1], [s.china, 'CHINA', 'CI-2026-118', 0.82]]) {
      const lines = [];
      for (const [code, referenceId] of Object.entries(s.refs)) {
        for (const finish of ['BP', 'NP', 'CH']) {
          lines.push({ referenceId, finishId: s.finishes[finish], origin, quantity: 20, grossAmount: String(Math.round(cost[code] * factor) * 20), discountPercent: '0', taxRatePercent: '19' });
        }
      }
      const purchase = await call(admin, 'POST', '/purchases', { supplierId, documentNumber: doc, documentDate: '2026-11-03', lines });
      const confirmed = await call(admin, 'POST', `/purchases/${purchase.id}/confirm`);
      for (const line of confirmed.lines) await call(admin, 'POST', '/sale-prices', { purchaseId: purchase.id, purchaseLineId: line.id, markupPercent: '35', enabled: true });
    }
    s.pricesDone = true;
    writeFileSync(file, JSON.stringify(s, null, 1));
  }
  if (!s.bundlesDone) {
    let n = 0;
    const R = s.refs, F = s.finishes, K = s.racks;
    const bundle = (ref, fin, quantity, inventoryLocationId, rackId, origin) => ({
      epc: `E28068940000${(0x4a10 + ++n).toString(16).toUpperCase().padStart(12, '0')}`,
      referenceId: R[ref], finishId: F[fin], quantity, inventoryLocationId, ...(rackId ? { rackId } : {}),
      registrationType: 'INITIAL_STOCK', arrivalDatePrecision: 'UNKNOWN', origin, ...(origin === 'NATIONAL' ? { supplierId: s.national } : {}),
    });
    const inBodega = [
      bundle('387', 'BP', 24, s.bodega, K['1-1'], 'CHINA'),
      bundle('387', 'BP', 24, s.bodega, K['1-1'], 'CHINA'),
      bundle('387', 'NP', 24, s.bodega, K['1-2'], 'CHINA'),
      bundle('393', 'BP', 30, s.bodega, K['1-2'], 'CHINA'),
      bundle('393', 'NP', 30, s.bodega, K['1-3'], 'CHINA'),
      bundle('392', 'BP', 20, s.bodega, K['1-3'], 'CHINA'),
      bundle('194', 'BP', 30, s.bodega, K['2-1'], 'NATIONAL'),
      bundle('194', 'CH', 30, s.bodega, K['2-1'], 'NATIONAL'),
      bundle('193', 'BP', 30, s.bodega, K['2-2'], 'NATIONAL'),
      bundle('193', 'NP', 30, s.bodega, K['2-2'], 'NATIONAL'),
      bundle('177', 'NP', 18, s.bodega, K['2-2'], 'NATIONAL'),
    ];
    const inStore = [
      bundle('387', 'BP', 12, s.store7, null, 'CHINA'),
      bundle('393', 'BP', 12, s.store7, null, 'CHINA'),
      bundle('194', 'BP', 10, s.store7, null, 'NATIONAL'),
    ];
    const bodega = await login('bodega');
    const almacen7 = await login('almacen7');
    s.epcs = [];
    for (const [token, list] of [[bodega, inBodega], [almacen7, inStore]]) {
      for (const origin of ['NATIONAL', 'CHINA']) {
        const group = list.filter((b) => b.origin === origin);
        if (group.length === 0) continue;
        const saved = await call(token, 'POST', '/inventory/bundles/batch', { operationKey: randomUUID(), bundles: group });
        s.epcs.push(...saved.bundles.map((b) => b.epc));
      }
    }
    s.bundlesDone = true;
    writeFileSync(file, JSON.stringify(s, null, 1));
    console.log('bundles', s.epcs.length);
  }
  console.log('http ok');
} else {
  console.error('Uso: node seed-manual.mjs base|http');
  process.exitCode = 1;
}
await prisma.$disconnect();
