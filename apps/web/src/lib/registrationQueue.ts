import { useCallback, useEffect, useState } from 'react'

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
  }
}

const storageKey = (userId: string) => `solaluminios.registrationQueue.${userId}`

function read(userId: string): QueueItem[] {
  try {
    const raw = window.sessionStorage.getItem(storageKey(userId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? (parsed as QueueItem[]) : []
  } catch {
    return []
  }
}

function write(userId: string, items: QueueItem[]) {
  try {
    if (items.length === 0) window.sessionStorage.removeItem(storageKey(userId))
    else window.sessionStorage.setItem(storageKey(userId), JSON.stringify(items))
  } catch {
    // Storage unavailable (private mode, quota): the queue still works in memory.
  }
}

// Bundles waiting for the final save. Kept per user in this browser tab
// (sessionStorage), so changing views, reloading or an expired session in the
// same tab does not lose the work. Nothing reaches the inventory until saved.
export function useRegistrationQueue(userId: string) {
  const [items, setItems] = useState<QueueItem[]>(() => read(userId))

  useEffect(() => {
    write(userId, items)
  }, [userId, items])

  const add = useCallback((item: QueueItem) => setItems((current) => [...current, item]), [])
  const remove = useCallback((id: string) => setItems((current) => current.filter((i) => i.id !== id)), [])
  const removeEpcs = useCallback(
    (epcs: string[]) => setItems((current) => current.filter((i) => !epcs.includes(i.body.epc))),
    [],
  )
  const clear = useCallback(() => setItems([]), [])

  return { items, add, remove, removeEpcs, clear }
}
