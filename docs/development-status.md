# Estado de desarrollo

## Auditoría de roles, permisos e IDOR (16/10/2026)

- Informe: [roles-permissions-idor-audit.md](roles-permissions-idor-audit.md),
  con matriz de permisos, evidencia HTTP, diferencias documentales y límites.
- Roles: ADMIN, WAREHOUSE, SALES, READ_ONLY. BD local antes/después: 1 ADMIN
  activo y 1 READ_ONLY inactivo; sin cuentas WAREHOUSE/SALES persistentes.
- No se reprodujo IDOR de tareas ni elusión de permisos en los escenarios
  probados. Tres pares de usuarios del mismo rol no pueden leer/completar
  tareas ajenas (404), filtrar por otro asignado ni asignarle tareas (403).
  ADMIN puede consultar tareas del equipo, pero solo completa las propias.
- Hallazgo de alcance: inventario global, sin permisos por sucursal/bodega.
  `defaultInventoryLocationId` no restringe acceso. Demostrado: WAREHOUSE con
  predeterminada A registra, descuenta y traslada un paquete de B; todos los
  roles leen B. Sería una brecha si el negocio exige aislamiento; esa regla
  debe definirse antes de cambiar el contrato actual.
- READ_ONLY sí crea/completa tareas propias; SALES tiene actualmente los
  mismos permisos efectivos. Cotizador sin implementar. Administración de
  usuarios/catálogos/ubicaciones disponible en API, sin UI de gestión completa.
- Nuevo archivo: `apps/api/test/authorization-idor.e2e-spec.ts` (20 pruebas).
  Sin cambios de código funcional, roles, endpoints, esquema o migraciones.
- Ejecución: `pnpm.cmd --dir apps/api exec vitest run --config
  ./vitest.config.e2e.ts test/authorization-idor.e2e-spec.ts
  test/tasks.e2e-spec.ts test/security.e2e-spec.ts
  test/inventory-batch.e2e-spec.ts test/inventory-operations.e2e-spec.ts
  --no-file-parallelism` → 53/53. Unitarias API 8/8; build API/web OK;
  lint API salida 0 con aviso previo `require-array-sort-compare` en
  `test/tasks.e2e-spec.ts:120`; lint web OK. No se repitieron todos los e2e
  ni la suite aislada. Comandos completos en el informe.
- Pruebas con usuarios/objetos temporales, JWT del helper existente y guards
  reales; sin alterar login ni cuentas reales. Limpieza por IDs; conteos
  inicial/final iguales: 2 usuarios, 0 tareas, 10 paquetes, 11 movimientos,
  1 sucursal, 1 ubicación, 1 pasillo, 1 burro, 2 referencias, 7 acabados y
  1 familia. Los conteos antiguos en este documento son históricos.
- Se conservaron los cambios previos del usuario. Sin commit, push o
  despliegue realizados por esta auditoría. Pendiente: definir si se necesita
  aislamiento por sede; no se verificó navegador ni servidor ya iniciado.

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
| PATCH | /users/:id/role | Cambiar rol por ADMIN (20/10/2026) |
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
| POST | /inventory/bundles/batch | Guardado definitivo de la lista (ADMIN, WAREHOUSE) |
| GET/POST | /tasks | Tareas: listar por estado / crear o asignar |
| GET | /tasks/summary | Conteos de tareas |
| GET | /tasks/:id | Detalle de tarea |
| PATCH | /tasks/:id/complete | Completar (solo la persona asignada) |
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
Pendiente (no urgente o requiere decisión): ver la revisión del 15/10/2026
más abajo, que corrige la nota sobre tokens y resuelve el des-versionado.

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

## Revisión focalizada (15/10/2026, tarde)

### Comprobado (con evidencia ejecutada)

1. Sesiones y desactivación — CORRECCIÓN del informe anterior.
   - `JwtAuthGuard` (`jwt-auth.guard.ts:40-47`) consulta `user.active` en
     CADA solicitud. Desactivar una cuenta rechaza de inmediato sus tokens ya
     emitidos (401 "La sesión ya no está habilitada"). `Test-Auth.ps1:81-83`
     ya lo verificaba; ahora también `test/security.e2e-spec.ts`
     ("deactivating an account…"), que usa solo usuarios de prueba.
   - La nota anterior "desactivar no invalida tokens" era incorrecta. No se
     preparó migración.
   - Cerrar sesión ≠ desactivar: cerrar sesión solo borra el token de la
     memoria del navegador; una copia del token seguiría siendo válida hasta
     su vencimiento (máx. 1 h). Desactivar sí corta el acceso al instante.
   - Límite real (comprobado en la misma prueba): reactivar la cuenta dentro
     de esa hora vuelve a validar el token anterior.
2. Guardado por lotes idempotente (sin migración): `POST
   /inventory/bundles/batch` exige `operationKey` (UUID del cliente). Cada
   movimiento inicial usa la columna única existente con la clave
   `bundle-batch:<uuid>:<n>`.
   - Misma clave + lista equivalente (mismos chips, orden, cantidades,
     ubicación, tipo, llegada, notas y usuario) → 200 `replayed: true` con
     los paquetes ya guardados; no crea nada. Funciona aunque después haya
     habido salidas (se compara con el movimiento inicial).
   - Misma clave con otro contenido, otro orden, más/menos paquetes u otro
     usuario → 409 "La clave de guardado ya se usó con otra lista".
   - Reintentos simultáneos con la misma clave → uno 201, el resto 200, sin
     duplicados (repetido 3 veces).
   - Navegador: con `fetch` interceptado, la 1.ª petición llegó al servidor
     (201, 2 paquetes) pero el navegador recibió error de red; la UI mostró la
     lista como NO guardada y "no sabemos si se guardó". El reintento usó la
     misma clave → 200 "La lista ya estaba guardada; el reintento no duplicó
     nada"; la BD quedó con 2 paquetes y 1 movimiento cada uno.
3. Lista pendiente (web):
   - Aislamiento: clave por usuario en sessionStorage; el usuario B no vio la
     lista de A en la misma pestaña (comprobado).
   - Recuperación: tras volver a ingresar y tras recargar la página se
     recuperó la lista con el aviso "Sigue sin guardar" (comprobado).
   - Fallo de sessionStorage (simulado: setItem/removeItem lanzan): aviso
     "Este navegador no permite conservar la lista…", la lista sigue en
     memoria y el diálogo de salida ya no ofrece "conservar" (comprobado).
     Lista ilegible al cargar → aviso y se ignora.
   - Cerrar sesión con pendientes: diálogo con "Volver y guardar", "Salir y
     conservar" (solo si el almacenamiento funciona) y "Descartar N y salir";
     sin pendientes no hay diálogo (comprobado). Cerrar/recargar la pestaña
     con pendientes registra aviso `beforeunload` (no observable desde la
     automatización: la recarga se forzó).
   - Visible que no está guardada: banner fijo "N paquetes sin guardar",
     etiqueta "Sin guardar" en la lista y contador en el menú Registrar.
   - Conflictos: ya no hay borrado masivo; cada chip en conflicto se marca
     con "Ya está registrado en el inventario · Ver el paquete existente"
     (abre el detalle y la lista se conserva) y el usuario decide quitarlo.
     Al agregar un chip ya registrado se rechaza con el mismo enlace.
4. Último administrador con concurrencia: base aislada
   `solaluminios_dev_isolated_test` (mismo servidor PostgreSQL, creada por
   `pnpm test:isolated`, migraciones aplicadas con `prisma migrate deploy`).
   15 rondas de dos ADMIN desactivándose mutuamente a la vez → siempre 1
   éxito, 1 rechazo y 1 ADMIN activo; y 4 ADMIN + actor cruzados → nunca 0.
   La prueba se niega a correr si la BD no termina en `_isolated_test`. No se
   desactivó ningún administrador real (BD de desarrollo: 1 ADMIN activo).
   Mecanismo: `SELECT … FOR UPDATE` sobre ADMIN activos; tras esperar el
   bloqueo, PostgreSQL re-evalúa la condición y excluye al ya desactivado.
