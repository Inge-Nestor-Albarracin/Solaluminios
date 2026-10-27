# Solaluminios: origen, compras, ventas y despachos con RFID

Rama `feat/sales-dispatch-origin`, sin commit, push ni despliegue. Mismo
monorepo: `apps/api` (NestJS 12 + Prisma 7.8 + PostgreSQL) y `apps/web`
(React 19 + Vite 8 + PWA). No hay microservicios ni broker: la cola de avisos
vive en PostgreSQL. No se cambió el login (sigue siendo por correo), ni
Product/SKU/longitudes, ni la integración Chafon de la pistola.

Fecha: 26/10/2026. **La migración nueva solo está aplicada en la base de
pruebas**; la base de desarrollo y el VPS no se tocaron.

## 1. Qué se construyó

| Área | Resumen |
| --- | --- |
| Proveedores y origen | `Supplier` con orígenes admitidos (China / Nacional). Un proveedor fijo de China configurable (`Setting`). Ingreso nacional exige proveedor activo y admitido. |
| Lotes (`StockLot`) | Fuente única de procedencia y costo de cada paquete: envío China (`CHINA_SHIPMENT`), ingreso nacional (`MANUAL_ENTRY`) o apertura de stock histórico (`OPENING`). Origen/proveedor de un lote no se pueden cambiar (trigger). Un paquete y su lote deben coincidir en referencia/acabado (trigger). |
| China | Rol `CHINA_OPERATOR` con interfaz en inglés y solo prerregistro (EPC, referencia, acabado, cantidad). Proveedor y origen los pone el servidor; el envío abierto lo define ADMIN. No crea stock en Colombia. |
| Recepción | Bodega lee el chip prerregistrado y confirma la cantidad recibida; diferencia ⇒ motivo obligatorio y auditoría. Una sola recepción por EPC, también contra el alta manual simultánea (bloqueo por EPC). |
| Stock histórico | Paquetes previos quedan «sin procedencia»; no se venden como China ni Nacional hasta que ADMIN los clasifica con un lote de apertura y evidencia. |
| Compras y costos | Documento con descuentos de renglón y general (asignado por resto mayor, exacto al centavo), IVA explícito (descontable o al costo), gastos atribuibles, moneda y tasa. Confirmar fija importes y el costo por perfil de los lotes (6 decimales). Nada se inventa: lo que falta bloquea la confirmación y se lista. |
| Precios | Recargo sobre costo `costo × (1 + p)` o margen bruto `costo ÷ (1 − p)`; precio manual con motivo auditado. Costo 9.700 al 30 % → 12.610,00 / 13.857,14. |
| Cotizaciones | Guardan una copia de las condiciones (costo base, lote, método, etiquetas): cambios posteriores de costo no las alteran. **No reservan ni descuentan.** |
| Órdenes | Conversión idempotente (una orden por cotización). Confirmar reserva todo o nada en la ubicación elegida; si falta, queda «pendiente de abastecimiento» con el faltante visible. FIFO por lote. |
| Despachos | Autorizan cantidades por renglón (parcial solo si se autoriza explícitamente), crean una tarea `DISPATCH` para un trabajador de bodega de esa ubicación y el aviso. La pistola valida cada EPC en el servidor; incompatibles ⇒ incidencia + alerta. «Confirmar salida física» registra en una sola transacción movimientos, reservas consumidas, cantidad entregada, tarea completada, estado de la orden y avisos. |
| Avisos | Outbox persistente (`NotificationOutbox`) escrita en la misma transacción del negocio; un worker en el API envía Web Push con reintentos y deduplicación. Un fallo del push no deshace nada. |
| Fase 2 | Lectores fijos/portal: autenticación del dispositivo, sesión ligada a un despacho, deduplicación de eventos, solo **monitoreo** (nunca prepara ni descuenta). Simulador etiquetado con el mismo contrato. |

## 2. Archivos

**Migración nueva:** `apps/api/prisma/migrations/20261027120000_sales_dispatch_origin/`
(no modifica migraciones aplicadas). Crea enums, tablas nuevas, columnas
`bundles.lotId`, `inventory_movements.dispatchId`, `tasks.kind/dispatchId/cancelledAt`,
secuencias de numeración (`COT-`, `OV-`, `DES-`, `LOT-`), CHECKs, índices
únicos parciales y triggers:

- `bundle_lot_matches`, `stock_lot_identity_immutable`;
- reservas activas ≤ cantidad del paquete (diferido);
- entregas ≤ pedido por renglón (diferido);
- `tasks_completed_before_due` redefinida para exceptuar despachos.

