# Estado de desarrollo

## Adaptación del login (14/10/2026)

- Petición actual: adaptar `Login page diseño sobrio.zip` al acceso existente;
  sin recuperación de contraseña, con otra tipografía y un botón propio.
  El bloque de cotizador descrito en `next-task.md` no forma parte de esta tarea.
- Inspección: Git está disponible. Se preservaron los cambios previos de
  `apps/api/tsconfig.build.tsbuildinfo` y su ruta enlazada en node_modules.
  El ZIP es una maqueta con envío simulado y recordar sesión sin implementar;
  la aplicación usa `SessionProvider.login` y sesión en memoria. Se adaptó
  únicamente la presentación, conservando la autenticación real y sus avisos.
- Archivos: `apps/web/src/views/LoginView.tsx`, nuevo
  `apps/web/src/views/LoginView.css`, `apps/web/src/App.css` (retira estilos
  anteriores del login) y este documento.
- Diseño de dos paneles, marca Solaluminios y WeTracking de la referencia;
  títulos Georgia y texto Trebuchet MS con alternativas locales, sin descargas
  de fuentes ni dependencias nuevas. Botón sólido con flecha separada,
  mostrar/ocultar contraseña, etiquetas accesibles y estados de envío.
  Estilos limitados al login, con paleta clara explícita y movimiento reducido.
- Sin opción de contraseña olvidada ni recordar sesión. Se conserva el aviso
  de reingreso al recargar; la ayuda remite al administrador, sin enlaces vacíos
  de soporte, privacidad o términos de la maqueta.
- Validación: `pnpm.cmd --version` → 11.4.0;
  `pnpm.cmd --dir apps/web build` → OK;
  `pnpm.cmd --dir apps/web lint` → OK.
  Se usó `.cmd` porque PowerShell bloquea el wrapper `pnpm.ps1`.
- Navegador: el integrado falló al conectar (`missing field sandboxPolicy`).
  Revisión realizada con Chrome headless y perfil temporal: escritorio
  1440×1000, móvil 390×844, móvil pequeño 320×740 y tablet 768×1024.
  Sin desbordamiento horizontal en los tres tamaños adaptativos; capturas
  de escritorio, móvil y tablet inspeccionadas. Comprobados campos obligatorios,
  mostrar/ocultar contraseña, `aria-pressed` y ausencia de recuperación/recordar.
  Evidencias y script provisional en `apps/web/login-review.local/` (ignorado).
- No se ejecutó login exitoso contra el API: no había servidor en el puerto
  3000 ni sesión disponible. Pendiente: ingresar con un usuario existente y
  comprobar llegada al inventario y errores de credenciales/servidor.
  No hubo cambios de API, BD, migraciones, credenciales o datos de prueba.

Fecha de traspaso: 13 de octubre de 2026.
Fuente: conversación con el desarrollador y resultados que él ejecutó en su
equipo. El proyecto local completo no fue inspeccionado desde ChatGPT.

## Evidencia confirmada

- PostgreSQL local conectado; GET /health/database devolvió status ok y
  database connected antes de autenticación; luego fue probado con token.
- Esquema inicial válido; dos migraciones iniciales sincronizadas. Después se
  generó y aplicó inventory_phase1; las tablas de inventario ya existen.
- Se verificaron cinco CHECK en pgAdmin:
  - bundles_arrival_date_consistent
  - bundles_epc_normalized
  - bundles_quantity_nonnegative
  - inventory_movements_balance_consistent
  - inventory_movements_quantities_valid
- products tenía 0 filas. Se dieron instrucciones para retirarlo mediante
  remove_unused_products; la eliminación final debe verificarse en local.
- Módulo locations agregado: creación y listas jerárquicas. Script ejecutado
  dos veces produjo dos árboles de prueba; el usuario confirmó limpieza de la
  prueba anterior desde pgAdmin, preservando la reciente.
- Usuarios y AuthModule incorporados al proyecto. Admin local creado.
- Test-Auth.ps1 ejecutado correctamente el 13/10/2026:
  `OK: login, protected endpoints, roles, safe responses, duplicate email, password validation and inactive user.`
- Segunda ejecución con contraseña deliberadamente incorrecta produjo 401
  Correo o contraseña incorrectos y se detuvo en el login. No fue una segunda
  ejecución completa de todas las pruebas.
- Existe al menos un usuario READ_ONLY de prueba inactivo. No borrar usuarios
  o volver a generar admin/secreto para iniciar la tarea del catálogo.

## API existente que debe preservarse

