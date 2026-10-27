import type { UserRole } from '../api/types'

export const ROLES: UserRole[] = ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY', 'CHINA_OPERATOR']

// What each role can do today (same matrix as docs/roles-permissions-idor-audit.md).
export const ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  ADMIN: 'Todo: catálogo, proveedores, compras y costos, ubicaciones, usuarios, ajustes y excepciones.',
  WAREHOUSE: 'Registrar y recibir paquetes, salidas y traslados; ejecutar los despachos de su ubicación.',
  SALES: 'Clientes, cotizaciones y órdenes propias; generar despachos de sus órdenes. Consulta de inventario.',
  READ_ONLY: 'Solo consulta de inventario, más sus propias tareas. Sin precios ni órdenes.',
  CHINA_OPERATOR: 'Solo prerregistra paquetes del proveedor chino configurado (interfaz en inglés). Sin inventario ni costos.',
}

export interface AdminUser {
  id: string
  name: string
  email: string
  role: UserRole
  active: boolean
  defaultInventoryLocationId: string | null
  createdAt: string
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