5. Git (sin commit ni push):
   - Retirados del índice con `git rm --cached` (archivos locales intactos):
     `node_modules/` (80.417 archivos), `apps/api/src/generated/prisma/`
     (36), `apps/api/tsconfig.build.tsbuildinfo` y
     `Solaluminios-auth-step2.zip` (copia antigua del módulo de auth; se
     revisó y no contiene secretos). Quedan 127 archivos versionados.
   - `.gitignore` raíz cubre esos patrones (+ `*.zip`, `.env*`); verificado
     con `git check-ignore`.
   - Historial: ningún `.env` real se versionó nunca. Búsqueda de URLs con
     contraseña, `JWT_SECRET` con valor y contraseñas literales en todos los
     commits (sin node_modules): solo aparece la línea de ejemplo de
     `apps/api/.env.example`, que es el marcador `USUARIO:CONTRASENA`
     (comprobado por comparación exacta). No se encontraron credenciales.
   - Tras clonar de nuevo el repo hay que ejecutar
     `pnpm --dir apps/api exec prisma generate` (el cliente ya no se versiona).
   - Nota: el API que corría en el puerto 3000 (proceso del desarrollador)
     no tenía el cambio de `operationKey` y respondió 400; las pruebas de
     navegador se hicieron con API en 3101 y web en 5174 (`api-alt`,
     `web-alt`). Reiniciar ese proceso para usar el código actual.

### Pruebas ejecutadas
- API: build y lint OK; `pnpm test` 8/8; e2e 47/47 en 7 archivos
  (inventory-batch 10, security 6); `pnpm test:isolated` 2/2.
- Web: build y lint OK; navegador según los puntos 2 y 3.
- Datos temporales borrados por ID (2 usuarios, 3 paquetes, 3 movimientos,
  acabado y ubicaciones `E2E-UI-*`). En la BD de desarrollo siguen los 6
  paquetes del usuario Wetracking (hoy con 7 movimientos: una salida suya a
  las 11:18), no tocados.

### Recomendaciones (no implementadas)
- HTTPS en producción. Lo probado aquí es HTTP local (localhost), que el
  navegador trata como contexto seguro; no equivale a un despliegue con
  HTTPS. Las tablets en la LAN por `http://IP` no son contexto seguro (por
  eso el respaldo de UUID) y el token viajaría sin cifrar.
- Revocación por token (p. ej. versión de sesión en el JWT) solo si se
  necesita cortar un token concreto sin desactivar la cuenta, o evitar que
  una reactivación revalide tokens previos. Requeriría migración; no se hizo.
- Contador de intentos de login y throttler compartidos si hay varias
  instancias; paginar el resumen en SQL; limitar concurrencia de scrypt;
  health público sin BD; `HOST` configurable; fallar el build web sin
  `VITE_API_URL`.
- Hacer commit del des-versionado en un commit propio y revisar que nadie
  dependa del cliente Prisma versionado.

## Módulo de tareas (16/10/2026)

### Decisiones
- "Jefe" = rol ADMIN (único con autoridad sobre otros usuarios; no se creó
  un rol nuevo). Coincide con project-context: "el usuario programa las
  propias; el administrador asigna".
- Cualquier rol (ADMIN, WAREHOUSE, SALES, READ_ONLY) crea tareas para sí.
  Solo ADMIN asigna a otra persona activa. El creador sale de la sesión.
- Solo la persona asignada marca la tarea como completada (ni siquiera el
  ADMIN que la asignó). Completar dos veces no cambia nada.
- "Si vence sin completarse se elimina pero queda en incompletas": la tarea
  NO se borra; sale de pendientes y aparece en Incompletas. El estado se
  calcula con el reloj del servidor en cada consulta (sin trabajos
  programados): completed si completedAt; incomplete si dueAt ≤ ahora sin
  completar; pending en otro caso. Una tarea vencida ya no se puede
  completar (409) y la BD lo garantiza con CHECK.
- Vencimiento con fecha y hora; el API exige zona horaria explícita y el
  frontend envía hora de Bogotá (-05:00, sin horario de verano). Mínimo 1 min
  en el futuro, máximo 366 días.

### Base de datos — migración nueva `20261016174032_tasks`
- Solo crea la tabla `tasks` (id, title, description, dueAt, assigneeId,
  createdById, completedAt, createdAt, updatedAt), índices y FK a `users`
  (RESTRICT). No modifica tablas ni datos existentes.
- CHECK añadidos a mano: `tasks_title_not_blank`,
  `tasks_due_after_creation`, `tasks_completed_before_due`.
- Generada con `prisma migrate dev --create-only`, SQL revisado, aplicada con
  `prisma migrate deploy` a la BD de desarrollo y a la base aislada.

### API (`src/modules/tasks`)
| Método | Ruta | Permiso / reglas |
| --- | --- | --- |
| POST | /tasks | Todos. `{ title, description?, dueAt, assigneeId? }`; assigneeId de otra persona solo ADMIN (403) |
| GET | /tasks?status=pending\|completed\|incomplete&assigneeId&page&pageSize | Empleado: solo las suyas (assigneeId ajeno → 403). ADMIN: todo el equipo o una persona |
| GET | /tasks/summary?assigneeId | pending, dueSoon (24 h), completed, incomplete |
| GET | /tasks/:id | Asignado, creador o ADMIN; si no, 404 |
| PATCH | /tasks/:id/complete | Solo el asignado; vencida → 409; actualización condicional atómica |

Orden: pendientes por vencimiento ascendente; completadas por fecha de
completado; incompletas por vencimiento descendente. Personas expuestas
solo con id, nombre y rol.

### Web
- Menú "Tareas" para todos los roles, con contador de pendientes (se
  actualiza cada minuto).
- Indicadores: Pendientes, Vencen en 24 h, Completadas, Incompletas.
- Pestañas Pendientes (agrupadas por día: Hoy, Mañana, días de la semana y
  "Más adelante"), Completadas e Incompletas.
- ADMIN: filtro "Persona" y formulario "Crear y asignar" con "Asignar a".
  Empleado: formulario "Programar una tarea" sin asignación.
- Marcar completada con confirmación (solo en tareas propias pendientes). La
  lista se refresca cada minuto; una tarea que vence en pantalla se marca
  "Vencida", pierde el botón y pasa a Incompletas.
- Archivos: `views/TasksView.tsx`, `components/TaskCard.tsx`,
  `components/TaskForm.tsx`, `lib/tasks.ts`, `lib/useNow.ts`, iconos,
  estilos en `App.css`, menú en `App.tsx`. KPIs en 2 columnas hasta 340 px.

### Pruebas
- e2e `test/tasks.e2e-spec.ts` 9/9: creación propia por los 3 roles no
  ADMIN, asignación solo ADMIN (403/400 inactivo/404), validaciones (título,
  pasado, <1 min, sin zona horaria → 400, >366 días, campos extra), visibilidad
  (empleado solo las suyas, 404 ajena, ADMIN todas/filtro), completar solo el
  asignado + idempotente + concurrente, vencida → incompletas y 409, una tarea
  que vence en 1,5 s pasa sola a incompletas, conteos = listas, CHECK de BD,
  401. La prueba detectó y se corrigió: se aceptaba dueAt sin zona horaria.
- Suite completa: unit 8/8, e2e 56/56 (8 archivos), aislada 2/2; web build y
  lint OK.
- Navegador (API 3101, web 5174, usuarios temporales): la jefa asignó una
  tarea (sin botón completar para ella); el empleado la vio, sin selector de
  asignación, creó una propia y completó la asignada con confirmación; la
  tarea vencida aparece en Incompletas; una tarea que vencía a los 20 s salió
  sola de pendientes y quedó en Incompletas sin recargar; móvil 375 px sin
  desbordamiento. Se corrigió el desbordamiento de las pestañas.
- Datos temporales borrados (4 tareas, 2 usuarios). BD: 0 tareas.
- El API del desarrollador en el puerto 3000 debe reiniciarse para cargar el
  módulo de tareas (la migración ya está aplicada).

## Administración: catálogo y usuarios (20/10/2026)

Sin migraciones. Pantalla "Administración" (menú visible solo para ADMIN;
el API exige ADMIN en todos estos endpoints).

- Familias: buscar, crear (código en mayúsculas, no editable), renombrar,
  activar/desactivar con confirmación (desactivar conserva sus referencias).
  Usa `GET/POST /catalog/families` y `PATCH /catalog/families/:id`.
- Referencias: buscar, filtrar por familia ("Sin familia") y estado; crear
  con descripción y familia opcional; editar descripción y familia (quitarla
  o cambiarla); activar/desactivar con confirmación. Lista filtrada en el
  navegador, máximo 100 filas visibles. Usa los endpoints existentes de
  `/catalog/references`. Los acabados no se administran aquí (se ajustaron
  por SQL y no se deben renombrar).
- Usuarios: buscar; crear con nombre, correo, contraseña inicial (mín. 12,
  botón "Generar" con CSPRNG y muestreo por rechazo, se muestra una sola vez
  tras crear) y rol con la descripción de sus permisos; cambiar rol con
  confirmación; activar/desactivar. La fila propia no tiene controles.
