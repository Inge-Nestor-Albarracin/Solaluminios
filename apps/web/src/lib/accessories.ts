// Accessories warehouse (docs/accesorios-fase-1.md): baskets with one chip,
// entries (IA-…) and exits without a sale (SS-…).

export interface AccessoryReference {
  id: string
  code: string
  description: string | null
  supplierCode: string | null
  brand: string | null
  family: { code: string; name: string } | null
}

export interface AccessoryFinish {
  id: string
  code: string
  description: string | null
}

export interface AccessoryLocation {
  id: string
  code: string
  name: string
  branch: { name: string }
}

export interface AccessoryCatalog {
  references: AccessoryReference[]
  finishes: AccessoryFinish[]
  locations: AccessoryLocation[]
}

export type Origin = 'CHINA' | 'NATIONAL'

export interface Basket {
  id: string
  epc: string
  quantity: number
  reserved: number
  available: number
  origin: Origin | null
  inventoryLocationId: string
  createdAt: string
  updatedAt: string
  reference: AccessoryReference
  finish: AccessoryFinish
  inventoryLocation: AccessoryLocation
}

export interface BasketMovement {
  id: string
  type: 'INITIAL_STOCK' | 'ENTRY' | 'EXIT' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'TRANSFER' | 'OPENING'
  quantity: number
  quantityBefore: number
  quantityAfter: number
  occurredAt: string
  reason: string | null
  performedBy: { id: string; name: string }
  accessoryVoucher: { id: string; number: string; kind: VoucherKind } | null
}

export interface BasketDetail extends Basket {
  movements: BasketMovement[]
}

export type VoucherKind = 'ENTRY' | 'EXIT'
export type ExitType = 'UNREGISTERED_SALE' | 'INTERNAL_USE'

export interface Voucher {
  id: string
  number: string
  kind: VoucherKind
  supplierName: string | null
  documentNumber: string | null
  arrivalDate: string | null
  exitType: ExitType | null
  exitTypeLabel: string | null
  detail: string | null
  receivedBy: string | null
  notes: string | null
  createdAt: string
  inventoryLocation: AccessoryLocation
  createdBy: { id: string; name: string }
  movements: {
    id: string
    type: 'ENTRY' | 'EXIT'
    quantity: number
    quantityBefore: number
    quantityAfter: number
    bundle: { id: string; epc: string; reference: AccessoryReference; finish: AccessoryFinish }
  }[]
  task: { id: string; completedAt: string | null; assignee: { id: string; name: string } } | null
  totals: { baskets: number; units: number }
}

export const ORIGIN_LABEL: Record<Origin, string> = { CHINA: 'China', NATIONAL: 'Nacional' }

export const EXIT_TYPES: { id: ExitType; label: string; hint: string }[] = [
  { id: 'UNREGISTERED_SALE', label: 'Venta no registrada', hint: 'Se vendió por fuera del sistema: describe a quién y cómo.' },
  { id: 'INTERNAL_USE', label: 'Consumo interno', hint: 'Lo usó la empresa (taller, instalación, reparación…).' },
]

export const MOVEMENT_LABEL: Record<BasketMovement['type'], string> = {
  INITIAL_STOCK: 'Conteo inicial',
  ENTRY: 'Ingreso',
  EXIT: 'Salida sin venta',
  ADJUSTMENT_IN: 'Ajuste (suma)',
  ADJUSTMENT_OUT: 'Ajuste (resta)',
  TRANSFER: 'Traslado',
  OPENING: 'Apertura',
}

// How people name an accessory: the supplier's code (if any) and description.
export function accessoryLabel(reference: Pick<AccessoryReference, 'code' | 'description' | 'supplierCode'>): string {
  const name = reference.description ?? reference.code
  return reference.supplierCode ? `${reference.supplierCode} · ${name}` : name
}

export function basketLabel(basket: { reference: AccessoryReference; finish: AccessoryFinish }): string {
  return `${accessoryLabel(basket.reference)} · ${basket.finish.code}`
}

export const units = (n: number) => `${n.toLocaleString('es-CO')} ${n === 1 ? 'unidad' : 'unidades'}`
