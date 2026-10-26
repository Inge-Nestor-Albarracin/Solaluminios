# Solaluminios como PWA instalable y con notificaciones Web Push

Rama: `feat/pwa-web-push` (sin push ni despliegue). Proyecto: Solaluminios
(`github.com/Inge-Nestor-Albarracin/Solaluminios`), monorepo pnpm con
`apps/api` (NestJS 12 + Prisma 7.8 + PostgreSQL) y `apps/web` (React 19 +
Vite 8). No se cambió el stack, la autenticación ni los módulos de negocio.

## 1. Cambios realizados

### Frontend (`apps/web`)

| Archivo | Qué hace |
| --- | --- |
| `vite.config.ts` | `vite-plugin-pwa@2.0.0` en modo `injectManifest`: manifest + **un único** service worker propio. `VITE_BASE` fija `id`, `start_url`, `scope`. |
| `src/sw/sw.ts` (+ `tsconfig.sw.json`) | Service worker: precache de los archivos estáticos públicos del build, navegación → `index.html`, actualización solo con `SKIP_WAITING` enviado por la app, eventos `push` y `notificationclick`. |
| `public/icons/*` | PNG 192, 512, maskable 192/512 (márgenes de zona segura), apple-touch 180 y badge monocromo 96, generados desde la marca de `favicon.svg` (`scripts/make-pwa-icons.py`). |
| `index.html` | `description`, `apple-touch-icon`, `mobile-web-app-capable` (el manifest lo enlaza el plugin). |
| `src/pwa/serviceWorker.ts` | Registro (solo en builds de producción), detección de versiones nuevas cada hora y al volver a la app; nunca recarga sola. |
| `src/pwa/workGuard.ts` | Registro de trabajo sin guardar (lectura RFID activa, lista de registro, formularios, escrituras en curso) y consulta a las otras ventanas por `BroadcastChannel`. |
| `src/pwa/PwaBanners.tsx` | Avisos «Sin conexión» y «Hay una versión nueva» (Actualizar / Más tarde). |
| `src/pwa/connectivity.ts` | Estado de conexión por resultados reales de las solicitudes (no solo `navigator.onLine`) con sondeo del API cuando falla. |
| `src/pwa/install.ts`, `src/pwa/DevicePanel.tsx` | «Este dispositivo» en Inicio: instalar (solo si el navegador lo ofrece; «Ahora no» lo oculta 30 días) y activar/desactivar notificaciones + prueba. |
| `src/pwa/push.ts` | Soporte, permiso tras clic, suscripción, desvinculación al cerrar sesión y limpieza de suscripciones de otra cuenta al iniciar sesión. |
| `src/pwa/launchView.ts` | Vistas permitidas por URL (`/?view=tasks`, accesos del manifest) y por clic en notificación; nada más. |
| `src/api/client.ts` | Tiempo de espera de 30 s, mensaje «Sin conexión» real, reporte de conectividad, escrituras en curso como trabajo pendiente. Sin cambios en el contrato ni en la autenticación. |
| `src/lib/useChafonReader.ts`, `views/BulkReadView.tsx` | Limpieza de listeners en desconexiones inesperadas y **Reconectar** sin volver a elegir el dispositivo. |
| `views/BundleDetailView.tsx`, `lib/useLoad.ts` | Si una recarga falla, el detalle conserva los últimos datos **marcados como no actualizados** (hora de la consulta) en vez de desmontar el panel: no se pierden los datos escritos ni la clave de una operación incierta. |
| Formularios (`OperationsPanel`, `RegisterBundleView`, `TaskForm`, admin) | Declaran trabajo sin guardar para la actualización. |

### Backend (`apps/api`)

| Archivo | Qué hace |
| --- | --- |
| `prisma/schema.prisma`, migración `20261026150000_push_subscriptions` | Modelo `PushSubscription` (tabla `push_subscriptions`): una fila por dispositivo, `endpoint` único, FK a `users` con `ON DELETE CASCADE`; CHECK de HTTPS y formato de claves. Migración nueva; ninguna aplicada se editó. |
| `src/modules/push/*` | Módulo `push`: configuración VAPID por variables de entorno, validación de destinos (lista de servicios push: FCM, Mozilla, Apple, WNS; solo HTTPS, sin credenciales ni puertos raros → sin SSRF), claves P-256, envío con `web-push@3.6.7`, reintentos limitados (1 s y 3 s, `Retry-After` máx. 10 s), borrado ante 404/410, logs solo con id y host. |
| `src/modules/tasks/tasks.service.ts` | Tras crear una tarea asignada por ADMIN a otra persona, aviso «tarea asignada» sin esperar y sin afectar la tarea si falla. |
| `scripts/Configure-Vapid.mjs` | Genera las claves VAPID en `.env` (o el archivo indicado) sin mostrar la privada. |
| `.env.example` | `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` vacías. |
| `test/support/e2e.ts` | `createE2eApp` acepta reemplazar proveedores (para no contactar servicios push reales). |