- API nuevo: `PATCH /users/:id/role` (ADMIN). Rechaza cambiar el propio rol
  (400) y quitar el rol al último ADMIN activo (400, con el mismo
  `SELECT … FOR UPDATE` que la desactivación). El guard relee el rol en cada
  solicitud: el cambio aplica en la siguiente acción, sin nuevo login.
- Pruebas: unit `users.service.spec.ts` 11/11 en total (3 nuevas de setRole);
  e2e `test/users-admin.e2e-spec.ts` 3/3 (crear con rol y login, 409/400,
  cambio de rol aplicado a la sesión existente, propio rol 400, no ADMIN 403,
  401). Suite completa: e2e 79/79 en 10 archivos, aislada 2/2, web build y
  lint OK. Navegador (API 3101, web 5174, ADMIN temporal): crear, renombrar,
  duplicado 409 y desactivar/activar familia; crear, editar (quitar familia) y
  desactivar referencia; crear usuario Ventas con contraseña generada, cambiar
  a Bodega (verificado en BD: WAREHOUSE, hash scrypt); fila propia sin
  controles; móvil 375 px sin desbordamiento (6 secciones de 61 px).
- Datos temporales borrados por valor exacto (1 familia, 1 referencia, 2
  usuarios). La cuenta inactiva `auth-test-…@example.invalid` es de
  `Test-Auth.ps1` y no se tocó.
- Pendiente: cambio y recuperación de contraseña; editar nombre/correo de
  usuarios; la matriz de `roles-permissions-idor-audit.md` debería añadir
  "cambiar rol (ADMIN)".

## Revisión de concurrencia e idempotencia (20/10/2026)

Informe completo, tabla por escenario y carga:
[concurrency-audit.md](concurrency-audit.md). Sin migraciones nuevas, sin
commit, push ni despliegue.

- **Base de pruebas dedicada**: los e2e ya no usan la base de desarrollo.
  `TEST_DATABASE_URL` (entorno o `apps/api/.env.test`, ignorado por Git;
  `pnpm test:db:setup` la crea como `<dev>_e2e_test`). Guardas: host local
  (o `TEST_DATABASE_ALLOWED_HOSTS`), nombre `*_test` sin "prod", distinta de
  `DATABASE_URL`, `current_database()` comprobado en el *global setup* y en
  cada app; `migrate deploy` una sola vez. La base de desarrollo quedó
  idéntica antes y después.
- **Corregido** (reproducido primero con prueba que fallaba):
  1. Fila bloqueada > 5 s → era 409 (el frontend descartaba la clave y un
     reintento podía duplicar); ahora 503 + `Retry-After` + `retryable`.
  2. Errores transitorios de BD (pool agotado, timeouts, deadlock) → eran
     500; filtro global `RetryableErrorFilter` → 503 reintentable.
  3. Ediciones de catálogo sobrescribían cambios ajenos → `expectedUpdatedAt`
     opcional en `PATCH /catalog/references/:id` y `/catalog/families/:id`,
     actualización condicional → 409 "modificada por otra persona".
  4. Frontend: la `operationKey` se conserva tras resultado incierto aunque
     se edite el formulario; `ExitForm` ya no se re-monta al cambiar el
     saldo; recarga del paquete/historial tras 409 o resultado incierto;
     Administración sale del modo edición y recarga tras un conflicto.
- **Pruebas nuevas**: `concurrency.e2e-spec.ts` (escenarios A–K,
  idempotencia, operación en curso, permisos), `concurrency-repeat` (20
  rondas × 3 casos críticos), `transient-errors`, carga
  `test/load/inventory.load-spec.ts` (`pnpm test:load`, 5/10/25 usuarios).
  `security.e2e-spec.ts` actualizada al contrato 503.
- **Resultados**: unit 11/11; e2e 99/99 en 13 archivos sobre
  `solaluminios_dev_e2e_test`; aislada 2/2; carga sin errores inesperados ni
  saldos negativos/descuadrados (25 usuarios: 2151 solicitudes, p95 47 ms,
  equipo local, no VPS); API lint y build OK; web build y lint OK.
  Navegador (API 3101 con `pnpm start:test-db`, web 5174): saldo
  desactualizado, respuesta perdida, 503 y conflicto de administración.
- **Pantallas**: sin SSE/WebSocket ni sondeo en inventario (carga al abrir,
  filtrar, paginar y tras operar o recibir conflicto); tareas cada 60 s.
- **Pendiente**: clave de reintento en registro individual y creación de
  tareas; limitador en memoria por instancia; `expectedUpdatedAt` opcional;
  sin aislamiento por sucursal.

## Frontend con la marca WeTracking (21/10/2026)

Fuentes: «MANUAL WETracking 11DIC2020» (manual de marca) y «wetracking
diseñoApp v03 4oct2021» (pantallas de la app). Solo `apps/web`; sin cambios
de API, permisos ni flujos.

- Colores exactos del manual como tokens en `src/index.css`: aqua `#00FFD7`,
  azul `#1184E6`, cian `#00A5D7`, azul marino `#0B194F`; degradado azul
  del diseño de la app (`#1650C5 → #012468`). Para texto pequeño y enlaces
  se usa `#0D6FC4` (tono más oscuro del azul de marca, contraste AA); el
  aqua solo va sobre fondos oscuros o como acento decorativo.
- Tipografía: Nunito Sans (complementaria, OFL) servida desde la app con
  `@fontsource-variable/nunito-sans`. Uni Neue (títulos) es una fuente
  comercial de Fontfabric: se usa si está instalada en el equipo
  (`local()`); si la empresa tiene la licencia web, basta añadir los
  `.woff2` en el `@font-face` de `index.css`. Mientras tanto los títulos
  usan Nunito Sans.
- Logo vectorial trazado del manual (p. 6): `components/brand/BrandLogo.tsx`
  con variantes original (con tag-line), mínima y solo isotipo «We», en
  positivo/negativo. Favicon según la «versión favicon» (p. 9).
- Login como el diseño de la app: fondo azul degradado, logo en negativo,
  tarjeta blanca «¡Bienvenido!», campos grises con icono y etiqueta
  flotante, botón píldora azul marino. Sin enlace de recuperar contraseña
  (no existe esa función): se indica consultar al administrador.
- Nueva vista **Inicio** (pantalla de entrada tras el login): «¡Hola!
  nombre», banner de la empresa y tarjetas de acceso con iconos lineales
  aqua → cian que se vuelven azules al pasar/pulsar; respeta los roles
  (Registrar solo operadores, Administración solo ADMIN). El logo de la
  barra lateral/superior lleva a Inicio.
- Resto de pantallas: botones píldora, pasos numerados en píldora azul
  marino, cejas con la píldora diagonal de marca, KPI y paneles en azul,
  cargador «píldora + punto» del diseño, pestañas en píldora. Se eliminaron
  la tipografía serif y el monoespaciado salvo en códigos de chip,
  contraseñas generadas y códigos de catálogo.
- Archivos: `index.html`, `public/favicon.svg`, `src/main.tsx`,
  `src/index.css`, `src/App.css`, `src/App.tsx`, `src/views/LoginView.tsx`,
  `src/views/LoginView.css`, `src/views/HomeView.tsx` (nuevo),
  `src/views/navigation.ts`, `src/components/ui.tsx`,
  `src/components/icons.tsx`, `src/components/brand/` (nuevo),
  `package.json`/`pnpm-lock.yaml` (fuente). `.claude/launch.json`: entrada
  `api-test` (API sobre la base de pruebas, puerto 3101).
- Verificación: `pnpm build` y `pnpm lint` OK. Navegador (web 5174, API de
  pruebas 3101 sobre `solaluminios_dev_e2e_test`): login, Inicio, registro,
  consulta y detalle de chip, paquetes, resumen, tareas y administración en
  375 px, ~730 px, 900 px y escritorio; sin desbordamiento horizontal ni
  errores de consola. Datos temporales (1 usuario ADMIN, 1 sede/bodega/
  pasillo/burro, familia, referencia, acabado, 3 paquetes, 4 movimientos,
  1 tarea) borrados por ID exacto; la base de pruebas quedó vacía.

### Registro en celular: chip y cantidad juntos (22/10/2026)

- «Perfiles en el paquete» pasó de «02 Producto» a la sección 05, ahora
  «Etiqueta RFID y perfiles», justo debajo del código del chip: es lo que
  cambia entre paquetes consecutivos de la misma referencia, acabado y
  llegada. El resumen lateral muestra Chip y Perfiles al final.
- En una columna (≤ 1023 px) «Guardar y continuar» y sus avisos aparecen
  debajo de chip, cantidad y notas; en escritorio siguen en el panel de
  resumen (solo uno visible).