| Método | Ruta | Función |
| --- | --- | --- |
| POST | /auth/login | Login público con límite de frecuencia |
| GET | /auth/me | Usuario de sesión |
| GET/POST | /users | Administración de usuarios (ADMIN) |
| PATCH | /users/:id/active | Activar/desactivar por ADMIN |
| GET | /health/database | Conexión BD, actualmente protegida |
| GET/POST | /catalog/references | Referencias |
| GET/PATCH | /catalog/references/:id | Consulta/actualización |
| GET/POST | /catalog/finishes | Acabados |
| PATCH | /catalog/finishes/:id | Actualización |
| GET/POST | /catalog/families | Familias (13/10/2026) |
| PATCH | /catalog/families/:id | Nombre/estado de familia (13/10/2026) |
| POST | /inventory/bundles | Registrar paquete + movimiento inicial (ADMIN, WAREHOUSE) |
| GET | /inventory/bundles/epc/:epc | Consulta exacta por EPC |
| GET | /inventory/bundles/:id | Detalle de paquete |
| GET | /inventory/bundles | Listado paginado con filtros |
| GET | /inventory/summary | Resumen por referencia/acabado con ubicaciones |
| GET | /inventory/bundles/:id/movements | Historial paginado |
| POST | /inventory/bundles/:id/exit | Salida (ADMIN, WAREHOUSE) |
| POST | /inventory/bundles/:id/transfer | Traslado del paquete completo (ADMIN, WAREHOUSE) |
| POST | /inventory/bundles/:id/adjustments | Ajuste con motivo (ADMIN) |
| GET/POST | /locations/branches | Sucursales |
| GET | /locations/branches/:branchId/inventory-locations | Bodegas/almacenes |
| POST | /locations/inventory-locations | Crear bodega/almacén |
| GET | /locations/inventory-locations/:inventoryLocationId/aisles | Pasillos |
| POST | /locations/aisles | Crear pasillo |
| GET | /locations/aisles/:aisleId/racks | Burros |
| POST | /locations/racks | Crear burro |

Revisar controladores reales para confirmar nombres/contratos. Esta lista no
autoriza recrear archivos existentes ni sobrescribir cambios locales.

## Archivos/patrones esperados

- src/infrastructure/database/database.module.ts y prisma.service.ts.
- src/modules/catalog (DTO, controller, service, module).
- src/modules/locations (DTO, controller, service, module).
- src/modules/auth y src/modules/users.
- src/infrastructure/security/password.ts.
- src/scripts/create-admin.ts.
- scripts/Configure-Jwt.mjs, Create-Admin.ps1, Test-Auth.ps1 (en apps/api).
- Test-Locations.ps1 se entregó en la raíz; no manda token, por lo que ahora
  falla con 401 salvo que se adapte. Ese resultado no indica una regresión.

## Verificación local por Claude Code (13/10/2026)

- La carpeta no es un repositorio Git: no hay `git status` ni historial.
- pnpm 11.4.0 está declarado en `devEngines` de la raíz (no hay campo
  `packageManager`). Node v24.11.0. Prisma/client/adapter-pg 7.8.0.
- 4 migraciones: init_references, setup_catalog_and_locations,
  inventory_phase1, remove_unused_products. `prisma migrate status`:
  "Database schema is up to date" → la tabla products ya fue retirada.
- `test/app.e2e-spec.ts` (plantilla Nest) fallaba durante la tarea de familias:
  no cargaba `.env` (JWT_SECRET) y `GET /` ya requiere sesión. Corregido en la
  tarea de paquetes (ver abajo) sin hacer pública ninguna ruta.

## Tarea completada: familias y asociación de referencias (13/10/2026)

Sin migraciones ni cambios en schema.prisma; usa ProductFamily y
Reference.familyId existentes. Permisos: guards globales sin cambios
(GET autenticado; POST/PATCH solo ADMIN).

Endpoints:
- `GET /catalog/families[?active=true|false]`: sin `active` devuelve todas
  (igual que referencias/acabados); orden por code. Otro valor → 400.
- `POST /catalog/families` `{ code, name }`: code trim + mayúsculas, máx. 50,
  mismo patrón que referencias (`A-Z0-9 . _ / -`); name trim, no vacío, máx. 100.
  Duplicado → 409.
- `PATCH /catalog/families/:id` `{ name?, active? }`: code no editable; vacío → 400;
  inexistente → 404. Desactivar no toca referencias, paquetes ni historial.
- `POST /catalog/references` acepta `familyId` opcional (null/omitido = sin familia).
- `PATCH /catalog/references/:id` acepta `familyId`: omitido conserva, null
  desasocia, ID asocia/cambia. Ahora basta con enviar solo familyId.
- Asociación nueva a familia inexistente → 404; inactiva → 400. Reenviar la
  familia actual (aunque esté inactiva) no se considera asociación nueva.
- `GET /catalog/references?familyId=<id>`: filtra; familia inexistente → 404;
  valor vacío → 400. Sin filtro: misma respuesta que antes (array plano).
  Nota: al validar la query, parámetros desconocidos en GET /catalog/references
  ahora reciben 400 (forbidNonWhitelisted).

Archivos: `src/modules/catalog/catalog.controller.ts`, `catalog.service.ts`,
`dto/create-reference.dto.ts`, `dto/update-reference.dto.ts`,
`dto/family.dto.ts` (nuevo), `test/catalog-families.e2e-spec.ts` (nuevo).

Comandos y resultados (apps/api):
- `pnpm build` → OK. `pnpm lint` → OK (exit 0, sin avisos).
- `pnpm test` → 1/1 OK (spec existente).
- `pnpm exec vitest run --config ./vitest.config.e2e.ts test/catalog-families.e2e-spec.ts`
  → 7/7 OK contra la BD local: creación/consulta, 409, 400 (vacío, longitud,
  PATCH vacío, code en PATCH, query inválida), 404, familia inactiva 400,
  filtro incluye/excluye, PATCH omitido/null/ID, READ_ONLY lee y recibe 403,
  sin token 401, regresión de referencias sin filtro y acabados.

