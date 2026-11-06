// Catalog codes are stored in upper case. Reference codes may have single
// spaces between parts ("703 CURVO", as operators know them); family and
// finish codes may not.
export const CATALOG_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]*$/;
export const REFERENCE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._/-]*(?: [A-Z0-9._/-]+)*$/;

// Trimmed, upper case and with runs of spaces collapsed to one.
export function normalizeReferenceCode(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