- Corregido: tras agregar a la lista el foco no volvía al chip (el campo
  seguía deshabilitado por la verificación). Ahora vuelve al chip y, en una
  columna, lo centra en pantalla.
- Verificado en navegador (375 px y 1280 px, API de pruebas): 3 paquetes
  seguidos solo cambiando chip y cantidad; referencia/ubicación conservadas;
  chip, cantidad y botón en una sola pantalla del celular. Lista descartada
  y datos temporales borrados por ID; base de pruebas vacía.

## Lectura masiva RFID con la pistola Chafon (22/10/2026)

**Cambio de alcance pedido por el usuario:** AGENTS.md describía la fase 1
sin lectura continua; este módulo la añade solo para **consultar**. No
registra, no descuenta, no escribe/bloquea/mata etiquetas y no crea tablas.

Fuente: SDK del fabricante «H100.102.103+SDK» (manual «UHF Hand Reader User
Manual V1.2», «Bluetooth Development 20250304», app demo CfTech). Leído sin
ejecutar nada del paquete.

- Protocolo (modo **transparente** BLE): servicio `0000ffe0-…`, escritura
  `0000ffe3-…`, notificaciones `0000ffe4-…` (UUIDs confirmados en la app
  demo). Trama `CF ADDR CMD(2) LEN DATA CRC16` (preset 0xFFFF, polinomio
  0x8408, MSB primero). Inicio de inventario continuo
  `cf ff 00 01 05 00 00 00 00 00 f5 b5` (idéntico al ejemplo del
  fabricante), parada `cf ff 00 02 00 …`. Lecturas: `cmd 0x0001`,
  `STATUS 0`, `RSSI(2) ANT CH EPC_LEN EPC`; `0x12` = inventario terminado;
  `0x0089` = gatillo. Los códigos de barras (H103/H104) se ignoran.
- Web: `src/lib/chafon.ts` (tramas, CRC, re-ensamblado de notificaciones
  partidas), `src/lib/useChafonReader.ts` (Web Bluetooth), vista
  `views/BulkReadView.tsx` («Lectura masiva»: tarjeta en Inicio, menú
  lateral/superior y botón «Leer varios chips» en Consultar chip; no está
  en la barra inferior del celular porque ya está llena). Muestra por chip
  el EPC, la referencia (código y descripción), acabado, perfiles,
  ubicación y número de lecturas; resumen por referencia y filtros
  registrados / no registrados; «Registrar» para chips sin paquete
  (solo ADMIN/WAREHOUSE). Modo teclado (HID) y pegado de listas como
  alternativa. La lista se conserva al abrir un paquete y volver; se borra
  al cerrar sesión. Máximo 3000 chips por pantalla.
- API: `POST /inventory/bundles/lookup` `{ epcs: string[] }` (1–200,
  letras/números, normalizados) → `{ bundles, missing }`. Solo lectura, 200,
  todos los roles (con `@Roles` explícito: un POST sin decorador sería
  solo-ADMIN para RolesGuard). Sin migraciones.
- Requisitos: Chrome en Android o computador, con **HTTPS** en producción
  (Web Bluetooth no existe en iPhone/Safari ni en HTTP). La pistola debe
  estar en salida «transparente» (app «UHF Reader» del fabricante); en modo
  HID se usa el campo de modo teclado.
- Pruebas: `pnpm test` en `apps/web` (protocolo 5/5: comando documentado,
  tramas partidas en 7 bytes, ruido, CRC inválido, fin de inventario,
  gatillo, código de barras). API: `test/bulk-reading.e2e-spec.ts` 4/4
  (resultado y orden, solo lectura, roles y 401, validación 0/201/200).
  Suite: unit 11/11, e2e 103/103 en 14 archivos, lint OK; web build/lint OK.
  Navegador (API de pruebas): lector Bluetooth **simulado** con las tramas
  del manual en notificaciones de 20 bytes (conectar, iniciar, 15 lecturas
  de 5 chips → 5 filas con referencia, detener, gatillo, desconexión
  inesperada conservando la lista), modo teclado, pegado de lista y
  regreso desde el detalle. Datos temporales borrados por ID; base de
  pruebas vacía.
- **Pendiente con el equipo real:** probar con la pistola física (UUIDs y
  tramas reales, que el EPC llegue en hex igual al registrado por modo
  teclado, alcance/velocidad), y publicar el frontend con HTTPS.
- 22/10/2026: el usuario confirmó lecturas con la pistola real. El error
  «Cannot POST /inventory/bundles/lookup» era un API iniciado antes del
  cambio con `nest start` sin `--watch`; se resuelve reiniciándolo
  (`pnpm --dir apps/api start:dev`). Sin cambio de código.

### Distancia de lectura (22/10/2026)

Con el lector conectado, «Lectura masiva» muestra **Distancia de lectura**:
Corta / Media / Larga (35 %, 65 % y 100 % de la potencia máxima del modelo)
y un ajuste fino en dBm que solo se envía al pulsar «Aplicar». Se bloquea
mientras se lee («Detén la lectura para cambiar la distancia»).

- Protocolo, tomado de la librería del SDK (`cf-sdk-v1.0.4.aar`:
  `CmdBuilder`/`CmdHandler`) y de la pantalla de ajustes de la app demo:
  la distancia es la potencia RF. Igual que la app del fabricante, se leen
  todos los parámetros (`RFM_GET_ALL_PARAM 0x0072`, 25 bytes tras STATUS),
  se cambia solo `RfidPower` (byte 15) y se escriben de vuelta
  (`RFM_SET_ALL_PARAM 0x0071`); luego se vuelve a leer para mostrar lo
  guardado. El modelo se obtiene con `0x0070` (el manual dice 0x0051, el SDK
  envía 0x0070) para el rango: H100 1–20, H102 1–26, H103 1–33 dBm; modelo
  desconocido 5–30. Se usa mínimo 5 dBm. Si la respuesta no tiene la forma
  esperada (longitud o potencia > 33) no se escribe nada.
- El valor queda en la configuración de la pistola, por lo que también
  afecta el modo teclado (HID) y la app del fabricante.
- Archivos: `src/lib/chafon.ts` (comandos y lectura de parámetros/modelo),
  `src/lib/useChafonReader.ts` (petición-respuesta por comando con tiempo
  límite de 2 s y 3 intentos de lectura; estado `power`, `setPower`,
  `reloadPower`), `views/BulkReadView.tsx` (`ReadRange`), `App.css`.
  Sin cambios en el API ni en la base de datos.
- Pruebas: `pnpm test` en `apps/web` 7/7 (nuevas: lectura de parámetros,
  escritura con solo la potencia cambiada y CRC, límite a 33, respuesta
  corta o potencia inválida rechazada, modelo desde la versión); lint y
  build OK. Navegador (API de pruebas, lector **simulado** con respuestas
  del protocolo en notificaciones de 20 bytes): lee H103 y 26 dBm; «Corta»
  envía `cf ff 00 71 19 … 0c …` con los otros 24 bytes idénticos y muestra
  «guardada: 12 dBm»; ajuste fino a 30 dBm; bloqueo durante la lectura;
  lector sin respuesta → error sin cambiar el valor y «Reintentar» (la
  lectura de chips sigue funcionando); celular 375 px sin desbordes; sin
  errores en consola. Un usuario temporal en la base de pruebas, borrado por
  ID (0 usuarios restantes).
- **Pendiente con la pistola real:** confirmar que responde a 0x0070/0x0072
  como el SDK, que la potencia cambia el alcance y que se conserva al
  apagarla.

## PWA instalable y notificaciones Web Push (26/10/2026)

Rama `feat/pwa-web-push`. Detalle completo, comandos y tabla de escenarios en
`README-PWA.md`.

- Web: `vite-plugin-pwa@2.0.0` (injectManifest) con un único service worker
  propio (`src/sw/sw.ts`): precache solo de archivos estáticos, ninguna ruta
  para el API, actualización solo tras «Actualizar» (comprueba trabajo sin
  guardar en esta y otras ventanas), push y clic con vistas permitidas.
  Manifest «Solaluminios · Inventario», íconos 192/512/maskable desde la marca.
  Aviso «Sin conexión», tiempo de espera de 30 s en `apiRequest` (resultado
  incierto conserva la clave). Panel «Este dispositivo» en Inicio.
- API: módulo `push` (`/push/config`, `/push/subscriptions`, `…/check`,
  `…/remove`, `/push/test`), `web-push@3.6.7`, VAPID por entorno
  (`scripts/Configure-Vapid.mjs`), validación de destinos (sin SSRF),
  reintentos limitados, borrado ante 404/410. Aviso al asignar una tarea
  (ADMIN → otra persona) después de crearla; un fallo no afecta la tarea.