No borra ni reescribe datos: los paquetes existentes quedan con `lotId` nulo
(«sin procedencia»).

**API (`apps/api/src`)**

| Ruta | Contenido |
| --- | --- |
| `shared/money.ts`, `shared/db.ts` | Decimal, redondeo, asignación por resto mayor; bloqueos, numeración, auditoría. |
| `modules/supply/` | Proveedores, ajustes, lotes, prerregistro China, recepción, compras y costeo (`costing.ts` + `costing.spec.ts`). |
| `modules/sales/` | Clientes, precios (`pricing.ts`), cotizaciones, órdenes, reservas y disponibilidad por procedencia. |
| `modules/dispatch/` | Despachos, validación de EPC (`validation.ts`), cancelación, incidencias. |
| `modules/notifications/` | Outbox (`enqueue`, worker, `GET /notifications/outbox`). |
| `modules/readers/readers.ts` | Lectores fijos, sesiones, `POST /reader/observations`, `GET /dispatches/:id/readers`. |
| Cambios | `auth/roles.guard.ts` (CHINA_OPERATOR denegado salvo rutas explícitas), `inventory/*` (origen/proveedor en el alta, bloqueo por EPC, reservas respetadas en salida/traslado/ajuste, filtro «sin procedencia»), `tasks/tasks.service.ts` (tareas de despacho), `users/*` (`PATCH /users/:id/location`), `locations/*`, `push/push.service.ts`, `app.module.ts`. |
| `scripts/reader-simulator.mjs` | SIMULADOR del portal. |
| `test/sales-dispatch*.e2e-spec.ts`, `test/support/e2e.ts` | Escenarios y carreras ×20. |

**Web (`apps/web/src`)**

- Vistas nuevas: `ChinaView` (inglés), `ReceiveView`, `SalesView`,
  `QuoteView`, `OrderView`, `DispatchesView`, `DispatchView`.
- Componentes nuevos: `components/FixedReaderPanel.tsx` y en
  `components/admin/`: `SuppliersAdmin`, `LotsAdmin`, `PurchasesAdmin`,
  `ReadersAdmin`.
- `lib/commerce.ts` (tipos, etiquetas, formato de dinero y costo unitario).
- Cambios:
  - `App.tsx`: espacio de trabajo China y pestañas Ventas / Despachos /
    Recepción China.
  - `RegisterBundleView.tsx` y la cola: origen y proveedor nacional.
  - `TaskCard` y `TasksView`: «Abrir despacho» y estado «Atrasada».
  - `UsersAdmin`: bodega del usuario.
  - `navigation.ts`, `launchView.ts`, `sw/sw.ts`: vistas y tipos de aviso
    nuevos.
  - `App.css`.

## 3. Instalación y prueba local

```powershell
# Desde la raíz
pnpm install
# API
cd apps/api
pnpm exec prisma generate
pnpm build
pnpm lint
pnpm test                 # unitarias (costeo, precios, etc.)
pnpm test:db:setup        # solo si aún no existe la base *_test
pnpm test:e2e             # PostgreSQL real, base de pruebas (aplica migraciones allí)
# Web
cd ../web
pnpm lint
pnpm build
pnpm test                 # protocolo Chafon
```

Para aplicar la migración en **la base de desarrollo local**, cuando decidas
hacerlo (no se hizo en esta tarea):

```powershell
cd apps/api
pnpm exec prisma migrate status   # lectura
pnpm exec prisma migrate deploy   # aplica solo las pendientes; nunca reset ni db push
```

Prueba manual contra la base de pruebas (lo usado en esta verificación):

1. Arranca `api-test-pwa` de `.claude/launch.json` (puerto 3101,
   `READER_CAPTURE_ENABLED=true`).
2. Compila la web con `VITE_API_URL=http://localhost:3101 pnpm build`.
3. Sírvela con `vite preview` en el puerto 4173.

## 4. Variables (sin secretos)

