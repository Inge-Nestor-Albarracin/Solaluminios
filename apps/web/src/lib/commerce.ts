// Shared types and labels of supply, sales and dispatch. Amounts arrive from
// the API as decimal strings and are only formatted here, never computed:
// the API is the single source of every price, cost and total.

export type MaterialOrigin = 'CHINA' | 'NATIONAL'

export const ORIGIN_LABEL: Record<MaterialOrigin | 'UNKNOWN', string> = {
  CHINA: 'China',
  NATIONAL: 'Nacional',
  UNKNOWN: 'Origen desconocido',
}

export interface Supplier {
  id: string
  code: string
  name: string
  taxId: string | null
  origins: MaterialOrigin[]
  active: boolean
  notes: string | null
}

export interface Customer {
  id: string
  name: string
  taxId: string | null
  phone: string | null
  email: string | null
}

export interface AvailabilityGroup {
  origin: MaterialOrigin | 'UNKNOWN'
  supplier: { id: string; code: string; name: string } | null
  bundles: number
  physical: number
  reserved: number
  available: number
}

export type PricingMethod = 'MARKUP_ON_COST' | 'GROSS_MARGIN' | 'MANUAL'

export const PRICING_LABEL: Record<PricingMethod, string> = {
  MARKUP_ON_COST: 'Recargo sobre costo',
  GROSS_MARGIN: 'Margen bruto sobre venta',
  MANUAL: 'Precio manual autorizado',
}

export const PRICING_HELP: Record<PricingMethod, string> = {
  MARKUP_ON_COST: 'Precio sin IVA = costo × (1 + %). Ej.: costo 9.700 con 30 % → 12.610.',
  GROSS_MARGIN: 'Precio sin IVA = costo ÷ (1 − %). Ej.: costo 9.700 con 30 % → 13.857,14. No es la utilidad neta.',
  MANUAL: 'Precio comercial autorizado; requiere motivo y queda auditado.',
}

export interface QuoteLine {
  id: string
  lineNo: number
  referenceId: string
  finishId: string
  origin: MaterialOrigin
  supplierId: string | null
  supplierName: string | null
  quantity: number
  // ADMIN only: the API removes them for sales.
  pricingMethod?: PricingMethod
  pricingPercent?: string | null
  costBasis?: string | null
  priceReason: string | null
  unitPrice: string
  discountPercent: string
  taxRatePercent: string
  lineSubtotal: string
  discountAmount: string
  taxAmount: string
  lineTotal: string
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
}

export interface Quote {
  id: string
  number: string
  customerId: string
  customerName: string
  status: 'DRAFT' | 'CONVERTED' | 'CANCELLED'
  validUntil: string | null
  notes: string | null
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
  createdAt: string
  lines: QuoteLine[]
  order: { id: string; number: string } | null
  paymentMethod: PaymentMethod | null
  paymentTerms: string | null
  // ADMIN only (the API omits it for other roles).
  createdBy?: { id: string; name: string }
}

export type OrderStatus = 'DRAFT' | 'PENDING_SUPPLY' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED'

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  DRAFT: 'Por confirmar',
  PENDING_SUPPLY: 'Pendiente de abastecimiento',
  CONFIRMED: 'Reservada',
  COMPLETED: 'Entregada',
  CANCELLED: 'Cancelada',
}

export interface OrderLine extends Omit<QuoteLine, 'pricingMethod' | 'pricingPercent' | 'costBasis' | 'priceReason'> {
  reservedQuantity: number
  authorisedQuantity: number
  dispatchedQuantity: number
  pendingQuantity: number
  unauthorisedQuantity: number
}

export interface DispatchSummary {
  id: string
  number: string
  status: 'OPEN' | 'CONFIRMED' | 'CANCELLED'
  dueAt: string
  partial: boolean
  confirmedAt: string | null
  assignee: { id: string; name: string }
  _count: { incidents: number }
}

export type PaymentMethod = 'CASH' | 'TRANSFER' | 'PARTIAL' | 'CREDIT'

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Contado – efectivo',
  TRANSFER: 'Contado – transferencia',
  PARTIAL: 'Abono',
  CREDIT: 'Cartera (crédito)',
}

// Example for the free terms field, by method.
export const PAYMENT_TERMS_HINT: Record<PaymentMethod, string> = {
  CASH: 'Opcional.',
  TRANSFER: 'Opcional, p. ej. la cuenta o el plazo de la transferencia.',
  PARTIAL: 'P. ej. «anticipo del 50 %, saldo contra entrega».',
  CREDIT: 'P. ej. «30 días».',
}

