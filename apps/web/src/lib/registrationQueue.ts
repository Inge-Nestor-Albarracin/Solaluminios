import { useCallback, useMemo, useState } from 'react'
import { uuid } from './uuid'

// Same limit as the API (MAX_BATCH_SIZE): one final save is one transaction.
export const MAX_QUEUE_SIZE = 50

export interface RegisterBundleBody {
  epc: string
  referenceId: string
  finishId: string
  quantity: number
  inventoryLocationId: string
  rackId: string
  registrationType: 'INITIAL_STOCK' | 'ENTRY'
  arrivalDatePrecision: 'EXACT' | 'MONTH' | 'UNKNOWN'
  arrivalDate?: string
  arrivalYear?: number
  arrivalMonth?: number
  notes?: string
  // Provenance of the entry group (lists saved before this field have none).
  origin?: 'CHINA' | 'NATIONAL'
  supplierId?: string
}

export interface QueueItem {
  id: string
  body: RegisterBundleBody
  labels: {
    type: string
    reference: string
    finish: string
    arrival: string
    location: string
    origin?: string
  }
}

// ok: persisted in this tab. unavailable: the browser refused sessionStorage
// (private mode, quota, policy); the list lives only in memory. corrupt: a
// stored list could not be read and was ignored.
export type StorageStatus = 'ok' | 'unavailable' | 'corrupt'

interface Stored {
  version: 1
  items: QueueItem[]
  // Retry key of the final save; kept until the list changes or is saved.
  batchKey: string | null
}

const storageKey = (userId: string) => `solaluminios.registrationQueue.${userId}`

function isItem(value: unknown): value is QueueItem {
  const item = value as QueueItem
  return (
    !!item &&
    typeof item.id === 'string' &&
    !!item.body &&
    typeof item.body.epc === 'string' &&
    typeof item.body.quantity === 'number' &&
    !!item.labels
  )
}

function read(userId: string): { stored: Stored; status: StorageStatus } {
  const empty: Stored = { version: 1, items: [], batchKey: null }
  let raw: string | null
  try {
    raw = window.sessionStorage.getItem(storageKey(userId))
  } catch {
    return { stored: empty, status: 'unavailable' }
  }
  if (!raw) return { stored: empty, status: 'ok' }
  try {
    const parsed: unknown = JSON.parse(raw)
    // Version 0 stored a bare array of items.
    const candidate = Array.isArray(parsed) ? { version: 1, items: parsed, batchKey: null } : (parsed as Stored)
    if (candidate?.version === 1 && Array.isArray(candidate.items) && candidate.items.every(isItem)) {
      return {
        stored: { version: 1, items: candidate.items, batchKey: typeof candidate.batchKey === 'string' ? candidate.batchKey : null },
        status: 'ok',
      }
    }
  } catch {
    // fall through
  }
  return { stored: empty, status: 'corrupt' }
}

function write(userId: string, stored: Stored): boolean {
  try {
    if (stored.items.length === 0) window.sessionStorage.removeItem(storageKey(userId))
    else window.sessionStorage.setItem(storageKey(userId), JSON.stringify(stored))
    return true
  } catch {
    return false
  }
}

// Bundles waiting for the final save, per user and per browser tab
// (sessionStorage): another user in the same tab never sees them; changing
// views, reloading or an expired session in the same tab does not lose them.
// Closing the tab does. Nothing reaches the inventory until the final save.
export function useRegistrationQueue(userId: string) {
  const initial = useMemo(() => read(userId), [userId])
  const [stored, setStored] = useState<Stored>(initial.stored)
  const [status, setStatus] = useState<StorageStatus>(initial.status)
  // Number of pending bundles found when the session started (recovered).
  const [recovered, setRecovered] = useState(initial.stored.items.length)

  // Persists synchronously so the status shown is the real outcome.
  const commit = useCallback(
    (next: Stored) => {
      setStored(next)
      const ok = write(userId, next)
      setStatus(ok ? 'ok' : 'unavailable')
    },
    [userId],
  )

  // Any change to the list invalidates the retry key of the final save.
  const change = useCallback(
    (items: QueueItem[]) => {
      commit({ version: 1, items, batchKey: null })
      setRecovered(0)
    },
    [commit],
  )

  const add = useCallback((item: QueueItem) => change([...stored.items, item]), [change, stored.items])
  const remove = useCallback((id: string) => change(stored.items.filter((i) => i.id !== id)), [change, stored.items])
  const clear = useCallback(() => change([]), [change])

  // Same key for every retry of the same list; persisted with it so a reload
  // after a lost response still retries safely.
  const batchKey = useCallback(() => {
    if (stored.batchKey) return stored.batchKey
    const key = uuid()
    commit({ ...stored, batchKey: key })
    return key
  }, [commit, stored])

  return {
    items: stored.items,
    status,
    recovered,
    add,
    remove,
    clear,
    batchKey,
    dismissRecovered: useCallback(() => setRecovered(0), []),
  }
}

export type RegistrationQueue = ReturnType<typeof useRegistrationQueue>