Datos de prueba: el e2e crea 2 usuarios temporales (ADMIN y READ_ONLY,
correo `e2e-*-<sufijo>@test.local`, contraseña aleatoria descartada), firma
sus tokens en proceso con el JwtService de la app (no se imprimen) y crea
familias/referencias `E2E-*-<sufijo>`. En afterAll los borra por ID exacto.
Comprobado tras la ejecución: 0 usuarios @test.local, 0 familias y 0
referencias con código `E2E-`. No se tocó el admin real ni JWT_SECRET.
La tabla product_families no tiene registros reales todavía (count = 0).

## Tarea completada: registro de paquetes y movimiento inicial (13/10/2026)

Sin migraciones ni cambios en schema.prisma; usa Bundle e InventoryMovement
de inventory_phase1 y sus CHECK SQL. Sin longitud, SKU, Product ni tablas RFID.

### Paso previo: e2e antiguo y configuración de pruebas
- `src/app.setup.ts` (nuevo): `configureApp()` aplica el ValidationPipe global;
  lo usan `main.ts` y las pruebas, así validan igual.
- `test/support/e2e.ts` (nuevo): carga `.env` (dotenv), crea la app y usuarios
  temporales `e2e-<rol>-<sufijo>@test.local` con contraseña aleatoria
  descartada; sus tokens se firman en proceso con el JwtService de la app y
  nunca se imprimen. No se usa el admin real ni se cambia JWT_SECRET.
- `test/app.e2e-spec.ts`: `GET /` sin sesión → 401; con sesión → 200.
  Ninguna ruta se hizo pública.
- `test/catalog-families.e2e-spec.ts` pasó a usar el helper (misma cobertura).
- Resultado antes de implementar inventario: build OK, lint OK, unit 1/1,
  e2e 9/9 (app 2 + familias 7).

### Endpoints
| Método | Ruta | Permiso |
| --- | --- | --- |
| POST | /inventory/bundles | ADMIN, WAREHOUSE (`@Roles`) |
| GET | /inventory/bundles/epc/:epc | Cualquier usuario autenticado |
| GET | /inventory/bundles/:id | Cualquier usuario autenticado |

Body de POST: `epc, referenceId, finishId, quantity, inventoryLocationId,
rackId, registrationType (INITIAL_STOCK|ENTRY), arrivalDatePrecision
(EXACT|MONTH|UNKNOWN), arrivalDate?, arrivalYear?, arrivalMonth?, notes?`.
Cualquier otro campo (p. ej. performedById, length) → 400.

Ejemplo:
```json
{ "epc": "e2003412ab01", "referenceId": "<id>", "finishId": "<id>",
  "quantity": 10, "inventoryLocationId": "<id>", "rackId": "<id>",
  "registrationType": "INITIAL_STOCK", "arrivalDatePrecision": "MONTH",
  "arrivalYear": 2024, "arrivalMonth": 3 }
```

Respuesta (POST 201 y ambos GET): el paquete con reference (+family),
finish, inventoryLocation (+branch), rack (+aisle) y movements (+performedBy
id/nombre/rol). La familia se obtiene de la referencia; no se guarda en Bundle.

### Reglas implementadas
- EPC: trim + mayúsculas; solo `A-Z0-9`, sin espacios internos ni guiones;
  máx. 128; sin longitud fija; se conservan ceros iniciales. El patrón
  alfanumérico es una decisión provisional: confirmar con el lector real.
- quantity: entero JSON ≥ 1 (máx. 1.000.000 como límite de sanidad); "10"
  como texto, 0, negativos o decimales → 400.
- Referencia/acabado: inexistente 404; inactivo 400.
- Ubicación: inexistente 404; ubicación o sucursal inactiva 400.
- Burro: obligatorio en este endpoint; inexistente 404; inactivo o pasillo
  inactivo 400; burro de otra ubicación 400.
- Llegada: EXACT exige solo `arrivalDate` AAAA-MM-DD válida; MONTH exige solo
  arrivalYear (1900–9999) y arrivalMonth (1–12); UNKNOWN no admite ninguno.
  Fechas/meses futuros → 400, comparando con el día actual en America/Bogota.
  Cualquier precisión vale para ambos tipos de registro (no se inventa día).
- EPC existente → 409 (verificación previa + índice único; en concurrencia la
  segunda transacción recibe P2002 y se traduce a 409).
- Transacción interactiva: validaciones, Bundle e InventoryMovement en la misma
  `$transaction`. Movimiento: tipo = registrationType, quantity = cantidad,
  quantityBefore 0, quantityAfter = cantidad, destino = ubicación y burro,
  origen null, performedById = usuario de la sesión, operationKey
  `bundle-registration:<uuid>` generado en backend.
- Fechas: Bundle guarda la llegada física (exacta/mes/desconocida);
  `movement.occurredAt` y `bundle.createdAt` son el momento del registro
  digital. Nunca se copia la llegada histórica a occurredAt.
- Consultar por EPC (normaliza trim/mayúsculas, coincidencia exacta) o por ID
  no crea ni modifica nada; inexistente → 404.

### Archivos
- Nuevos: `apps/api/src/app.setup.ts`, `src/modules/inventory/inventory.module.ts`,
  `inventory.controller.ts`, `inventory.service.ts`,
  `dto/register-bundle.dto.ts`, `test/support/e2e.ts`,
  `test/inventory-bundles.e2e-spec.ts`.
- Modificados: `src/main.ts` (usa configureApp, mismo comportamiento),
  `src/app.module.ts` (registra InventoryModule), `test/app.e2e-spec.ts`,
  `test/catalog-families.e2e-spec.ts`.

