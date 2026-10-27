export type UserRole = 'ADMIN' | 'WAREHOUSE' | 'SALES' | 'READ_ONLY' | 'CHINA_OPERATOR'

export interface SessionUser {
  id: string
  name: string
  email: string
  role: UserRole
  active: boolean
  defaultInventoryLocationId: string | null
}

export interface LoginResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  user: SessionUser
}

export interface Family {
  id: string
  code: string
  name: string
  active: boolean
  // Version used for conflict-safe edits (expectedUpdatedAt).
  updatedAt?: string
}

export interface Reference {
  id: string
  code: string
  description: string | null
  active: boolean
  familyId: string | null
  updatedAt?: string
}

export interface Finish {
  id: string
  code: string
  description: string | null
  active: boolean
}

export interface Branch {
  id: string
  code: string
  name: string
}

export interface InventoryLocation {
  id: string
  code: string
  name: string
  type: 'WAREHOUSE' | 'RETAIL_STORE'
}

export interface Aisle {
  id: string
  number: number
  floorNumber: number | null
}

export interface Rack {
  id: string
  number: number
}

export type ArrivalDatePrecision = 'EXACT' | 'MONTH' | 'UNKNOWN'
export type MovementType =
  | 'INITIAL_STOCK'
  | 'ENTRY'
  | 'EXIT'
  | 'TRANSFER'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT'

export interface Bundle {
  id: string
  epc: string
  quantity: number
  arrivalDate: string | null
  arrivalYear: number | null
  arrivalMonth: number | null
  arrivalDatePrecision: ArrivalDatePrecision
  notes: string | null
  createdAt: string
  inventoryLocationId: string
  rackId: string | null
  reference: Reference & { family: Pick<Family, 'id' | 'code' | 'name'> | null }
  finish: Finish
  inventoryLocation: InventoryLocation & { branch: Branch }
  rack: (Rack & { aisle: Aisle }) | null
  // Provenance (no cost). null = origin unknown (historical stock).
  lot?: { id: string; code: string; origin: 'CHINA' | 'NATIONAL'; supplier: { id: string; code: string; name: string } | null } | null
}

export interface MovementPlace {
  id: string
  code?: string
  name?: string
  number?: number
  aisle?: Aisle
}

export interface Movement {
  id: string
  type: MovementType
  quantity: number
  quantityBefore: number
  quantityAfter: number
  occurredAt: string
  reason: string | null
  performedBy: { id: string; name: string; role: UserRole }
  sourceLocation?: MovementPlace | null
  destinationLocation?: MovementPlace | null
  sourceRack?: MovementPlace | null
  destinationRack?: MovementPlace | null
}

export interface BundleDetail extends Bundle {
  movements: Movement[]
}

export interface Page<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
  totalPages: number
}

export interface SummaryLocation {
  inventoryLocation: InventoryLocation & { branch: Branch }
  aisle: Aisle | null
  rack: Rack | null
  profiles: number
  bundles: number
}

export interface SummaryGroup {
  reference: Pick<Reference, 'id' | 'code' | 'description' | 'active'> & {
    family: Pick<Family, 'id' | 'code' | 'name'> | null
  }
  finish: Finish
  profiles: number
  bundles: number
  locations: SummaryLocation[]
}

export interface SummaryPage extends Page<SummaryGroup> {
  totals: { profiles: number; bundles: number }
}

export interface OperationResult {
  replayed: boolean
  movement: Movement
  bundle: BundleDetail
}