| Variable | Dónde | Uso |
| --- | --- | --- |
| `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN`, `PORT` | API | Sin cambios. |
| `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | API | Web Push (opcional). Sin ellas los avisos quedan `SKIPPED` y el negocio sigue igual. |
| `OUTBOX_WORKER` | API | `off` apaga el worker en esa instancia (si hubiera varias réplicas). Con `NODE_ENV=test` nunca arranca. |
| `READER_CAPTURE_ENABLED` | API | `true` habilita `POST /reader/observations`; si no, 503. Apagado por defecto. |
| `READER_SECRET` | Solo en la consola del simulador/adaptador | Secreto del lector; nunca como argumento ni en el navegador. |
| `VITE_API_URL` | Web (build) | URL del API. |

Están documentadas en `apps/api/.env.example`, sin valores.

## 5. Roles y permisos

El backend aplica todo. La interfaz solo oculta lo que el rol no puede usar.

| Recurso | ADMIN | SALES | WAREHOUSE | CHINA_OPERATOR |
| --- | --- | --- | --- | --- |
| Proveedores: ver | ✔ | ✔ | ✔ (alta nacional) | ✘ |
| Proveedores, ajustes, envíos China, lotes, compras/costos, lectores: gestionar | ✔ | ✘ | ✘ | ✘ |
| Precios de venta por compra (`/sale-prices`: costo, ganancia, habilitar) | ✔ | ✘ | ✘ | ✘ |
| Precio de venta habilitado (`/sales/price`, solo el precio) | ✔ | ✔ | ✘ | ✘ |
| Proveedor fijo de China (`/suppliers/china`, solo el nombre) | ✔ | ✔ | ✔ | ✘ |
| Prerregistro China | ver | ✘ | ✘ | ✔ crear y ver **solo los propios** |
| Contexto/catálogo China | ✔ | ✘ | ✘ | ✔ (sin costos ni stock) |
| Recepción en Colombia | ✔ | ✘ | ✔ | ✘ |
| Clientes, cotizaciones, órdenes (crear, confirmar, cancelar) | ✔ todas | ✔ **solo las propias** | ✘ | ✘ |
| Disponibilidad por procedencia | ✔ | ✔ | ✔ | ✘ |
| Crear despacho, cancelar, reasignar | ✔ | ✔ (de sus órdenes) | ✘ | ✘ |
| Ver despachos | ✔ | ✔ (de sus órdenes, sin costos) | ✔ (asignados o de su bodega) | ✘ |
| Leer/preparar/confirmar salida, resolver incidencias | ✔ | ✘ | ✔ (asignado o su bodega) | ✘ |
| Sesión de lector fijo (abrir/cerrar) | ✔ | ✘ | ✔ (lectores de su bodega) | ✘ |
| `POST /reader/observations` | — | — | — | — (credencial del **dispositivo**, no de usuario) |
| Estado de la outbox | ✔ | ✘ | ✘ | ✘ |
| Resto de la app (inventario, tareas, etc.) | sin cambios | sin cambios | sin cambios | ✘ (denegado salvo rutas marcadas) |

- El responsable de cada operación sale de la sesión.
- Un recurso ajeno responde 404, para no revelar su existencia.

## 6. Guía: proveedores reales y proveedor fijo de China

No se crearon proveedores reales. Los de prueba solo existieron en la base
`*_test` y se eliminaron.

1. **Administración → Proveedores → Crear proveedor**:
   - código, nombre, NIT (opcional);
   - orígenes admitidos: Nacional, China o ambos.

   Desactivar no borra el historial.
2. Crea el proveedor de China y luego, en la misma pantalla, elige:
   - **Proveedor fijo de China**: solo activo y con origen China;
   - **Supervisor de despachos** (opcional): recibe las alertas de
     incidencias. No hace falta para registrar ni despachar.
3. **Envíos de China**: se abren solos con el primer prerregistro
   (código `AUTO-AAAAMMDD`); el operador nunca crea ni escribe uno.
   Opcionalmente, administración puede cerrar el abierto o abrir uno con un
   código propio. Cambiar el proveedor fijo cierra el envío abierto del
   anterior (sus paquetes prerregistrados se pueden seguir recibiendo).
4. **Usuarios**:
   - crea al operador con rol «Operador China»; su interfaz es en inglés y
     solo prerregistra;
   - asigna a cada usuario de bodega su **Bodega / almacén**. Sin bodega no
     aparece como responsable elegible de despachos.
5. **Lotes y procedencia** → clasifica el stock histórico con evidencia
   (inventario físico, documento, declaración):
   - con origen Nacional o China;
   - con el proveedor solo si está documentado.
6. **Compras y costos**: por renglón, referencia, acabado, origen, cantidad
   de perfiles, **valor bruto de compra con IVA incluido** y descuento (%).
   Costo por perfil = (valor bruto − descuento) ÷ perfiles; el IVA de compra
   no se suma ni se separa. Asociar lotes es opcional. Confirma la compra.
7. **Precios de venta**: elige la compra confirmada y su renglón, escribe la
   ganancia sobre el costo y habilítalo. Cada precio queda ligado a su línea
   de compra; ventas recibe solo el precio habilitado de cada referencia,
   acabado y origen. Detalle: `docs/refinamiento-registro-precios.md`.

## 7. Guía: cotización → orden → despacho → tarea → salida

1. **Ventas → Nueva cotización**:
   - cliente;
   - por renglón: referencia, acabado, **origen requerido** y perfiles;
   - el precio de venta habilitado aparece solo; el IVA de venta viene en
     19 % y es editable; subtotal sin IVA, IVA y total se recalculan al
     escribir.

   Ventas no elige compras, costos, lotes ni porcentajes: la API rechaza
   esos campos y quita costos y ganancias de las respuestas. La línea guarda
   el precio usado (`salePriceId`) con sus importes. Guardar no reserva.
2. **Convertir en orden de venta** (una sola vez aunque se repita).
3. **Confirmar orden** eligiendo sucursal y bodega:
   - reserva todo o nada;
   - si falta material, la orden queda «Pendiente de abastecimiento» con el
     faltante.
4. **Crear despacho**:
   - cantidades por renglón; parcial solo con «Autorizar entrega parcial»;
   - responsable de bodega de esa ubicación y fecha límite.

   Se crea la tarea y el aviso.
5. **Bodega → Tareas → Abrir despacho**:
   - lee con la pistola (BLE o modo teclado) o escribe el chip;
   - los sugeridos muestran pasillo/burro;
   - un paquete compatible se prepara con la cantidad sugerida, ajustable;
   - una lectura repetida no suma.
   - Un paquete incompatible abre una incidencia con sonido y vibración y
     avisa al responsable y al supervisor. Por ejemplo: «No coincide: este
     despacho requiere 20 perfiles nacionales de referencia 17.39…, negro
     perla. El paquete leído es de origen China.»
6. **Resolver** cada incidencia con una nota. **Revisar y confirmar salida** →
   «Confirmar salida física»:
   - descuenta inventario y consume reservas;
   - completa la tarea, actualiza la orden (Entregada / parcialmente
     entregada) y avisa a ventas.
   - Si se pierde la respuesta, la pantalla lo dice y el reintento usa la
     misma clave: no descuenta dos veces.
7. **Atrasos y cancelaciones**:
   - una tarea de despacho vencida sigue pendiente («Atrasada»); no libera
     reservas ni se completa sola;
   - cancelar el despacho devuelve sus reservas a la orden si estaba
     reservada por completo; si era una autorización parcial, las libera;
   - en ambos casos cierra sus incidencias y la sesión de lector, y cancela
     la tarea;
   - cancelar la orden libera las reservas pendientes;
   - las salidas confirmadas nunca se deshacen.

## 8. Fase 2: contrato del lector fijo y simulador

**Contrato**: `POST /reader/observations`.

- Cabeceras: `X-Reader-Id: <código>` y `Authorization: Reader <secreto>`.
- Cuerpo:

  ```json
  { "sessionId": "<opcional>", "events": [ { "eventId": "<único por lector>", "epc": "E280…", "observedAt": "<ISO-8601>", "antenna": 1, "rssi": -55 } ] }
  ```

- Máximo 500 eventos por lote. Se rechazan los eventos con más de 5 min en el
  futuro.
- `eventId` repetido ⇒ duplicado ignorado, así que reenviar es seguro.
- Sin `sessionId` se usa la sesión abierta del lector (como máximo una).

Respuesta:

```json
{ "mode": "MONITOR", "simulator": true, "sessionId": "…", "dispatch": "DES-…", "accepted": 0, "duplicates": 0, "rejected": 0, "results": [ { "epc": "…", "detections": 0, "result": "MATCH|INCIDENT|…", "message": "…" } ] }
```

Reglas:

- Las observaciones pasan por la misma validación que la pistola, pero solo
  registran detecciones agrupadas e incidencias (una por EPC y tipo, con
  contador).
- Nunca preparan, reservan ni mueven stock: la salida la confirma una persona.
- No se infiere dirección de paso ni salida autónoma.

**Configuración**:

1. ADMIN → Lectores fijos → registrar (código, nombre, sucursal/ubicación;
   marcar «simulador» si lo es). El secreto se muestra una sola vez y solo se
   guarda su hash.
2. En el despacho, bodega abre la sesión en el panel «Lector fijo / portal
   (monitoreo)».
3. El adaptador del lector (PC/gateway, no un navegador) envía las
   observaciones.

**Simulador** (desde `apps/api`; el secreto va por variable):

```powershell
$env:READER_SECRET = '<secreto mostrado al registrar el lector>'
node scripts/reader-simulator.mjs --api http://localhost:3000 --reader SIM-01 --epcs E2801170...,E2801170... --repeat 20 --batch 25 --resend
Remove-Item Env:READER_SECRET
```

El simulador prueba reglas, incidencias, deduplicación y autenticación. **No**
prueba cobertura, dirección, interferencias ni lectura real de radio.

## 9. Publicación (pendiente, no aplicado)

1. Respaldo de la base de producción.
2. Despliegue del código.
3. `pnpm exec prisma migrate deploy` en `apps/api`, sin reset ni db push.
4. Revisar que los paquetes existentes queden «sin procedencia».
5. En el entorno del API: `READER_CAPTURE_ENABLED` solo cuando haya un lector
   real que integrar (por defecto apagado), VAPID si se usarán avisos, y
   `OUTBOX_WORKER=off` en réplicas adicionales si las hubiera.
6. Con la aplicación publicada (ADMIN):
   - proveedores reales;
   - proveedor fijo de China y supervisor;
   - primer envío abierto;
   - bodega de cada usuario de bodega;
   - usuario(s) operador China.
7. Clasificar el stock histórico con evidencia y registrar las compras reales
   para tener costos.
8. Prueba física:
   - pistola en un despacho real (BLE y modo teclado);
   - Android con HTTPS para los avisos;
   - el portal, cuando exista hardware.

## 10. Escenarios de aceptación

Evidencia automática:

- `test/sales-dispatch.e2e-spec.ts` (`SD`): 23 pruebas, PostgreSQL real, base
  `*_test`;
- `test/sales-dispatch-concurrency.e2e-spec.ts` (`SDC`): 3 carreras × 20
  rondas;
- `src/modules/supply/costing.spec.ts` (`UNIT`).

Se marca «Navegador» lo recorrido en la interfaz el 26/10/2026 contra la base
de pruebas (API 3101 + `vite preview`).

| # | Escenario | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Operador China prerregistra | APROBADO | SD #1; Navegador: 2 prerregistros, duplicado rechazado, sin stock creado. |
| 2 | Operador China intenta cambiar proveedor/origen o ver costos | APROBADO | SD #2 (400/403, sin escrituras; GET ajenos denegados por RolesGuard). |
| 3 | Nacional sin proveedor o no permitido | APROBADO | SD #3 (sin paquete ni movimiento). |
| 4 | Misma referencia/acabado China y Nacional, varios proveedores | APROBADO | SD #4; Navegador: disponibilidad separada «Disponible Nacional: 30» / «China: 24». |
| 5 | Recepción simultánea / carrera con alta manual | APROBADO | SD #5 ×2 (20 rondas cada una). |
| 6 | Discrepancia de cantidad | APROBADO | SD #5 #6; Navegador: 24 de 25 con motivo, re-recepción bloqueada. |
| 7 | 1.000.000 COP con 3 % | APROBADO | UNIT + SD #7 (30.000 exactos, neto 970.000). Navegador: compra con descuento de renglón 5 %, general 2 %, IVA 19 % y flete, cuadrada a mano. |
| 8 | Recargo vs margen sobre 9.700 | APROBADO | UNIT + SD #8 (12.610,00 / 13.857,14). |
| 9 | Cambio de costo tras cotizar | APROBADO | SD #9 #10. |
| 10 | Doble conversión | APROBADO | SD #9 #10 + SDC (20 rondas). |
| 11 | Dos órdenes por el mismo saldo | APROBADO | SD #11 + SDC (20 rondas). |
| 12 | Stock insuficiente | APROBADO | SD #12 #13 (pendiente de abastecimiento, sin reservas ni tarea). |
| 13 | Despacho parcial autorizado | APROBADO | SD #12 #13. |
| 14 | Exige Nacional y se lee China | APROBADO | SD #14; Navegador: mensaje exacto, incidencia + aviso en outbox. |
| 15 | Nacional sin restringir proveedor | APROBADO | SD #15 #16. |
| 16 | Proveedor concreto exigido | APROBADO | SD #15 #16. |
| 17 | Mismo EPC leído muchas veces | APROBADO | SD #14 #17; Navegador: «la lectura repetida no suma de nuevo». |
| 18 | Salida parcial de un paquete | APROBADO | SD #18; Navegador: 30 → 10 y 24 → 14 con lote/origen conservados. |
| 19 | Completar tarea de despacho por ruta genérica | APROBADO | SD #19 (409). |
| 20 | Tarea vencida con despacho pendiente | APROBADO | SD #20. |
| 21 | Dos confirmaciones / respuesta perdida | APROBADO | SD #21 #32 + SDC (20 rondas). |
| 22 | Fallo entre saldo, reserva y tarea | APROBADO | SD #22 (fallo inyectado ⇒ rollback total). |
| 23 | Cancelar orden o despacho | APROBADO | SD #23 (también cierra incidencias); Navegador: despacho cancelado conserva la reserva en la orden, tarea cancelada, sesión de lector cerrada. |
| 24 | Salida/traslado/ajuste sobre reservado | APROBADO | SD #24. |
| 25 | Lector sin sesión, no autorizado, EPC desconocido | APROBADO | SD #25 #26 (503 / 401 / 409; sin movimientos). |
| 26 | Incidencia repetida por lecturas continuas | APROBADO | SD #25 #26; simulador: 20 detecciones ⇒ 1 incidencia, reenvío = 25 duplicados. |
| 27 | Falla el push tras el commit | APROBADO | SD #27 #28 (sustituto de push; sin servicio real). |
| 28 | Worker reinicia con avisos pendientes | APROBADO | SD #27 #28 (lease vencido recuperado). |
| 29 | Despacho u orden ajenos | APROBADO | SD #11 #29 + `authorization-idor.e2e-spec.ts` sin regresiones; `GET /dispatches/:id/readers` de otra bodega ⇒ 404. |
| 30 | Stock histórico sin origen | APROBADO | SD #30 + SD #14 #17 #18 #30. |
| 31 | Actualización PWA durante preparación/formulario | APROBADO (manual) | Navegador: con una cantidad sin aplicar, otra ventana recibe «Cantidades de despacho sin aplicar» por `BroadcastChannel`; la actualización sin trabajo pendiente pide confirmación y avisa del nuevo inicio de sesión. No automatizado. |
| 32 | Pérdida de red durante confirmación | APROBADO (API) | SD #21 #32 (misma clave ⇒ una salida). La pantalla de resultado incierto está implementada pero no se cortó la red en el navegador en esta tarea. |
| — | Pistola física en un despacho | NO EJECUTADO | Sin equipo en esta sesión; se usó modo teclado/manual. |
| — | Portal / lector fijo físico | NO EJECUTADO | No hay hardware; solo simulador. |
| — | Push real en Android con HTTPS | NO EJECUTADO | Avisos verificados en la outbox (`SKIPPED`: usuarios de prueba sin dispositivos). |

Resultados de esta entrega:

- API: build OK, lint OK, unitarias 26/26, e2e 139/139 (17 archivos, incluye
  todas las suites previas);
- web: `tsc` OK, lint OK, build OK (precache 24 entradas, ~658 KiB, solo
  estáticos), protocolo Chafon 7/7.

## 11. Limitaciones y pendientes

- **Base de desarrollo sin migrar** (`solaluminios_dev`): falta
  `prisma migrate deploy`. Hoy tiene 18 paquetes que quedarán «sin
  procedencia» hasta clasificarlos.
- **Catálogo real**: solo hay referencias de prueba. 17.30 y 17.39 se usaron
  únicamente como datos de pruebas automáticas, no en el catálogo de
  desarrollo.
- **Acabado NP**: en el catálogo existente NP es «Negro pintura», mientras el
  requerimiento habla de «negro perla». Hay que confirmarlo con el negocio
  antes de cargar referencias.
- **Contabilidad**:
  - el descuento condicionado se registra como nota y no reduce el costo
    hasta que exista una política contable;
  - no hay valorización promedio: el costo es el del lote.
- **Lector fijo**:
  - solo monitoreo; dirección de paso y salidas autónomas quedan fuera de
    alcance hasta validarlas con hardware;
  - el adaptador del lector real está por escribir según el contrato de la
    sección 8.
- **Avisos**: el worker usa sondeo dentro del API. Con varias réplicas,
  `FOR UPDATE SKIP LOCKED` evita dobles envíos, pero conviene dejar una sola
  activa.
- **Sin probar en esta tarea**: corte de red real en el navegador durante la
  confirmación, pistola BLE física en un despacho y Android con HTTPS.