### Comandos y resultados (apps/api)
- `pnpm build` → OK. `pnpm lint` → OK (exit 0, sin avisos).
- `pnpm test` → 1/1 OK.
- `pnpm exec vitest run --config ./vitest.config.e2e.ts` → 3 archivos,
  17/17 OK (app 2, familias 7, paquetes 8) contra la BD local.
- Cobertura de paquetes: INITIAL_STOCK (WAREHOUSE, llegada MONTH, EPC con
  ceros iniciales/minúsculas/espacios) y ENTRY (ADMIN, llegada EXACT) y UNKNOWN;
  exactamente un movimiento con saldos, destino, operationKey y occurredAt de
  registro; responsable = sesión y performedById en body → 400; EPC duplicado
  (también con otra capitalización) → 409 sin segundo paquete/movimiento y sin
  cambiar cantidad; 3 solicitudes simultáneas → [201, 409, 409] y 1 paquete +
  1 movimiento; 26 casos de validación (cantidad, fechas, tipo, burro de otra
  ubicación, inactivos, inexistentes, campo `length`) sin registros; EPC
  vacío/espacios/guion → 400; sin token 401; READ_ONLY y SALES 403 en POST;
  fallo inyectado en la creación del movimiento → 500 y ni paquete ni
  movimiento, luego el mismo EPC se registra bien; consulta por EPC e ID
  (READ_ONLY/SALES), prefijo de EPC → 404, conteos globales sin cambios.
- Aviso observado: `DeprecationWarning: Calling client.query() when the client
  is already executing a query` del paquete `pg`, solo con `$transaction`
  interactivo de @prisma/adapter-pg 7.8.0. No es un fallo; no se actualizaron
  paquetes. Revisar cuando se planifique una actualización de Prisma.

### Datos de prueba y limpieza
Cada ejecución crea, con sufijo aleatorio: 4 usuarios (ADMIN, WAREHOUSE,
SALES, READ_ONLY @test.local), 1 familia, 2 referencias, 2 acabados,
1 sucursal, 2 ubicaciones, 2 pasillos, 3 burros, y paquetes con EPC
`E2E<sufijo>…`/`0000<sufijo>A1` más sus movimientos. afterAll borra
movimientos y paquetes por los EPC exactos usados y el resto por ID exacto.
Comprobado tras la ejecución: 0 registros de prueba restantes; la BD local
tiene 0 paquetes y 0 movimientos reales (no se tocó ningún dato real).

### Pendientes de esta área
- Confirmar con el lector UHF real el formato que entrega (hex, separadores).
- Confirmar si un registro sin burro (p. ej. almacén minorista) debe permitirse;
  hoy rackId es obligatorio en el endpoint aunque la columna admite null.
- Idempotencia por clave del cliente: resuelta en el bloque siguiente para
  salidas, traslados y ajustes.
- Roles autorizados a crear referencias desde bodega: sigue sin confirmar.

## Bloque completado: inventario fase 1 + frontend (13/10/2026)

Sin migraciones nuevas: el contrato de reintentos usa la columna única
`inventory_movements.operationKey` existente y los campos ya guardados en el
movimiento. Sin cambios en schema.prisma ni en migraciones aplicadas.

### Etapa 1 — estado al iniciar
- La carpeta ya es un repositorio Git (rama main, remoto origin en GitHub),
  árbol limpio salvo `tsconfig.build.tsbuildinfo` que cambia en cada build.
- build OK, lint OK, unit 1/1, e2e 17/17, `migrate status` al día. El e2e
  antiguo ya respetaba la autenticación (corregido en la tarea anterior).
- Observación de higiene (no modificada): no hay `.gitignore` en la raíz y
  el repositorio versiona `node_modules/` (~80.000 archivos), incluido
  `node_modules/.pnpm/node_modules/api` y `/web`, que son enlaces a `apps/api`
  y `apps/web` y aparecen duplicados en `git status`. `.env` NO está versionado
  y hoy queda ignorado también en la ruta enlazada. Recomendado: añadir
  `.gitignore` raíz con `node_modules/` y ejecutar
  `git rm -r --cached node_modules apps/api/node_modules apps/web/node_modules`
  en un commit aparte, decidido por el desarrollador.

### Etapa 2–3 — consultas
| Método | Ruta | Permiso |
| --- | --- | --- |
| GET | /inventory/bundles | Autenticado |
| GET | /inventory/summary | Autenticado |
| GET | /inventory/bundles/:id/movements | Autenticado |

- `GET /inventory/bundles`: filtros familyId, referenceId, finishId, branchId,
  inventoryLocationId, aisleId, rackId, `available=true|false`; `page` (≥1) y
  `pageSize` (1–100, por defecto 25). Orden estable createdAt desc, id desc.
  Respuesta `{ items, page, pageSize, total, totalPages }`; los items no
  incluyen movimientos. ID de filtro inexistente → 404; query inválida o
  parámetro desconocido → 400.
- `GET /inventory/summary`: agrupa por referencia + acabado con `groupBy`
  sobre bundles actuales con quantity > 0 (los agotados no suman perfiles ni
  paquetes). Cada grupo: perfiles, paquetes y `locations[]` por
  ubicación/pasillo/burro. Filtros familyId, referenceId, finishId, branchId,
  inventoryLocationId. Orden por código de referencia y de acabado; desglose
  por sucursal, bodega, pasillo y burro. Paginado por grupo; `totals` describe
  todo el resultado filtrado. No existe tabla de stock aparte.
