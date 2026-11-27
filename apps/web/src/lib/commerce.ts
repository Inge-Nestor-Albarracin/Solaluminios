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
  // The same stock by location: an order reserves in one location only.
  locations: { id: string; name: string; type: 'WAREHOUSE' | 'RETAIL_STORE'; bundles: number; physical: number; reserved: number; available: number }[]
}

// Available profiles per location of the given groups, most stock first.
export function availableByLocation(groups: AvailabilityGroup[]): { id: string; name: string; available: number }[] {
  const places = new Map<string, { id: string; name: string; available: number }>()
  for (const group of groups) {
    for (const location of group.locations) {
      const place = places.get(location.id) ?? { id: location.id, name: location.name, available: 0 }
      place.available += location.available
      places.set(location.id, place)
    }
  }
  return [...places.values()].sort((a, b) => b.available - a.available || a.name.localeCompare(b.name))
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
  // Manual price: set by hand, explained, and authorised by an administrator
  // (manualApprovedBy null = not authorised: no PDF for the customer and no
  // conversion). The seller sees its own reason and estimated cost.
  manualPrice: boolean
  priceReason: string | null
  estimatedUnitCost: string | null
  manualApprovedAt: string | null
  manualApprovedBy: { id: string; name: string } | null
  unitPrice: string
  discountPercent: string
  // Enabled price with a discount above the seller's 3 %: the administrator
  // who authorised it (null = not authorised; see the API's rule).
  discountApprovedAt: string | null
  discountApprovedBy: { id: string; name: string } | null
  taxRatePercent: string
  lineSubtotal: string
  discountAmount: string
  // Share of the document's global discount (VAT and lineTotal come after it).
  globalDiscountAmount: string
  taxAmount: string
  lineTotal: string
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
}

// Global discount of a quote: SALES applies up to this percentage by itself
// (the API enforces it and returns the limit of each quote, which grows to
// what an administrator approved).
export const SELLER_GLOBAL_DISCOUNT_LIMIT = 3

export type DiscountRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'

// Manual line as requested (and, once approved, the price the administrator set).
export interface ManualPriceItem {
  lineNo: number
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
  quantity: number
  discountPercent: string
  proposedUnitPrice: string
  enabledUnitPrice: string | null
  estimatedUnitCost: string | null
  priceReason: string
  approvedUnitPrice?: string
}

export const DISCOUNT_REQUEST_STATUS_LABEL: Record<DiscountRequestStatus, string> = {
  PENDING: 'Pendiente de autorización',
  APPROVED: 'Aprobada',
  REJECTED: 'Rechazada',
  CANCELLED: 'Cancelada',
}

// Requests of a quote to an administrator: a global discount above the
// seller's limit, or the quote's manual prices.
export interface DiscountRequest {
  id: string
  kind: 'GLOBAL_DISCOUNT' | 'MANUAL_PRICE'
  // GLOBAL_DISCOUNT only.
  requestedPercent: string | null
  // MANUAL_PRICE only.
  details: { lines: ManualPriceItem[] } | null
  replacedById: string | null
  reason: string | null
  status: DiscountRequestStatus
  resolution: string | null
  createdAt: string
  resolvedAt: string | null
  requestedBy: { id: string; name: string }
  approver: { id: string; name: string }
  // PENDING only: the quote's totals if it is approved.
  projected: { globalDiscountAmount: string; taxTotal: string; total: string } | null
}