// «Contado – efectivo · condiciones»; documents saved before have none.
export function paymentLabel(document: { paymentMethod: PaymentMethod | null; paymentTerms: string | null }) {
  if (!document.paymentMethod) return 'Sin forma de pago registrada'
  return `${PAYMENT_METHOD_LABEL[document.paymentMethod]}${document.paymentTerms ? ` · ${document.paymentTerms}` : ''}`
}

// Abono / credit orders only (cash and transfer: null).
export type PaymentStatus = 'PENDING' | 'PAID'

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  PENDING: 'Pago pendiente',
  PAID: 'Pagada',
}

export interface SalesOrder {
  id: string
  number: string
  status: OrderStatus
  customerName: string
  paymentMethod: PaymentMethod | null
  paymentTerms: string | null
  paymentStatus: PaymentStatus | null
  paymentStatusAt: string | null
  // ADMIN only: who recorded the current payment state.
  paymentStatusBy?: { id: string; name: string } | null
  // ADMIN only (the API omits them for other roles).
  createdBy?: { id: string; name: string }
  convertedBy?: { id: string; name: string } | null
  subtotal: string
  discountTotal: string
  taxTotal: string
  total: string
  createdAt: string
  inventoryLocation: { id: string; code: string; name: string } | null
  quote: { id: string; number: string } | null
  lines: OrderLine[]
  dispatches: DispatchSummary[]
  cancelReason: string | null
}

export interface Shortage {
  lineNo: number
  referenceCode: string
  finishCode: string
  origin: MaterialOrigin
  required: number
  available: number
  missing: number
}

export interface DispatchPick {
  bundleId: string
  epc: string
  // From an opened bundle: loose profiles of the warehouse.
  loose: boolean
  quantity: number
  bundleQuantity: number
  lot: string | null
  origin: MaterialOrigin | null
  supplier: string | null
  aisle: number | null
  rack: number | null
}

export interface DispatchLine {
  id: string
  lineNo: number
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
  origin: MaterialOrigin
  supplierRequired: string | null
  authorised: number
  prepared: number
  pending: number
  dispatched: number
  // Loose profiles ASSIGNED to this line (its reservations on opened bundles).
  loose: { assigned: number; prepared: number; toTake: number; missing: number; places: string[] }
  // Closed bundles reserved for the line and not read yet.
  suggested: {
    bundleId: string
    epc: string
    quantity: number
    bundleQuantity: number
    needsOpening: boolean
    aisle: number | null
    rack: number | null
  }[]
  picks: DispatchPick[]
}

export interface DispatchIncident {
  id: string
  kind: string
  epc: string
  message: string
  status: 'OPEN' | 'RESOLVED'
  occurrences: number
  source: string
  lastSeenAt: string
  resolution: string | null
  resolvedBy: { id: string; name: string } | null
}

export interface DispatchDetail {
  id: string
  number: string
  status: 'OPEN' | 'CONFIRMED' | 'CANCELLED'
  dueAt: string
  partial: boolean
  confirmedAt: string | null
  cancelReason: string | null
  salesOrder: { id: string; number: string; customerName: string; status: OrderStatus }
  inventoryLocation: { id: string; code: string; name: string }
  assignee: { id: string; name: string }
  createdBy: { id: string; name: string }
  confirmedBy: { id: string; name: string } | null
  lines: DispatchLine[]
  incidents: DispatchIncident[]
  progress: { authorised: number; prepared: number; dispatched: number; openIncidents: number; overdue: boolean; readyToConfirm: boolean }
}

export interface DispatchListItem {
  id: string
  number: string
  status: 'OPEN' | 'CONFIRMED' | 'CANCELLED'
  dueAt: string
  partial: boolean
  salesOrder: { id: string; number: string; customerName: string }
  inventoryLocation: { id: string; code: string; name: string }
  assignee: { id: string; name: string }
  _count: { incidents: number }
}

export const DISPATCH_STATUS_LABEL = { OPEN: 'Abierto', CONFIRMED: 'Salida confirmada', CANCELLED: 'Cancelado' } as const

const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2 })
const COP_CENTS = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Display only.
export function formatMoney(value: string | number | null | undefined, currency = 'COP'): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  // Whole pesos without decimals; with cents, always two ($ 54.184,20).
  if (currency === 'COP') return Number.isInteger(number) ? COP.format(number) : COP_CENTS.format(number)
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 6 }).format(number)
}

// Unit costs are kept with 6 decimals and prices are computed from that exact
// value; showing them rounded to cents would make a price look miscalculated.
const COP_UNIT_COST = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 6 })

export function formatUnitCost(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number) ? COP_UNIT_COST.format(number) : String(value)
}

export function materialLabel(line: { referenceCode: string; finishCode: string; finishDescription?: string | null }) {
  return `${line.referenceCode} · ${line.finishDescription ?? line.finishCode}`
}