Endpoints (todos con sesión; ninguno recibe `userId`):

| Método | Ruta | Roles | Respuesta |
| --- | --- | --- | --- |
| GET | `/push/config` | todos | `{ enabled, publicKey }` (solo la clave pública) |
| POST | `/push/subscriptions` | todos | Vincula este dispositivo al usuario de la sesión (máx. 10 por usuario). Límite 20/min. |
| POST | `/push/subscriptions/check` | todos | `{ linked }` para el usuario de la sesión |
| POST | `/push/subscriptions/remove` | todos | Desvincula solo si el dispositivo es del usuario de la sesión |
| POST | `/push/test` | todos | Prueba a los propios dispositivos; 1 cada 30 s por usuario y 5/min por cliente |

Se usan POST (no DELETE) para no ampliar los métodos de CORS del API.

## 2. Comandos

```powershell
# API (desde apps/api)
pnpm build
pnpm lint
pnpm test                 # unitarias
pnpm test:e2e             # e2e contra la base aislada *_e2e_test (aplica migraciones allí)

# Web (desde apps/web)
pnpm build                # tsc -b (app + service worker) + vite build
pnpm lint
pnpm test                 # protocolo Chafon
pnpm preview --port 4173 --strictPort   # sirve dist con el service worker
```

Prueba local completa de la PWA (base de pruebas, nunca la de desarrollo):

```powershell
# 1. Claves VAPID solo para pruebas, en un archivo ignorado por git
cd apps/api; node scripts/Configure-Vapid.mjs .env.push-test mailto:pruebas@empresa.com
# 2. API de pruebas en 3101 aceptando el origen de vite preview
$env:PORT='3101'; $env:CORS_ORIGIN='http://localhost:4173'; node --env-file-if-exists=.env.push-test scripts/start-test-api.mjs
# 3. Web compilada contra ese API y servida con preview
cd ../web; $env:VITE_API_URL='http://localhost:3101'; pnpm build; pnpm preview --port 4173 --strictPort
```

(En `.claude/launch.json` existen `api-test-pwa` y `web-preview` con lo mismo.)

## 3. Variables (sin secretos)

| Variable | Dónde | Uso |
| --- | --- | --- |
| `VAPID_SUBJECT` | API | `mailto:` o `https://` de contacto del emisor |
| `VAPID_PUBLIC_KEY` | API | Se entrega al navegador por `/push/config` |
| `VAPID_PRIVATE_KEY` | API | **Solo backend.** Nunca en `VITE_*`, logs ni repositorio |
| `CORS_ORIGIN` | API | Origen exacto del frontend publicado (sin comodines) |
| `TRUST_PROXY` | API | `1` detrás de nginx |
| `VITE_API_URL` | build web | URL del API (p. ej. `https://inventario.ejemplo.com/api`) |
| `VITE_BASE` | build web | Ruta de publicación si no es `/` (p. ej. `/app/`) |

Sin las tres `VAPID_*` el API arranca igual y la app muestra «No están configuradas en el servidor». Generar las claves **una vez por entorno**: cambiarlas invalida todas las suscripciones.

## 4. Instalación en Android (Chrome)

1. Abrir la dirección **HTTPS** de la aplicación en Google Chrome.
2. Inicio → «Este dispositivo» → **Instalar aplicación** (solo aparece si Chrome lo permite). También: menú ⋮ → «Instalar aplicación» / «Agregar a pantalla principal».
3. Se abre desde el ícono, sin barra del navegador (`standalone`). Mantener pulsado el ícono muestra accesos a Registrar, Lectura masiva, Consultar chip y Tareas.

La sesión no se guarda en el dispositivo (el token vive en memoria): al abrir la app o recargarla se vuelve a iniciar sesión. Es el comportamiento previo y no se cambió.

## 5. Notificaciones