- Migración nueva `20261026150000_push_subscriptions` (solo crea
  `push_subscriptions`). Aplicada en la base de pruebas; **pendiente en
  desarrollo** (`prisma migrate deploy`).
- Correcciones: el detalle del paquete ya no se desmonta si una recarga falla
  (se perdían datos y la clave de una operación incierta); registro del
  service worker cuando la página ya cargó; listeners de la pistola tras
  desconexión y «Reconectar».
- Pruebas: API unit 18/18, e2e 113/113; web build/lint/test OK. Navegador:
  dos builds (actualización sin perder trabajo), servidor caído en una salida
  (aplicada una sola vez), push real FCM con página abierta y cerrada,
  aislamiento entre cuentas. Pistola simulada.
- Pendiente: Android real con HTTPS, pistola física, migración y VAPID en
  desarrollo/producción, publicación (propuesta en `docs/deploy/`).

## Origen, compras, ventas y despachos con RFID (26/10/2026)

Rama `feat/sales-dispatch-origin`, sin commit. El detalle está en
`README-VENTAS-DESPACHOS.md`: guías, matriz de roles, contrato del lector y
tabla de 32 escenarios.

- **Modelo**:
  - `Supplier`, `Setting` (proveedor fijo China, supervisor);
  - `InboundShipment`, `InboundPreRegistration`;
  - `StockLot` como fuente de procedencia y costo (`Bundle.lotId`);
  - `Purchase*`, `Customer`, `Quote*`, `SalesOrder*`, `StockReservation`;
  - `Dispatch*` (líneas, picks, incidencias), `NotificationOutbox`;
  - `Reader*`, `AuditEvent`;
  - `Task.kind/dispatchId/cancelledAt`;
  - rol `CHINA_OPERATOR`.

  Integridad en PostgreSQL:
  - CHECKs e índices únicos parciales;
  - triggers de identidad de lote y de reservas/entregas (diferidos);
  - bloqueo por EPC compartido por prerregistro, recepción y alta manual.
- **Migración nueva** `20261027120000_sales_dispatch_origin`: aplicada solo en
  la base de pruebas. **Pendiente en desarrollo** (`prisma migrate deploy`) y
  en el VPS. No modifica migraciones existentes; los paquetes actuales quedan
  «sin procedencia».
- **API**: módulos `supply`, `sales`, `dispatch`, `notifications`, `readers`
  y `shared/`. Cambios en `inventory`:
  - origen y proveedor en el alta;
  - reservas respetadas en salida, traslado y ajuste;
  - filtro «sin procedencia».

  Otros cambios:
  - `tasks`: tareas DISPATCH que no vencen a incompletas ni se completan por
    la ruta genérica;
  - `users`: `PATCH /users/:id/location`;
  - `RolesGuard`: CHINA_OPERATOR denegado salvo rutas explícitas.
- **Web**:
  - vistas China (inglés), Recepción, Ventas/Cotización/Orden y
    Despachos/Despacho (pistola BLE o teclado, incidencias, confirmación con
    clave idempotente);
  - panel de lector fijo;
  - administración de proveedores, lotes, compras y lectores;
  - bodega por usuario;
  - origen y proveedor en «Registrar paquete».
- **Pruebas**:
  - API: unitarias 26/26, e2e 139/139 (incluye `sales-dispatch` con 23
    escenarios y `sales-dispatch-concurrency` con 3 carreras × 20 rondas);
  - web: build, lint y Chafon 7/7.

  En la base de pruebas, dos suites antiguas de concurrencia cambiaron la
  barrera a `barrierAtTransactionStart`, porque el bloqueo por EPC ahora
  serializa; las aserciones no cambiaron.
- **Navegador** (base de pruebas, API 3101 + `vite preview`). Circuito
  completo:
  1. Proveedores, ajustes y envío China.
  2. Prerregistro China y recepción con diferencia.
  3. Alta nacional.
  4. Compra con descuentos, IVA y flete (cuadrada a mano).
  5. Cotización (recargo y precio manual) → orden → reserva → despacho →
     tarea.
  6. Lectura incorrecta (incidencia), lecturas correctas y repetidas.
  7. Resolución y salida confirmada (paquetes 30→10 y 24→14, orden
     entregada, tarea completada).
  8. Outbox procesada (`SKIPPED` sin dispositivos).
  9. Simulador de portal: 20 detecciones ⇒ 1 incidencia, reenvío = 25
     duplicados, nada preparado.
  10. Cancelación por ventas.
  11. workGuard entre ventanas.

  Correcciones que salieron de esta revisión:
  - costo unitario mostrado con 6 decimales;
  - etiquetas del descuento de renglón;
  - centavos COP con 2 decimales;
  - la cantidad vuelta al valor guardado ya no deja «Aplicar» ni bloquea la
    actualización;
  - el contador de tareas se refresca al confirmar o cancelar;
  - un despacho cancelado cierra sus incidencias abiertas;
  - panel y endpoint `GET /dispatches/:id/readers` para abrir la sesión del
    lector desde la pantalla;
  - `sessionId` opcional en el contrato del lector.
- **Datos de prueba**: los de las suites se limpian por sus relaciones. Los
  de la verificación en navegador (sufijo C4154C: 4 usuarios, 3 proveedores,
  sucursal/bodega/pasillo/burro, 2 referencias, 2 acabados y todo lo creado
  sobre ellos) se borraron por IDs exactos en una transacción; se comprobó
  que no quedan.
- **Discrepancias**:
  - en el catálogo NP es «Negro pintura» y el requerimiento dice «negro
    perla»;
  - el catálogo de desarrollo solo tiene referencias de prueba;
  - desarrollo tiene 18 paquetes sin procedencia;
  - desarrollo aún no tiene la migración.
- **Pendiente**:
  - migración en desarrollo y VPS;
  - proveedores reales, proveedor China, supervisor y bodegas de usuarios;
  - clasificación del stock histórico y compras reales;
  - pistola física en un despacho, Android con HTTPS y portal físico (no
    ejecutados);
  - adaptador del lector real;
  - política contable para descuentos condicionados.

## Registro y precios simplificados (27/10/2026)

Objetivo: registrar paquetes sin pasos extra y que solo ADMIN maneje costos
y ganancias. Sin migración nueva: usa las tablas existentes (`settings`,
`inbound_shipments`, `stock_lots`) y no borra datos.

- **Registro**:
  - «Registrar paquetes» ya abría con China; ahora muestra el proveedor de
    China asignado (`GET /suppliers/china`, solo nombre) o avisa si falta
    configurarlo. Nacional sigue pidiendo el proveedor.
  - Prerregistro China sin envío: `shipmentId` es opcional y el servidor usa
    el envío abierto o abre uno `AUTO-AAAAMMDD[-n]` (candado consultivo por
    proveedor). La pantalla China ya no exige envío.
  - Recepción: la nota de diferencia es opcional; la diferencia se sigue
    guardando y auditando. La pantalla no muestra lotes.
  - Supervisor de despachos marcado como opcional (ya lo era en el backend).
  - Cambiar el proveedor de China cierra el envío abierto del anterior en vez
    de exigir cerrarlo a mano.
  - Los paquetes históricos no se reclasifican.
- **Pruebas del registro** (e2e `sales-dispatch`): envío automático
  compartido por dos prerregistros simultáneos y recepción con diferencia
  sin nota.
- **Precios**: la regla por origen de este bloque se sustituyó el mismo día
  por precios ligados a una línea de compra. Ver la sección siguiente.

## Compras con IVA incluido y precios por línea de compra (27/10/2026)

Detalle completo en `docs/refinamiento-registro-precios.md`.

- Compra: valor bruto con IVA incluido, descuento %, perfiles → costo por
  perfil; sin IVA descontable, moneda ni gastos en compras nuevas.
- `SalePrice` (nuevo) ligado a una línea de compra por clave foránea
  compuesta (línea + referencia + acabado + origen); un solo precio
  habilitado por referencia, acabado y origen (índice único parcial).
- Cotizaciones y órdenes guardan `salePriceId` e importes propios.
- Migración nueva `20261027160000_sale_prices_from_purchases`: aplicada en
  la base de pruebas y en `solaluminios_dev` (27/10/2026, autorizada);
  **pendiente en el VPS**.
- Pruebas: unitarias 30/30, e2e 141/141, builds y lint OK, navegador con el
  ejemplo 1.190.000 / 3 % / 100 / 30 % / IVA 19 %.

## PDF de cotizaciones y órdenes; nombre Solualuminios (27/10/2026)

