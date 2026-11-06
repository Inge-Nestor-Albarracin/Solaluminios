import type { PrismaClient } from '../../generated/prisma/client.js';
import { CATALOG_CODE_PATTERN, REFERENCE_CODE_PATTERN, normalizeReferenceCode } from './catalog-codes.js';

// Reconciled import of the product catalog (families and references) from
// the CSV kept in prisma/data. Safe by design:
//   - without `apply` it only reports what would change (dry run);
//   - it creates and fills in, and never deletes nor deactivates anything;
//   - an existing reference whose family or description differs from the
//     catalog is reported as a conflict and kept as it is, unless `overwrite`;
//   - any invalid row stops the whole import (nothing is written);
//   - running it twice gives the same result (the second run changes nothing).
// Finishes are not part of the import (they stay as they are).

export interface CatalogRow {
  line: number;
  familyCode: string;
  familyName: string;
  referenceCode: string;
  description: string;
  // Other families where it is also known: a hint only.
  familyHint: string | null;
  // The workbook marks the family as still to be validated.
  familyToValidate: boolean;
}

export interface CatalogImportReport {
  applied: boolean;
  errors: { line: number; message: string }[];
  families: { create: string[]; rename: { code: string; from: string; to: string }[]; unchanged: number };
  references: {
    create: string[];
    // Empty fields filled in from the catalog (family, description, hint).
    fill: { code: string; fields: string[] }[];
    conflicts: { code: string; field: 'family' | 'description'; current: string; catalog: string }[];
    unchanged: number;
    inactive: string[];
  };
  toValidate: string[];
}

const HEADER = ['familyCode', 'familyName', 'referenceCode', 'description', 'familyHint', 'familyToValidate'];

// RFC 4180 CSV (quoted fields may contain commas, quotes and new lines).
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  // Without the byte order mark that Excel may add (U+FEFF).
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => value.trim() !== ''));
}

export function parseCatalogCsv(text: string): { rows: CatalogRow[]; errors: { line: number; message: string }[] } {
  const [header, ...data] = parseCsv(text);
  if (!header || HEADER.some((name, index) => header[index]?.trim() !== name)) {
    return { rows: [], errors: [{ line: 1, message: `Encabezado esperado: ${HEADER.join(',')}` }] };
  }
  return {
    rows: data.map((values, index) => ({
      line: index + 2,
      familyCode: (values[0] ?? '').trim().toUpperCase(),
      familyName: (values[1] ?? '').trim(),
      referenceCode: normalizeReferenceCode(values[2] ?? ''),
      description: (values[3] ?? '').trim().replace(/\s+/g, ' '),
      familyHint: (values[4] ?? '').trim() || null,
      familyToValidate: /^(si|sí|true|1)$/i.test((values[5] ?? '').trim()),
    })),
    errors: [],
  };
}

function validate(rows: CatalogRow[]) {
  const errors: { line: number; message: string }[] = [];
  const families = new Map<string, string>();
  const references = new Map<string, number>();
  for (const row of rows) {
    const problems: string[] = [];
    if (!CATALOG_CODE_PATTERN.test(row.familyCode) || row.familyCode.length > 50) problems.push(`código de familia inválido «${row.familyCode}»`);
    if (!row.familyName || row.familyName.length > 100) problems.push('nombre de familia vacío o de más de 100 caracteres');
    if (!REFERENCE_CODE_PATTERN.test(row.referenceCode) || row.referenceCode.length > 50) problems.push(`código de referencia inválido «${row.referenceCode}»`);
    if (row.description.length > 255) problems.push('descripción de más de 255 caracteres');
    if (row.familyHint && row.familyHint.length > 200) problems.push('pista de familia de más de 200 caracteres');
    const name = families.get(row.familyCode);
    if (name !== undefined && name !== row.familyName) problems.push(`la familia ${row.familyCode} aparece con dos nombres («${name}» y «${row.familyName}»)`);
    families.set(row.familyCode, row.familyName);
    const first = references.get(row.referenceCode);
    if (first !== undefined) problems.push(`la referencia ${row.referenceCode} se repite (línea ${first})`);
    references.set(row.referenceCode, row.line);
    for (const message of problems) errors.push({ line: row.line, message });
  }
  return errors;
}

type Client = Pick<PrismaClient, 'productFamily' | 'reference' | 'auditEvent' | '$transaction'>;
type Tx = Pick<PrismaClient, 'productFamily' | 'reference' | 'auditEvent'>;

