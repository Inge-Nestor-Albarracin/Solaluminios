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
  test: { body: 'Notificación de prueba: este dispositivo recibe los avisos de Solualuminios.', view: 'home' },
  'task-assigned': { body: 'Tienes una tarea nueva asignada. Abre la aplicación para verla.', view: 'tasks' },
  'dispatch-assigned': { body: 'Tienes un despacho asignado. Ábrelo en Tareas para prepararlo.', view: 'tasks' },
  'dispatch-reassigned': { body: 'Un despacho que tenías asignado pasó a otra persona.', view: 'tasks' },
  'dispatch-cancelled': { body: 'Se canceló un despacho que tenías asignado.', view: 'tasks' },
  'dispatch-incident': { body: 'Hay una incidencia en un despacho. Revísala en la aplicación.', view: 'dispatches' },
  'dispatch-confirmed': { body: 'Se confirmó la salida de un despacho de tu orden.', view: 'sales' },
  'dispatch-overdue': { body: 'Un despacho está atrasado. Revísalo en la aplicación.', view: 'dispatches' },
  'discount-requested': { body: 'Te pidieron autorizar un descuento. Revísalo en Tareas.', view: 'tasks' },
  'discount-approved': { body: 'Aprobaron tu solicitud de descuento. Revisa la cotización en Ventas.', view: 'sales' },
  'discount-rejected': { body: 'Rechazaron tu solicitud de descuento. Revisa la cotización en Ventas.', view: 'sales' },
  'discount-resolved': { body: 'Respondieron tu solicitud de descuento. Revisa la cotización.', view: 'sales' },
  'price-requested': { body: 'Te pidieron autorizar un precio manual. Revísalo en Tareas.', view: 'tasks' },
  'price-approved': { body: 'Aprobaron tu precio manual. Revisa la cotización en Ventas.', view: 'sales' },
  'price-rejected': { body: 'Rechazaron tu precio manual. Revisa la cotización en Ventas.', view: 'sales' },
  'price-resolved': { body: 'Respondieron tu solicitud de precio manual. Revisa la cotización.', view: 'sales' },
  'material-request-assigned': { body: 'Tienes una solicitud de materiales por preparar. Ábrela en Tareas.', view: 'tasks' },
  'material-request-shipped': { body: 'Salió de bodega una solicitud de materiales. Revísala en Tareas.', view: 'tasks' },
  'material-request-received': { body: 'El almacén recibió una solicitud de materiales.', view: 'home' },
  'material-request-cancelled': { body: 'Se canceló una solicitud de materiales que tenías asignada.', view: 'tasks' },
  'billing-requested': { body: 'Tienes una orden de venta por facturar. Ábrela en Tareas.', view: 'tasks' },
  'billing-cancelled': { body: 'Una orden que tenías por facturar ya no requiere factura.', view: 'tasks' },
  'billing-void-needed': { body: 'Se canceló una orden ya facturada: revisa la anulación en Tareas.', view: 'tasks' },
  'order-billed': { body: 'Facturaron una de tus órdenes de venta.', view: 'sales' },
  'accessory-entry': { body: 'Accesorios registró un ingreso de mercancía. Míralo en Tareas.', view: 'tasks' },
  'accessory-exit': { body: 'Accesorios registró una salida sin venta. Mírala en Tareas.', view: 'tasks' },
  'return-requested': { body: 'Un vendedor pide autorizar una devolución.', view: 'tasks' },
  'return-approved': { body: 'Autorizaron una devolución que pediste.', view: 'sales' },
  'return-rejected': { body: 'Rechazaron una devolución que pediste.', view: 'sales' },
  'return-to-receive': { body: 'Tienes una devolución por recibir en bodega.', view: 'tasks' },
  'return-received': { body: 'Bodega recibió una devolución de tus órdenes.', view: 'sales' },
  'return-cancelled': { body: 'Se canceló una devolución que tenías pendiente.', view: 'tasks' },
  'credit-note-needed': { body: 'Una orden facturada tuvo una devolución: registra la nota crédito.', view: 'tasks' },
}
const FALLBACK = { body: 'Tienes un aviso nuevo en Solualuminios.', view: 'home' as View }
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
    self.registration.showNotification('Solualuminios', {
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