- **Activar:** Inicio → «Este dispositivo» → **Activar notificaciones** → aceptar el permiso de Chrome. Se pide solo con ese clic.
- **Rechazo:** si se rechaza, la app no vuelve a pedirlo; indica habilitarlo en la configuración del sitio (candado → Permisos → Notificaciones).
- **Prueba:** **Enviar notificación de prueba** (solo a los dispositivos propios, máx. 1 cada 30 s).
- **Desactivar:** **Desactivar** quita este dispositivo; los demás del usuario siguen.
- **Cerrar sesión** desvincula este dispositivo de la cuenta (servidor) y elimina la suscripción del navegador. Si la sesión terminó sin cerrar sesión (recarga o vencimiento) y entra otra persona, la app elimina la suscripción anterior al iniciar sesión y el servidor borra la fila cuando el servicio push la declare inválida.
- **Eventos:** «tarea asignada» (cuando un ADMIN asigna una tarea a otra persona) y la prueba. Textos genéricos, sin títulos ni datos del negocio (pueden verse con la pantalla bloqueada). Al pulsar se abre/enfoca Inicio o Tareas; si hay trabajo en curso, la app ofrece ir a Tareas en vez de cambiar de vista.
- No hay avisos por lecturas RFID ni por movimientos de inventario.

## 6. Actualizaciones

1. Una versión nueva se descarga en segundo plano y **espera**.
2. Aparece «Hay una versión nueva» con **Actualizar** y **Más tarde**. Nunca recarga sola.
3. **Actualizar** comprueba trabajo en curso en esta ventana y en las otras ventanas de la app: lectura RFID o pistola conectada, lista de lectura masiva, lista de registro sin guardar, formularios con datos, una escritura esperando respuesta. Si hay, los enumera y no actualiza hasta que se terminen o cancelen.
4. Sin trabajo pendiente pide confirmación (se deberá iniciar sesión de nuevo), activa la versión y recarga **solo esa ventana**. Las otras muestran «Se activó una versión nueva desde otra ventana» y se recargan cuando el usuario decide.
5. «Más tarde» deja la versión esperando; vuelve a ofrecerse al abrir la app.

## 7. Sin conexión: qué hace y qué no

- Carga la interfaz (HTML, JS, CSS, fuentes, íconos) desde la caché `solaluminios-precache-*` si ya se visitó.
- Muestra **«Sin conexión»** (sin red) o **«Sin conexión con el servidor»** (hay red pero el API no responde o supera 30 s), con la explicación de qué requiere conexión. Desaparece al responder el API.
- **Requieren conexión:** iniciar sesión, consultas, registro de paquetes, salidas, traslados, ajustes, tareas, administración y la referencia de los chips leídos.
- **No** hay inventario offline, cola de movimientos ni sincronización posterior: nada se envía después automáticamente.
- Una operación sin respuesta se informa como **incierta**, se conservan los datos y la **misma** clave de operación; al reintentar, el API la reconoce y no la aplica dos veces.
- Los datos en pantalla que no pudieron recargarse se marcan como no actualizados con la hora de su consulta.
- Cache Storage no contiene respuestas del API, tokens ni contraseñas (el API responde `Cache-Control: no-store` y el service worker no intercepta sus solicitudes).

## 8. Lector Chafon

- Comunicación real: **Web Bluetooth** (modo «transparente» del lector, servicio `ffe0`) o **modo teclado (HID)**. El SDK nativo Android (`.aar`) **no** se ejecuta en Chrome ni en la PWA; solo se usó como referencia del protocolo.
- Requiere Chrome en Android/computador y HTTPS (o `localhost`). No hay Web Bluetooth en iPhone.
- Bloquear la pantalla, salir de la app o alejarse puede cortar el enlace Bluetooth: la app lo muestra, conserva la lista y ofrece **Reconectar** (sin volver a elegir el dispositivo mientras la página siga abierta). No hay lectura en segundo plano.
- Salir de Lectura masiva envía «detener», cierra el enlace y quita los listeners.
- Instalar, actualizar o recuperar la conexión no registra paquetes ni movimientos.

## 9. Publicación (preparado, no aplicado)