- **PDF** generado en la API con `pdfkit` 0.18.0 (y `@types/pdfkit` 0.17.6
  como dependencia de desarrollo):
  - `GET /quotes/:id/pdf` y `GET /sales-orders/:id/pdf`, para ADMIN y SALES;
  - mismo control que ver el documento: SALES solo los propios, otro
    vendedor recibe 404 y bodega 403.

  Formato carta, como una factura:
  - logo y NIT 901882638;
  - número, fecha, vigencia, estado y documento relacionado;
  - cliente (NIT, dirección, teléfono, correo) y vendedor;
  - renglones con precio sin IVA, descuento e IVA de venta;
  - totales y notas.

  Nunca imprime costos, ganancias ni el origen del material (China o
  Nacional), que es información interna; lo comprueba
  `sales/sales-pdf.spec.ts` leyendo el texto del PDF. El pie aclara que es
  un documento comercial y no una factura electrónica de venta (DIAN).
- **Logo**: `apps/api/src/modules/sales/assets/solualuminios-logo.png`, que
  `nest-cli.json` copia a `dist`.
- **Web**: botón «Descargar PDF» en la cotización guardada y en la orden.
- **Nombre visible** corregido a «Solualuminios» en:
  - menú, inicio y login;
  - pantalla de China;
  - notificaciones push;
  - título y descripción de la página;
  - manifiesto de la PWA.

  Las claves internas (`solaluminios.*`, caché del service worker, emisor
  del JWT) no cambian, para no cerrar sesiones ni perder colas guardadas.
- **Pruebas**:
  - unitarias 30/30 y e2e 141/141, que comprueban `application/pdf`, el
    nombre del archivo, la cabecera `%PDF-` y los permisos;
  - builds de API y web correctos;
  - PDF de muestra revisado visualmente.

## Marca WeTracking en pantallas nuevas y textos más grandes (27/10/2026)

Aplica el manual de marca y el diseño de la app (sección «Frontend con la
marca WeTracking») a las pantallas creadas después: ventas, cotización,
orden, despachos, compras, precios de venta y proveedores. Solo CSS y
algunas marcas de texto; sin cambios de API ni de flujos.

- Renglones de cotización y compra:
  - el título es la píldora azul marino con texto aqua de los pasos;
  - los datos del renglón (disponible, precio con IVA, subtotal/IVA/total,
    costo por perfil) pasan de 13,5 px a 16,5 px;
  - cada dato va en su propia píldora, con los valores en negrita de 18 px,
    sobre un panel claro con la barra aqua → cian;
  - en pantallas de 640 px o menos son bloques de ancho completo.
- Totales: panel azul marino del diseño, con el total en aqua de 22 px.
- Valores calculados por el sistema (precio de venta, proveedor, costo): en
  campo de solo lectura con fondo azul claro y negrita.
- Listas de documentos: tarjeta con sombra, barra de acento cian o azul,
  título azul marino de 16 px y texto secundario de 14 px.
- Insignia «China» en azul marino y aqua (antes naranja, fuera de la
  paleta).
- Despachos: textos de recogida y lecturas a 15 px.
- Casilla «Habilitar para ventas» con tamaño normal.
- Corregido: la sección de administración se ensanchaba con tablas anchas
  (desbordamiento horizontal); ahora la tabla se desplaza dentro de su
  recuadro.
- Verificación en navegador (base de pruebas):
  - cotización nueva en 1100 px y 390 px, sin desbordamiento;
  - compras, nuevo registro de compra y precios de venta en 1100 px.
- `tsc`, `oxlint` y `pnpm build` correctos.

## Contenido de los lotes y filtro de procedencia en Paquetes (27/10/2026)

- **Lotes con costo pendiente al registrar una compra.** Cada lote muestra su
  código, material, proveedor, paquetes y perfiles. Por ejemplo:
  «LOT-000853 · PRUEBA Champaña · Proveedor… · 10 paquetes · 250 perfiles».
  - Los perfiles son los que ingresaron (movimiento de alta de cada paquete),
    así que una salida posterior no cambia lo que documenta la compra.
  - En China se suma lo prerregistrado aún sin recibir («por recibir…»).
  - Debajo aparece el total seleccionado. Si no coincide con la cantidad de
    perfiles del renglón, se avisa sin bloquear.
  - La lista múltiple pasa a casillas, porque en celular cortaba el texto.
  - «Lotes y procedencia» muestra lo mismo, más los perfiles en existencia.
  - API: `GET /lots` agrega `totals` a cada lote: `bundles`, `profiles`,
    `inStock`, `pendingBundles` y `pendingProfiles`.
- **Paquetes.**
  - Filtros «Procedencia» (China, Nacional, Sin procedencia) y «Proveedor»,
    que incluye proveedores inactivos.
  - Columna nueva «Procedencia».
  - API: `GET /inventory/bundles?origin=CHINA|NATIONAL|UNKNOWN&supplierId=`.
  - Con «Sin procedencia», el proveedor se limpia y se desactiva.
- **PDF de cotización.** El código y el build actual no tienen columna de
  origen; `sales-pdf.spec.ts` lo comprueba. El API de desarrollo en el puerto
  3000 se había iniciado a las 10:38, antes de esa versión, y hay que
  reiniciarlo.
- **Pruebas.**
  - API: unitarias 31/31, e2e 141/141. Se ampliaron #1 (lote China con
    pendientes) y #4 (filtros por procedencia y proveedor, totales del lote).
  - Web: `tsc`, `oxlint` y build correctos.
  - Navegador, contra la base de pruebas con datos temporales (sufijo 661ECD,
    borrados por IDs exactos al terminar): filtros con 12 nacionales, 0 de
    China, 1 sin procedencia y 13 en total; casillas de lotes en 375 px sin
    desbordamiento; aviso de diferencia 240 frente a 250; el borrador guarda
    el lote elegido.

## Concurrencia de cotizaciones, órdenes y reservas (27/10/2026)

**Duración de la reserva.** Al confirmar una orden, la reserva **no vence**.
Dura hasta que ocurre una de estas cosas:
- se confirma la salida del despacho (se consume);
- se cancela la orden (se libera);
- se cancela un despacho parcial (se liberan sus reservas);
- se cambia lo preparado en un despacho (se reasigna).

Tampoco hay vencimiento por la fecha «Válida hasta» de la cotización: no se
comprueba al convertirla. Una orden «Pendiente de abastecimiento» no se
reintenta sola cuando llega material. Las tres son decisiones de negocio
pendientes.

**Suite nueva** `test/sales-orders-concurrency.e2e-spec.ts`: 12 carreras ×
20 rondas en PostgreSQL real. Cuando ambas operaciones abren transacción, la
barrera las suelta juntas.
- Conversión repetida con la misma clave.
- Edición frente a conversión de una cotización.
- Cancelación frente a conversión de una cotización.
- Doble confirmación de la misma orden.
- Confirmar frente a cancelar una orden.
- Confirmar frente a salida manual del mismo paquete.
- Cambio de proveedor exigido frente a confirmar.
- Dos órdenes con los mismos dos materiales en orden inverso.
- Creación de despacho repetida con la misma clave.
- Dos despachos distintos para toda la orden.
- Cancelar la orden frente a confirmar un despacho parcial.
- Cancelar la orden frente a confirmar un despacho total.

**Fallos encontrados por la suite** (fallaban antes de corregir):
1. Cancelar una orden mientras se confirmaba su despacho producía un
   deadlock: la confirmación bloqueaba despacho → orden y la cancelación
   orden → despacho. Respondía 500 y dejaba la orden reservada. Ahora la
   confirmación bloquea primero la orden (`lockOrderOf`), y
   `cancelOpenDispatches` bloquea los despachos y relee su estado; un
   despacho confirmado entretanto se omite, nunca se cancela sobre su salida.
2. Los deadlocks y tiempos de espera de candados respondían 500 en lugar de
   503 reintentable. El adaptador pg deja el código en `cause.originalCode`,
   y PostgreSQL responde en español («se ha detectado un deadlock»). Nuevo
   `sqlState()` en `shared/db.ts`, usado por el filtro global, por
   `isLockTimeout` y por `isCheckViolation`. Prueba unitaria en
   `retryable.spec.ts`.
3. Crear el mismo despacho dos veces a la vez con la misma clave respondía
   201 y 400: la comprobación de repetición estaba antes del bloqueo de la
   orden. Ahora también se repite después del bloqueo.

**Corrección preventiva.** `ReservationsService.plan()` solo usa paquetes
bloqueados. Un paquete que se volvía elegible entre la lista de candidatos y
el plan (ingreso, traslado o clasificación) podía reservarse sin bloqueo.
No se reproduce de forma determinista; queda cubierto por las suites
existentes.

