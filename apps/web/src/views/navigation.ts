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
  | { name: 'sales'; tab?: 'quotes' | 'orders' }
  | { name: 'quote'; id?: string }
  | { name: 'order'; id: string }
  | { name: 'dispatches' }
  | { name: 'dispatch'; id: string }

export type Navigate = (view: View) => void