export interface Quote {
  id: string
  number: string
  customerId: string
  customerName: string
  // Current customer record (for its NIT; e-mail for billing).
  customer?: { taxId: string | null; email?: string | null }
  status: 'DRAFT' | 'CONVERTED' | 'CANCELLED'
  validUntil: string | null
  notes: string | null
  subtotal: string
  // Line discounts; the global discount has its own fields.
  discountTotal: string
  globalDiscountPercent: string
  globalDiscountAmount: string
  // «Detal» / «Ventanería»: assembly and installation (no VAT, no discount).
  saleType: SaleType
  assemblyAmount: string
  installationAmount: string
  // Highest global discount the viewer may apply without asking (at the
  // saved base).
  globalDiscountLimit: string
  // A global discount above 3 % authorised by an administrator: up to that
  // percentage while the base (subtotal − line discounts) does not grow.
  globalDiscountApprovedPercent: string | null
  globalDiscountApprovedBase: string | null
  globalDiscountApprovedAt: string | null
  globalDiscountApprovedBy: { id: string; name: string } | null
  discountRequests: DiscountRequest[]
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

export interface OrderLine extends Omit<QuoteLine, 'pricingMethod' | 'pricingPercent' | 'costBasis' | 'estimatedUnitCost' | 'manualApprovedAt'> {
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

export type PaymentMethod = 'CASH' | 'TRANSFER' | 'CASH_TRANSFER' | 'PARTIAL' | 'CREDIT'

// Insertion order is the order of the selectors.
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Contado – efectivo',
  TRANSFER: 'Contado – transferencia',
  CASH_TRANSFER: 'Contado – efectivo y transferencia',
  PARTIAL: 'Abono',
  CREDIT: 'Cartera (crédito)',
}

// Paid in full at the sale (the money is recorded with the conversion).
export const CONTADO_METHODS: PaymentMethod[] = ['CASH', 'TRANSFER', 'CASH_TRANSFER']

// Example for the free terms field, by method.
export const PAYMENT_TERMS_HINT: Record<PaymentMethod, string> = {
  CASH: 'Opcional.',
  TRANSFER: 'Opcional, p. ej. la cuenta o el plazo de la transferencia.',
  CASH_TRANSFER: 'Opcional. El reparto entre efectivo y transferencia se escribe al convertir en orden.',
  PARTIAL: 'P. ej. «anticipo del 50 %, saldo contra entrega». Cada abono se registra en la orden.',
  CREDIT: 'P. ej. «30 días». Los pagos se registran en la orden como abonos.',
}

// Medium of money actually received. CREDIT_BALANCE: the customer's saldo
// a favor (from returns, see lib/returns.ts); no money changes hands.
export type PaymentMedium = 'CASH' | 'TRANSFER' | 'CREDIT_BALANCE'
export const PAYMENT_MEDIUM_LABEL: Record<PaymentMedium, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', CREDIT_BALANCE: 'Saldo a favor' }

// One payment of an order: contado (atSale) or an abono. Amounts in pesos as
// decimal strings; `changes` are the corrections (author for ADMIN only).
// Where Solaluminios receives transfers (the list comes from the API:
// GET /transfer-entities; ids are stable).
export interface TransferEntity {
  id: string
  name: string
}
export const ENTITY_QUESTION = '¿Dónde se recibió la transferencia?'
export const ENTITY_PLACEHOLDER = 'Selecciona una entidad'
// A transfer recorded before the entity was asked: never assumed.
export const ENTITY_UNKNOWN = 'Sin especificar'

export interface OrderPayment {
  id: string
  medium: PaymentMedium
  // Transfers only; null on a transfer = «Sin especificar».
  transferEntity: TransferEntity | null
  amount: string
  paidOn: string
  note: string | null
  atSale: boolean
  createdAt: string
  updatedAt: string
  edited: boolean
  createdBy?: { id: string; name: string }
  updatedBy?: { id: string; name: string } | null
  changes: { at: string; changed: Record<string, { from: string | null; to: string | null }>; by?: { id: string; name: string } }[]
}

// Computed by the API (never typed): total, paid and balance of the order.
// With returns: net = total − returned; balance = net − (paid − settled),
// where `settled` is what was given back to the customer (saldo a favor or
// reintegro).
export interface PaymentSummary {
  recorded: boolean
  total: string
  returned: string
  settled: string
  net: string
  paid: string
  balance: string
  complete: boolean
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
  // ADMIN and the seller only (billing reads the order without them).
  payments?: OrderPayment[]
  paymentSummary?: PaymentSummary
  // ADMIN only (the API omits them for other roles).
  createdBy?: { id: string; name: string }
  convertedBy?: { id: string; name: string } | null
  // Who authorised a global discount above 3 % (null on older orders).
  globalDiscountApprovedBy?: { id: string; name: string } | null
  subtotal: string
  discountTotal: string
  globalDiscountPercent: string
  globalDiscountAmount: string
  // «Detal» / «Ventanería»: assembly and installation (no VAT, no discount).
  saleType: SaleType
  assemblyAmount: string
  installationAmount: string
  taxTotal: string
  total: string
  createdAt: string
  inventoryLocation: { id: string; code: string; name: string } | null
  quote: { id: string; number: string } | null
  lines: OrderLine[]
  dispatches: DispatchSummary[]
  cancelReason: string | null
  // Customer record (what an electronic invoice needs).
  customer?: { id: string; name: string; taxId: string | null; email: string | null }
  // Electronic invoice, made in another software (see BillingView).
  requiresBilling?: boolean
  billingRequestedAt?: string | null
  invoiceNumber?: string | null
  billedAt?: string | null
  billedBy?: { id: string; name: string } | null
  // Sales returns (documento DV) of the order; value and net total.
  returns?: OrderReturn[]
  returnSummary?: { returned: string; net: string }
  // ADMIN and the seller: the customer's saldo a favor.
  customerCredit?: string
}

export interface OrderReturn {
  id: string
  number: string
  status: 'REQUESTED' | 'APPROVED' | 'RECEIVED' | 'REJECTED' | 'CANCELLED'
  reasonLabel: string
  settlement: 'CREDIT' | 'REFUND'
  settlementLabel: string
  lines: number
  amount: string | null
  settledAmount: string | null
  createdAt: string
  receivedAt: string | null
  creditNoteNumber: string | null
  refundPending: boolean
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

// «5 %», «2,5 %».
export function formatPercent(value: string | number): string {
  return `${Number(value).toLocaleString('es-CO', { maximumFractionDigits: 2 })} %`
}

// Totals line of a quote or order: subtotal, line discounts, global discount
// (only when there is one), VAT and total.
export function totalsParts(document: {
  subtotal: string
  discountTotal: string
  globalDiscountPercent: string
  globalDiscountAmount: string
  taxTotal: string
  assemblyAmount?: string
  installationAmount?: string
}) {
  const global = Number(document.globalDiscountAmount) > 0
  const assembly = Number(document.assemblyAmount ?? 0)
  const installation = Number(document.installationAmount ?? 0)
  const labour = assembly > 0 || installation > 0
  return [
    `${labour ? 'Materiales' : 'Subtotal'} ${formatMoney(document.subtotal)}`,
    `${global ? 'Descuentos por renglón' : 'Descuentos'} ${formatMoney(document.discountTotal)}`,
    ...(global ? [`Descuento global ${formatPercent(document.globalDiscountPercent)} −${formatMoney(document.globalDiscountAmount)}`] : []),
    `IVA ${formatMoney(document.taxTotal)}`,
    ...(assembly > 0 ? [`Ensamble ${formatMoney(assembly)} (sin IVA)`] : []),
    ...(installation > 0 ? [`Instalación ${formatMoney(installation)} (sin IVA)`] : []),
  ].join(' · ')
}

// Kind of sale of a quote / order.
export type SaleType = 'RETAIL' | 'WINDOWS'
export const SALE_TYPE_LABEL: Record<SaleType, string> = { RETAIL: 'Detal', WINDOWS: 'Ventanería' }

// Whether a quote / order charges labour (assembly or installation).
export const hasLabour = (document: { assemblyAmount?: string; installationAmount?: string }) =>
  Number(document.assemblyAmount ?? 0) > 0 || Number(document.installationAmount ?? 0) > 0

export function materialLabel(line: { referenceCode: string; finishCode: string; finishDescription?: string | null }) {
  return `${line.referenceCode} · ${line.finishDescription ?? line.finishCode}`
}
