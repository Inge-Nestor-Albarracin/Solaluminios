import type { View } from '../views/navigation'

// Views that a URL (?view=…, manifest shortcuts, a reload) or a notification
// may open. Anything else is ignored; the role checks of each view and of the
// API still apply after login.
export type LaunchView = Exclude<View['name'], 'bundle' | 'quote' | 'order' | 'dispatch'>

const ALLOWED = new Set<LaunchView>(['home', 'register', 'lookup', 'bulk', 'bundles', 'summary', 'tasks', 'admin', 'receive', 'sales', 'dispatches'])

export function parseView(value: unknown): LaunchView | null {
  return typeof value === 'string' && ALLOWED.has(value as LaunchView) ? (value as LaunchView) : null
}

// Read once at start-up, then removed from the address bar (a later reload
// or logout must not jump to it again).
let pending: LaunchView | null = null
if (typeof window !== 'undefined') {
  const url = new URL(window.location.href)
  pending = parseView(url.searchParams.get('view'))
  if (url.searchParams.has('view')) {
    url.searchParams.delete('view')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
}

const listeners = new Set<(view: LaunchView) => void>()

// Notification clicked while the app is open (message from the worker).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; view?: unknown } | null
    if (data?.type !== 'open-view') return
    const view = parseView(data.view)
    if (!view) return
    if (listeners.size === 0) pending = view // logged out: open it after login
    for (const listener of listeners) listener(view)
  })
}

export function takeLaunchView(): LaunchView | null {
  const view = pending
  pending = null
  return view
}

export function onOpenView(listener: (view: LaunchView) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
