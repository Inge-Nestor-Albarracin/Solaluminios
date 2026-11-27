// Login names and passwords (docs/usuarios-y-contrasenas.md).
//
// - User name: «pedro.alvarez». Lowercase letters and digits separated by
//   single dots, dashes or underscores, 3 to 50 characters (also a CHECK).
// - Initial password: the person's ID number (cédula), typed by the
//   administrator. It must be replaced at the first login.
// - Own password: at least 8 characters with a letter and a digit (so it can
//   never be the ID number again), not containing the user name, and
//   different from the current one.

export const USERNAME_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
export const USERNAME_MESSAGE =
  'El usuario lleva minúsculas y números, separados por punto, guion o guion bajo (p. ej. pedro.alvarez), de 3 a 50 caracteres';
export const ID_NUMBER_PATTERN = /^\d{5,12}$/;
export const ID_NUMBER_MESSAGE = 'La cédula (clave inicial) son solo números, de 5 a 12 dígitos';
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

export const normalizeLogin = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export function passwordProblem(password: string, username: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
  if (password.length > MAX_PASSWORD_LENGTH) return `La contraseña puede tener como máximo ${MAX_PASSWORD_LENGTH} caracteres`;
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'La contraseña debe tener al menos una letra y un número';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'La contraseña no puede contener tu usuario';
  return null;
}
