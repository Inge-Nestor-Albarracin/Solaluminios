// Imports the product catalog (families and references) from the CSV in
// prisma/data into the database of DATABASE_URL (apps/api/.env).
//
//   pnpm build
//   pnpm catalog:import                 dry run: report only, writes nothing
//   pnpm catalog:import --apply         creates and fills in (never deletes)
//   pnpm catalog:import --apply --overwrite
//                                       also replaces conflicting families,
//                                       descriptions and family names
//   pnpm catalog:import --file other.csv
//
// The connection string is never printed: only the database name and host.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { importCatalog, parseCatalogCsv, type CatalogImportReport } from '../modules/catalog/catalog-import.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const overwrite = args.includes('--overwrite');
const fileIndex = args.indexOf('--file');
const file = resolve(fileIndex >= 0 ? args[fileIndex + 1] : 'prisma/data/catalog-references.csv');

function print(report: CatalogImportReport) {
  const list = (items: string[]) => (items.length > 0 ? ` (${items.join(', ')})` : '');
  console.log(`Familias: ${report.families.create.length} nuevas${list(report.families.create)}, ${report.families.unchanged} sin cambios`);
  for (const rename of report.families.rename) {
    console.log(`  Nombre distinto en ${rename.code}: «${rename.from}» en la base, «${rename.to}» en el catálogo${overwrite ? ' → se reemplaza' : ' → se conserva'}`);
  }
  console.log(`Referencias: ${report.references.create.length} nuevas, ${report.references.fill.length} completadas, ${report.references.unchanged} sin cambios`);
  for (const fill of report.references.fill) console.log(`  ${fill.code}: se completa ${fill.fields.join(', ')}`);
  for (const conflict of report.references.conflicts) {
    const field = conflict.field === 'family' ? 'familia' : 'descripción';
    console.log(`  Conflicto ${conflict.code} (${field}): «${conflict.current}» en la base, «${conflict.catalog}» en el catálogo${overwrite ? ' → se reemplaza' : ' → se conserva'}`);
  }
  if (report.references.inactive.length > 0) console.log(`  Inactivas en la base (no se reactivan): ${report.references.inactive.join(', ')}`);
  if (report.toValidate.length > 0) console.log(`Familia por validar en el catálogo: ${report.toValidate.join(', ')}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en apps/api/.env');
  const target = new URL(url);
  console.log(`Base de datos: ${decodeURIComponent(target.pathname.slice(1))} en ${target.hostname}`);
  console.log(`Archivo: ${file}`);
  console.log(apply ? `Modo: APLICAR${overwrite ? ' (sobrescribiendo conflictos)' : ''}` : 'Modo: simulación (no escribe nada; usa --apply para aplicar)');

  const parsed = parseCatalogCsv(readFileSync(file, 'utf8'));
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  try {
    const report = parsed.errors.length > 0 ? null : await importCatalog(prisma, parsed.rows, { apply, overwrite, source: file.split(/[\\/]/).pop() });
    const errors = report?.errors ?? parsed.errors;
    if (errors.length > 0) {
      console.error('El archivo tiene errores; no se importó nada:');
      for (const error of errors) console.error(`  Línea ${error.line}: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    print(report!);
    console.log(report!.applied ? 'Listo: cambios aplicados.' : 'Simulación terminada: no se escribió nada.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // P2021/P2022: a table or column of the schema is missing in that database.
  const code = (error as { code?: string } | null)?.code;
  if (code === 'P2021' || code === 'P2022') {
    console.error('La base de datos no tiene todas las migraciones. Ejecuta primero: pnpm exec prisma migrate deploy');
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
