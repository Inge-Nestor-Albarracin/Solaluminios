import type { UserRole } from '../api/types'

export const ROLES: UserRole[] = ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY', 'CHINA_OPERATOR', 'BILLING', 'ACCESSORIES']

// What each role can do today (same matrix as docs/roles-permissions-idor-audit.md).
export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  ADMIN: 'Todo: catálogo, proveedores, compras y costos, ubicaciones, usuarios, ajustes y excepciones.',
  WAREHOUSE: 'Registrar y recibir paquetes, salidas y traslados; ejecutar los despachos de su ubicación.',
  SALES: 'Clientes, cotizaciones y órdenes propias; generar despachos de sus órdenes. Consulta de inventario.',
  READ_ONLY: 'Solo consulta de inventario, más sus propias tareas. Sin precios ni órdenes.',
  CHINA_OPERATOR: 'Solo prerregistra paquetes del proveedor chino configurado (interfaz en inglés). Sin inventario ni costos.',
  BILLING: 'Recibe las órdenes que requieren facturación, descarga su PDF y registra el número de factura. Sin inventario, cotizaciones ni costos.',
  ACCESSORIES: 'Bodega de accesorios. Por ahora solo ve sus tareas; las canastas, ingresos, ventas de mostrador y despachos de accesorios llegan en las próximas entregas. Sin perfiles, costos ni usuarios.',
}

export interface AdminUser {
  id: string
  name: string
  username: string
  email: string | null
  role: UserRole
  active: boolean
  defaultInventoryLocationId: string | null
  // Still with the initial password (ID number).
  mustChangePassword: boolean
  passwordChangedAt: string | null
  lastLoginAt: string | null
  createdAt: string
}

// «Pedro Álvarez Gómez» → «pedro.alvarez»: first name and first surname,
// lowercase, without accents (same rules as the API).
export const USERNAME_PATTERN = /^[a-z0-9]+([._-][a-z0-9]+)*$/
export function suggestUsername(name: string): string {
  const words = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  return (words.length > 1 ? `${words[0]}.${words[1]}` : (words[0] ?? '')).slice(0, 50)
}

export type LoginEventType = 'LOGIN_OK' | 'LOGIN_FAILED' | 'LOGIN_LOCKED' | 'LOGIN_INACTIVE' | 'PASSWORD_CHANGED' | 'PASSWORD_RESET'
export const LOGIN_EVENT_LABEL: Record<LoginEventType, string> = {
  LOGIN_OK: 'Ingresó',
  LOGIN_FAILED: 'Intento fallido',
  LOGIN_LOCKED: 'Bloqueado por intentos',
  LOGIN_INACTIVE: 'Usuario inactivo',
  PASSWORD_CHANGED: 'Cambió su contraseña',
  PASSWORD_RESET: 'Contraseña restablecida',
}
export interface LoginEvent {
  id: string
  type: LoginEventType
  identifier: string
  ip: string | null
  userAgent: string | null
  at: string
  user: { id: string; name: string; username: string } | null
  actor: { id: string; name: string } | null
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_'

// Random initial password (16 chars, ~93 bits) from the browser CSPRNG.
// Rejection sampling keeps every character equally likely.
export function generatePassword(length = 16): string {
  const size = PASSWORD_ALPHABET.length
  const limit = 256 - (256 % size)
  let out = ''
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += PASSWORD_ALPHABET[byte % size]
    }
  }
  return out
}

// Case- and accent-insensitive text match for client-side search.
export function matches(text: string, query: string): boolean {
  const normalize = (value: string) =>
    value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return normalize(text).includes(normalize(query.trim()))
}