- `GET /inventory/bundles/:id/movements`: historial paginado, más reciente
  primero (occurredAt, createdAt, id desc), con origen/destino legibles.
- Datos de usuario expuestos: solo id, nombre y rol (`performedBy`). Ninguna
  respuesta incluye email, passwordHash ni hashes (probado).

### Etapa 4 — operaciones
| Método | Ruta | Permiso | Body |
| --- | --- | --- | --- |
| POST | /inventory/bundles/:id/exit | ADMIN, WAREHOUSE | operationKey, quantity, reason? |
| POST | /inventory/bundles/:id/transfer | ADMIN, WAREHOUSE | operationKey, inventoryLocationId, rackId, reason? |
| POST | /inventory/bundles/:id/adjustments | ADMIN | operationKey, type (ADJUSTMENT_IN/OUT), quantity, reason |

No hay PATCH genérico de quantity/ubicación. Respuesta:
`{ replayed, movement, bundle }`; 201 si se aplicó, 200 si fue un reintento.

- Salida: entero 1..saldo; saldo insuficiente o agotado → 409. Movimiento EXIT
  con origen = ubicación/burro actual.
- Traslado: paquete completo; cantidad sin cambio (movimiento TRANSFER con
  quantity = before = after); destino activo (ubicación, sucursal, pasillo,
  burro) y burro perteneciente a la ubicación → si no, 400/404; mismo burro de
  la misma ubicación → 400; paquete agotado → 409. Se permite cambiar de burro
  dentro de la misma bodega.
- Ajuste: solo ADMIN; motivo obligatorio (no vacío tras trim); OUT nunca deja
  saldo negativo (409). WAREHOUSE → 403.
- Concurrencia: cada operación es una transacción interactiva que primero
  ejecuta `SELECT id FROM bundles WHERE id = $1 FOR UPDATE`. PostgreSQL
  serializa las operaciones del mismo paquete; el saldo se lee después de
  obtener el bloqueo (READ COMMITTED ve el último valor confirmado). Los CHECK
  de saldos siguen como última defensa. Probado: 8 salidas simultáneas de 3
  sobre 10 perfiles → 3 aplicadas, 5 rechazadas (409), saldo final 1, saldos
  encadenados 10→7→4→1.
- Contrato de reintentos (`operationKey`): UUID generado por el cliente, uno
  por operación intencionada; se normaliza a minúsculas.
  - Misma clave + mismo paquete + mismo usuario + datos equivalentes (tipo,
    cantidad, motivo; en traslado, destino) → 200 `replayed: true` con el
    movimiento original; no cambia el stock.
  - Misma clave con otros datos, otra operación, otro paquete u otro usuario
    → 409 "La clave de operación ya se usó con otros datos".
  - La clave se consulta tras el bloqueo; duplicados simultáneos sobre otro
    paquete los detiene el índice único (P2002) y se resuelven igual.
  - Si la operación falla (4xx/5xx) no se consume la clave: no queda
    movimiento. El frontend conserva la clave ante errores de red/5xx para que
    el reintento sea seguro, y la descarta si cambian los datos.
  - Las claves de registro de paquetes usan el prefijo `bundle-registration:`
    y no pueden colisionar con UUIDs de cliente.

### Etapa 5 — frontend (apps/web)
Sin dependencias nuevas (React 19 + Vite 8 de la plantilla). Navegación por
estado, sin router.
- Login con `/auth/login`; usuario y rol en cabecera; cierre de sesión local.
- Token solo en memoria (contexto React): recargar la página pide login de
  nuevo. Se cierra la sesión al vencer `expires_in` o ante cualquier 401
  (usuario desactivado, token inválido) con aviso en español.