export async function importCatalog(
  prisma: Client,
  rows: CatalogRow[],
  options: { apply: boolean; overwrite?: boolean; source?: string },
): Promise<CatalogImportReport> {
  const report: CatalogImportReport = {
    applied: false,
    errors: validate(rows),
    families: { create: [], rename: [], unchanged: 0 },
    references: { create: [], fill: [], conflicts: [], unchanged: 0, inactive: [] },
    toValidate: rows.filter((row) => row.familyToValidate).map((row) => row.referenceCode),
  };
  if (report.errors.length > 0) return report;

  // Same planning for the dry run and the real run (inside its transaction).
  const run = async (tx: Tx, write: boolean) => {
    const familyIds = new Map<string, string>();
    const families = new Map(rows.map((row) => [row.familyCode, row.familyName]));
    const existingFamilies = await tx.productFamily.findMany({ where: { code: { in: [...families.keys()] } } });
    for (const [code, name] of families) {
      const current = existingFamilies.find((family) => family.code === code);
      if (!current) {
        report.families.create.push(code);
        if (write) familyIds.set(code, (await tx.productFamily.create({ data: { code, name } })).id);
        continue;
      }
      familyIds.set(code, current.id);
      if (current.name !== name) {
        // Renaming is only reported unless `overwrite`: the name is what people see.
        report.families.rename.push({ code, from: current.name, to: name });
        if (write && options.overwrite) await tx.productFamily.update({ where: { id: current.id }, data: { name } });
      } else {
        report.families.unchanged += 1;
      }
    }

    const existing = await tx.reference.findMany({
      where: { code: { in: rows.map((row) => row.referenceCode) } },
      include: { family: { select: { code: true } } },
    });
    for (const row of rows) {
      const current = existing.find((reference) => reference.code === row.referenceCode);
      const familyId = familyIds.get(row.familyCode);
      if (!current) {
        report.references.create.push(row.referenceCode);
        if (write) {
          await tx.reference.create({
            data: { code: row.referenceCode, description: row.description || null, familyId, familyHint: row.familyHint },
          });
        }
        continue;
      }
      if (!current.active) report.references.inactive.push(row.referenceCode);
      const data: { familyId?: string; description?: string | null; familyHint?: string | null } = {};
      const filled: string[] = [];
      if (!current.familyId) {
        data.familyId = familyId;
        filled.push('familia');
      } else if (current.family?.code !== row.familyCode) {
        report.references.conflicts.push({ code: row.referenceCode, field: 'family', current: current.family?.code ?? '', catalog: row.familyCode });
        if (options.overwrite) data.familyId = familyId;
      }
      if (row.description && !current.description) {
        data.description = row.description;
        filled.push('descripción');
      } else if (row.description && current.description !== row.description) {
        report.references.conflicts.push({ code: row.referenceCode, field: 'description', current: current.description ?? '', catalog: row.description });
        if (options.overwrite) data.description = row.description;
      }
      // The hint is catalog information: it always follows the catalog.
      if ((current.familyHint ?? null) !== row.familyHint) {
        data.familyHint = row.familyHint;
        filled.push('pista de familia');
      }
      if (filled.length > 0) report.references.fill.push({ code: row.referenceCode, fields: filled });
      if (Object.keys(data).length === 0) report.references.unchanged += 1;
      else if (write) await tx.reference.update({ where: { id: current.id }, data });
    }
  };

  if (!options.apply) {
    await run(prisma, false);
    return report;
  }
  await prisma.$transaction(
    async (tx) => {
      await run(tx, true);
      await tx.auditEvent.create({
        data: {
          entity: 'Catalog',
          entityId: 'references',
          action: 'CATALOG_IMPORTED',
          reason: `Importación del catálogo${options.source ? ` desde ${options.source}` : ''}${options.overwrite ? ' (sobrescribiendo conflictos)' : ''}`,
          data: {
            familiesCreated: report.families.create,
            familiesRenamed: options.overwrite ? report.families.rename : [],
            referencesCreated: report.references.create,
            referencesFilled: report.references.fill,
            conflicts: report.references.conflicts,
            conflictsOverwritten: Boolean(options.overwrite),
          },
        },
      });
    },
    { timeout: 60_000 },
  );
  report.applied = true;
  return report;
}
