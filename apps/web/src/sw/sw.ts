/// <reference lib="webworker" />
// The only service worker of the app (built by vite-plugin-pwa, strategy
// injectManifest). Responsibilities:
// 1. Precache the public static files of this build (JS, CSS, HTML, fonts,
//    icons) so the interface loads without network.
// 2. Never touch API requests: they are not matched by any route, so they go
//    to the network as usual and are never stored (no inventory, users,
//    tasks, tokens or query results in Cache Storage).
// 3. Wait for the user before taking over: a new version stays "waiting"
//    until the page sends SKIP_WAITING (button «Actualizar»).
// 4. Web Push: show a discreet notification and open an allowed view.
import { setCacheNameDetails } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
}

// Caches named "solaluminios-precache-…" (and runtime names reserved but
// unused): old versions of OUR precache are removed on activation; caches of
// other apps on the same origin are never touched.
setCacheNameDetails({ prefix: 'solaluminios', suffix: 'v1' })
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Page navigations (address bar, home-screen icon, reload on an internal
// URL) get the app shell. Only `mode: navigate` requests reach this route,
// so a fetch() to the API never receives HTML. Paths that look like API or
// files are left to the network.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api(\/|$)/, /\/[^/?]+\.[a-z0-9]+$/i],
  }),
)

self.addEventListener('message', (event) => {
  // Sent by the page after the user confirms «Actualizar».
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting()
})

// --- Web Push --------------------------------------------------------------
// The server only sends a type; texts and destinations live here, so a push
// can never show arbitrary content or open an arbitrary URL. The texts are
// generic on purpose: they may be visible on a locked screen.
type View = 'home' | 'tasks' | 'sales' | 'dispatches'

const MESSAGES: Record<string, { body: string; view: View }> = {
  test: { body: 'Notificación de prueba: este dispositivo recibe los avisos de Solaluminios.', view: 'home' },
  'task-assigned': { body: 'Tienes una tarea nueva asignada. Abre la aplicación para verla.', view: 'tasks' },
  'dispatch-assigned': { body: 'Tienes un despacho asignado. Ábrelo en Tareas para prepararlo.', view: 'tasks' },
  'dispatch-reassigned': { body: 'Un despacho que tenías asignado pasó a otra persona.', view: 'tasks' },
  'dispatch-cancelled': { body: 'Se canceló un despacho que tenías asignado.', view: 'tasks' },
  'dispatch-incident': { body: 'Hay una incidencia en un despacho. Revísala en la aplicación.', view: 'dispatches' },
  'dispatch-confirmed': { body: 'Se confirmó la salida de un despacho de tu orden.', view: 'sales' },
  'dispatch-overdue': { body: 'Un despacho está atrasado. Revísalo en la aplicación.', view: 'dispatches' },
}
const FALLBACK = { body: 'Tienes un aviso nuevo en Solaluminios.', view: 'home' as View }
const ALLOWED_VIEWS = new Set<View>(['home', 'tasks', 'sales', 'dispatches'])

const scoped = (path: string) => new URL(path, self.registration.scope).href

self.addEventListener('push', (event) => {
  let type = ''
  try {
    type = String((event.data?.json() as { type?: unknown } | undefined)?.type ?? '')
  } catch {
    // Not JSON: generic notice.
  }
  const message = Object.hasOwn(MESSAGES, type) ? MESSAGES[type] : FALLBACK
  event.waitUntil(
    self.registration.showNotification('Solaluminios', {
      body: message.body,
      icon: scoped('icons/icon-192.png'),
      badge: scoped('icons/badge-96.png'),
      lang: 'es',
      tag: type || 'aviso',
      data: { view: message.view },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const requested = (event.notification.data as { view?: unknown } | null)?.view
  const view: View = ALLOWED_VIEWS.has(requested as View) ? (requested as View) : 'home'
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (open) {
        // Already open (maybe with unsaved work): the page changes view
        // itself, or offers it if busy; it is never reloaded.
        open.postMessage({ type: 'open-view', view })
        await open.focus().catch(() => undefined)
        return
      }
      await self.clients.openWindow(scoped(`./?view=${view}`)).catch(() => undefined)
    })(),
  )
})
