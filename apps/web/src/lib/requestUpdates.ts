import { useEffect } from 'react'
import { useLoad } from './useLoad'

// Answers of an administrator to the session user's own requests (global
// discount or manual price) not seen yet. Shown inside the app, so the seller
// learns the answer even without push notifications on the device.
export interface RequestUpdate {
  id: string
  kind: 'GLOBAL_DISCOUNT' | 'MANUAL_PRICE'
  status: 'APPROVED' | 'REJECTED'
  requestedPercent: string | null
  resolution: string | null
  resolvedAt: string | null
  approver: { id: string; name: string }
  quote: { id: string; number: string; customerName: string }
}

export interface RequestUpdates {
  count: number
  items: RequestUpdate[]
}

const CHANGED = 'request-updates-changed'

// A quote was opened and its answers marked as seen: every notice refreshes.
export function notifyRequestUpdatesChanged() {
  window.dispatchEvent(new Event(CHANGED))
}

// Loaded only when `enabled` (ADMIN / SALES); refreshed every minute, when
// the window regains focus and after a quote marks its answers as seen.
export function useRequestUpdates(enabled: boolean) {
  const state = useLoad<RequestUpdates>(enabled ? '/sales/request-updates' : null)
  const { reload } = state
  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(reload, 60_000)
    window.addEventListener(CHANGED, reload)
    window.addEventListener('focus', reload)
    return () => {
      window.clearInterval(id)
      window.removeEventListener(CHANGED, reload)
      window.removeEventListener('focus', reload)
    }
  }, [enabled, reload])
  return state
}
