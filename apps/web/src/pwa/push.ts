import type { RequestOptions } from '../api/client'
import { readyRegistration, serviceWorkerSupported } from './serviceWorker'

// Web Push on this device. The permission is requested only from a click on
// «Activar notificaciones»; a refusal is respected (the browser blocks new
// prompts and we never ask again by ourselves).

type Request = <T>(path: string, options?: RequestOptions) => Promise<{ status: number; data: T }>

export type PushAvailability =
  | 'supported'
  | 'insecure' // HTTP on a network address: browsers require HTTPS
  | 'unsupported' // browser without Push API / Notifications (e.g. iPhone outside the home screen)
  | 'no-worker' // development server (`vite dev`) or worker not registered

export function pushAvailability(): PushAvailability {
  if (typeof window === 'undefined') return 'unsupported'
  if (!window.isSecureContext) return 'insecure'
  if (!serviceWorkerSupported() || !('PushManager' in window) || !('Notification' in window)) return 'unsupported'
  if (!import.meta.env.PROD) return 'no-worker'
  return 'supported'
}

export type Permission = NotificationPermission | 'unsupported'

export function notificationPermission(): Permission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

interface PushConfig {
  enabled: boolean
  publicKey: string | null
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey
  if (!current) return false
  const a = new Uint8Array(current)
  const b = keyBytes(publicKey)
  return a.length === b.length && a.every((value, index) => value === b[index])
}

async function browserSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability() !== 'supported') return null
  const registration = await readyRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

function body(subscription: PushSubscription) {
  const json = subscription.toJSON()
  return { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } }
}

export async function serverPushConfig(request: Request): Promise<PushConfig> {
  return (await request<PushConfig>('/push/config')).data
}

// Result of «Activar»: on, or the permission the user chose.
export async function enablePush(request: Request): Promise<'on' | 'denied' | 'default'> {
  const config = await serverPushConfig(request)
  if (!config.enabled || !config.publicKey) throw new Error('server-disabled')
  // From the user's click. 'default' = closed without choosing.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return permission
  const registration = await readyRegistration()
  if (!registration) throw new Error('no-worker')

  let subscription = await registration.pushManager.getSubscription()
  // Subscribed with other server keys (keys rotated): start again.
  if (subscription && !sameKey(subscription, config.publicKey)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(config.publicKey),
  })
  try {
    await request('/push/subscriptions', { method: 'POST', body: body(subscription) })
  } catch (error) {
    // Not linked on the server: do not leave a half-active subscription.
    await subscription.unsubscribe().catch(() => undefined)
    throw error
  }
  return 'on'
}

// «Desactivar» and logout: unlink this device from the account (server) and
// drop the browser subscription, so nobody else can receive these notices.
// The local part is done even if the server cannot be reached; the server
// then deletes the row the first time the push service reports it gone.
export async function disablePush(request: Request | null): Promise<void> {
  const subscription = await browserSubscription()
  if (!subscription) return
  if (request) {
    await request('/push/subscriptions/remove', {
      method: 'POST',
      body: { endpoint: subscription.endpoint },
    }).catch(() => undefined)
  }
  await subscription.unsubscribe().catch(() => undefined)
}

// Before logout: bounded time, never throws.
export async function releasePushOnLogout(request: Request, timeoutMs = 4000): Promise<void> {
  await Promise.race([
    disablePush(request).catch(() => undefined),
    new Promise((resolve) => window.setTimeout(resolve, timeoutMs)),
  ])
}

// After login: a subscription left in this browser by another account (or
// already unlinked) is dropped, so this account never receives other
// people's notices. Returns whether this device is linked to the user.
export async function syncPushOnLogin(request: Request): Promise<boolean> {
  const subscription = await browserSubscription()
  if (!subscription) return false
  const { data } = await request<{ linked: boolean }>('/push/subscriptions/check', {
    method: 'POST',
    body: { endpoint: subscription.endpoint },
  })
  if (!data.linked) await subscription.unsubscribe().catch(() => undefined)
  return data.linked
}

export async function sendTestPush(request: Request) {
  return (await request<{ devices: number; delivered: number; removed: number; failed: number }>('/push/test', { method: 'POST' })).data
}

// --- Link state of this device for the signed-in user ---------------------
// null: unknown (not checked, logged out or the check failed).
const linkListeners = new Set<() => void>()
let linked: boolean | null = null

export function setPushLinked(value: boolean | null) {
  if (value === linked) return
  linked = value
  for (const listener of linkListeners) listener()
}

export function subscribePushLinked(listener: () => void) {
  linkListeners.add(listener)
  return () => {
    linkListeners.delete(listener)
  }
}

export const pushLinked = () => linked
