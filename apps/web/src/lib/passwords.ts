// Own password (docs/usuarios-y-contrasenas.md). The same rules as the API:
// at least 8 characters with a letter and a digit (never the ID number), not
// containing the user name, different from the current one.
export function passwordRules(password: string, username: string, current: string) {
  return [
    { ok: password.length >= 8, text: 'Al menos 8 caracteres' },
    { ok: /\p{L}/u.test(password) && /\d/.test(password), text: 'Al menos una letra y un número (no puede ser la cédula)' },
    { ok: !username || !password.toLowerCase().includes(username.toLowerCase()), text: 'No contiene tu usuario' },
    { ok: password.length > 0 && password !== current, text: 'Distinta de la actual' },
  ]
}
