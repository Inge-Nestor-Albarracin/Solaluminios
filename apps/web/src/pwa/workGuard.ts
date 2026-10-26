import { useEffect, useSyncExternalStore } from 'react'

// Registry of work that a reload would interrupt or lose: an active RFID
// reading, a pending registration list, a form with data, a write still
// waiting for the server… The update prompt refuses to reload while there is
// any, in this window or in another window of the app (BroadcastChannel).
// Nothing is stored: each window answers from its own memory.

const blockers = new Map<symbol, string>()
const listeners = new Set<() => void>()
let snapshot: string[] = []

function emit() {
  snapshot = [...new Set(blockers.values())]
  for (const listener of listeners) listener()
}

// Imperative form, for code outside React (e.g. a request in flight).
export function beginWork(reason: string): () => void {
  const id = Symbol(reason)
  blockers.set(id, reason)
  emit()
  return () => {
    if (blockers.delete(id)) emit()
  }
}

// Declares unsaved work while `reason` is not null; released on unmount.
export function useUnsavedWork(reason: string | null) {
  useEffect(() => (reason ? beginWork(reason) : undefined), [reason])
}

export function useLocalBlockers(): string[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot,
  )
}

export const localBlockers = () => snapshot

// --- Other windows of the app -------------------------------------------
type Message =
  | { type: 'work-query'; id: string }
  | { type: 'work-answer'; id: string; reasons: string[] }

const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('solaluminios-app')

channel?.addEventListener('message', (event: MessageEvent<Message>) => {
  if (event.data?.type === 'work-query') {
    channel.postMessage({ type: 'work-answer', id: event.data.id, reasons: snapshot } satisfies Message)
  }
})

// Reasons reported by the other open windows within `waitMs` (a window that
// does not answer in time is not counted; the browser may have frozen it).
export function otherWindowsBlockers(waitMs = 500): Promise<string[]> {
  if (!channel) return Promise.resolve([])
  const id = `${Date.now()}-${Math.random()}`
  const reasons: string[] = []
  const onMessage = (event: MessageEvent<Message>) => {
    if (event.data?.type === 'work-answer' && event.data.id === id) reasons.push(...event.data.reasons)
  }
  channel.addEventListener('message', onMessage)
  channel.postMessage({ type: 'work-query', id } satisfies Message)
  return new Promise((resolve) => {
    window.setTimeout(() => {
      channel.removeEventListener('message', onMessage)
      resolve([...new Set(reasons)])
    }, waitMs)
  })
}
