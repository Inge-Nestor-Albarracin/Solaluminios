import { createContext, useContext } from 'react'
import type { RequestOptions } from '../api/client'
import type { SessionUser, UserRole } from '../api/types'

export interface SessionValue {
  user: SessionUser | null
  notice: string | null
  login: (email: string, password: string) => Promise<void>
  logout: (notice?: string) => void
  request: <T>(path: string, options?: RequestOptions) => Promise<{ status: number; data: T }>
  download: (path: string) => Promise<{ blob: Blob; filename: string | null }>
}

export const SessionContext = createContext<SessionValue | null>(null)

export function useSession(): SessionValue {
  const value = useContext(SessionContext)
  if (!value) throw new Error('useSession debe usarse dentro de SessionProvider')
  return value
}

// UI hints only: the API remains the authority on permissions.
export const canOperate = (role: UserRole | undefined) => role === 'ADMIN' || role === 'WAREHOUSE'
export const canAdjust = (role: UserRole | undefined) => role === 'ADMIN'
export const canSell = (role: UserRole | undefined) => role === 'ADMIN' || role === 'SALES'
export const canDispatch = (role: UserRole | undefined) => role === 'ADMIN' || role === 'SALES' || role === 'WAREHOUSE'

export const ROLE_LABELS: Record<UserRole, string> = {
  ADMIN: 'Administrador',
  WAREHOUSE: 'Bodega',
  SALES: 'Ventas',
  READ_ONLY: 'Solo consulta',
  CHINA_OPERATOR: 'Operador China',
}
