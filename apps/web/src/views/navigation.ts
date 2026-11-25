import type { CatalogValue } from '../lib/forms'

export type View =
  | { name: 'home' }
  | { name: 'register'; epc?: string }
  | { name: 'lookup' }
  | { name: 'bulk' }
  | { name: 'bundles'; catalog?: Partial<CatalogValue> }
  | { name: 'summary' }
  | { name: 'tasks' }
  | { name: 'admin' }
  | { name: 'bundle'; id: string }
  | { name: 'receive' }
  | { name: 'sales'; tab?: 'quotes' | 'orders' | 'returns' }
  | { name: 'quote'; id?: string }
  | { name: 'order'; id: string }
  | { name: 'dispatches' }
  | { name: 'dispatch'; id: string }
  | { name: 'requests' }
  | { name: 'billing' }
  | { name: 'request'; id?: string }
  // Accessories warehouse (ACCESSORIES role and administrator).
  | { name: 'accessories' }
  | { name: 'basket'; id: string }
  | { name: 'basketNew'; epc?: string }
  | { name: 'vouchers' }
  | { name: 'voucher'; id: string }
  | { name: 'voucherNew'; kind: 'ENTRY' | 'EXIT' }
  // Sales returns (documento DV): detail and the request from an order.
  | { name: 'return'; id: string }
  | { name: 'returnNew'; orderId: string }

export type Navigate = (view: View) => void