**Pruebas.** API unitarias 34/34, e2e 153/153 (18 archivos), lint correcto.
- Algunas carreras siempre terminaron en el mismo orden: edición frente a
  conversión, confirmar frente a cancelar, y confirmar frente a salida
  manual. El servidor decide quién bloquea primero. Los casos secuenciales
  inversos ya estaban cubiertos por otras pruebas.
- `tsc` sobre `test/` mantiene un error previo en
  `test/load/inventory.load-spec.ts`, ajeno a esta tarea.

## Compras: orden de la factura (sin IVA → descuento → IVA) y filtros (29/10/2026)

- **Regla nueva** (`computeTaxOnNetLine`): por renglón se registra el valor
  bruto sin IVA; el descuento % se aplica sobre él; el IVA de compra % (obligatorio,
  puede ser 0; la pantalla propone 19) va sobre la base ya descontada.
  - Total = base + IVA.
  - Costo por perfil = total ÷ perfiles: el IVA de compra sigue dentro del
    costo, como en la regla anterior.
  - Con 1.000.000 sin IVA, 3 % y 19 % se obtiene 11.543 por perfil: el mismo
    costo que 1.190.000 con IVA y 3 %. Cambia el registro y el desglose, no el
    costo.
- **Migración nueva** `20261029120000_purchase_tax_on_net`: columna
  `purchase_lines.taxOnNet` y CHECK para que un renglón tenga una sola regla.
  - No recalcula nada: los renglones existentes conservan sus importes y la
    pantalla los identifica («(con IVA)», «Incluido en el bruto»).
  - Aplicada en la base de pruebas. **Pendiente en desarrollo**:
    `pnpm --dir apps/api exec prisma migrate deploy`.
- **Precios de venta**: aceptan renglones de la regla nueva y de la de IVA
  incluido.
- **Filtros de «Compras y costos»** (`GET /purchases`): proveedor (incluye
  inactivos), fecha desde, fecha hasta (ambas incluidas), familia y
  referencia.
  - Se combinan libremente o no se usa ninguno.
  - Fechas inexistentes o invertidas → 400.
- **Pantalla**:
  - el renglón pide, en este orden, valor bruto sin IVA, descuento e IVA;
  - la vista previa muestra descuento, base, IVA, total y costo por perfil;
  - la tabla tiene las columnas valor bruto sin IVA, descuento, base después
    del descuento, IVA de compra, total con IVA y costo por perfil;
  - totales del documento: bruto, descuentos, base, IVA y total. Las compras
    de la regla anterior conservan sus rótulos.
- **Pruebas**:
  - API: unitarias 38/38 (4 nuevas de costeo); e2e 154/154. La #7 pasa a la
    regla nueva, con IVA obligatorio y como máximo 100 %; hay una prueba nueva
    de filtros combinados y fechas inválidas.
  - Web: `tsc`, `oxlint` y build correctos.
  - Navegador, base de pruebas con datos temporales (sufijo 592926, borrados
    por IDs al terminar):
    - filtros solos y combinados (proveedor, proveedor + desde, proveedor +
      referencia, solo referencia, rango, sin resultados, limpiar);
    - detalle y edición de una compra de dos renglones (400.000 − 5 % sin IVA
      = 9.500 por perfil; 100.000 − 10 % + 19 % = 10.710);
    - compra antigua con IVA incluido mostrada con sus rótulos;
    - 375 px sin desbordamiento.
- **Cantidad desde los lotes** (mismo día, solo web):
  - Al marcar lotes en un renglón, «Cantidad de perfiles» se llena con la
    suma de sus perfiles: los ingresados más, en China, lo prerregistrado por
    recibir. La selección de lotes va antes de la cantidad.
  - La cantidad se puede corregir a mano y el aviso de diferencia con los
    lotes se mantiene. Al cambiar los lotes se vuelve a tomar la suma.
  - Si se desmarcan todos, o cambian el material o el origen, se vacía solo
    la cantidad que venía de los lotes.
  - Verificado en navegador con lotes temporales de 250 y 33 perfiles
    (sufijo F1FCC8, borrados): 250, luego 283, manual 280 con aviso, vuelta a
    250, vacía al desmarcar y al cambiar de origen.

## Prerregistro China: cantidad reutilizada y EPC junto a la cantidad (29/10/2026)

Solo web (`ChinaView.tsx`, `App.css`).

- **Orden del formulario**: 1. Reference, 2. Finish / Color, 3. EPC,
  4. Quantity, 5. Save. El EPC y la cantidad van juntos al final: lado a lado
  desde 520 px de ancho y uno debajo del otro en celular.
- **Cantidad reutilizada**:
  - Después de guardar se conserva, igual que referencia y acabado; se puede
    cambiar.
  - Al abrir la pantalla toma la cantidad del último paquete del operador,
    así que vale también tras recargar o en otro equipo.
  - Ya no cuenta como trabajo sin guardar, pero un EPC escrito sí.
- **Lector**:
  - El Enter que envía la pistola tras el EPC pasa a la cantidad, con el
    valor seleccionado, en vez de guardar sin mostrarla. El segundo Enter
    guarda; escribir encima la reemplaza.
  - Tras guardar, el foco vuelve al EPC con `setTimeout` en lugar de
    `requestAnimationFrame`, que no corre si la página no se está pintando: el
    siguiente chip podía quedar escrito en la cantidad.
- **Corregido**: faltaba el punto entre el error del servidor y «Nothing was
  saved.».
- **Verificado en navegador** (base de pruebas, datos temporales con sufijo
  902753; el ajuste `china.supplierId` creado para la prueba se eliminó porque
  no existía antes):
  - 375 px y 768 px;
  - 25, 25 reutilizado y luego 30;
  - tras volver a iniciar sesión empieza en 30;
  - un EPC duplicado se rechaza y conserva la cantidad.
- `tsc`, `oxlint` y build correctos.

## Forma de pago en cotizaciones y autor visible solo para ADMIN (29/10/2026)

- **Migración nueva** `20261029160000_quote_payment_method`. Aplicada en la
  base de pruebas; **pendiente en desarrollo**. Contenido:
  - enum `PaymentMethod` con CASH (Contado – efectivo), TRANSFER (Contado –
    transferencia), PARTIAL (Abono) y CREDIT (Cartera, crédito);
  - en `quotes` y `sales_orders`: `paymentMethod` (nulo en documentos
    anteriores) y `paymentTerms` (texto libre ≤ 300, con CHECK);
  - en `sales_orders`: `convertedById`, con FK a users.

  No asume nada sobre los documentos existentes.
- **Reglas**:
  - Guardar una cotización exige forma de pago; las condiciones son
    opcionales («anticipo del 50 %», «30 días»).
  - La orden copia ambas al convertirse.
  - Una cotización anterior sin forma de pago no se puede convertir (409):
    primero se elige y se guarda.
  - El PDF de cotización y de orden muestra «FORMA DE PAGO» bajo el vendedor
    (no aparece en documentos anteriores).
- **Autoría**:
  - `createdBy`, y en órdenes `convertedBy`, solo llegan a ADMIN, en el
    detalle y en los listados (`forViewer` en `sales.service.ts`). Las demás
    respuestas los omiten.
  - El dueño de la orden sigue siendo el vendedor de la cotización (permisos
    sin cambios). Ahora queda registrado quién la convirtió.
  - En pantalla, ADMIN ve «Creada por X · fecha» en cotización y orden, y
    «creada por X» en las listas. En órdenes anteriores aparece «sin
    registro».
  - El PDF conserva el nombre del vendedor: es dato comercial para el
    cliente.
- **Pruebas**:
  - API: unitarias 39/39 (PDF con y sin forma de pago); e2e 155/155.
  - Casos cubiertos: forma de pago obligatoria y válida, condiciones ≤ 300,
    copia a la orden, autor oculto para SALES y visible para ADMIN en detalle
    y listados, ADMIN que convierte la cotización de un vendedor, y bloqueo
    de conversión sin forma de pago.
  - Navegador, base de pruebas con datos temporales (sufijo 883BFD, borrados
    por IDs):
    - el vendedor no puede guardar sin forma de pago; ve la forma de pago y
      no el autor;
    - ADMIN ve «Creada por» en cotización, orden y listas;
    - los PDF reales muestran la forma de pago.

## Estado de pago de órdenes con abono o crédito (29/10/2026)

- **Migración nueva** `20261029200000_order_payment_status`. Aplicada en
  pruebas; **pendiente en desarrollo**. Contenido:
  - enum `PaymentStatus` (PENDING, PAID);
  - en `sales_orders`: `paymentStatus`, `paymentStatusAt` y
    `paymentStatusById` (FK users);
  - las órdenes existentes con abono o crédito quedan PENDING, sin autor ni
    fecha;
  - CHECK: el estado existe solo y siempre en órdenes PARTIAL o CREDIT.
    Contado (efectivo o transferencia) queda en NULL.
