// Copies the finishes and the physical structure (branches, inventory
// locations, aisles and racks) from another database of the same PostgreSQL
// server into the database of DATABASE_URL (apps/api/.env). No screen creates
// them, so a clean production database starts from the ones already defined
// (see docs/deploy/base-limpia.md).
//
//   pnpm build
//   pnpm structure:copy --from <base>            dry run: report only
//   pnpm structure:copy --from <base> --apply    copies them (same ids)
//     --exclude-branch CODE      leaves out a branch and all its locations
//     --exclude-location CODE    leaves out a location (and its aisles/racks)
//   (both can be repeated)
//
// Only ACTIVE records are copied. The destination must be a different
// database without finishes or structure yet; nothing is ever updated or
// deleted. Same credentials as DATABASE_URL; only database names are printed.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const valuesOf = (flag: string) => args.flatMap((arg, i) => (arg === flag && args[i + 1] ? [args[i + 1]] : []));
const from = valuesOf('--from')[0];
const excludeBranches = valuesOf('--exclude-branch');
const excludeLocations = valuesOf('--exclude-location');

const client = (url: URL) => new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
const databaseOf = (url: URL) => decodeURIComponent(url.pathname.slice(1));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en apps/api/.env');
  if (!from || !/^[A-Za-z0-9_]+$/.test(from)) throw new Error('Indica la base de origen: --from <nombre> (letras, números y _)');
  const target = new URL(url);
  const origin = new URL(url);
  origin.pathname = `/${from}`;
  const sameDatabase = databaseOf(origin) === databaseOf(target);
  console.log(`Origen: ${databaseOf(origin)} en ${origin.hostname}`);
  console.log(`Destino: ${databaseOf(target)} en ${target.hostname}`);
  console.log(apply ? 'Modo: APLICAR' : 'Modo: simulación (no escribe nada; usa --apply para aplicar)');

  const source = client(origin);
  const destination = client(target);
  try {
    // What the origin has, active and not excluded.
    const allBranches = await source.branch.findMany({ select: { code: true, name: true, active: true } });
    const allLocations = await source.inventoryLocation.findMany({ select: { code: true } });
    const unknown = [
      ...excludeBranches.filter((code) => !allBranches.some((b) => b.code === code)).map((code) => `sucursal ${code}`),
      ...excludeLocations.filter((code) => !allLocations.some((l) => l.code === code)).map((code) => `ubicación ${code}`),
    ];
    if (unknown.length > 0) throw new Error(`No existen en el origen: ${unknown.join(', ')}. Revisa los códigos.`);

    const finishes = await source.finish.findMany({ where: { active: true }, orderBy: { code: 'asc' } });
    const branches = await source.branch.findMany({ where: { active: true, code: { notIn: excludeBranches } }, orderBy: { code: 'asc' } });
    const locations = await source.inventoryLocation.findMany({
      where: { active: true, branchId: { in: branches.map((b) => b.id) }, code: { notIn: excludeLocations } },
      orderBy: { code: 'asc' },
    });
    const aisles = await source.aisle.findMany({ where: { active: true, inventoryLocationId: { in: locations.map((l) => l.id) } }, orderBy: { number: 'asc' } });
    const racks = await source.rack.findMany({ where: { active: true, aisleId: { in: aisles.map((a) => a.id) } }, orderBy: { number: 'asc' } });
    const inactive = {
      finishes: await source.finish.count({ where: { active: false } }),
      branches: allBranches.filter((b) => !b.active).length,
      locations: await source.inventoryLocation.count({ where: { active: false } }),
    };

    console.log(`Acabados (${finishes.length}): ${finishes.map((f) => `${f.code}${f.description ? ` ${f.description}` : ''}`).join(', ') || 'ninguno'}`);
    console.log(`Sucursales (${branches.length}), ubicaciones (${locations.length}), pasillos (${aisles.length}), burros (${racks.length}):`);
    for (const branch of branches) {
      console.log(`  ${branch.code} · ${branch.name}`);
      for (const location of locations.filter((l) => l.branchId === branch.id)) {
        const own = aisles.filter((a) => a.inventoryLocationId === location.id);
        const ownRacks = racks.filter((r) => own.some((a) => a.id === r.aisleId)).length;
        console.log(`    ${location.code} · ${location.name} (${location.type === 'RETAIL_STORE' ? 'almacén' : location.type === 'ACCESSORY_WAREHOUSE' ? 'bodega de accesorios' : 'bodega'}) · ${own.length} pasillos, ${ownRacks} burros`);
      }
    }
    for (const code of excludeBranches) console.log(`  Excluida: sucursal ${code} · ${allBranches.find((b) => b.code === code)?.name}`);
    for (const code of excludeLocations) console.log(`  Excluida: ubicación ${code}`);
    if (inactive.finishes + inactive.branches + inactive.locations > 0) {
      console.log(`No se copian por inactivos: ${inactive.finishes} acabados, ${inactive.branches} sucursales, ${inactive.locations} ubicaciones (y sus pasillos y burros inactivos).`);
    }

    // The destination must be a new database.
    const present = {
      acabados: await destination.finish.count(),
      sucursales: await destination.branch.count(),
      ubicaciones: await destination.inventoryLocation.count(),
      pasillos: await destination.aisle.count(),
      burros: await destination.rack.count(),
    };
    const filled = Object.entries(present).filter(([, count]) => count > 0);
    const problem = sameDatabase
      ? 'origen y destino son la misma base'
      : filled.length > 0
        ? `el destino ya tiene ${filled.map(([name, count]) => `${count} ${name}`).join(', ')}; este script es solo para una base nueva`
        : null;
    if (!apply) {
      console.log(problem ? `No se podría aplicar: ${problem}.` : 'Destino vacío: se puede aplicar.');
      console.log('Simulación terminada: no se escribió nada.');
      return;
    }
    if (problem) throw new Error(`No se aplicó: ${problem}.`);

    await destination.$transaction(async (tx) => {
      await tx.finish.createMany({ data: finishes });
      await tx.branch.createMany({ data: branches });
      await tx.inventoryLocation.createMany({ data: locations });
      await tx.aisle.createMany({ data: aisles });
      await tx.rack.createMany({ data: racks });
      await tx.auditEvent.create({
        data: {
          entity: 'Structure',
          entityId: 'copy',
          action: 'STRUCTURE_COPIED',
          reason: `Acabados y estructura copiados desde ${databaseOf(origin)}`,
          data: {
            finishes: finishes.length,
            branches: branches.length,
            locations: locations.length,
            aisles: aisles.length,
            racks: racks.length,
            excludeBranches,
            excludeLocations,
          },
        },
      });
    });
    console.log('Listo: acabados y estructura copiados.');
  } finally {
    await source.$disconnect();
    await destination.$disconnect();
  }
}

main().catch((error: unknown) => {
  // P2021/P2022: a table or column of the schema is missing in that database.
  const code = (error as { code?: string } | null)?.code;
  if (code === 'P2021' || code === 'P2022') {
    console.error('Una de las bases no tiene todas las migraciones. Ejecuta primero en el destino: pnpm exec prisma migrate deploy');
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
