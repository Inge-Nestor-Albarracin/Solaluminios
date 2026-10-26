import { useSyncExternalStore } from 'react'

// "Instalar aplicación": only offered when the browser itself allows it
// (Chrome fires beforeinstallprompt when the app is installable and not
// installed). If the user dismisses it, it is not offered again for a while.

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallState = 'installed' | 'available' | 'unavailable'

const DISMISS_KEY = 'solaluminios.install.dismissedAt'
const DISMISS_DAYS = 30

const listeners = new Set<() => void>()
let deferred: BeforeInstallPromptEvent | null = null
let state: InstallState = computeState()

function standalone() {
  return typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches
}

function dismissedRecently(): boolean {
  try {
    const at = Number(window.localStorage.getItem(DISMISS_KEY))
    return Number.isFinite(at) && at > 0 && Date.now() - at < DISMISS_DAYS * 86_400_000
  } catch {
    return false
  }
}

function computeState(): InstallState {
  if (standalone()) return 'installed'
  return deferred && !dismissedRecently() ? 'available' : 'unavailable'
}

function update() {
  const next = computeState()
  if (next === state) return
  state = next
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep it for our discreet button instead of the browser's own banner.
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    update()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    update()
  })
}

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const event = deferred
  if (!event) return 'unavailable'
  // A prompt can only be shown once per event.
  deferred = null
  await event.prompt()
  const { outcome } = await event.userChoice
  if (outcome === 'dismissed') dismissInstall()
  update()
  return outcome
}

export function dismissInstall() {
  try {
    window.localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    // Without storage it may be offered again next time; harmless.
  }
  update()
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}
