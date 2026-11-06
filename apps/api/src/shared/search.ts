// Helpers of the text searches (customers, references).

// The user's text inside a LIKE pattern, with %, _ and \ taken literally.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// Lower case without accents («Peña» → «pena»): combining marks (\p{M})
// removed after NFD. The SQL side folds the column with ACCENT_FOLD_FROM/TO.
export function foldAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

// translate(lower(column), FROM, TO) folds the accents used in Spanish.
export const ACCENT_FOLD_FROM = 'áàäâéèëêíìïîóòöôúùüûñ';
export const ACCENT_FOLD_TO = 'aaaaeeeeiiiioooouuuun';