- **Reglas**:
  - Al convertir una cotización con abono o crédito, la orden empieza
    «Pago pendiente».
  - `PATCH /sales-orders/:id/payment-status {status}` (ADMIN, SALES). El
    vendedor solo puede cambiar sus órdenes; otro vendedor recibe 404 y
    bodega, 403.
  - El cambio es reversible, idempotente si el estado no cambia, bloquea la
    orden y queda auditado (`PAYMENT_STATUS_CHANGED` con de → a).
  - En contado responde 409.
  - Quién registró el estado (`paymentStatusBy`) llega solo a ADMIN.
- **Pantalla**:
  - La orden muestra la insignia «Pago pendiente» o «Pagada», la fecha y el
    botón «Marcar como pagada» o «Volver a pendiente». ADMIN ve además «por
    X».
  - La lista de órdenes muestra la misma insignia.
  - El PDF no cambia.
- **Pruebas**:
  - API: e2e 155/155. Casos: pendiente inicial, permisos, valor inválido,
    pagada por el dueño, vuelta a pendiente por ADMIN, idempotencia,
    auditoría, contado 409, y el CHECK de la base aun fuera del API.
  - Navegador (sufijo ABEF31, datos borrados): el vendedor marca pagada y no
    ve el autor; contado sin estado; insignias en la lista; ADMIN ve «por
    Sergio…» y vuelve a pendiente.

## Paquetes abiertos y perfiles sueltos (30/10/2026)

**Modelo.** Un paquete abierto sigue siendo la misma fila `bundles`: su
`quantity` pasa a ser perfiles **sueltos** de su ubicación. Así:
- el total no cambia ni se cuenta dos veces;
- se conservan EPC, historial y lote (procedencia);
- no hace falta un chip nuevo;
- sus reservas quedan en la misma fila: pasan a sueltos sin liberarse.

**Migración nueva** `20261030120000_open_bundles_loose_profiles`. Aplicada en
la base de pruebas; **pendiente en desarrollo**. Contenido:
- tipo de movimiento `OPENING` (saldo antes = después = cantidad; no es
  salida);
- columnas `bundles.openedAt` y `openedById` (FK), con CHECK de que van
  juntas;
- trigger `bundle_opened_is_final`: no se puede reabrir ni deshacer;
- CHECK `inventory_movements_balance_consistent` recreado con OPENING. Se
  compara `type::text`, porque el valor nuevo del enum no se puede usar en la
  misma transacción.
- Los paquetes existentes quedan cerrados.

**API.**
- `POST /inventory/bundles/:id/open {operationKey, reason?}`:
  - roles ADMIN y WAREHOUSE, iguales a salida y traslado;
  - idempotente por clave; otra apertura → 409; vacío → 409.
- **Sueltos primero**:
  - `USE_ORDER` (abiertos por fecha de apertura, luego cerrados FIFO) en
    `ReservationsService.plan`, al confirmar órdenes y en despachos
    parciales;
  - `rebalance` del despacho reescrito: primero sueltos propios y libres de
    la ubicación, después cerrados propios y libres;
  - todos los paquetes implicados se bloquean en una sola sentencia,
    ordenados por id, y el cambio ocurre en la misma transacción.
- **Despacho**:
  - la creación aplica «sueltos primero»;
  - `POST /dispatches/:id/loose/refresh` lo reaplica (por ejemplo, tras
    abrir un paquete);
  - `POST /dispatches/:id/loose/prepare {lines:[{dispatchLineId, quantity}]}`
    prepara los sueltos asignados sin leer chips. Recibe la cantidad que
    mostró la pantalla: si cambió, 409 y no prepara nada; repetirlo no cambia
    nada; queda auditado (`LOOSE_PREPARED`);
  - el detalle informa por renglón `loose {assigned, prepared, toTake,
    missing, places}` y los cerrados reservados (`suggested`, con
    `needsOpening`).
- **Lectura**:
  - leer un paquete abierto → `OPENED`; no prepara nada;
  - leer un cerrado cuando los sueltos cubren el renglón → `LOOSE_FIRST`;
  - si los sueltos cubren solo una parte, el cerrado cubre únicamente el
    faltante.
- **Confirmación**:
  - descuenta automáticamente y es idempotente, como antes;
  - un paquete cerrado que sale en parte se abre ahí (OPENING más EXIT) y su
    resto queda suelto.
- **Corregido** (fallo previo que «sueltos primero» hizo visible):
  - `freeFor` no contaba las reservas de órdenes aún sin despacho
    (`NOT { dispatchLineId }` no incluye NULL);
  - podía planear material ya comprometido; el trigger diferido lo frenaba
    con un 500.
- **Resumen**: `bundles` cuenta solo paquetes cerrados; `looseProfiles`
  aparte; `profiles` es el total una sola vez.

**Web.**
- **Despacho**: aviso grande (`LooseProfilesNotice`) bajo el título, antes
  de los KPI, los renglones y la lectura.
  - Caso A: «RETIRAR N PERFILES SUELTOS DEL ALMACÉN / NO ES NECESARIO ABRIR
    OTRO PAQUETE».
  - Caso B: «USAR PRIMERO N… / FALTAN M…», con dos pasos separados y el
    paquete sugerido con «Abrir paquete» (con confirmación).
  - Datos mostrados: referencia, color, origen y «En el almacén: …»
    (pasillo/burro).
  - Botón «Ya retiré los N sueltos».
  - Al abrir el despacho, su ejecutor reaplica «sueltos primero».
  - Las preparaciones de sueltos se muestran como «Sueltos del almacén».
- **Detalle de paquete**: pestaña «Abrir paquete» (solo cerrado con
  perfiles), aviso de paquete abierto e insignia «Abierto · sueltos».
- **Listado**: insignia «Sueltos». **Resumen**: KPI «Perfiles sueltos» y
  «+ N sueltos» por fila.

**Pruebas.**
- API: unitarias 39/39; e2e 163/163, dos corridas completas. La suite nueva
  `loose-profiles.e2e-spec.ts` (8 pruebas) cubre:
  1. abrir 30 da 30 sueltos con el mismo total;
  2. reintento sin duplicar, segunda apertura rechazada (API y trigger) y
     carrera de dos aperturas (20 rondas);
  3. entregar 25 deja 5, y confirmar dos veces no descuenta de nuevo;
  4. la siguiente orden de 5 usa esos 5 y no toca el paquete cerrado;
  5. orden de 25 con 5 sueltos: faltan 20; al abrir el de 30 se entregan 25
     y quedan 10;
  6. otro color, origen desconocido o China y otro proveedor no se ofrecen;
  7. dos despachos creados a la vez no comparten sueltos (20 rondas);
  8. un cerrado que sale en parte se abre al confirmar.
- Ajustes en suites existentes:
  - totales del resumen con `looseProfiles`;
  - el lector fijo responde `LOOSE_FIRST` cuando el renglón ya tiene
    sueltos;
  - la prueba de la outbox procesa lotes hasta atender su fila, porque fallaba
    con suites paralelas que dejan avisos.
- **Navegador** (sufijo 5BD291, datos borrados):
  - caso A en escritorio y caso B en 375 px, sin desbordamiento;
  - abrir desde el despacho, preparar 25 sin leer chips y confirmar: quedan
    10 sueltos (historial ENTRY 30 → OPENING 30 → EXIT 20);
  - resumen, listado y detalle muestran los sueltos;
  - pestaña «Abrir paquete» probada.
- Web: `tsc`, `oxlint`, build y Chafon 7/7.

**Límites y decisiones.**
- La salida manual parcial desde el inventario no abre el paquete (flujo
  existente sin cambios); para usar parte de un paquete, lo correcto es
  «Abrir paquete».
- Los sueltos de varios paquetes abiertos del mismo lugar se consumen en
  orden de apertura; el trabajador no elige lotes.
- El traslado entre bodegas sigue siendo el existente: el aviso indica
  trasladar el paquete al almacén del despacho y abrirlo allí.

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
7. ~~Clientes, cotizador, orden y relación con despacho~~ (hecho 26/10/2026,
   ver «Origen, compras, ventas y despachos»). Pendiente: migración en
   desarrollo/VPS, datos reales y pruebas físicas.
8. ~~Tareas: propias, asignación por ADMIN, completar, vencimiento →
   incompletas~~ (hecho 16/10/2026). Pendiente de negocio: recurrencia,
   editar/cancelar tareas, reabrir o prorrogar una incompleta, notificaciones.
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
