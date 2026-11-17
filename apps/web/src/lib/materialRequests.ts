import type { MaterialOrigin } from './commerce'

// Material requests (Sales → warehouse → store), as the API returns them.
export type MaterialRequestStatus = 'SENT' | 'PREPARING' | 'SHIPPED' | 'RECEIVED' | 'CANCELLED'

export const REQUEST_STATUS_LABEL: Record<MaterialRequestStatus, string> = {
  SENT: 'Enviada a bodega',
  PREPARING: 'En preparación',
  SHIPPED: 'Despachada (en camino)',
  RECEIVED: 'Recibida',
  CANCELLED: 'Cancelada',
}

interface Person {
  id: string
  name: string
}

export interface MaterialRequestRow {
  id: string
  number: string
  status: MaterialRequestStatus
  dueAt: string
  createdAt: string
  source: { id: string; name: string }
  destination: { id: string; name: string }
  assignee: Person
  createdBy: Person
  lineCount: number
  requested: number
  prepared: number
}

export interface MaterialRequestSuggestion {
  bundleId: string
  epc: string
  quantity: number
  loose: boolean
  aisle: number | null
  rack: number | null
}

export interface MaterialRequestLine {
  id: string
  lineNo: number
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
  origin: MaterialOrigin
  supplierName: string | null
  requested: number
  prepared: number
  shipped: number
  pending: number
  suggestions: MaterialRequestSuggestion[]
}

export interface MaterialRequestPick {
  id: string
  lineId: string
  quantity: number
  bundle: { id: string; epc: string; loose: boolean; aisle: number | null; rack: number | null; lot: string | null; origin: MaterialOrigin | null; supplier: string | null }
}

export interface MaterialRequest {
  id: string
  number: string
  status: MaterialRequestStatus
  dueAt: string
  notes: string | null
  createdAt: string
  source: { id: string; code: string; name: string; branch: { name: string } }
  destination: { id: string; code: string; name: string; branch: { name: string } }
  assignee: Person
  createdBy: Person
  shippedAt: string | null
  shippedBy: Person | null
  receivedAt: string | null
  receivedBy: Person | null
  receptionNote: string | null
  cancelledAt: string | null
  cancelledBy: Person | null
  cancelReason: string | null
  lines: MaterialRequestLine[]
  picks: MaterialRequestPick[]
  totals: { requested: number; prepared: number; shipped: number; bundles: number }
  reception: { assignee: Person; done: boolean } | null
  can: { prepare: boolean; ship: boolean; receive: boolean; reassign: boolean; cancel: boolean }
}

export interface Workers {
  workers: Person[]
  next: Person | null
}