1. HTTPS válido (p. ej. Let's Encrypt). Ver `docs/deploy/nginx-pwa.conf.example` y `docs/deploy/security-headers.conf.example`:
   - `sw.js`, `index.html`, `manifest.webmanifest` con `Cache-Control: no-cache`;
   - `/assets/*` con `max-age=31536000, immutable`;
   - `try_files $uri /index.html` para rutas internas;
   - `Content-Type: application/manifest+json`;
   - CSP con `connect-src` del API, `worker-src 'self'`, `manifest-src 'self'`.
2. API: `pnpm exec prisma migrate deploy` (aplica `20261026150000_push_subscriptions`; solo crea la tabla), claves VAPID del entorno, `CORS_ORIGIN` exacto, `TRUST_PROXY=1` con nginx.
3. Web: `VITE_API_URL=... pnpm build` y copiar `apps/web/dist`.
4. Salida HTTPS del servidor hacia los servicios push (`fcm.googleapis.com`, etc.).

| Acceso | Service worker / instalación / push / Bluetooth |
| --- | --- |
| `http://localhost` en el mismo equipo | Sí (contexto seguro), útil para desarrollo |
| `http://192.168.x.x` desde otro dispositivo | **No**: el navegador no lo considera seguro. La app funciona en línea como antes, sin PWA, push ni Bluetooth. No usar banderas de Chrome para saltarlo en producción |
| `https://dominio` con certificado válido | Sí: configuración objetivo |

## 10. Resultados y pendientes

Pruebas ejecutadas el 26/10/2026 en Windows con la API de pruebas
(`solaluminios_dev_e2e_test`), `vite preview` y dos navegadores: el panel del
navegador de Claude (Chromium; notificaciones bloqueadas por el entorno) y
Google Chrome con un **perfil temporal aislado** controlado por CDP (no el
perfil del usuario). Datos de prueba creados con IDs únicos y borrados por ID;
la base de pruebas quedó vacía.

Automáticas:

- API: `pnpm build` y `pnpm lint` sin errores; unitarias **18/18** (7 nuevas); e2e **113/113** en 15 archivos (10 nuevas en `test/push.e2e-spec.ts`). En la primera ejecución completa falló una vez `catalog-families › regression…`, que compara el total de referencias mientras otros archivos crean referencias en paralelo; pasó sola y en la repetición completa. Es un test intermitente previo, no relacionado con push.
- Web: `pnpm build` (incluye `tsc -b` de la app y del service worker), `pnpm lint` sin avisos, `pnpm test` 7/7.

Errores encontrados y corregidos durante las pruebas:

1. Si una salida/traslado/ajuste quedaba sin respuesta y la recarga del paquete también fallaba, el detalle se desmontaba y se perdían los datos escritos y la clave de la operación incierta. Ahora se conservan y los datos viejos se marcan con su hora.
2. El registro del service worker esperaba el evento `load`; si la página ya había cargado (pestaña abierta en segundo plano) no se registraba. Ahora se registra de inmediato en ese caso y deja un aviso en consola si falla.
3. Tras una desconexión inesperada de la pistola quedaban listeners colgados; al reconectar se habrían duplicado. Ahora se quitan y existe «Reconectar».

Pendientes:

- Probar en un **Android real con Chrome y HTTPS**: instalación, apertura standalone, push con la app cerrada y pantalla bloqueada, clic real en la notificación.
- Probar con la **pistola Chafon física**: conexión, bloqueo de pantalla y «Reconectar».
- Aplicar la migración en la base de desarrollo (`pnpm --dir apps/api exec prisma migrate deploy`) y reiniciar el API; **no se aplicó** (solo en la base de pruebas). Generar las claves VAPID del entorno (`node scripts/Configure-Vapid.mjs`).
- Publicación con HTTPS (configuración propuesta en `docs/deploy/`, no aplicada).
- La sesión sigue sin persistir entre recargas (decisión previa); actualizar la app implica volver a iniciar sesión.

## Tabla de escenarios

| # | Escenario | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Manifest válido (id, start_url, scope `/`, standalone, es-CO, colores) e íconos 192/512 + maskable | APROBADO | Manifest leído en el navegador; íconos revisados visualmente (marca sin deformar, maskable dentro de la zona segura) |
| 2 | Un único service worker registrado | APROBADO | `getRegistrations()` = 1, `sw.js` con scope `/`, en ambos navegadores |
| 3 | Chrome considera la app instalable y se ofrece «Instalar» de forma discreta | APROBADO | Chrome disparó `beforeinstallprompt`; botón visible en «Este dispositivo». En el panel (sin evento) no se muestra el botón |
| 4 | Instalación y apertura en modo standalone | NO EJECUTADO | No hay Android disponible; el dominio CDP `PWA` no existe en este Chrome |
| 5 | Rutas internas y recarga desde una URL (`/?view=tasks`, `/inventario/paquetes/123`) | APROBADO | Tras iniciar sesión abre Tareas y limpia la URL; ruta arbitraria servida por el service worker |
| 6 | Interfaz disponible sin servidor web | APROBADO | Con `vite preview` detenido, la app cargó desde el precache (login, fuentes, manifest) |
| 7 | Login sin API: sin login offline ni datos guardados | APROBADO | Mensaje de error; `localStorage`/`sessionStorage` vacíos |
| 8 | Login, logout | APROBADO | Bodega y Admin en Chrome; logout desvincula push |
| 9 | Roles y permisos | APROBADO (API) / NO EJECUTADO (UI) | e2e 113/113 (roles, IDOR, tareas, push). `?view=admin` con un usuario sin rol ADMIN no se probó en navegador (el código lo redirige a Inicio) |
| 10 | Inventario: listado, detalle, salida | APROBADO | Salida 18 → 16 registrada una sola vez (verificado en BD) |
| 11 | Registro de paquetes por la interfaz | NO EJECUTADO | Cubierto por e2e del API; el formulario solo se usó como trabajo sin guardar |
| 12 | Cotizador | NO APLICA | No existe en el repositorio |
| 13 | Tareas: asignación por ADMIN → aviso | APROBADO | e2e y push real a Chrome |
| 14 | Lectura masiva: deduplicación, referencia, resumen | APROBADO (simulado) | 4 lecturas → 3 chips, referencias y resumen por referencia (teclado y BLE simulado) |
| 15 | Pistola: conectar, leer, detener, desconexión, Reconectar sin selector, sin listeners duplicados, liberar al salir | APROBADO (simulado) | Listeners 1 → 0 → 1; segunda ronda cuenta exactamente el doble; al salir envía «detener» y cierra el enlace |
| 16 | Pistola Chafon física | NO EJECUTADO | Sin hardware |
| 17 | Servidor caído durante una salida: sin guardado falso, datos y clave conservados, reintento aplicado una vez | APROBADO | Aviso de resultado incierto; datos «no actualizados» con hora; reintento → un solo EXIT en BD |
| 18 | Aviso «Sin conexión» y recuperación automática | APROBADO (servidor caído) / NO EJECUTADO (modo avión) | Banner con el API detenido; desaparece al volver. `navigator.onLine=false` no se pudo simular |
| 19 | Actualización entre dos compilaciones sin perder trabajo | APROBADO | Builds A y B distintos: aviso en 2 ventanas sin recarga; «Actualizar» bloqueado por lectura masiva (esta ventana) y formulario de tarea (otra); tras cancelarlos, solo la ventana que confirmó pasó a B; la otra conservó su estado con «Recargar / Más tarde»; la caché quedó solo con B |
| 20 | Cache Storage sin respuestas privadas | APROBADO | Solo `solaluminios-precache-*` con archivos estáticos; ninguna URL del API, sin datos en storage ni IndexedDB |
| 21 | Permisos: bloqueado, no solicitado, concedido | APROBADO | Chrome: textos y botones correctos en los tres estados. «Concedido» se dio por CDP en lugar del diálogo nativo |
| 22 | Rechazo desde el diálogo nativo | NO EJECUTADO | No se puede pulsar el diálogo por automatización (sí se probó el estado bloqueado) |
| 23 | Push real con la página abierta | APROBADO | Backend → web-push → FCM → Chrome: notificación de prueba mostrada en 1,3 s |
| 24 | Push real con la página cerrada | APROBADO | Sin ventanas de la app: «Tienes una tarea nueva asignada» mostrada por el service worker |
| 25 | Desactivar / cerrar sesión desvincula el dispositivo | APROBADO (cerrar sesión) | Servidor 0 filas y navegador sin suscripción. El botón «Desactivar» usa la misma función; no se pulsó en Chrome |
| 26 | Aislamiento entre cuentas y dispositivos | APROBADO | e2e (otra cuenta no puede quitar ni ver; varios dispositivos sin duplicar) y Chrome (Admin en el mismo navegador no recibe avisos de Bodega; cambio de cuenta sin logout elimina la suscripción anterior) |
| 27 | Suscripción inválida eliminada | APROBADO | FCM real rechazó una suscripción vieja y el servidor la borró; e2e con 404/410 |
| 28 | Clic en notificación: vista permitida, sin URLs arbitrarias, sin interrumpir trabajo | APROBADO (simulado) / NO EJECUTADO (clic real) | Evento `notificationclick` sintético: Tareas sin trabajo; con lectura en curso ofrece «Abrir ahora»; destino falsificado → Inicio |
| 29 | Push en Android con pantalla bloqueada | NO EJECUTADO | Sin dispositivo |
| 30 | Publicación con HTTPS y cabeceras | NO EJECUTADO | Configuración preparada en `docs/deploy/`, no aplicada a ningún servidor |
