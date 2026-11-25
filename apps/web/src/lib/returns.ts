// Sales returns (documento DV): the customer gives back delivered material.
// The API decides who may do each step; these are the shapes and labels.

export type ReturnStatus = 'REQUESTED' | 'APPROVED' | 'RECEIVED' | 'REJECTED' | 'CANCELLED'
export type ReturnReason = 'SELLER_ERROR' | 'CUSTOMER_ERROR' | 'WAREHOUSE_ERROR' | 'DEFECTIVE'
export type ReturnSettlement = 'CREDIT' | 'REFUND'

export const RETURN_STATUS_LABEL: Record<ReturnStatus, string> = {
  REQUESTED: 'Por autorizar',
  APPROVED: 'Por recibir en bodega',
  RECEIVED: 'Recibida',
  REJECTED: 'Rechazada',
  CANCELLED: 'Cancelada',
}

export const RETURN_STATUS_BADGE: Record<ReturnStatus, string> = {
  REQUESTED: 'badge badge-warning',
  APPROVED: 'badge badge-warning',
  RECEIVED: 'badge badge-paid',
  REJECTED: 'badge',
  CANCELLED: 'badge',
}

export const RETURN_REASONS: { id: ReturnReason; label: string }[] = [
  { id: 'SELLER_ERROR', label: 'Error del vendedor' },
  { id: 'CUSTOMER_ERROR', label: 'El cliente se equivocó o cambió de idea' },
  { id: 'WAREHOUSE_ERROR', label: 'Error de bodega' },
  { id: 'DEFECTIVE', label: 'Material defectuoso' },
]

export const SETTLEMENTS: { id: ReturnSettlement; label: string; hint: string }[] = [
  {
    id: 'CREDIT',
    label: 'Saldo a favor',
    hint: 'El dinero que el cliente ya pagó de más queda como saldo a favor y lo usa en otra compra.',
  },
  {
    id: 'REFUND',
    label: 'Reintegro',
    hint: 'Se le devuelve en efectivo o por transferencia; se registra cuando se le entregue.',
  },
]

export interface ReturnableLine {
  id: string
  lineNo: number
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
  origin: 'CHINA' | 'NATIONAL'
  quantity: number
  delivered: number
  returned: number
  inProcess: number
  returnable: number
  unitValue: string
  lineTotal: string
  returnedAmount: string
}

// Value of `count` profiles of a line, as the API computes it: proportional
// in cents, and the remainder when the returns complete the line.
export function estimateLine(line: ReturnableLine, count: number) {
  if (count <= 0) return 0
  const total = Math.round(Number(line.lineTotal) * 100)
  if (line.returned + count >= line.quantity) return (total - Math.round(Number(line.returnedAmount) * 100)) / 100
  return Math.round((total * count) / line.quantity) / 100
}

export interface Returnable {
  order: { id: string; number: string; status: string; customer: { id: string; name: string }; billed: boolean; invoiceNumber: string | null }
  location: { id: string; code: string; name: string } | null
  problem: string | null
  lines: ReturnableLine[]
  customerCredit: string
}

interface Person {
  id: string
  name: string
}

export interface SalesReturnLine {
  id: string
  salesOrderLineId: string
  lineNo: number
  referenceCode: string
  referenceDescription: string | null
  finishCode: string
  finishDescription: string | null
  origin: 'CHINA' | 'NATIONAL'
  orderedQuantity: number
  quantity: number
  goodQuantity: number | null
  damagedQuantity: number | null
  // Not sent to the warehouse.
  amount?: string | null
  baseAmount?: string | null
  estimatedAmount?: string | null
  movements: { id: string; quantity: number; epc: string; bundleId: string; closed: boolean }[]
  // While waiting for the warehouse: the bundles it left from.
  sources?: { bundleId: string; epc: string; picked: number; returned: number; closed: boolean }[]
}

export interface SalesReturn {
  id: string
  number: string
  status: ReturnStatus
  reason: ReturnReason
  reasonLabel: string
  settlement: ReturnSettlement
  settlementLabel: string
  notes: string | null
  createdAt: string
  order: {
    id: string
    number: string
    status: string
    customerName: string
    customerId: string
    billed: boolean
    invoiceNumber: string | null
    total?: string
  }
  location: { id: string; code: string; name: string }
  requestedBy: Person
  approver: Person | null
  decidedBy: Person | null
  decidedAt: string | null
  decisionNote: string | null
  receiver: Person | null
  receivedBy: Person | null
  receivedAt: string | null
  receptionNote: string | null
  cancelledBy: Person | null
  cancelledAt: string | null
  cancelReason: string | null
  // Money: not sent to the warehouse.
  amount?: string | null
  baseAmount?: string | null
  settledAmount?: string | null
  estimatedAmount?: string | null
  refund?: {
    medium: 'CASH' | 'TRANSFER'
    transferEntity: { id: string; name: string } | null
    refundedOn: string | null
    note: string | null
    at: string
    by: Person | null
  } | null
  refundPending?: boolean
  creditNote: { number: string; at: string; by: Person | null } | null
  creditNotePending: boolean
  lines: SalesReturnLine[]
}

export interface ReturnRow {
  id: string
  number: string
  status: ReturnStatus
  reason: ReturnReason
  settlement: ReturnSettlement
  createdAt: string
  receivedAt: string | null
  order: { id: string; number: string; customerName: string }
  location: { id: string; name: string }
  requestedBy: Person
  lines: number
  amount: string | null
  refundPending: boolean
}

export const profiles = (count: number) => `${count} ${count === 1 ? 'perfil' : 'perfiles'}`
