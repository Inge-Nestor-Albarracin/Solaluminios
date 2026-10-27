import type { IncidentKind, MaterialOrigin } from '../../generated/prisma/client.js';

// Matching of one scanned bundle against the lines of a dispatch (pure).
// The same function serves the handheld (phase 1) and fixed readers
// (phase 2), so both apply identical business rules.

export interface ScannedBundle {
  id: string;
  epc: string;
  referenceId: string;
  finishId: string;
  referenceCode: string;
  finishLabel: string;
  quantity: number;
  inventoryLocationId: string;
  locationLabel: string;
  origin: MaterialOrigin | null;
  supplierId: string | null;
  supplierName: string | null;
}

export interface DispatchLineRequirement {
  dispatchLineId: string;
  lineNo: number;
  referenceId: string;
  finishId: string;
  referenceCode: string;
  finishLabel: string;
  origin: MaterialOrigin;
  supplierId: string | null;
  supplierName: string | null;
  // Authorised for this dispatch minus what other bundles already cover.
  pending: number;
}

export type MatchResult =
  | { ok: true; line: DispatchLineRequirement }
  | { ok: false; kind: IncidentKind; message: string; line?: DispatchLineRequirement };

const ORIGIN_ADJECTIVE: Record<MaterialOrigin, string> = { CHINA: 'de origen China', NATIONAL: 'nacionales' };
const ORIGIN_NAME: Record<MaterialOrigin, string> = { CHINA: 'China', NATIONAL: 'Nacional' };

function requirementText(line: DispatchLineRequirement) {
  return `${line.pending} perfiles ${ORIGIN_ADJECTIVE[line.origin]} de referencia ${line.referenceCode}, ${line.finishLabel}`;
}

export function matchBundle(bundle: ScannedBundle, lines: DispatchLineRequirement[], dispatchLocationId: string, dispatchLocationLabel: string): MatchResult {
  const sameMaterial = lines.filter((line) => line.referenceId === bundle.referenceId && line.finishId === bundle.finishId);
  if (sameMaterial.length === 0) {
    const wanted = lines.map((line) => `${line.referenceCode} ${line.finishLabel}`).join('; ');
    return {
      ok: false,
      kind: 'WRONG_MATERIAL',
      message: `No coincide: el paquete leído es ${bundle.referenceCode}, ${bundle.finishLabel}. Este despacho requiere: ${wanted}.`,
    };
  }
  if (!bundle.origin) {
    return {
      ok: false,
      kind: 'UNKNOWN_ORIGIN',
      line: sameMaterial[0],
      message: `No coincide: el paquete leído no tiene procedencia registrada (origen desconocido). Este despacho requiere ${requirementText(sameMaterial[0])}.`,
    };
  }
  const sameOrigin = sameMaterial.filter((line) => line.origin === bundle.origin);
  if (sameOrigin.length === 0) {
    return {
      ok: false,
      kind: 'WRONG_ORIGIN',
      line: sameMaterial[0],
      message: `No coincide: este despacho requiere ${requirementText(sameMaterial[0])}. El paquete leído es de origen ${ORIGIN_NAME[bundle.origin]}.`,
    };
  }
  const allowed = sameOrigin.filter((line) => !line.supplierId || line.supplierId === bundle.supplierId);
  if (allowed.length === 0) {
    return {
      ok: false,
      kind: 'WRONG_SUPPLIER',
      line: sameOrigin[0],
      message: `No coincide: el renglón exige el proveedor ${sameOrigin[0].supplierName ?? ''}; el paquete leído es del proveedor ${bundle.supplierName ?? 'sin registrar'}.`,
    };
  }
  if (bundle.inventoryLocationId !== dispatchLocationId) {
    return {
      ok: false,
      kind: 'WRONG_LOCATION',
      line: allowed[0],
      message: `No coincide: el paquete está en ${bundle.locationLabel}; este despacho sale de ${dispatchLocationLabel}.`,
    };
  }
  if (bundle.quantity <= 0) {
    return { ok: false, kind: 'INSUFFICIENT', line: allowed[0], message: 'El paquete leído está agotado (0 perfiles).' };
  }
  // Lines that still need profiles first; a restricted line before an open one.
  const open = allowed.filter((line) => line.pending > 0).sort((a, b) => Number(!!b.supplierId) - Number(!!a.supplierId) || a.lineNo - b.lineNo);
  if (open.length === 0) {
    return { ok: false, kind: 'OTHER', line: allowed[0], message: 'Ese renglón ya tiene preparada toda la cantidad autorizada; el paquete no se agrega.' };
  }
  return { ok: true, line: open[0] };
}
