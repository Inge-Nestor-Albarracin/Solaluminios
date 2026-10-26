import { useSyncExternalStore } from 'react'

// Connection state shown to the user. navigator.onLine only says whether the
// device has a network; real requests decide whether the API answers:
//   online      -> the last request got an HTTP response
//   offline     -> the device reports no network
//   unreachable -> network present but the API did not answer (error/timeout)
export type Connectivity = 'online' | 'offline' | 'unreachable'

const PROBE_MS = 15_000
const PROBE_TIMEOUT_MS = 8_000

const listeners = new Set<() => void>()
let failed = false
let state: Connectivity = computeState()
let probeTimer: number | null = null
let probeUrl: string | null = null

function computeState(): Connectivity {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline'
  return failed ? 'unreachable' : 'online'
}

function update() {
  const next = computeState()
  if (next !== state) {
    state = next
    for (const listener of listeners) listener()
  }
  scheduleProbe()
}

// While the API does not answer, check it now and then with a request that
// carries no token and no data (any HTTP answer, even 401, means reachable).
function scheduleProbe(delay = PROBE_MS) {
  if (state === 'online' || probeTimer !== null || !probeUrl) return
  probeTimer = window.setTimeout(async () => {
    probeTimer = null
    if (state === 'online') return
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      await fetch(probeUrl!, { method: 'GET', cache: 'no-store', signal: controller.signal })
      reportReachable()
    } catch {
      update()
    } finally {
      window.clearTimeout(timer)
    }
  }, delay)
}

export function configureProbe(url: string) {
  probeUrl = url
}

export function reportUnreachable() {
  failed = true
  update()
}

export function reportReachable() {
  failed = false
  update()
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    // Network is back: confirm with the next real request or the probe.
    if (probeTimer !== null) {
      window.clearTimeout(probeTimer)
      probeTimer = null
    }
    scheduleProbe(0)
    update()
  })
  window.addEventListener('offline', update)
}

export function useConnectivity(): Connectivity {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}
