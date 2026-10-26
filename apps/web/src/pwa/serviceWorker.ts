import { useSyncExternalStore } from 'react'

// Registration of the app's single service worker (src/sw/sw.ts) and update
// detection. A new version is downloaded in the background and WAITS; it only
// takes over when the user confirms «Actualizar» in this window. Then only
// this window reloads; other windows are told and reload when they decide.

export type UpdateState = 'none' | 'available' | 'applying' | 'activated-elsewhere'

const BASE = import.meta.env.BASE_URL
const CHECK_EVERY_MS = 60 * 60 * 1000
const MIN_CHECK_GAP_MS = 5 * 60 * 1000

const listeners = new Set<() => void>()
let state: UpdateState = 'none'
let registration: ServiceWorkerRegistration | null = null
let lastCheck = 0

function set(next: UpdateState) {
  if (next === state) return
  state = next
  for (const listener of listeners) listener()
}

export const serviceWorkerSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator

function watch(reg: ServiceWorkerRegistration) {
  // A version installed earlier and still waiting (e.g. «Más tarde»).
  if (reg.waiting && navigator.serviceWorker.controller) set('available')
  reg.addEventListener('updatefound', () => {
    const installing = reg.installing
    installing?.addEventListener('statechange', () => {
      // With a controller it is an update; without, the first install.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) set('available')
    })
  })
}

function checkForUpdate() {
  if (!registration || Date.now() - lastCheck < MIN_CHECK_GAP_MS) return
  lastCheck = Date.now()
  void registration.update().catch(() => undefined)
}

// Production builds only: in `vite dev` there is no service worker, so HMR
// and the API work as before.
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !serviceWorkerSupported()) return
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (state === 'applying') {
      window.location.reload()
    } else {
      // Another window confirmed the update: this one keeps working with
      // the code it already loaded until the user reloads it.
      set('activated-elsewhere')
    }
  })
  const start = () => {
    navigator.serviceWorker
      .register(`${BASE}sw.js`, { scope: BASE, updateViaCache: 'none' })
      .then((reg) => {
        registration = reg
        lastCheck = Date.now()
        watch(reg)
        window.setInterval(checkForUpdate, CHECK_EVERY_MS)
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate()
        })
      })
      .catch((error: unknown) => {
        // Without a service worker the app keeps working online.
        console.warn('No se pudo registrar el service worker:', error instanceof Error ? `${error.name}: ${error.message}` : error)
      })
  }
  // After `load` so it does not compete with the first paint; if the page
  // already finished loading (e.g. opened in a background tab), right away.
  if (document.readyState === 'complete') start()
  else window.addEventListener('load', start, { once: true })
}

// Only call after checking unsaved work (see UpdateBanner).
export function applyUpdate(): boolean {
  const waiting = registration?.waiting
  if (!waiting) return false
  set('applying')
  waiting.postMessage({ type: 'SKIP_WAITING' })
  // If the new version never takes over, offer the prompt again.
  window.setTimeout(() => {
    if (state === 'applying') set(registration?.waiting ? 'available' : 'none')
  }, 10_000)
  return true
}

export function postponeUpdate() {
  // The waiting version stays; the prompt comes back on the next start.
  set('none')
}

export const reloadNow = () => window.location.reload()

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

// The active registration (null in dev or if registration failed).
export async function readyRegistration(timeoutMs = 4000): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerSupported() || !import.meta.env.PROD) return null
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
  ])
}