- `VITE_API_URL` (por defecto http://localhost:3000); `apps/web/.env.example`
  sin secretos. Vite fijo en puerto 5173 (`strictPort`).
- CORS en el API (`configureApp`): solo orígenes de `CORS_ORIGIN` (por defecto
  http://localhost:5173), métodos GET/POST/PATCH, cabeceras Authorization y
  Content-Type, sin cookies. Probado: origen permitido recibe la cabecera,
  otro origen no.
- Vistas: Registrar paquete (ADMIN/WAREHOUSE), Consultar EPC, Paquetes
  (filtros + paginación), Resumen (familia, sucursal, bodega + desglose),
  Detalle (datos, historial paginado y operaciones según rol).
- Registro: tipo inventario existente/entrada nueva; familia filtra
  referencias; referencia y acabado por separado; perfiles enteros; llegada
  exacta/mes-año/desconocida (botón "Hoy", sin fecha inventada); selectores
  dependientes sucursal → bodega → pasillo → burro que limpian los niveles
  inferiores; EPC como texto en mayúsculas conservando ceros; tras guardar se
  limpian EPC/cantidad/notas y se conservan producto y ubicación.
- Operaciones con paso de confirmación visible (saldo antes → después,
  destino legible); botones deshabilitados mientras se procesa; acciones
  ocultas si el rol no las permite (el API sigue autorizando).
- Nota: los mensajes de validación por defecto de class-validator (p. ej.
  "must not be greater than") pueden llegar en inglés; el frontend valida
  antes los casos comunes en español.

### Archivos de este bloque
API (`apps/api`):
- Nuevos: `src/modules/inventory/inventory.shared.ts`,
  `inventory-queries.service.ts`, `inventory-operations.service.ts`,
  `dto/inventory-query.dto.ts`, `dto/bundle-operation.dto.ts`,
  `test/inventory-queries.e2e-spec.ts`, `test/inventory-operations.e2e-spec.ts`,
  `test/support/inventory-fixtures.ts`, `.env.example`.
- Modificados: `src/app.setup.ts` (CORS), `inventory.controller.ts`,
  `inventory.module.ts`, `inventory.service.ts` (usa inventory.shared),
  `test/inventory-bundles.e2e-spec.ts` (conteos acotados a su corrida para
  poder ejecutarse en paralelo con otros archivos).
Web (`apps/web`):
- Nuevos: `.env.example`, `src/vite-env.d.ts`, `src/api/{client,types}.ts`,
  `src/session/{session-context.ts,SessionProvider.tsx}`,
  `src/lib/{useLoad,format,forms}.ts`,
  `src/components/{ui,CatalogSelectors,LocationSelectors,ArrivalFields,OperationsPanel}.tsx`,
  `src/views/{navigation.ts,LoginView,RegisterBundleView,LookupView,BundlesView,SummaryView,BundleDetailView}.tsx`.
- Reemplazados: `src/App.tsx`, `src/App.css`, `src/index.css`, `src/main.tsx`,
  `index.html` (lang es, título), `vite.config.ts` (puerto fijo).
Raíz: `.claude/launch.json` (arranque de api y web para el panel de vista previa).

### Comandos y resultados
- apps/api: `pnpm build` OK; `pnpm lint` OK (0 avisos); `pnpm test` 1/1;
  `pnpm exec vitest run --config ./vitest.config.e2e.ts` → 5 archivos, 31/31
  (app 2, familias 7, paquetes 8, consultas 6, operaciones 8). Las pruebas de
  concurrencia y reintentos se repitieron 3 veces más: 3/3 OK.
- apps/web: `pnpm build` OK (tsc + vite); `pnpm lint` OK (0 avisos).
- `prisma migrate status`: "Database schema is up to date".
- Aviso conocido: `DeprecationWarning` de `pg` con `$transaction` interactivo
  (adapter-pg 7.8.0); no es un fallo.

### Verificación real en navegador (panel integrado, API + Vite locales)
Con usuarios y datos temporales `E2E-UI-*` creados por un script provisional:
- WAREHOUSE: login → registro INITIAL_STOCK (mes/año, EPC con ceros iniciales
  escrito en minúsculas → guardado en mayúsculas) → mismo EPC otra vez →
  "Ya existe un paquete con ese EPC" → consulta por EPC → detalle → salida de 4
  con confirmación (10 → 6) → historial actualizado → traslado (mismo burro
  bloqueado con aviso; burro 8 confirmado, total sin cambio) → listado y
  resumen con desglose.
- READ_ONLY: sin pestaña de registro; detalle sin formularios; EPC inexistente
  sin enlace de registro. Al desactivar el usuario en BD, la siguiente
  solicitud devolvió al login con "Tu sesión venció o ya no está habilitada".
- ADMIN: pestaña Ajuste visible; sin motivo el botón queda deshabilitado;
  ajuste +2 confirmado (6 → 8).
- Diseño revisado en 768×1024 (tablet). Consola: solo los 409/404/401
  provocados a propósito.
- No probado en navegador: vencimiento real de una hora del token (cubierto
  por temporizador en código), modo oscuro, lector Bluetooth físico.

### Arranque local
1. PostgreSQL local en marcha y `apps/api/.env` configurado (ver
   `apps/api/.env.example`; no copiar valores reales a documentos).
2. API: `pnpm --dir apps/api start:dev` (puerto 3000).
3. Web: copiar `apps/web/.env.example` a `apps/web/.env.local` si el API no
   está en http://localhost:3000; luego `pnpm --dir apps/web dev`
   (http://localhost:5173). Si se cambia el puerto/origen del frontend,
   ajustar `CORS_ORIGIN` en `apps/api/.env`.
4. Desde la raíz también existen `pnpm dev:api` y `pnpm dev:web`.

### Prueba manual breve
1. Ingresar con un usuario ADMIN o WAREHOUSE existente.
2. Registrar paquete: Inventario existente, referencia, acabado, 10 perfiles,
   llegada "Solo mes y año", sucursal/bodega/pasillo/burro, EPC de prueba.
3. Repetir el mismo EPC → debe mostrar "Ya existe un paquete con ese EPC".
4. Consultar EPC → detalle con 10 perfiles y un movimiento inicial.
5. Salida de 4 → confirmar → saldo 6 y nueva fila "Salida" en el historial.
6. Resumen → la referencia/acabado muestra 6 perfiles y su burro.
7. Con un usuario READ_ONLY: no aparece Registrar ni formularios de operación.
8. Limpiar los registros de prueba creados (paquete y movimientos) por ID.

### Datos de prueba y limpieza
- e2e: cada archivo crea usuarios `@test.local` y catálogo/ubicaciones
  `E2E-*-<sufijo>` y borra por IDs exactos (paquetes por sus referencias de
  prueba).
- Navegador: 3 usuarios `ui-*@test.local`, familia/referencia/acabado/
  sucursal/bodega/pasillo/2 burros `E2E-UI-*-E3C5A8`, 1 paquete y 4
  movimientos; credenciales en un archivo local ignorado por Git. Limpieza por
  IDs exactos: 4 movimientos, 1 paquete, 2 burros, 1 pasillo, 1 bodega,
  1 sucursal, 1 referencia, 1 acabado, 1 familia, 3 usuarios; archivo de
  credenciales y script provisional eliminados.
- Comprobado al final: 0 usuarios @test.local, 0 registros `E2E-*`,
  0 paquetes y 0 movimientos en la BD local.
- Datos previos del desarrollador vistos en la BD local y NO tocados:
  referencia TEST-173 (inactiva), acabado TEST-COLOR (inactivo), sucursal
  "Sucursal de prueba" (TEST-C7923B31). Los IDs de los acabados reales son
  UUID (no CUID), cargados por SQL anteriormente.

## Rediseño responsive del frontend (14/10/2026)

Basado en el login rediseñado por el desarrollador (`views/LoginView.css`):
azul marino en degradado, tinta #17364a, acentos menta, foco #147a80,
títulos serif Georgia, texto Trebuchet, cejas en mayúsculas y numeración
monoespaciada. Solo frontend; sin cambios en el API.

- `index.css`: tokens compartidos con el login (tema claro, como el login).
- `App.css`: reescrito. Navegación: barra lateral azul marino en ≥1024 px,
  cabecera con pestañas en 761–1023 px y barra inferior fija en ≤760 px
  (respeta `safe-area-inset-bottom`). Tablas con `data-label` que se
  convierten en tarjetas en ≤900 px.
- `App.tsx`: nuevo armazón (marca WeTracking + Solaluminios, avatar, rol,
  cierre de sesión).
- Registrar: 5 secciones numeradas y panel lateral fijo "Nuevo paquete" con
  resumen en vivo, barra de progreso y botón de guardar (en móvil, debajo).
  Avisos de éxito/error dentro del panel, junto al botón.
- Consultar EPC: buscador grande con icono, botón con flecha estilo login y
  guía en 3 pasos.
- Paquetes: filtros plegables con contador y "Limpiar filtros" (cerrados por
  defecto en móvil); acepta filtros iniciales desde el resumen.
- Resumen: 3 indicadores (perfiles, paquetes con existencias, combinaciones),
  filtros plegables, desglose por ubicación y enlace "Ver paquetes" que abre
  Paquetes filtrado por referencia + acabado.
- Detalle de paquete: mismo encabezado y historial en tarjetas en móvil.
- Componentes nuevos/ampliados: `components/icons.tsx`, `ui.tsx`
  (PageHeader, Section, Kpi, FilterPanel), `CatalogSelectors` con
  `onDescribe`.

Verificación: `pnpm build` y `pnpm lint` de apps/web OK (0 avisos). En el
navegador, con datos temporales `E2E-UI-*` (luego borrados por ID: 6
movimientos, 5 paquetes, 1 usuario, catálogo y ubicaciones; 0 residuos):
registro, EPC duplicado, resumen (42 perfiles / 4 paquetes, agotado
excluido), desglose y "Ver paquetes" en escritorio; tablet 768×1024; móvil
375×812 y 320×640 sin desbordamiento horizontal en las cuatro vistas. API sin
cambios: no se repitieron sus pruebas.

## Ajustes de interfaz y catálogo de prueba (14/10/2026)

- En la interfaz la palabra "EPC" se reemplazó por "chip" (menú "Consultar
  chip", "Código del chip", columna "Chip", etc.). Solo cambia el texto
  visible: API, campos (`epc`), tipos y rutas siguen usando EPC. Los
  mensajes de error del API se adaptan al mostrarse (`api/client.ts`,
  `userWording`).
- Consultar chip: letra más grande en los tres pasos (17/15 px).
- Catálogo de prueba creado en la BD local (se conserva, no es real):
  - Familia `PRUEBA` — "Familia de prueba", id `cmv8lh2gw0000iwuq6hb9skip`.
  - Referencia `PRUEBA-001` — "Referencia de prueba", asociada a esa
    familia, id `cmv8lh2hd0001iwuq8mb8tmr0`.
  Para retirarlos: desactivarlos con PATCH (ADMIN) o borrarlos por esos IDs
  exactos, siempre que no tengan paquetes asociados.

## Cola de registro + auditoría de seguridad (15/10/2026)

### Cola de registro ("Guardar y continuar" → "Guardar definitivo")
- API: `POST /inventory/bundles/batch` (ADMIN, WAREHOUSE), body
  `{ bundles: RegisterBundleDto[] }`, 1–50 ítems. Todos los paquetes y sus
  movimientos iniciales se crean en UNA transacción: o se guardan todos o
  ninguno. Rechaza EPC repetidos en la lista (400 con `itemIndex`) y EPC ya
  registrados (409 con `epcs`, antes de escribir). Errores por ítem:
  "Paquete N (EPC …): …" + `itemIndex`. `POST /inventory/bundles` se conserva.
- Web: "Guardar y continuar" valida y agrega a la lista (verifica que el chip
  no esté en la lista ni registrado). La lista vive en `sessionStorage` por
  usuario (sobrevive a cambiar de vista, recargar o sesión vencida en la misma
  pestaña). "Guardar definitivo" pide confirmación (paquetes y perfiles) y
  envía el lote; si falla, resalta el ítem y ofrece quitar los ya registrados.
- Archivos: `inventory.service.ts` (createBundle compartido, registerBundles),
  `dto/register-bundle.dto.ts` (RegisterBundleBatchDto, MAX_BATCH_SIZE),
  `inventory.controller.ts`; web `lib/registrationQueue.ts`,
  `components/RegistrationQueuePanel.tsx`, `views/RegisterBundleView.tsx`,
  `api/client.ts` (ApiError.data).

### Auditoría (agente de solo lectura) y correcciones aplicadas
Sin hallazgos críticos. Aplicado:
- A1 `.gitignore` raíz (node_modules, .env*, dist, tsbuildinfo) y `.env*` en
  `apps/web/.gitignore`: un `.env` ya no puede entrar por las rutas enlazadas
  `node_modules/.pnpm/node_modules/{api,web}`. Ruta corregida de Prisma
  generado en `apps/api/.gitignore`. (No se des-versionó nada.)
- A2 Bloqueo por cuenta en login (`auth/login-attempts.ts`): 5 fallos en
  15 min → 429 durante 15 min; cuenta también emails inexistentes (no
  enumera). `TRUST_PROXY` (número de saltos) para la IP real tras proxy.
- M1 Cabeceras: sin `X-Powered-By`; `nosniff`, `X-Frame-Options DENY`,
  `Referrer-Policy no-referrer`, CSP `default-src 'none'`, `Cache-Control:
  no-store` (sin dependencia nueva).
- M2 `SET LOCAL lock_timeout = '5s'` en operaciones → 409 "paquete ocupado"
  en vez de esperar; pool `DATABASE_POOL_MAX` (por defecto 10, antes 5).
- M3 Detalle de paquete: solo los 20 movimientos más recientes (desc).
- M4 Web: UUID con respaldo `crypto.getRandomValues` (tablets por HTTP en LAN).
- B1 No se puede desactivar al último ADMIN activo (bloqueo FOR UPDATE).
- B3 Ajuste IN con tope de 1.000.000 perfiles → 400 (antes 500).
- B11 Doble clic: guardas con `useRef` en operaciones y registro.
Pendiente (no urgente o requiere decisión): des-versionar `node_modules`,
Prisma generado, zip y tsbuildinfo; `sessionVersion` en JWT para revocar
tokens (migración); paginar el resumen en SQL; límite de concurrencia de
scrypt; health público; `HOST` del API; fallo de build sin `VITE_API_URL`;
contador de intentos compartido si hay varias instancias.

### Pruebas
- API: build y lint OK; `pnpm test` 8/8 (nuevos: login-attempts, users
  último admin); e2e 43/43 en 7 archivos (nuevos: inventory-batch 7,
  security 5).
- Web: build y lint OK. Navegador (API en 3101, web en 5173): 3 chips a la
  lista, chip repetido rechazado, BD sin cambios hasta confirmar, lista
  conservada al cambiar de vista, guardado definitivo → 3 paquetes con 1
  movimiento cada uno; lote con un chip ya registrado → nada guardado, ítem
  resaltado, "Quitar de la lista los ya registrados".
- Datos temporales borrados por ID (3 paquetes, 3 movimientos, usuario,
  acabado, ubicaciones). En la BD hay 6 paquetes reales de prueba del usuario
  "Wetracking" (14/10, chips E2801160…, referencia PRUEBA-001): no se tocaron.

## Pendiente

1. ~~Familias~~ (hecho). Negocio: cargar familias reales; roles que crean
   referencias desde bodega.
2. ~~Registro de paquetes con movimiento inicial~~ (hecho).
3. ~~EPC: consulta exacta, duplicados, idempotencia de operaciones~~ (hecho).
4. ~~Resúmenes por referencia/acabado/ubicación e historial~~ (hecho).
5. ~~Frontend funcional de inventario~~ (hecho, primera versión). Pendiente:
   persistencia de sesión/refresh token, gestión de catálogos y ubicaciones
   desde la UI, administración de usuarios en la UI.
6. ~~Salidas, traslados y ajustes con concurrencia~~ (hecho). Pendiente de
   definir: división de paquetes, traslado parcial, reservas, excedentes a
   almacén, motivo obligatorio en salidas.
7. Empresas/contactos, cotizador, orden y relación con despacho (siguiente
   bloque).
8. Tareas semanales, usuarios propios y asignación administrativa.
9. Importación conciliada, pruebas con el lector UHF real, despliegue y
   capacitación.

Se estimó aproximadamente 20–30% del backend de fase 1, como apreciación de
alcance, no medición objetiva ni dato para certificar entregables.

## Verificación al recibir el proyecto

Revisar git status, package.json/lockfile, app.module.ts, guards, catálogos,
schema.prisma y directorios de migraciones. Ejecutar validación/build apropiados.
No inferir la versión actual de pnpm ni cantidad final de migraciones: leerlas.
Si PostgreSQL está disponible, migrate status es lectura. No resetear ante drift.
Si se requiere sesión para HTTP, pedir al desarrollador autenticarse mediante
el mecanismo existente sin enviar credenciales al chat. Reutilizar esa sesión
de manera local y no imprimir el token.

## Registro de trabajo futuro

Actualizar por cada tarea terminada:
- Fecha y objetivo.
- Archivos/endpoints cambiados.
- Comandos ejecutados y resultados concretos.
- Migraciones nuevas/aplicadas, si corresponde.
- Datos de prueba creados y limpieza realizada.
- Pendientes y siguiente tarea.

No marcar una función completada porque exista su tabla. No marcar pruebas
como ejecutadas si solo fueron preparadas para ejecución por el usuario.
