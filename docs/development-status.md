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

## Descuento global de cotizaciones y autorización (30/10/2026)

**Objetivo.** Descuento sobre toda la cotización, conservando el descuento por
renglón. El vendedor aplica solo de 0,1 % a 3 %; para más envía una solicitud
a un administrador que él elige, que la recibe como tarea. Si la aprueba, el
descuento se aplica.

**Cálculo** (`sales/pricing.ts`, pruebas en `pricing.spec.ts`).
- Orden: subtotal → descuento del renglón → descuento global → IVA.
- Global = base (subtotal − descuentos de renglón) × %, redondeado al centavo.
  Se reparte entre renglones en proporción a su base (`allocate`, suma exacta),
  y el IVA de cada renglón se calcula sobre lo que queda (las tasas pueden
  diferir).
- Cada renglón guarda su parte (`globalDiscountAmount`); su `taxAmount` y
  `lineTotal` ya la incluyen. Documento: `discountTotal` = descuentos de
  renglón; `globalDiscountPercent` / `globalDiscountAmount` aparte;
  total = subtotal − descuentos de renglón − global + IVA = Σ totales de
  renglón.
- Aprobar recalcula desde los valores guardados de los renglones, sin volver a
  leer precios. La orden copia los campos de la cotización y sus renglones.

**Reglas.**
- Valores válidos: 0 (sin descuento) o de 0,1 % a 100 %, hasta 2 decimales
  (DTO y CHECK `quotes_global_discount` / `sales_orders_global_discount`).
- SALES: hasta 3 % (`SELLER_GLOBAL_DISCOUNT_LIMIT`), o hasta el mayor
  porcentaje aprobado para esa cotización. Más → 403 con indicación de
  solicitar autorización. ADMIN aplica cualquier valor válido.
- Solicitud (`POST /quotes/:id/discount-requests` {percent, approverId,
  reason?}): solo SALES sobre su cotización vigente; el porcentaje debe superar
  su límite; el aprobador debe ser ADMIN activo.
  - Crea la tarea `DISCOUNT_APPROVAL` del administrador (vence en 24 h; después
    queda pendiente como atrasada, igual que las de despacho) y el aviso push
    `discount-requested` por la outbox.
  - Una sola solicitud pendiente por cotización (índice único parcial). Repetir
    la misma no crea otra; pedir otra distinta → 409 hasta cancelarla.
  - La cotización conserva su descuento actual mientras tanto y **no se
    convierte en orden** con una solicitud pendiente (409).
- Respuesta: solo el administrador elegido aprueba o rechaza
  (`.../:requestId/approve|reject`). Otro administrador → 403.
  - Aprobar aplica el porcentaje y recalcula; rechazar acepta un motivo
    opcional.
  - Ambas completan la tarea y avisan al vendedor (`discount-resolved`).
  - Repetir la misma respuesta no cambia nada; contradecirla → 409.
- Cancelar (`.../:requestId/cancel`): el vendedor dueño o un ADMIN. Cancelar
  la cotización también cancela su solicitud abierta. En ambos casos la tarea
  queda cancelada y sale de pendientes.
- `GET /sales/discount-approvers`: administradores activos (id y nombre).
- Todo bajo bloqueo de la fila de la cotización; auditoría
  `DISCOUNT_REQUESTED/APPROVED/REJECTED/CANCELLED`.

**Migración** `20261030160000_quote_global_discount` (revisada; aplicada solo a
la BD de pruebas):
- columnas con valor 0 en quotes, sales_orders y sus renglones (los documentos
  existentes no cambian);
- tabla `quote_discount_requests` con CHECK de estado y longitudes, y sin
  autoaprobación;
- `TaskKind.DISCOUNT_APPROVAL`, `tasks.discountRequestId`, CHECK
  `tasks_discount_request_link` y `tasks_completed_before_due` recreado
  (comparando `kind::text`) para que estas tareas se respondan después del
  vencimiento.

**Web.**
- Cotización:
  - campo «Descuento global (%)» con el límite del usuario;
  - vista previa de totales con la misma regla de reparto;
  - si supera el límite: selector de administrador, motivo y botón «Guardar y
    solicitar autorización»;
  - bloque de la solicitud: proyección del total si se aprueba, botones
    Aprobar/Rechazar para el elegido, Cancelar para los demás, e historial;
  - convertir deshabilitado con solicitud pendiente.
- Tarea: botón «Revisar y responder» que abre la cotización.
- Orden y PDF: «Descuentos por renglón» y «Descuento global (x %)» aparte, con
  nota de que los totales por renglón ya lo incluyen.
- Service worker: textos de los dos avisos nuevos.

**Pruebas.**
- API unitarias 43/43; e2e 172/172.
- Suite nueva `quote-discounts.e2e-spec.ts` (9 pruebas): límites por rol,
  cálculo y copia a la orden, flujo completo de solicitud/tarea/aprobación,
  rechazo, cancelación, validaciones y cuatro carreras de 10 rondas:
  - aprobar contra cancelar;
  - dos solicitudes a la vez;
  - aprobar contra una edición del vendedor;
  - aprobar contra convertir.
- Navegador (sufijo B51FEF, datos borrados por ID): 2,5 % aplicado con la
  vista previa igual al servidor; solicitud de 6 % a la administradora
  elegida; tarea recibida; aprobación con el total proyectado; rechazo de 8 %
  con motivo; sin desbordamiento a 375 px.
- Web: `tsc`, `oxlint` y build.

**Límites y decisiones.**
- El límite de 3 % aplica al descuento global. El descuento por renglón se
  mantiene como estaba, sin límite por rol. Un vendedor podría dar descuentos
  altos por renglón; si eso no se quiere, hay que extender la regla.
- Una aprobación vale para la cotización aunque después cambien sus
  renglones.
- El vendedor puede bajar el porcentaje aprobado; para pasarlo, pide otra
  autorización.
- La pantalla de la cotización no se refresca sola: el vendedor ve la
  respuesta al volver a abrirla (o por el aviso push).

## Precio manual en cotizaciones con autorización (04/11/2026)

**Objetivo.** Que ventas pueda poner un precio manual en cualquier renglón (haya
o no precio habilitado o inventario), con una justificación, y que un
administrador elegido lo autorice (pudiendo corregirlo) antes de imprimir o
convertir la cotización. Con aviso visible de la solicitud en curso,
advertencia antes de perder su avance y auditoría completa. Ventas solo cotiza
referencias existentes; solo ADMIN crea referencias (ya era así: las
escrituras del catálogo sin `@Roles` son solo ADMIN en `RolesGuard`; ahora lo
cubre una prueba).

**Reglas.**
- **Renglón manual** (`QuoteLineDto`): `manualUnitPrice` (> 0, máximo 2
  decimales), `priceReason` (obligatoria, mínimo 10 caracteres) y
  `estimatedUnitCost` (opcional, > 0). Se guarda con
  `pricingMethod = MANUAL` (ya existía en el esquema y su CHECK exige motivo).
  Sin precio manual, un color sin precio habilitado se rechaza indicando que se
  puede usar precio manual.
- **Autorización por renglón** (`manualApprovedById/At`):
  - ADMIN: queda autorizado al guardar (auditoría `MANUAL_PRICE_APPLIED`).
  - SALES: queda sin autorizar hasta que el administrador elegido lo apruebe.
  - Al editar la cotización se conserva solo en renglones iguales: referencia,
    color, origen, proveedor, cantidad, precio, descuento, justificación y
    costo. Si cambia algo se pierde (auditoría `MANUAL_PRICE_APPROVAL_LOST`
    con antes y después).
- **Sin autorizar**: SALES no descarga el PDF (409) y nadie convierte (409).
  Una solicitud pendiente de cualquier tipo también bloquea la conversión.
- **Solicitud** (`POST /quotes/:id/price-requests` {approverId, reason?,
  replace?}):
  - Cubre todos los renglones manuales sin autorizar. Guarda en `details` una
    instantánea de cada uno: precio propuesto, precio habilitado si existe,
    costo estimado, margen y justificación.
  - Crea una tarea del administrador (mismo tipo `DISCOUNT_APPROVAL`, título
    «Autorizar precio manual») y el aviso push `price-requested`.
  - Una pendiente por cotización y tipo. Repetir la misma no cambia nada; otra
    distinta exige `replace` (si no, 409 «se pierde su avance»). Con `replace`
    la anterior queda CANCELLED con `replacedById` y su tarea cancelada.
  - Editar la cotización de forma que la solicitud quede desactualizada exige
    `replacePendingPriceRequest`. Sin él, 409 y no se guarda nada; con él, la
    solicitud se cancela con nota en la auditoría. Las ediciones que no tocan
    los renglones manuales no la afectan.
- **Respuesta** (`.../:requestId/approve` {lines?: [{lineNo, unitPrice}]} y
  `/reject` {resolution?}):
  - Solo el administrador elegido responde; puede corregir cualquier precio al
    aprobar.
  - Aprobar recalcula renglones y totales (con descuento global si hay), marca
    los renglones como autorizados, guarda el precio aprobado en `details` y
    avisa al vendedor (`price-resolved`).
  - Repetir la misma respuesta no cambia nada; contradecirla da 409.
- **Cancelar**: `.../:requestId/cancel`, por el vendedor dueño o un ADMIN.
  Cancelar la cotización cancela sus solicitudes abiertas de ambos tipos.
- **Orden**: copia `manualPrice`, `priceReason` y `manualApprovedById`
  (CHECK `sales_order_lines_manual_price`).

**Auditoría** (entidad Quote), con usuario de la sesión, fecha y datos:

| Acción | Contenido |
|---|---|
| `MANUAL_PRICE_REQUESTED` | aprobador, solicitud reemplazada y renglones |
| `MANUAL_PRICE_CANCELLED` | motivo: editada, reemplazada, retirada o cotización cancelada |
| `MANUAL_PRICE_APPROVED` | precio propuesto vs. aprobado, si hubo corrección |
| `MANUAL_PRICE_REJECTED` | motivo |
| `MANUAL_PRICE_APPROVAL_LOST` | renglones antes y después |
| `MANUAL_PRICE_APPLIED` | precios puestos por ADMIN |
| `CONVERTED` | orden creada y los precios manuales que lleva |

**Migración** `20261104120000_quote_manual_price` (revisada; aplicada solo a la
BD de pruebas):
- Enum `QuoteRequestKind` (GLOBAL_DISCOUNT, MANUAL_PRICE).
- En `quote_discount_requests`: `kind`, `details`, `replacedById`, y
  `requestedPercent` pasa a ser opcional.
- CHECK `quote_discount_requests_values` recreado por tipo.
- Índice de pendiente única por (cotización, tipo).
- Columnas de autorización y costo estimado en `quote_lines`, con su CHECK.
- Campos de precio manual en `sales_order_lines`, con su CHECK.
- Los renglones MANUAL que ya existieran quedan autorizados por el creador de
  su cotización (eran precios de ADMIN según las reglas anteriores).

**Web (cotización).**
- Casilla «Precio manual» en cada renglón, con:
  - precio (precargado con el habilitado si existe);
  - costo estimado;
  - «¿Por qué el precio es manual?», con ejemplos;
  - margen estimado y estado «✓ Autorizado por X» o «Sin autorizar».
- Selector «Administrador que autoriza», compartido con el descuento global, y
  botón «Guardar y solicitar autorización».
- Aviso «PRECIO MANUAL EN SOLICITUD · pendiente de autorización de X», con la
  tabla propuesto / habilitado / costo / margen / justificación.
- El administrador elegido corrige los precios en la misma tabla y aprueba o
  rechaza; los demás pueden cancelar.
- Antes de perder una solicitud en curso aparece la confirmación «Sí, cancelar
  la solicitud y guardar».
- Historial de solicitudes, incluidas las correcciones («$11.500 → $11.800»).
- Sin PDF ni conversión mientras haya precios sin autorizar.
- Orden: «Precio manual autorizado por X» en el renglón.
- Service worker: textos de los dos avisos nuevos.

**Pruebas.**
- API unitarias 43/43; e2e 184/184.
- Suite nueva `quote-manual-price.e2e-spec.ts` (13 pruebas):
  - catálogo solo ADMIN y referencia inexistente rechazada;
  - validaciones;
  - bloqueo de PDF y conversión;
  - flujo con tarea, aviso, corrección, auditoría y orden;
  - pérdida de autorización al editar;
  - reemplazo con consentimiento;
  - rechazo, retiro y cancelación de la cotización;
  - precios de ADMIN;
  - convivencia con el descuento global;
  - tres carreras de 10 rondas: aprobar contra editar, dos reemplazos a la vez
    y aprobar contra convertir.
- Navegador (sufijo F478DA, datos borrados por ID):
  - solicitud desde la pantalla del vendedor;
  - edición con confirmación de pérdida;
  - tarea de la administradora y aprobación corrigiendo de 11.500 a 11.800;
  - auditoría verificada en la base;
  - sin desbordamiento a 375 px.
- Web: `tsc`, `oxlint` y build.

**Límites y decisiones.**
- Una solicitud cubre todos los precios manuales sin autorizar de la
  cotización; se aprueban juntos (con corrección por renglón).
- ADMIN puede descargar el PDF de una cotización con precios sin autorizar
  (vista previa); SALES no.
- El tipo de tarea sigue llamándose `DISCOUNT_APPROVAL` para ambos tipos de
  solicitud; el título la distingue.

## Ventas por vendedor y estado de pago (04/11/2026)

**Objetivo.** Que el administrador vea quién vendió qué y si está pagado, para
liquidar comisiones. Decisiones del usuario:
- El contado (efectivo o transferencia) queda como estaba, sin estado de pago.
- Se agrega una lista con filtros y totales.

**Vendedor.** Es el dueño de la orden (`createdById`, quien hizo la
cotización), aunque otra persona la haya convertido.
- Antes la lista mostraba «creada por» con quien la convirtió. Ahora muestra
  «vendedor X» y, si es distinto, «convertida por Y»; el detalle igual.
- Solo ADMIN lo ve, como antes.

**API.**
- `GET /sales-orders` acepta `sellerId`, `dateFrom` y `dateTo` (día de
  creación en Bogotá, ambos incluidos), y
  `payment=PAID|PENDING|NONE` (NONE = contado), además de `status`.
- Los filtros se combinan con AND. Para SALES el alcance propio se combina
  también con AND: la prueba nueva encontró que el filtro por vendedor lo
  pisaba y el vendedor recibía sus órdenes aunque pidiera las de otro.
- `GET /sales-orders/summary` (solo ADMIN, mismos filtros): una fila por
  vendedor, con:
  - órdenes, base sin IVA después de descuentos (base de comisión) y total con
    IVA;
  - esos mismos valores separados en pagado, pendiente y contado.

  Sin filtro de estado no cuenta las órdenes canceladas.

**Web.** En «Órdenes de venta» (ADMIN):
- Filtros: vendedor, desde, hasta, pago y estado.
- Tabla «Ventas por vendedor»: vendido, pagado, pago pendiente y contado, cada
  celda con la base sin IVA y el total con IVA. Clic en un vendedor lo filtra.
- Cada orden muestra al vendedor y una insignia «Pagada», «Pago pendiente» o
  «Contado».

**Pruebas.**
- API unitarias 43/43; e2e 188/188.
- Suite nueva `sales-commissions.e2e-spec.ts` (4 pruebas):
  - el vendedor es el dueño aunque convierta ADMIN;
  - filtros combinados y fechas inválidas;
  - resumen con montos exactos y sin canceladas;
  - SALES solo ve lo suyo y no accede al resumen.
- Navegador (sufijo 328EF0, datos borrados por ID): resumen, filtro por
  vendedor y por pago, sin desbordamiento a 375 px.
- Web: `tsc`, `oxlint` y build.

**Límites.**
- La comisión no se calcula: no hay porcentajes definidos. El resumen da la base
  y el total para liquidarla.
- Una orden de contado no indica si realmente se cobró; si hace falta, hay que
  extender el estado de pago al contado.

## Búsqueda de cliente en la cotización (06/11/2026)

**Problema.** «Buscar cliente» solo filtraba en silencio la lista desplegable
de al lado: no se veía ningún resultado ni se seleccionaba nada. Además, el
NIT se comparaba tal cual («900123456» no encontraba «900.123.456-7») y el
nombre distinguía tildes («pena» no encontraba «Peña»).

**Solución.**
- API `GET /customers?search=`, solo clientes activos y hasta 50 resultados:
  - el nombre ignora mayúsculas y tildes;
  - el NIT ignora puntos, guiones y espacios;
  - `%` y `_` del usuario se toman literalmente.
- Web: componente nuevo `CustomerPicker`, un solo campo «Cliente»:
  - al escribir (pausa de 250 ms) muestra los resultados debajo;
  - clic o Enter elige el primero;
  - el elegido se muestra con su NIT y un botón «Cambiar»;
  - avisa cuando no hay coincidencias y sugiere «+ Cliente nuevo»;
  - un cliente recién creado queda elegido.

**Pruebas.**
- Suite nueva `customers-search.e2e-spec.ts` (3 pruebas): tildes y mayúsculas,
  NIT con o sin símbolos, inactivos excluidos y `%`/`_` literales.
- API unitarias 43/43; e2e 191/191.
- Navegador (sufijo 8C5748, datos borrados por ID): «pena ventaneria» encuentra
  «Peña Ventanería»; «900857» encuentra «900.857.111-2»; Enter elige; sin
  resultados; crear cliente; «Cambiar»; sin desbordamiento a 375 px.
- Web: `tsc`, `oxlint` y build.

## Catálogo de referencias y selector para celular (06/11/2026)

**Fuente.** `Catalogo_Solualuminios.xlsx`, hoja «Referencias», primeras 4 columnas
más «Estado de familia» y «Otras familias»: 218 referencias en 23 familias
(máximo 21 por familia). Se convirtió a `apps/api/prisma/data/catalog-references.csv`
(columnas `familyCode, familyName, referenceCode, description, familyHint,
familyToValidate`).
- **Familias sin código (18):** códigos asignados aquí, con el nombre
  exactamente como lo conocen. Por ejemplo, `KALIMA-KIMBAYA` → «KALIMA -
  KIMBAYA», `TAIRONA-ZINU`, `COLOSAL-2.6`, `ASTRAL-1.7`, `SIDERAL-2.4`,
  `DIVISION-BANO`, `VARIOS-VITRAL`, `TUBULARES-ALETA`, `ANGULOS-ANCLAJE`,
  `CIRCULO-1/4`. Las demás llevan su nombre como código.
- **Familias con código en el archivo:** conservan el suyo (`744`, `3831`,
  `5020`, `7038`, `8025`).
- **Decisiones del usuario:**
  - los acabados quedan como estaban (no se importan los del archivo);
  - una referencia tiene una sola familia (la de la columna B). Las 9 que
    también aparecen en otra guardan solo una pista de texto (`familyHint`,
    «También aparece en: …») que se ve en pantalla; no la usa ningún filtro,
    total ni compra;
  - las 9 «familia por validar» se importan con la familia propuesta y el
    reporte las lista para revisarlas.
- **Códigos de referencia:** ahora admiten un espacio entre partes («703 CURVO»,
  «3604 LENNER»; 5 casos en el catálogo). Validación en el DTO y en el
  administrador; se normalizan espacios repetidos.

**Migración** `20261106120000_reference_family_hint` (revisada; aplicada solo a
la BD de pruebas): columna opcional `references.familyHint` con CHECK de 1 a 200
caracteres.

**Importador** (`src/modules/catalog/catalog-import.ts` y
`src/scripts/import-catalog.ts`; desde `apps/api`: `pnpm build`, luego
`pnpm catalog:import`):
- **Por defecto solo simula** y reporta: familias y referencias nuevas, campos
  vacíos que completaría, conflictos, inactivas y «por validar».
- `--apply` aplica en una transacción y deja una auditoría
  `CATALOG_IMPORTED`. Crea y completa campos vacíos, y **nunca borra ni
  desactiva**.
- Una referencia existente con otra familia u otra descripción se reporta como
  conflicto y se conserva. Solo `--overwrite` la reemplaza (también el nombre de
  una familia).
- La pista de familia siempre sigue al catálogo.
- Un archivo con errores (código inválido, referencia repetida, familia con dos
  nombres) no escribe nada.
- Ejecutarlo dos veces da lo mismo: la segunda vez reporta 0 nuevas y 218 sin
  cambios.
- Usa `DATABASE_URL` de `.env` y solo imprime el nombre de la base y el host.
- Si faltan migraciones, lo dice.

**API.**
- `GET /catalog/references?search=` busca por código o descripción, sin
  importar mayúsculas ni tildes, con el código exacto primero. Se combina con
  `familyId` y devuelve hasta 50 resultados.
- Crear y editar referencias acepta `familyHint`. Las escrituras del catálogo
  siguen siendo solo de ADMIN.
- Utilidades compartidas `shared/search.ts` (`escapeLike`, `foldAccents`),
  usadas también por la búsqueda de clientes.

**Web.**
- «Registrar paquete» usa las listas desplegables de siempre (`CatalogSelectors`
  con `requireFamily`):
  - la familia es obligatoria y se muestra con su número de referencias
    («KALIMA - KIMBAYA (14)»), en orden natural;
  - «Referencia» queda bloqueada («Elige primero la familia») hasta elegir
    familia, y luego lista solo las de esa familia, en orden natural de
    código;
  - si la referencia aparece en otra familia, se muestra «También aparece en:
    …» bajo la lista;
  - encima de la lista de familias hay un cuadro «Buscar por nombre o código».
    Lo escrito (p. ej. «Kim», «puerta», «744») deja en la lista solo las
    familias que coinciden, sin importar mayúsculas ni tildes, y el primer
    renglón dice cuántas coinciden o que ninguna. Vacío, muestra todas. La
    familia ya elegida no se pierde aunque no coincida con lo escrito.
- Las demás pantallas que usan los selectores (cotización, compras, lotes,
  filtros) no cambian.
- Administrador de referencias: códigos con espacio y el campo «También
  aparece en…».

**Pruebas.**
- Suite nueva `catalog-import.e2e-spec.ts` (6 pruebas):
  - el archivo real es válido (23 familias, 218 referencias, 9 por validar);
  - simular no escribe; aplicar crea; repetir no cambia nada;
  - conflictos conservados y reemplazados solo con `--overwrite`;
  - un archivo inválido no escribe;
  - búsqueda;
  - código con espacio y escritura solo de ADMIN.
- API unitarias 43/43; e2e 197/197.
- Navegador a 375 px:
  - catálogo real importado en la BD de pruebas con el script (y una segunda
    ejecución sin cambios);
  - búsqueda «387»; familia KALIMA - KIMBAYA con sus 14 referencias; pista de
    la 177; «Últimas usadas»;
  - sin desbordamiento;
  - limpieza por códigos exactos del CSV (218 referencias, 23 familias,
    usuario, ubicación y acabados de prueba).
- Web: `tsc`, `oxlint` y build.

**Selector descartado (06/11/2026).** Se probó un selector con pestañas,
tarjetas de familia y búsqueda por código. El usuario prefirió volver a las
listas desplegables con la familia obligatoria, y se retiró
(`ReferencePicker`, «Últimas usadas»). Se conservan del API:
- `activeReferences` en `GET /catalog/families`;
- la búsqueda `?search=` (código exacto primero y luego por longitud).

Quedan también las correcciones de pruebas hechas entonces: la suite
`catalog-import` borra todas sus auditorías y la prueba de la lista completa
de `catalog-families` tolera suites en paralelo.

**Pendiente para usar el catálogo.** En la base de desarrollo faltan las
migraciones `20261104120000_quote_manual_price` y
`20261106120000_reference_family_hint`; después de aplicarlas, ejecutar la
simulación y luego `--apply`. Igual en el servidor.

## Almacenes sin pasillo ni burro y traslado de varios paquetes (12/11/2026)

**Objetivo.** La bodega de la 116 manda paquetes completos al almacén del 7
de agosto, que vende todo por sueltos y no recibe de China. Decisiones del
usuario:
- Todos los almacenes trabajan sin pasillo ni burro; esa organización es solo
  de las bodegas.
- El traslado es inmediato (sin estado «en camino») y de paquetes completos.
- Se pueden trasladar varios paquetes en una sola operación.

**Regla.** La define el tipo de ubicación existente, sin migración nueva:
- `WAREHOUSE` (bodega): exige pasillo y burro.
- `RETAIL_STORE` (almacén): rechaza burro.

Todo paquete que llega a un almacén queda abierto en la misma transacción,
con un movimiento `OPENING` después del registro o traslado y un motivo que
lo explica. Aplica a:
- el registro de paquetes;
- la recepción de prerregistros de China;
- el traslado individual;
- el traslado múltiple.

Un paquete abierto que vuelve a una bodega sigue abierto y necesita burro. Los
paquetes cerrados que ya estuvieran en un almacén no se tocan.

**API.**
- `inventory.shared.ts`: `requirePlace` (ubicación activa y burro según el
  tipo) y `storeOpeningReason`.
- `rackId` pasa a ser opcional en el registro, el traslado y la recepción. Lo
  exige o lo rechaza el tipo de ubicación; la cadena vacía cuenta como
  ausente.
- Nuevo `POST /inventory/bundles/transfer` (ADMIN, WAREHOUSE):
  - recibe `{operationKey, bundleIds[1..200], inventoryLocationId, rackId?,
    reason?}`;
  - es todo o nada en una transacción, con las filas bloqueadas en orden;
  - si hay problemas (agotado, reservado, ya en el destino, inexistente), los
    informa todos juntos en `problems` y no mueve nada;
  - claves `bundle-transfer:<key>:<bundleId>` (`:open` para la apertura);
  - un reintento con la misma clave devuelve el resultado guardado (200), y
    con otros datos responde 409;
  - responde `{count, profiles, opened, bundles}`.
- `POST /locations/aisles` rechaza almacenes.

**Web.**
- `LocationSelectors` guarda el tipo de ubicación y oculta pasillo y burro en
  los almacenes, con un aviso.
- `placeReady` y `placePayload` (en `lib/forms.ts`) se usan en el registro, la
  recepción de China y el traslado individual.
- El traslado individual avisa que el paquete queda abierto al llegar a un
  almacén.
- Lectura masiva:
  - para ADMIN y WAREHOUSE, panel «Trasladar los paquetes leídos»
    (`BulkTransferPanel`) con destino, motivo o remisión, revisión y
    confirmación;
  - excluye agotados y los que ya están en el destino, y avisa cuántos
    quedarán abiertos;
  - conserva la clave mientras el resultado sea incierto;
  - «Quitar» por chip para descartar paquetes vecinos leídos por error.

**Pruebas.**
- Suite nueva `retail-store-loose.e2e-spec.ts` (5 pruebas):
  - burro exigido o rechazado según el tipo;
  - pasillos rechazados en almacenes;
  - registro en almacén abierto desde el inicio;
  - traslado de 4 paquetes, 3 abiertos al llegar, con sueltos sumados y
    reintento idempotente;
  - todo o nada con varios problemas y validaciones;
  - traslado individual de ida y vuelta.
- API unitarias 43/43; e2e 202/202; `oxlint` del API y la web; build web.
- Navegador, BD de pruebas:
  - seed `sdui/seed10.mjs` con sucursal 116 (bodega), 7 de agosto (almacén) y
    3 paquetes;
  - lectura manual de los 3 chips y uno inexistente («Quitar»);
  - traslado al almacén: 3 abiertos;
  - resumen del almacén con 60 sueltos;
  - registro con pasillo y burro ocultos;
  - 375 px sin desbordamiento;
  - limpieza con `--clean` por IDs exactos.

**Datos agregados en desarrollo (autorizado por el usuario).** En
`solaluminios_dev` se creó la sucursal `7-AGOSTO` («7 de agosto») con su
almacén `ALM-7-AGOSTO` («Almacén 7 de agosto», `RETAIL_STORE`). Solo se
agregaron registros; el script del scratchpad (`sdui/create-7agosto.mjs`) no
hace nada si ya existen.

**Verificación «Consultar chip → Traslado» (BD de pruebas).**
- La consulta encuentra el paquete aunque el código se escriba en minúsculas;
  un chip inexistente ofrece registrarlo.
- Traslado entre burros de la bodega: el mismo burro queda bloqueado con
  aviso.
- Traslado al almacén: pasillo y burro se ocultan; el paquete queda abierto y
  el historial muestra el traslado (con remisión) y la apertura.
- Volver a trasladar al mismo almacén queda bloqueado.
- Se corrigió la redacción del motivo de apertura, que repetía «almacén
  Almacén…».

**Pantalla blanca en «Consultar chip → Traslado» y traslado de pocos
paquetes (12/11/2026).**
- No se reprodujo con el código actual. Se probó con los datos reales de
  desarrollo mediante un API alterno (puerto 3101) y un usuario temporal
  WAREHOUSE (luego ADMIN):
  - paquete cerrado y paquete abierto;
  - escritorio y 375 px;
  - el usuario se borró por ID y sin movimientos;
  - no se confirmó ningún traslado.
- Causa probable: una pestaña abierta desde antes de los cambios, con la
  recarga en caliente de Vite en estado inconsistente.
- `ViewErrorBoundary` envuelve cada pantalla de `App.tsx`: si una falla, en
  vez de quedar en blanco muestra el mensaje con «Intentar de nuevo» e «Ir al
  inicio», y lo registra en la consola.
- La pestaña «Traslado» del paquete (`TransferForm`) usa ahora
  `BulkTransferPanel` en modo `embedded`:
  - lista «Este paquete» y permite agregar otros por chip (pistola en modo
    teclado o escrito, con Enter);
  - avisa chips repetidos, inexistentes o agotados;
  - permite quitar paquetes;
  - un paquete solo también se traslada por `POST /inventory/bundles/transfer`.
- Verificación en la BD de pruebas:
  - un paquete al almacén: quedó abierto, con traslado y apertura en el
    historial;
  - dos paquetes juntos a otro burro: después figuran como «ya están en el
    destino»;
  - sin errores de consola.
- Web: `tsc`, `oxlint` y build.

## QA exploratorio de usuario y correcciones (12/11/2026)

**Sesión de QA.** En la BD de pruebas, con el script `sdui/seed11.mjs`
(base, http y clean; limpieza por IDs y restauración de ajustes):
- 6 usuarios de todos los roles, sucursales 116 y 7 de agosto, catálogo,
  compras y precios, y 11 paquetes.
- Se recorrieron como usuario: registro, consulta, lectura masiva y
  traslado, operaciones, ventas (descuentos, precio manual, conversión,
  reserva, cancelación), despachos en almacén y en bodega, permisos,
  administración, 375 px y corte del API.
- Sin errores 500.

**Correcciones de los hallazgos importantes.**
1. **Doble clic al guardar una cotización creaba dos.** `QuoteView` atiende
   una solicitud a la vez (`once`, con ref) en guardar, convertir, crear
   cliente y cancelar.
2. **Descuento por renglón sin tope.** `SELLER_LINE_DISCOUNT_LIMIT` = 3 %
   para vendedores.
   - Más solo con precio manual, porque el administrador autoriza el renglón
     con su descuento.
   - Un renglón guardado antes con más se conserva si no cambia.
   - ADMIN no tiene tope.
   - La pantalla explica la regla.
   - Las pruebas que usaban 10 % con SALES pasan a 3 %.
3. **Precios con separador de miles.** `parseMoney` (`lib/numbers.ts`, con
   pruebas en `scripts/numbers.test.mts`) acepta «12.000», «$ 1.500» y
   «1.500,50», en el precio manual, el costo estimado y la aprobación del
   administrador.
   - Mensaje claro cuando el valor no es válido.
   - El motivo por el que no se puede guardar se muestra junto al botón (antes
     solo era un `title`).
   - El descuento global y el de renglón muestran su error.
4. **Límites por IP.** El inicio de sesión pasa de 5 a 30 por minuto y el
   límite general de 120 a 600, porque una sucursal comparte IP. El bloqueo
   por cuenta (5 fallos → 15 min) no cambia.
   - Mensaje 429 en español.
   - El cliente web traduce los mensajes técnicos de validación
     (`friendlyValidation`: «Paquete 2: La cantidad…»).
5. **Cantidades absurdas.** El registro tiene tope de 1.000.000 en pantalla.
   Más de 1.000 perfiles pide confirmar una vez. El DTO da el mensaje en
   español.
6. **Clientes duplicados.** No se repite un NIT en cualquier formato (se
   ignoran puntos, espacios y el dígito tras el guion), al crear ni al
   editar. Respuesta 409 con el nombre del cliente existente; los clientes
   sin NIT no se comparan.

Además: concordancia y separador de miles en el panel de traslado.

**Pruebas.**
- API: unitarias 43/43; e2e 204/204 (nuevas: tope por renglón en
  `quote-discounts` y NIT duplicado en `customers-search`); `oxlint`.
- Web: `tsc`, `oxlint`, `pnpm test` (chafon 7/7, numbers 14/14) y build.
- Navegador (BD de pruebas):
  - «Para guardar: Elige la forma de pago»;
  - aviso de 10 % por renglón;
  - «12.000» → $120.000;
  - triple clic → una sola cotización;
  - NIT duplicado rechazado;
  - aprobación con «1.800»;
  - 2.000.000 frenado y 999.999 confirmado;
  - 32 inicios de sesión → 429 con mensaje en español.

**Notificaciones.** El API las tiene activas (`/push/config` entrega la
llave pública) y las 9 pruebas e2e de push pasan con un emisor simulado. En
el navegador integrado el permiso está bloqueado y la app lo explica. La
entrega real a un celular no se verificó.

## Forma de pago al convertir, no al cotizar (13/11/2026)

**Problema.** Una cotización puede ser solo una consulta, así que la forma de
pago pasa a ser **opcional en la cotización** y **obligatoria al convertirla
en orden de venta**. No hace falta migración: las columnas ya admitían NULL.

**API.**
- `SaveQuoteDto.paymentMethod` es opcional.
- `ConvertQuoteDto` acepta `paymentMethod` y `paymentTerms` opcionales.
  - Al convertir se usa la forma enviada o la guardada en la cotización.
  - Si no hay ninguna, responde 400: «Elige la forma de pago para convertir
    la cotización en orden de venta».
  - Lo elegido también queda guardado en la cotización, y la auditoría
    `CONVERTED` registra la forma de pago.
  - Abono y crédito siguen naciendo con pago pendiente.
- El PDF de una cotización sin forma de pago omite esa línea.

**Web.**
- El campo de la cotización se llama «Forma de pago (opcional)», con la
  opción «Por definir». Ya no bloquea el guardado.
- La cabecera muestra «por definir (se elige al convertir en orden de venta)».
- «Convertir en orden de venta» en una cotización sin forma de pago abre un
  paso con forma (obligatoria) y condiciones, con la sugerencia según la
  forma elegida.
- Si la cotización ya tiene forma de pago, convierte directo, como antes.

**Pruebas.**
- `sales-dispatch`: una cotización sin forma de pago se guarda y no se
  convierte (400); con una forma inválida también responde 400; con
  forma y condiciones se convierte y la cotización las conserva.
- Se quitó la aserción antigua que exigía la forma de pago al cotizar.
- API: unitarias 43/43, e2e 204/204 y `oxlint`. Web: `tsc`, `oxlint` y build.
- Navegador (BD de pruebas, `seed11` con limpieza):
  - cotización guardada sin forma de pago, con cabecera «por definir»;
  - el paso de conversión exige elegir;
  - con Abono y «Anticipo del 50 %», doble clic → una sola orden
    (OV-010164) con pago pendiente.

## Aviso al vendedor cuando el administrador responde (13/11/2026)

**Objetivo.** El proceso de solicitudes (descuento global y precio manual) no
cambia. Ya existía un push «Respondieron tu solicitud…», pero solo llega con
la app compilada y el dispositivo suscrito. Ahora el vendedor también se
entera dentro de la app.

**Migración nueva:** `20261113120000_request_answer_seen`.
- Agrega `quote_discount_requests."requesterSeenAt"` (TIMESTAMPTZ, nulo) y
  el índice (`requestedById`, `requesterSeenAt`).
- Las solicitudes ya respondidas se marcan vistas en su `resolvedAt`, para no
  anunciarlas de nuevo.
- Se verificó con `prisma migrate diff` (sin diferencias) en la BD de
  pruebas.
- **Pendiente aplicarla en desarrollo y en el servidor** (`prisma migrate
  deploy`).

**API.**
- Push con el resultado: `discount-approved`, `discount-rejected`,
  `price-approved` y `price-rejected`. Se conservan los `*-resolved` para
  avisos ya encolados.
- `GET /sales/request-updates` (ADMIN, SALES) devuelve las respuestas no vistas
  de las solicitudes del usuario de la sesión: cuántas y las 20 más recientes,
  con cotización, cliente, estado, quién respondió y motivo.
- `POST /quotes/:id/request-updates/seen` las marca vistas. Solo actúa sobre
  las del propio usuario y repetirlo no cambia nada.

**Web.**
- `lib/requestUpdates.ts` las carga cada minuto, al volver a la ventana y al
  marcarlas vistas.
- Contador en «Ventas» del menú.
- Aviso «Tienes N respuestas nuevas a tus solicitudes» (`RequestUpdatesNotice`)
  en Inicio y en Ventas:
  - aprobado: «Descuento global de 5 % aprobado por …: ya quedó aplicado»;
  - rechazado: «… rechazado por …: «motivo»»;
  - con «Ver cotización».
- Al abrir la cotización, sus respuestas quedan vistas y el aviso desaparece.
- Textos push en `sw.ts`, discretos para la pantalla bloqueada.

**Pruebas.**
- Nueva e2e en `quote-discounts`:
  - push aprobado y rechazado;
  - aviso con motivo, visible solo para el vendedor;
  - otro vendedor no puede marcarlo como visto;
  - visto al abrir;
  - WAREHOUSE recibe 403.
- Se actualizaron los tipos en `quote-discounts` y `quote-manual-price`.
- API: unitarias 43/43, e2e 205/205 y `oxlint`. Web: `tsc`, `oxlint` y build.
- Navegador (BD de pruebas, `seed11` con limpieza):
  - la vendedora pide 5 % y un precio manual;
  - la administradora aprueba el descuento y rechaza el precio con motivo;
  - la vendedora ve «2» en Ventas y las dos respuestas en Inicio;
  - «Ver cotización» limpia el contador y el aviso;
  - el outbox tiene `discount-approved` y `price-rejected`.

## Cotizaciones de Detal y Ventanería (17/11/2026)

**Decisiones del usuario.**
- Ensamble e instalación **sin IVA** y **sin descuentos**.
- Sin tope, pero desde $1.000.000 se pide confirmar.
- **No cuentan en la base de comisión.**
- La lista de cotizaciones marca las que tienen mano de obra.
- Las cotizaciones existentes quedan como Detal.

**Migración** `20261117120000_quote_sale_type_services`:
- Enum `SaleType` (RETAIL/WINDOWS).
- En `quotes` y `sales_orders`: `saleType` (por defecto RETAIL) y
  `assemblyAmount`/`installationAmount` (decimal, por defecto 0).
- CHECK `*_services_valid`: valores ≥ 0, y RETAIL ⇒ ambos en 0.
- Los valores existentes no cambian.

**API.**
- `documentTotals(lines, services)`: total = Σ líneas + ensamble +
  instalación. El servicio es obligatorio en la firma, así que el compilador
  obliga a pasarlo en guardar, recalcular, aplicar el descuento global y
  proyectar la solicitud (`servicesOf`).
- `saleOf`: Detal con servicios responde 400; no se descarta en silencio.
- La conversión copia la modalidad y los servicios a la orden. Los servicios
  no son renglones, así que no se reservan ni se despachan.
- El PDF agrega el bloque «SERVICIOS DE VENTANERÍA (SIN IVA, SIN DESCUENTO)»
  y separa materiales, IVA de materiales, ensamble e instalación.
- La base de comisión sigue siendo subtotal − descuentos.

**Web.**
- Selector de modalidad.
- Tarjeta «Mano de obra (Ventanería)» con `parseMoney`.
- Pasar a Detal limpia los valores con un aviso visible.
- Confirmación desde $1.000.000.
- Vista previa con servicios; `totalsParts` los muestra.
- Marca «Ventanería · con mano de obra» en la lista.
- Modalidad visible en la cotización y en la orden («no se despacha»).

**Pruebas.**
- `pricing.spec`: servicios sin IVA ni descuento.
- `sales-pdf.spec`: bloque de servicios, solo los cobrados.
- e2e en `quote-discounts`:
  - Detal con servicios responde 400;
  - el descuento global de 3 % no toca los servicios;
  - la aprobación conserva el total con servicios;
  - la orden hereda modalidad y servicios, con solo los renglones de
    material;
  - CHECK en la BD.
- Navegador:
  - COT con ensamble $150.000 e instalación $1.200.000 (pidió
    confirmación): total $1.439.285,11, igual en la vista previa y en el
    servidor;
  - pasar a Detal mostró el aviso;
  - la orden conservó los servicios.

## Solicitud de materiales Ventas → Bodega → 7 de agosto (17/11/2026)

**Decisiones del usuario.**
- Paquetes completos, que pasan a sueltos al enviarse al almacén.
- Los bodegueros preparan por **turnos**; Ventas puede cambiar al
  responsable.
- El 7 de agosto tiene una tarea para marcar el pedido como recibido.
- El material queda disponible en el almacén **desde que sale** de bodega.

**Diseño.** Es un flujo propio, porque el despacho de ventas asume salidas
parciales por línea de orden y «preparado = autorizado». Reutiliza:
- `stock_reservations` y su trigger por paquete;
- `matchBundle` (referencia, color, origen, proveedor, ubicación);
- `moveBundle`, extraída de los traslados (TRANSFER y apertura en el
  almacén);
- tareas y outbox.

**Migración** `20261117130000_material_requests`. Se generó con
`prisma migrate diff` y se le agregaron reglas propias:
- tablas `material_requests`, `material_request_lines` y
  `material_request_picks`;
- secuencia `material_request_number_seq` (`SM-000001`);
- `TaskKind` + `MATERIAL_REQUEST`/`MATERIAL_RECEPTION`, con
  `tasks.materialRequestId` (único por solicitud y tipo);
- `stock_reservations.salesOrderLineId` pasa a admitir NULL, más
  `materialRequestLineId`, con CHECK «exactamente uno»;
- `inventory_movements.materialRequestId`;
- CHECK de coherencia de estados, origen ≠ destino, cantidades > 0 y
  longitudes;
- los datos existentes no cambian.

**API** (`modules/material-requests`).
- `GET /material-requests/workers?sourceLocationId` da los bodegueros de esa
  bodega y a quién le toca. El turno se calcula con la última solicitud de la
  misma bodega, con un bloqueo de asesoría para que dos envíos simultáneos no
  le lleguen a la misma persona.
- `POST /material-requests` crea y envía. El origen es una bodega y el
  destino un almacén.
  - No mueve ni reserva nada.
  - Crea la tarea `MATERIAL_REQUEST` y el push `material-request-assigned`.
  - Es idempotente con `operationKey`.
- Lista y detalle con alcance por rol: ADMIN todo; SALES las propias;
  WAREHOUSE las que prepara o recibe y las de su ubicación. El detalle trae
  solicitado / preparado / despachado / pendiente por renglón, sugerencias de
  paquetes libres (sueltos primero) y permisos.
- `POST :id/picks` (bodeguero asignado o ADMIN):
  - por chip, o sueltos de un paquete abierto por id;
  - valida con `matchBundle`;
  - rechaza paquetes con reservas;
  - reserva el paquete **completo**;
  - lo preparado puede superar lo pedido, y se avisa cuánto sobra.
  `POST :id/picks/:pickId/remove` libera la reserva.
- `POST :id/ship` (idempotente):
  - verifica cantidad, ubicación y reserva de cada paquete;
  - consume las reservas;
  - registra TRANSFER y OPENING con `materialRequestId`;
  - completa la tarea de preparación;
  - crea la tarea `MATERIAL_RECEPTION` para el personal del almacén, por
    turnos (o para quien la pidió si no hay personal);
  - envía push a quien recibe y a quien la pidió.
- `POST :id/receive` (personal del almacén o ADMIN; nota opcional) completa
  la tarea y avisa a quien la pidió.
- `POST :id/assignee` y `POST :id/cancel`: solo quien la creó o ADMIN, antes
  de la salida. Cancelar libera las reservas y cancela la tarea.
- Las tareas de estos tipos no se cierran con la ruta genérica (409).

**Web.**
- Menú «Solicitudes a bodega» y mosaico «Solicitudes» en Inicio (para
  celular).
- `MaterialRequestsView`: pestañas por estado.
- `MaterialRequestView`:
  - crear: bodega y almacén preseleccionados cuando hay uno, bodeguero por
    turno («(turno)») cambiable, fecha límite, renglones con catálogo, origen,
    proveedor opcional y disponibilidad en la bodega;
  - detalle: preparar por chip o «Tomar sueltos», quitar, confirmar salida,
    recibir con novedades, cambiar responsable y cancelar.
- `TaskCard` con «Preparar solicitud» y «Revisar y marcar recibido».
- Textos push en `sw.ts`.

**Pruebas.**
- Nueva `material-requests.e2e-spec.ts` (7 pruebas):
  - turnos e idempotencia;
  - validaciones y alcance;
  - cambio de responsable;
  - preparación (origen, material, inexistente, repetido, excedente,
    reservado, sueltos, quitar);
  - salida concurrente con la misma clave: un solo TRANSFER y OPENING por
    paquete, reservas consumidas, `ledgerProblems` vacío, tareas y push;
  - recepción;
  - cancelación y el CHECK de reservas.
- Crea su paquete de China con su lote directamente, sin tocar el ajuste
  global del proveedor de China, que revisa la suite `sales-dispatch` en
  paralelo.
- API: unitarias 45/45, e2e 213/213 (26 suites) y `oxlint`. Web: `tsc`,
  `oxlint`, `pnpm test` y build.
- Navegador (BD de pruebas, `seed11` con limpieza ampliada):
  - SM-000007 de 50 perfiles, sin chips, asignada por turno;
  - el bodeguero rechazó un chip de China, no sumó la lectura repetida y
    preparó 60 de 50;
  - doble clic al confirmar → un solo TRANSFER y OPENING por paquete;
  - la cotera recibió la tarea y la marcó recibida con nota;
  - a 375 px sin desbordes.
- Un intento intermedio de la prueba creó el ajuste global del proveedor de
  China. Al limpiar, quedaron restos de una ejecución fallida de
  `sales-dispatch` (sufijo `855BB9D1`). Se borraron solo sus dos filas de
  `settings`; sus demás registros siguen en la BD de pruebas.

**Pendiente.** Aplicar las migraciones `20261117120000` y `20261117130000` en
desarrollo y en el servidor (`prisma migrate deploy`).

**Pendientes de QA (no corregidos).**
- Contraseñas solo con regla de longitud; no hay cambio de contraseña.
- Avisos viejos que no se limpian.
- Colores en minúscula en incidencias.
- Sueltos sin separar por origen en Resumen.
- No probados: pistola y lectores físicos, entrega real de push, iPhone,
  PDF y recepción de China.

**Pendientes.**
- No hay pantalla para crear ubicaciones: el almacén del 7 de agosto debe
  crearse con tipo `RETAIL_STORE`, porque el tipo no se edita.
- El resumen no separa los sueltos por origen. Las reservas y despachos sí
  los separan.

## Exportación a Excel de ventas para comisiones (17/11/2026)

**Decisiones del usuario.** Solo el administrador exporta. La comisión la
calculan ellos; el archivo trae la base. La segunda hoja trae el detalle de
cada renglón. Las órdenes canceladas se incluyen, marcadas en rojo.

**API.**
- `GET /sales-orders/export` (`@Roles('ADMIN')`, declarada antes de
  `sales-orders/:id`) acepta los mismos filtros que la lista y el resumen
  (`OrderListQueryDto`: vendedor, desde, hasta, pago, estado) y devuelve un
  `.xlsx` con nombre `ventas[_vendedor]_<desde|inicio>_a_<hasta|hoy>.xlsx`.
- `sales-export.ts` genera el libro con ExcelJS 4.4.0 (nueva dependencia del
  API, versión fija):
  - «Órdenes»: una fila por orden con vendedor, quién la convirtió, cliente y
    NIT, modalidad, forma y estado de pago, estado de la orden, cotización,
    materiales antes de descuentos, descuentos, **base de comisión** (sin IVA,
    sin ensamble ni instalación), IVA, ensamble, instalación, total y motivo
    de cancelación;
  - «Renglones»: una fila por renglón con referencia, color, origen,
    proveedor, cantidad, precio (y si fue manual), descuentos, base, IVA y
    total;
  - «Resumen»: filtros usados, quién generó el archivo y los totales por
    vendedor de `ordersSummary` (sin canceladas, salvo filtro «Cancelada»);
  - montos como celdas numéricas con formato de pesos; fechas a la hora de
    Bogotá; encabezado fijo con autofiltro; canceladas con fondo rojo en
    «Órdenes» y «Renglones».
- Tope de 10.000 órdenes por archivo: por encima responde 400 pidiendo acotar
  fechas.
- CORS expone `Content-Disposition` para que la web lea el nombre del archivo
  (también aplica al PDF).

**Web.** Ventas → Órdenes (administrador): botón «Exportar a Excel» bajo los
filtros. `DownloadPdfButton.tsx` ahora exporta un `DownloadButton` genérico.

**Pruebas.**
- `sales-export.spec.ts` (6): hojas y orden, montos numéricos, hora de
  Bogotá, rojo solo en canceladas, texto con «=» queda como texto, resumen.
- `sales-commissions.e2e-spec.ts`: exportación filtrada por vendedor y día,
  cancelada en rojo, renglones, resumen, 400 por fechas invertidas y 403 para
  SALES.
- API: unitarias 51/51, e2e 214/214 (26 suites), `oxlint` y build. Web:
  `tsc`, `oxlint`, `pnpm test` y build.
- Navegador (BD de pruebas, administrador temporal creado y borrado): descarga
  sin filtros (12 órdenes, 6 canceladas en rojo) y con filtro de vendedor; a
  375 px sin desbordes.
- `pnpm audit`: ExcelJS solo añade un aviso moderado de `uuid@8` (funciones
  v3/v5/v6 con buffer, que ExcelJS no usa).

## Catálogo de accesorios (17/11/2026)

**Decisiones del usuario.** Dos familias, «Accesorios» y «Accesorios Yale».
El código de cada accesorio es interno e inventado; en pantalla se ve el
código del proveedor o, si no tiene, solo la descripción. Se guarda la marca.
Alcance: **solo catálogo**. Venderlos o inventariarlos queda pendiente de
definir color y unidad (unidad, metro o rollo).

**Cambio de alcance explícito.** AGENTS.md describe la referencia como perfil.
Los accesorios entran como referencias de familias de tipo `ACCESSORY` y no
participan en operaciones. No se añadió Product, SKU ni unidad.

**Migración `20261117140000_accessory_catalog`** (aditiva; aplicada en la BD
local de desarrollo el 17/11/2026):
- enum `ProductKind` (`PROFILE`, `ACCESSORY`);
- `product_families.kind`, por defecto `PROFILE`, así que las familias
  existentes no cambian;
- `references.supplierCode` (puede repetirse; conserva ceros iniciales) y
  `references.brand`.

**API.**
- `catalog-kind.ts`: `withFamilyKind`, `isAccessory` y el mensaje común.
- Rechazan referencias de accesorios (400): registro de paquetes, prerregistro
  de China, lotes de apertura, compras, cotizaciones y solicitudes de
  materiales.
- Catálogo:
  - la búsqueda incluye código de proveedor y marca;
  - las referencias aceptan `supplierCode` y `brand` al crear y editar;
  - las familias aceptan `kind` al crearse; no se cambia después.
- Importador: columnas opcionales `familyKind,supplierCode,brand`. Un valor
  vacío no borra nada. Un código de proveedor o una marca distintos son
  conflicto, y el tipo de una familia existente solo cambia con `--overwrite`.

**Datos.**
- `prisma/data/catalog-accessories.csv`, generado del libro
  `Catalogo_Accesorios_Solualuminios.xlsx`:
  - 100 en ACCESORIOS (`ACC-001`…`ACC-100`) y 28 en ACCESORIOS-YALE
    (`YALE-001`…`YALE-028`), en el orden del libro;
  - 61 sin código de proveedor.
- Cargado en la BD local con
  `pnpm catalog:import --file prisma/data/catalog-accessories.csv --apply`.
  Una segunda corrida da 0 cambios.
- Notas del libro conservadas tal cual:
  - UA-138 y UA138 están por validar;
  - las filas 91 y 97 se consolidaron;
  - hay erratas de origen, como «DUMI SENCIILA» y «NAYLON».

**Web.**
- `CatalogSelectors` no ofrece familias ni referencias de accesorios, así que
  quedan fuera de todos los selectores operativos.
- Administración → Familias: columna Tipo y tipo al crear.
- Administración → Referencias: código del proveedor o «Sin código», con el
  código interno en pequeño; marca junto a la descripción; edición del código
  de proveedor y la marca; búsqueda por esos campos.
- `referenceLabel(ref, accessory)` arma la etiqueta sin el código interno.

**Pruebas.**
- `catalog-accessories.e2e-spec.ts` (6): archivo real válido; importación
  idempotente; conflictos y tipo; búsqueda; rechazo en paquetes y
  cotizaciones; creación de familia y edición.
- API: unitarias 51/51, e2e 220/220 (27 suites), `oxlint` y build. Web:
  `tsc`, `oxlint` y build.
- Navegador sobre la BD local (API aparte en el puerto 3101): Referencias
  muestra «S38312F · BISAGRA REVERSIBLE · PRODUCTOS EUROPEOS» y «Sin código ·
  BRAZOS DE 8"». Los filtros de Paquetes no ofrecen accesorios.

**Pendiente.**
- ~~En el servidor: `prisma migrate deploy` y la importación del CSV~~
  (hecho el 18/11/2026; ver «Despliegue en producción»).
- Para venderlos: color (o «sin color»), unidad (unidad, metro o rollo) y
  cómo se muestran en cotizaciones y PDF.

## Rol Facturación (18/11/2026)

**Decisiones del usuario.**
- La factura electrónica se hace en otro software; la app solo centraliza la
  información.
- El vendedor marca «Requiere facturación» al convertir la cotización o
  después en la orden.
- Hay una sola persona de facturación.
- Al marcarla, el cliente necesita NIT o cédula y correo.
- El número de factura es obligatorio al marcar la orden como facturada.

**Migración `20261118120000_order_billing`** (aditiva; aplicada en la BD local
de desarrollo el 18/11/2026):
- `UserRole.BILLING` y `TaskKind.BILLING`;
- en `sales_orders`: `requiresBilling`, `billingRequestedAt`, `invoiceNumber`,
  `billedAt` y `billedById`, más un índice por `(requiresBilling, billedAt)`;
- `tasks.salesOrderId`, único por `(salesOrderId, kind)`;
- CHECK `tasks_sales_order_link` y `sales_orders_billing_valid`. La factura
  solo existe si se requiere, y número, fecha y autor van juntos.

**API.**
- `RolesGuard`: BILLING, como CHINA_OPERATOR, solo entra a rutas que lo
  nombran. Se añadieron roles explícitos a las lecturas de tareas y a
  `push/config`. No ve inventario, cotizaciones, resumen ni usuarios.
- Rutas:
  - `GET /sales-orders`, `/:id` y `/:id/pdf` admiten BILLING, que solo ve
    las órdenes con `requiresBilling`;
  - filtro `billing=PENDING|BILLED`;
  - `PATCH /sales-orders/:id/billing {required}` (ADMIN, SALES dueño);
  - `POST /sales-orders/:id/invoice {invoiceNumber}` (ADMIN, BILLING):
    completa la tarea y avisa al vendedor;
  - `PATCH /customers/:id/billing-data {taxId, email}`: solo esos dos campos.
- `ConvertQuoteDto.requiresBilling`. Sin NIT y correo del cliente responde
  400 y no crea la orden.
- Asignación de la tarea:
  - al único usuario activo de facturación;
  - si hay varios, por turno;
  - si no hay ninguno, al administrador activo más antiguo, con una nota en
    la tarea.
- Desmarcar antes de facturar cancela la tarea y avisa a facturación. Volver
  a marcar reabre la misma tarea. No se desmarca una orden ya facturada (409).
- Cancelar la orden:
  - sin factura, cancela la tarea;
  - ya facturada, crea una tarea GENERAL «Anular factura …» para facturación,
    con aviso.
- El mismo número de factura dos veces no cambia nada; uno distinto da 409.
- Avisos: `billing-requested`, `billing-cancelled`, `billing-void-needed` y
  `order-billed`.
- El Excel de comisiones suma las columnas «Requiere facturación», «N° de
  factura» (o «Pendiente») y «Facturada el».

**Web.**
- Rol «Facturación» con menú propio (Inicio, Facturación y Tareas) y vista
  `BillingView`, con las pestañas «Por facturar» y «Facturadas».
- Orden:
  - tarjeta «Facturación electrónica», con la casilla «Requiere facturación»
    para el vendedor o el administrador y el registro del número de factura
    para facturación;
  - si faltan datos del cliente, los pide ahí mismo;
  - facturación no ve las acciones de confirmar, despachar, cobrar ni
    cancelar.
- Conversión: el diálogo siempre se abre (forma de pago precargada) e incluye
  la casilla, con NIT y correo si faltan.
- Lista de órdenes: etiquetas «Por facturar» y «Factura FE-…».
- Tarea BILLING: «Ver orden y facturar».

**Pruebas.**
- `order-billing.e2e-spec.ts` (5): datos del cliente obligatorios; tarea
  asignada; alcance de facturación (403 o 404 fuera de sus órdenes); factura
  idempotente y 409; anulación al cancelar una orden facturada; marcar,
  desmarcar y reabrir; tareas propias.
- `sales-export.spec.ts`: columnas de facturación (7 en total).
- API: unitarias 52/52, e2e 225/225 (28 suites), `oxlint` y build. Web:
  `tsc`, `oxlint`, `pnpm test` y build.
- Navegador (BD de pruebas, `seed11` con un usuario de facturación, ya
  limpiada):
  - la vendedora convirtió COT-016292 con «Requiere facturación»; pidió el
    correo y dejó el NIT precargado;
  - facturación vio solo su menú y la tarea, descargó el PDF de OV-014439 y
    registró FE-20931;
  - la vendedora ve «Factura FE-20931»;
  - a 375 px sin desbordes.

**Pendiente.**
- Crear el usuario real con rol Facturación (Administración → Usuarios).
- ~~En el servidor: `prisma migrate deploy`~~ (hecho el 18/11/2026).

## Disponibilidad por ubicación en la cotización (18/11/2026)

**Problema.** La 177 negro pintura mostraba «Disponible China: 18 perfiles»
a Wesales, cuya ubicación es Bodega de prueba. Los 18 estaban en Almacén 7 de
agosto (1 paquete, lote China). `GET /sales/availability` sin
`inventoryLocationId` sumaba todas las ubicaciones. La orden se reserva en una
sola ubicación al confirmarla, así que el sistema no reservaba lo que no hay,
pero la cifra de la cotización confundía. No hubo error de datos.

**API.** Sin cambios en el contrato: cada grupo (origen + proveedor)
conserva sus totales y agrega `locations` con `id`, `name`, `type`,
`bundles`, `physical`, `reserved` y `available`. Las ubicaciones se ordenan
de mayor a menor disponible.

**Web (cotización).**
- La cifra principal es la de la ubicación predeterminada del vendedor:
  «Disponible China en Bodega de prueba (tu ubicación): 0 perfiles».
- El resto aparece aparte: «En otras ubicaciones: Almacén 7 de agosto: 18».
- **Aviso** cuando la cantidad pedida supera lo que hay en su ubicación:
  - si hay en otras ubicaciones: se reserva en una sola; elegir la ubicación
    al confirmar o pedir un traslado;
  - si no hay en ninguna: la orden quedaría pendiente de abastecimiento.
- **Sin ubicación predeterminada** (p. ej. un administrador): el total, con
  el desglose entre paréntesis.
- El origen desconocido se cuenta en el mismo alcance.

**Archivos.** `sales/reservations.service.ts`; `web/lib/commerce.ts`
(`locations`, `availableByLocation`); `web/views/QuoteView.tsx`; `App.css`
(`.stock-warning`); `test/sales-dispatch.e2e-spec.ts`.

**Pruebas.**
- e2e `sales-dispatch`: 27/27. Comprueba el desglose filtrado (solo esa
  ubicación) y sin filtro (la suma por ubicación cuadra con el grupo).
- API: unitarias 52/52, `oxlint` y build. Web: `tsc` y `oxlint`.
- **Navegador** (BD de desarrollo, vendedor temporal en Bodega de prueba;
  se abrió una cotización sin guardar y el vendedor se borró por su id):
  - 177 negro pintura: tu ubicación 0, Almacén 7 de agosto 18;
  - con 5 perfiles aparece el aviso;
  - sin ubicación: «18 perfiles (Almacén 7 de agosto: 18)»;
  - a 375 px sin desbordes.

## Despliegue en producción (18/11/2026)

Lo hizo el usuario en el servidor (`/srv/solaluminios`, base
`solaluminios_prod`, commit `b427d499`). Aquí se resume la salida que pegó.

**Migraciones** (`prisma migrate deploy`): se aplicaron
`20261106120000_reference_family_hint`, `20261113120000_request_answer_seen`,
`20261117120000_quote_sale_type_services`, `20261117130000_material_requests`,
`20261117140000_accessory_catalog` y `20261118120000_order_billing`. El
resultado fue «Database schema is up to date».

**Comprobación:** la página responde HTTP 200 y `/api/tasks` sin sesión
responde 401.

**Catálogo** (`pnpm catalog:import` desde `apps/api`; primero simulación,
luego `--apply`). Producción no tenía familias ni referencias: no hubo
conflictos.
- **Perfiles** (`catalog-references.csv`): 23 familias y 218 referencias
  nuevas. Las 9 «por validar» (177, 413, 1122, 1123, 840, 3709, T166, 315,
  T237) entraron con la familia propuesta.
- **Accesorios** (`catalog-accessories.csv`): 2 familias (ACCESORIOS y
  ACCESORIOS-YALE) y 128 referencias.
- Una segunda corrida dio «0 nuevas, 218 sin cambios».

**Pendiente en producción.**
- Crear el usuario de Facturación.
- Revisar la ubicación predeterminada de cada vendedor: de ella depende la
  disponibilidad que muestra la cotización.
- Validar las 9 referencias «por validar».

## Base limpia para arrancar en producción (18/11/2026)

**Decisión del usuario:** en una semana, arrancar con una base sin pruebas,
solo con el catálogo. Opción elegida: base nueva. La actual se renombra a
`solaluminios_pruebas` y se conserva; no se borra tabla por tabla.

**Hallazgo.** No hay pantallas para crear acabados, sucursales, ubicaciones,
pasillos ni burros (solo `POST` del API). Una base vacía los perdería.

**Script nuevo `pnpm structure:copy`** (`src/scripts/copy-structure.ts`):
- copia esas cinco tablas desde otra base del mismo servidor, con sus mismos
  ids; ninguna tiene relación con usuarios;
- por defecto solo simula; `--apply` aplica en una transacción y deja la
  auditoría `STRUCTURE_COPIED`;
- solo copia lo activo;
- `--exclude-branch` y `--exclude-location` dejan fuera la estructura de
  prueba; un código inexistente da error;
- se niega a aplicar sobre la misma base o sobre una que ya tenga estructura;
- solo imprime nombres de base, nunca credenciales.

**Guía:** `docs/deploy/base-limpia.md`:
- días antes: desplegar, revisar con la simulación, anotar la configuración;
- el corte: detener, respaldar, renombrar, crear, migrar, catálogo,
  estructura, administrador con `read -s`, iniciar y configurar en la app;
- cómo volver atrás.

**Ensayo local completo** (PostgreSQL 18; la base de desarrollo hizo de
producción actual y solo se leyó):
- renombrar con conexiones cerradas y crear con el mismo dueño, codificación
  y configuración regional;
- 20 migraciones y los dos catálogos;
- la simulación de `structure:copy` mostró 6 acabados activos, omitió el
  inactivo y rechazó un código inexistente;
- `--apply` excluyendo `TEST-C7923B31` copió solo 7 de agosto;
- en una segunda base, la copia de pasillos y burros conservó sus relaciones;
- una segunda aplicación y origen igual a destino se rechazaron;
- `create-admin` creó uno y rechazó el segundo;
- resultado: solo catálogo (25 familias, 346 referencias), 6 acabados, una
  sucursal, 1 usuario y 3 auditorías; contadores de numeración en cero;
- **navegador** (API apuntando a la base del ensayo): inicio de sesión
  correcto; Registrar paquete ofreció las 23 familias de perfiles, los 6
  acabados y solo 7 de agosto; Ventas, «Sin cotizaciones»;
- después se borraron las tres bases del ensayo y se quitó la entrada
  temporal de `.claude/launch.json`.

**Pendiente.**
- Desplegar el commit con `structure:copy` antes del corte.
- Pasar a los CSV las correcciones del catálogo antes del corte.

## Manual de usuario: Ventas (18/11/2026)

El usuario pidió manuales en PDF: primero Ventas, luego Bodega y Administración.

- **Entregado:** `docs/manual/Manual-Ventas.pdf`, de 29 páginas. Fuente en
  `manual-ventas.html` con estilos compartidos en `assets/manual.css`; cómo
  regenerarlo, en `docs/manual/README.md`.
- **Contenido:**
  - ingreso, menú y celular;
  - consulta de inventario;
  - cotizaciones, con disponibilidad por ubicación, precio manual y descuentos;
  - órdenes: conversión, reserva, pago y facturación;
  - despachos, solicitudes a bodega, tareas y preguntas frecuentes.
- **Pantallazos** (41, en `docs/manual/img`):
  - tomados con Edge sin ventana, nítidos y del mismo tamaño;
  - la captura del panel del navegador recortaba la imagen por el escalado al
    125 %;
  - en una base local de demostración, `solaluminios_ensayo_manual`: catálogo
    real y personas, clientes y proveedores ficticios;
  - las capturas que requieren un celular o hardware real quedan marcadas como
    «Pantallazo pendiente».
- **Base de demostración:** se conserva para los manuales de Bodega y
  Administración; se borra al terminarlos.

**Manual de Bodega** (`Manual-Bodega.pdf`, 27 páginas, 33 pantallazos
`bodega-*`):
- registrar paquetes: inventario existente o entrada nueva, la lista por
  guardar y el guardado definitivo;
- consultar y operar un paquete: abrir, salida, traslado e historial (los
  ajustes son del administrador);
- lectura masiva y traslado masivo;
- despachos: lectura, incidencia resuelta y salida confirmada;
- solicitudes de materiales: preparar, despachar y recibir en el almacén;
- tareas y preguntas frecuentes.

Por decisión del usuario se omite Recepción China.

## Documentos actualizados para el cambio de equipo (20/11/2026)

El usuario cambia de computador y pidió dejar el contexto completo en GitHub.

**Documentos reescritos:**
- **`docs/project-context.md`:** contexto vigente completo, que reemplaza la
  versión del 13/10. Cubre qué hace, roles, reglas, arquitectura, entornos,
  comandos, estado y pendientes, más un anexo con los hallazgos de fase 1 que
  siguen vigentes (Excel, China, pisos, fase 2).
- **`docs/next-task.md`:** próximas tareas reales: el corte a base limpia, el
  manual de Administración y la configuración de producción.
- **`CLAUDE.md` y `START-HERE.md`:** quitan la restricción vieja «no ampliar al
  cotizador ni al frontend» y la tarea de familias, ya hecha. Ya no suponen una
  ruta fija de Windows. Agregan el primer encargo para retomar el proyecto en un
  equipo nuevo.
- **`README.md` de la raíz:** era de un paquete antiguo y estaba en UTF-16;
  ahora es un índice en UTF-8.

**Herramientas de los manuales en el repositorio** (`docs/manual/herramientas/`):
- `driver.mjs` y `m.sh`: Edge sin ventana para los pantallazos;
- `demo-db.mjs`: la base de demostración;
- `seed-manual.mjs`: los datos, sin depender de otra base;
- `demo-api.mjs`: preparar estados por el API.

Las rutas son relativas al repositorio. Los `.json` con contraseñas de
demostración y las salidas quedan fuera de Git. `.claude/launch.json` suma la
configuración `api-manual`.

**Verificado:** sintaxis de los cuatro scripts. `counts` sobre la base de
demostración funciona con las rutas nuevas. El guard rechaza
`DROP DATABASE solaluminios_dev` y la base de desarrollo sigue intacta.

## Proyecto retomado en el equipo nuevo (20/11/2026)

Primer encargo de `START-HERE.md`. No se cambió código.

**Equipo:**
- Git 2.56, Node 24.22.3 (MSI de nodejs.org, con checksum y firma
  verificados), pnpm 11.4.0, PostgreSQL 18.7 y VS Code;
- repositorio en `C:\dev\Aduvidrios`, rama `main` al día con `origin/main`;
- los tres `.env` de `apps/api` vienen de la USB y Git los ignora.

**Base local:**
- `solaluminios_dev` y `solaluminios_ensayo_manual` se restauraron con
  `pg_restore --single-transaction` desde volcados del equipo anterior
  (PostgreSQL 18.6, formato custom), copiados a `C:\dev\respaldos`, fuera
  del repositorio;
- ambas tienen UTF8 y `Spanish_Colombia.1252`;
- `prisma migrate status`: 20 migraciones, «Database schema is up to date»;
- `solaluminios_dev`: 8 usuarios, 26 familias, 348 referencias, 35 paquetes
  y 31 cotizaciones; la de demostración: 6 usuarios, 25 familias y 346
  referencias;
- `pnpm test:db:setup` creó `solaluminios_dev_e2e_test`.

**Verificación:**
- API: `prisma generate`, `build` y `lint` correctos; `pnpm test` 52/52.
- Web: `build` y `lint` correctos (aviso de un archivo JS de más de 500 kB);
  `pnpm test` con Chafon 7/7 y números 14/14.
- API `pnpm test:e2e`:
  - primera corrida, 223/225: fallaron 2 de `material-requests.e2e-spec.ts`;
  - el archivo solo dio 7/7;
  - segunda corrida completa, 225/225.

**Diferencias con lo documentado:**
- En un clon nuevo hay que ejecutar `pnpm exec prisma generate` en `apps/api`
  antes de `pnpm build`, porque `src/generated/prisma/` no está en Git. La
  sección 10 de `docs/project-context.md` no lo menciona.
- **Fallo intermitente en `material-requests.e2e-spec.ts`.** El test «the
  shipment transfers…» usa `s.bundle2`, que se asigna al final del test
  anterior («preparing by chip…»). Si ese falla, el siguiente cae en cadena
  con `findUniqueOrThrow` sin id. La causa del primer fallo no quedó en la
  salida guardada; queda por reproducir.

## Diseño del rol Accesorios (24/11/2026)

El usuario pidió plantear un rol de Accesorios. Solo diseño: no se cambió
código ni la base.

**Decisiones del usuario:**
- las cajas son canastas fijas de la bodega, con un chip por canasta
  (referencia y color);
- las compras se echan en la canasta y la entrada se digita a mano;
- los accesorios se venden completos;
- los colores son los mismos acabados;
- la persona de Accesorios genera un despacho que le llega a ella misma y
  registra la salida, todo auditable.

**Propuesta** (`docs/accesorios-fase-1.md`):
- canasta = `Bundle`;
- recarga con `ENTRY` sobre la canasta existente, que el CHECK
  `inventory_movements_balance_consistent` ya admite;
- vale de salida asignado a sí misma, con salidas `EXIT` vinculadas;
- rol `ACCESSORIES` restringido como `BILLING`;
- ajustes solo del administrador.

**Revisado en el código:**
- las salidas parciales ya existen (`BundleExitDto.quantity`);
- los despachos actuales exigen una orden de venta (`Dispatch.salesOrderId`),
  por eso el vale es un documento aparte;
- el registro de paquetes rechaza accesorios en `inventory.service.ts`.

**Segunda ronda de decisiones (mismo día):**
- todo lo que sale es para la venta;
- en las entradas basta el soporte, y el administrador recibe una tarea
  informativa sin autorizar;
- no hay canastas repetidas;
- si Ventas cotiza y despacha accesorios, a Bodega solo le llegan los
  perfiles y a Accesorios, los accesorios.

**Cambios en el diseño:**
- se quita el vale de salida propio: toda salida de accesorios sale de un
  despacho de una orden;
- una orden mixta genera dos despachos;
- el ingreso es un documento (`IA-0001`) con su tarea al administrador;
- la canasta es única por referencia y color, con un índice en la base.

**Revisado en el código:**
- `SalePrice` exige una línea de compra;
- la orden reserva en una sola ubicación (`SalesOrder.inventoryLocationId`);
- `eligibleAssignees` solo ofrece bodegueros de esa ubicación.

**Tercera ronda de decisiones (mismo día):**
- las órdenes mixtas de Ventas entran en la fase 1;
- Accesorios vende solo accesorios, con un cliente genérico de mostrador, y
  el despacho le llega a ella misma;
- Accesorios también registra salidas sin venta (muestras, garantías,
  consumo interno), con motivo y tarea al administrador;
- el precio nace de la compra, como en los perfiles.

**Hallazgo.** La reserva solo usa paquetes con un lote del origen pedido
(`eligibleWhere`), pero una canasta se rellena con varias compras. Propuesta:
- la canasta tiene un lote fijo que dice su origen;
- el costo de cada compra queda en su ingreso;
- un ingreso de otro origen se rechaza.

El usuario confirmó que un mismo accesorio nunca se compra de los dos
orígenes, así que queda decidido.

**Pendiente:** las cinco preguntas de «Por confirmar» del documento. Se
sugieren tres entregas: inventario, venta de mostrador y ventas mixtas.

## Rol Accesorios creado (24/11/2026)

El usuario pidió crear el rol antes de cerrar las preguntas del diseño. Solo el
rol: todavía sin canastas, ingresos, ventas ni despachos de accesorios.

**Migración `20261124120000_accessories_role`** (aditiva; aplicada en
`solaluminios_dev` el 24/11/2026):
- solo `ALTER TYPE "UserRole" ADD VALUE 'ACCESSORIES'`; los usuarios
  existentes no cambian;
- `migrate status`: 21 migraciones, al día;
- `migrate diff` entre la base y el esquema: «No difference detected»;
- no se aplicó en producción. En `solaluminios_ensayo_manual` se aplicó
  después, junto con la de la entrega 1 (ver «Accesorios, entrega 1»).

**API:**
- `RolesGuard`: la lista `RESTRICTED_ROLES` (`CHINA_OPERATOR`, `BILLING` y
  `ACCESSORIES`) solo llega a las rutas que la nombran;
- `ACCESSORIES` se agregó a las rutas de tareas y de avisos (`push`);
- se actualizó el mensaje de validación del rol en `UpdateUserRoleDto`.

**Web:**
- tipo `UserRole`;
- nombre «Accesorios» y su descripción en Administración → Usuarios;
- menú e Inicio del rol: solo Inicio y Tareas, como Facturación sin su
  pantalla;
- `allowed()` no deja abrir otras vistas desde una URL o un aviso.

**Pruebas** (`accessories-role.e2e-spec.ts`, 3):
- el administrador crea un usuario de Accesorios y le cambia el rol a otro
  usuario; el cambio aplica desde la siguiente petición;
- un rol inválido da 400;
- Accesorios maneja sus tareas y sus avisos, y no asigna tareas a otros;
- da 403 en inventario, catálogo, ubicaciones, cotizaciones, órdenes,
  despachos, solicitudes, proveedores, precios, lotes y usuarios.

**Verificación:**
- API: `build`, `oxlint` y `pnpm test` 52/52; `pnpm test:e2e` 228/228 (29
  archivos);
- web: `build`, `oxlint` y sus pruebas (7/7 y 14/14);
- no se probó en el navegador: hace falta iniciar sesión con un usuario de
  Accesorios.

**Pendiente:**
- crear en la app la «Bodega de accesorios» y el usuario real, y asignarle esa
  ubicación. El usuario indicó que va en la sede de la **139**: «116» fue un
  error suyo y **solo se renombra en producción**, si allí existe (por
  confirmar con la salida del paso A3 de `docs/deploy/base-limpia.md`; el
  cambio sería un `UPDATE` del nombre o el código, sin cambiar IDs). Por
  decisión del usuario, los manuales, `seed-manual.mjs`, la base de
  demostración y las pruebas conservan «Bodega 116» como ejemplo;
- desplegar la migración cuando se publique;
- las preguntas del diseño antes de la primera entrega.

## Accesorios, entrega 1: inventario por canastas (24/11/2026)

**Decisiones del usuario (mismo día):**
- los rollos se sacan completos;
- no hay accesorios sin color;
- las salidas sin venta son «Venta no registrada» o «Consumo interno»;
- una sola persona tendrá el rol;
- la bodega de accesorios va en la sede de la 139.

Diseño completo en `docs/accesorios-fase-1.md`. Las compras y los precios de
accesorios pasan a la entrega 2.

**Migración `20261124130000_accessory_inventory`** (aditiva; aplicada en
`solaluminios_dev`; `migrate diff`: «No difference detected»):
- enums:
  - `InventoryLocationType.ACCESSORY_WAREHOUSE`;
  - `LotKind.ACCESSORY_BASKET`;
  - `TaskKind.ACCESSORY_NOTICE`;
  - `AccessoryVoucherKind` (`ENTRY`, `EXIT`);
  - `AccessoryExitType` (`UNREGISTERED_SALE`, `INTERNAL_USE`);
- `bundles.basket` (por defecto `false`: nada existente cambia);
- tabla `accessory_vouchers`, más `accessoryVoucherId` en
  `inventory_movements` y en `tasks`;
- reglas en la base:
  - una canasta por referencia, color y ubicación (índice único parcial);
  - una canasta nunca se abre;
  - el lote de canasta puede ser nacional sin proveedor (se rehízo
    `stock_lots_national_supplier`);
  - encabezado válido según el tipo de comprobante;
  - las líneas de un comprobante son movimientos `ENTRY` o `EXIT`, una por
    canasta;
  - la tarea `ACCESSORY_NOTICE` siempre apunta a su comprobante;
- secuencias `IA-` (ingresos) y `SS-` (salidas sin venta).

**API (módulo `accessories`, solo `ADMIN` y `ACCESSORIES`):**
- `GET /accessories/catalog`: accesorios, colores y bodegas de accesorios
  (para Accesorios, solo la suya);
- `GET /accessories/baskets` (búsqueda), `GET /accessories/baskets/epc/:epc` y
  `GET /accessories/baskets/:id`, este último con su historial;
- `POST /accessories/baskets`: registro con chip, accesorio, color, origen y
  conteo de hoy.
  - Crea un lote `ACCESSORY_BASKET` con solo el origen.
  - Con 0 unidades no hay movimiento (la base exige cantidad > 0): el
    historial empieza con el primer ingreso. Los reintentos se reconocen por
    la clave guardada en la auditoría.
- `GET /accessories/vouchers` y `GET /accessories/vouchers/:id`;
- `POST /accessories/vouchers/entries`: proveedor, factura o remisión y fecha
  de llegada;
- `POST /accessories/vouchers/exits`: tipo y detalle obligatorios, y quién
  recibe;
- en cada comprobante:
  - todas las canastas cambian o ninguna, con bloqueo de filas, clave de
    operación idempotente y sin superar el saldo libre de reservas;
  - auditoría `ACCESSORY_ENTRY_CREATED` o `ACCESSORY_EXIT_CREATED`;
  - si lo hace Accesorios, una tarea `ACCESSORY_NOTICE` al administrador
    activo más antiguo, con aviso `accessory-entry` o `accessory-exit`. El
    administrador la marca como vista en cualquier momento.
- **Protecciones en los flujos de perfiles:**
  - salida, apertura y traslado (uno o varios) rechazan una canasta; solo el
    ajuste del administrador la toca;
  - `requirePlace` rechaza la bodega de accesorios;
  - no se crean pasillos en ella;
  - Paquetes y Resumen no muestran canastas;
  - los lotes de canasta no salen en Administración → Lotes.

**Web:**
- **Accesorios:** menú Inicio, Canastas, Comprobantes y Tareas.
- **Pantallas:**
  - Canastas: leer chip o buscar; ofrece registrar un chip desconocido;
  - Registrar canasta;
  - detalle de la canasta con su kárdex;
  - Ingreso y Salida sin venta: el chip se lee con la pistola o se elige la
    canasta; la pantalla no deja guardar una salida mayor que lo disponible;
  - Comprobantes y su detalle.
- **Administrador:** entrada «Accesorios» y tarjeta en Inicio.
- **Tareas:** el aviso tiene «Ver IA-…» y «Marcar como visto».
- **Service worker:** textos de los dos avisos nuevos.

**Pruebas** (`accessories-inventory.e2e-spec.ts`, 6):
- registro, reintento y canasta repetida;
- chip ajeno, referencia de perfil y usuario sin bodega;
- ingreso con tarea y aviso, reintento y clave reutilizada;
- salida que no supera el saldo, kárdex y consistencia del historial
  (`ledgerProblems`);
- el aviso solo lo cierra el administrador;
- protecciones de perfiles: salida, traslado, apertura, registro y pasillos;
  el ajuste del administrador sí funciona;
- alcance por bodega: Accesorios solo ve y mueve su bodega.

**Verificación:**
- API: `build`, `oxlint`, `pnpm test` 52/52.
- API `pnpm test:e2e`:
  - en paralelo, por defecto, hubo tiempos de espera vencidos en archivos que
    pasan solos (`authorization-idor`, `security`, `sales-dispatch`, entre
    otros);
  - con `--maxWorkers=2`: **234/234** en 30 archivos.
  - En este equipo la corrida en paralelo es sensible a la carga.
- Web: `build`, `oxlint` y pruebas (7/7 y 14/14).
- **Navegador** (API aparte en el puerto 3101 y web en el 5174, sobre
  `solaluminios_dev`, con un usuario de Accesorios de prueba):
  - menú del rol;
  - registro de canasta (40);
  - ingreso IA-000001 (+10, de 40 a 50) con el chip leído;
  - la pantalla bloquea una salida de 60;
  - salida SS-000001 (Consumo interno, −3, de 50 a 47);
  - vista de celular; sin errores en la consola.
  - No se probó como administrador en el navegador (marcar el aviso como
    visto está cubierto por la prueba e2e).

**Datos de prueba creados en `solaluminios_dev`** (se conservan para que el
usuario los vea):
- sucursal `139` «Sede 139» con la ubicación `ACCESORIOS-139` «Bodega de
  accesorios»;
- usuario «QA Accesorios» (`qa-accesorios@test.local`, rol Accesorios); sus
  credenciales están en `.env.browser-test`, ignorado por Git;
- la canasta `E2800QA00010001` (rodachina 744 doble nailon, NP), con
  IA-000001 y SS-000001;
- dos tareas de aviso para el administrador «Wetracking».

**Base de demostración** (`solaluminios_ensayo_manual`), a pedido del
usuario:
- se aplicaron las dos migraciones de accesorios con
  `node docs/manual/herramientas/demo-db.mjs run solaluminios_ensayo_manual pnpm exec prisma migrate deploy`;
- `migrate status`: 22, al día;
- `migrate diff`: «No difference detected»;
- `counts` antes y después: mismas filas en todas las tablas, más la tabla
  nueva `accessory_vouchers`, vacía. Ninguna canasta.

**Pendiente:**
- reiniciar el API local del usuario (`pnpm start:dev`): seguía sin el módulo
  y respondía 404 en `/accessories/...`;
- **las referencias «por metro» no se bloquean al registrar una canasta.** El
  catálogo no tiene un campo que las distinga; decidir si se marca en el
  catálogo;
- producción:
  - desplegar las dos migraciones;
  - crear la bodega de accesorios en la sede 139 y asignarla al usuario;
- entrega 2 (compras, precios y venta de mostrador) y entrega 3 (órdenes
  mixtas; antes, confirmar qué pasa con una orden mixta sin existencias).

## Pagos de contado mixtos y abonos en la orden (24/11/2026)

Pedido del cliente: contado en efectivo y transferencia combinados, y abonos
sucesivos con fecha, valor y saldo.

**Cómo funcionaba antes:**
- **Cotización:** guardaba la forma de pago esperada (`CASH`, `TRANSFER`,
  `PARTIAL` o `CREDIT`) y unas condiciones en texto libre; no registraba
  dinero.
- **Conversión:** exigía la forma de pago y la copiaba a la orden.
- **Orden:**
  - contado: sin estado («pagada al vender»);
  - abono o cartera: empezaba en `PENDING`, y el dueño o el administrador la
    marcaba `PAID` a mano, con auditoría `PAYMENT_STATUS_CHANGED`;
  - no se guardaban valores, fechas ni medios.

**Migración `20261124140000_order_payments`** (aditiva; aplicada en
`solaluminios_dev`):
- `PaymentMethod.CASH_TRANSFER` («Contado – efectivo y transferencia») y
  el enum `PaymentMedium` (`CASH` o `TRANSFER`);
- tabla `sales_order_payments`: orden, medio, valor `Decimal(18,2)`, fecha
  del pago (`DATE`), observación, `atSale` (contado registrado al
  convertir), `operationKey` única, autor, y autor y fecha de la última
  corrección;
- reglas en la base:
  - CHECK de valor mayor que 0;
  - un trigger que bloquea la orden y rechaza que los pagos superen su total;
  - un trigger que impide mover un pago a otra orden.
- **Registros anteriores:** no se crea ningún pago (no se inventan valores,
  fechas ni medios).
  - Una orden de contado anterior sigue entendiéndose como pagada al vender,
    sin detalle de medios.
  - Una de abono o cartera conserva su estado, que se sigue cambiando a mano
    mientras no tenga abonos registrados.

**API:**
- **Al convertir** (`POST /quotes/:id/convert`), con `cashAmount` y
  `transferAmount` opcionales (`order-payments.ts`, `contadoSplit`):
  - `CASH` o `TRANSFER` registran un pago por el total en ese medio, fechado
    hoy;
  - `CASH_TRANSFER` exige ambos valores mayores que 0 y que sumen
    exactamente el total. Si no, responde 400 con lo que falta o sobra.
  - Abono y cartera no aceptan reparto.
- **`POST /sales-orders/:id/payments`** (`ADMIN` y `SALES` dueño):
  - abono con valor, fecha y medio, y observación opcional;
  - solo en órdenes de abono o cartera, no canceladas;
  - el valor debe ser mayor que 0 y no superar el saldo; la fecha, real y no
    posterior a hoy;
  - idempotente por `operationKey`.
  - Una orden marcada pagada a mano sin abonos pide volverla a pendiente.
- **`PATCH /sales-orders/:id/payments/:paymentId`** (mismos roles):
  - corrige valor, fecha, medio u observación;
  - el saldo se calcula reemplazando el valor anterior;
  - en un pago de contado el valor no cambia; el medio, la fecha y la
    observación sí;
  - auditoría `PAYMENT_EDITED`, con autor y cada campo de antes y después;
  - repetir la misma corrección no cambia nada.
- **Estado de pago:** en abono o cartera con abonos se calcula solo (`PAID`
  con saldo 0; `PENDING` si una corrección lo reabre), auditado. El cambio
  manual (`PATCH …/payment-status`) responde 409 si hay abonos.
- **`GET /sales-orders/:id`** agrega `payments` y `paymentSummary` (total,
  abonado, saldo, completo), y las correcciones de cada pago.
  - Solo para `ADMIN` y el vendedor dueño. Facturación lee la orden sin
    ellos.
  - Los autores solo los ve el administrador, como en el resto de la orden.
- **Concurrencia:** cada escritura bloquea la fila de la orden
  (`lockOrder`, que también aplica el alcance por rol) antes de leer el
  saldo.

**Web:**
- **Cotización:** la forma de pago ofrece «Contado – efectivo y
  transferencia».
- **Diálogo de conversión:**
  - con el contado mixto pide efectivo y transferencia y muestra, mientras se
    escribe, cuánto falta por distribuir o cuánto sobra;
  - no deja convertir si no suma el total;
  - con contado de un solo medio informa que se registra el total.
- **Orden: panel «Pagos»** (`OrderPaymentsPanel`):
  - total, abonado, saldo y «Pago completo»;
  - historial con fecha, medio, valor, observación y correcciones;
  - «Agregar abono»: valor, fecha (hoy por defecto) y medio; muestra el saldo
    que quedará;
  - «Editar» en cada pago.
  - Los botones manuales de estado se ocultan cuando hay abonos.

**Pruebas:**
- `order-payments.e2e-spec.ts` (6):
  - contado de un solo medio;
  - contado mixto 35.000 / 65.000 sobre 100.000;
  - suma que falta o que sobra, rechazada y sin crear la orden;
  - abonos de 5.000 (ayer, efectivo) y 1.000 (hoy, transferencia): 6.000
    abonados y 4.000 pendientes;
  - corrección del segundo a 1.500: 6.500 y 3.500, con auditoría;
  - rechazo de 0, negativos, más que el saldo y fecha futura;
  - abono final con saldo 0, pagada;
  - doble clic con la misma clave (un solo abono) y dos abonos simultáneos
    que no caben (uno pasa, el otro 400);
  - permisos;
  - órdenes anteriores sin registros.
- `order-payments.spec.ts` (5 unitarias): reparto con centavos y validación
  de fechas.
- **Ajuste a 8 pruebas existentes:** su limpieza borra sus propias órdenes de
  prueba y ahora borra antes sus pagos, porque la llave foránea es RESTRICT.
  - Un corte de esa limpieza dejó en la base de pruebas dos valores de
    configuración (`china.supplierId` y `dispatch.supervisorUserId`), del
    administrador de prueba de esa corrida. Se borraron solo esas dos filas.

**Verificación:**
- API: `build`, `oxlint`, `pnpm test` 57/57;
- `test:e2e --maxWorkers=2`: **240/240** en 31 archivos;
- web: `build`, `oxlint` y pruebas.
- **Navegador** (API aparte en el puerto 3101 y web en el 5174, sobre
  `solaluminios_dev`, con el usuario de prueba «QA Ventas»):
  - COT-000033 → OV-000031 con contado mixto:
    - el aviso mostró «falta por distribuir $1.145,75» y no dejó convertir;
    - con $5.000 + $7.145,75 quedó pagada, saldo $0, «Pago completo».
  - COT-000034 → OV-000032 con abono:
    - $5.000 en efectivo el 23/11 y $1.000 por transferencia el 24/11:
      abonado $6.000;
    - «Editar» el segundo a $1.500: abonado $6.500 y saldo $5.645,75, con la
      nota «Corregido … Valor $1.000 → $1.500»;
    - los botones manuales de estado se ocultaron.
  - Vista de celular sin desborde de página.

**Migración en las bases locales** (24/11/2026, a pedido del usuario):
- `solaluminios_dev` y `solaluminios_dev_e2e_test`: 23, al día.
- `solaluminios_ensayo_manual`: se aplicó `20261124140000_order_payments` con
  `demo-db.mjs run … pnpm exec prisma migrate deploy`.
  - `migrate status`: al día; `migrate diff`: «No difference detected».
  - `counts` antes y después: mismas filas, más la tabla
    `sales_order_payments`, vacía.
- En producción sigue pendiente: se aplica con el script de despliegue.

**Datos de prueba en `solaluminios_dev`:**
- el usuario «QA Ventas» (`qa-ventas@test.local`); sus credenciales están en
  `.env.browser-test`, ignorado por Git;
- COT-000033 / OV-000031 y COT-000034 / OV-000032, con sus pagos.

**Pendiente (decisiones del usuario):**
- **Quién corrige un abono ya registrado:** hoy los mismos que lo registran
  (el vendedor dueño y el administrador); no se amplió a nadie más. ¿Solo el
  administrador?
- **Botones manuales de estado:** en órdenes nuevas de abono o cartera sin
  abonos siguen visibles «Marcar como pagada» y «Volver a pendiente», como
  antes. ¿Se ocultan para que solo decidan los abonos?
- **Reparto de un contado ya registrado:** se corrigen el medio, la fecha y la
  observación, no los valores (por ejemplo, 30/70 en lugar de 35/65).
- **Abono registrado por error:** no se puede anular ni borrar; solo
  corregir.
- **Cartera:** también recibe abonos; confirmar.
- **Facturación:** no ve los abonos; confirmar si debe verlos en solo
  lectura.
- **Sin cambios:** el PDF y el Excel de comisiones no muestran lo abonado ni
  el saldo (fuera del alcance pedido).

## Entidad donde se recibe cada transferencia (24/11/2026)

Pedido: guardar dónde recibió Solaluminios cada transferencia (por ejemplo,
Nequi), para informes futuros.

**Cómo quedó almacenado:**
- **Tabla `transfer_entities`:** es la única lista de entidades. Tiene `id`
  estable en texto, `name`, `active` y `sortOrder`. Empieza con `NEQUI`
  (Nequi) y `BANCO_CAJA_SOCIAL` (Banco Caja Social). Una entidad nueva es una
  fila más, agregada por migración; no hay pantalla.
- **`sales_order_payments.transferEntityId`:** llave foránea a esa tabla, en
  cada pago. Así cada importe transferido lleva su entidad, su fecha y su
  valor; no se guarda en la orden ni como texto libre.
- **Informe por entidad:** `SUM(amount) … GROUP BY "transferEntityId"` sobre
  los pagos con medio `TRANSFER`.
- **Reglas en la base:**
  - CHECK: solo una transferencia tiene entidad;
  - trigger: toda transferencia nueva, y todo pago que pasa a transferencia,
    exige entidad, y una entidad conocida no se borra.

**Migración `20261124150000_transfer_entities`** (aditiva; aplicada en
`solaluminios_dev`, `solaluminios_dev_e2e_test` y
`solaluminios_ensayo_manual`):
- crea la tabla, las dos filas, la columna y las reglas;
- **registros anteriores:** las transferencias ya registradas quedan sin
  entidad y se muestran como «Sin especificar»; no se asigna ninguna por
  suposición.

**API:**
- **`GET /transfer-entities`** (`ADMIN` y `SALES`): entidades activas.
- **`POST /quotes/:id/convert`** con `transferEntityId`:
  - obligatorio en `TRANSFER` y en la parte transferida de `CASH_TRANSFER`;
  - rechazado con `CASH`;
  - debe ser de la lista y estar activa.
- **`POST /sales-orders/:id/payments`:** la misma regla, según el medio.
- **`PATCH /sales-orders/:id/payments/:paymentId`:**
  - pasar a efectivo quita la entidad;
  - pasar a transferencia la exige;
  - se puede cambiar por otra de la lista;
  - una transferencia «Sin especificar» puede corregir su fecha u
    observación sin inventarle entidad;
  - todo cambio queda en `PAYMENT_EDITED` (`transferEntityId` de → a).
- **`GET /sales-orders/:id`:** cada pago trae `transferEntity` (`id` y
  `name`, o null).

**Web:**
- **Conversión:** con «Contado – transferencia» y con la parte transferida del
  contado mixto aparece el desplegable obligatorio «¿Dónde se recibió la
  transferencia?».
  - Empieza en «Selecciona una entidad», sin opción por defecto.
  - No deja convertir sin elegir.
- **«Agregar abono» y «Editar»:** el mismo desplegable aparece al elegir
  Transferencia y desaparece con Efectivo. Una transferencia histórica
  muestra «Sin especificar (sin cambiar)».
- **Historial de pagos:** muestra la entidad bajo «Transferencia», o «Sin
  especificar», y las correcciones como «Entidad Nequi → Banco Caja Social».

**Pruebas:**
- `order-payments.e2e-spec.ts`, ahora con 9 casos. Los 3 nuevos:
  - **aceptación:** orden de $100.000 = $35.000 en efectivo (sin entidad) +
    $65.000 por transferencia a Banco Caja Social. El `groupBy` por entidad
    da `BANCO_CAJA_SOCIAL = 65.000`, no el total. Se rechazan una
    transferencia sin entidad, una entidad fuera de la lista y efectivo con
    entidad;
  - **dos abonos de una orden** en Nequi (ayer) y Banco Caja Social (hoy),
    cada uno con su fecha e importe. Se rechazan el abono por transferencia
    sin entidad, una entidad inexistente y efectivo con entidad. Pasar a
    efectivo quita la entidad, con auditoría de antes y después; volver a
    transferencia la exige; cambiar a otra entidad queda auditado;
  - **transferencia histórica:** escrita sin entidad con los triggers
    desactivados en la sesión. Se ve «Sin especificar», se corrige su
    observación sin asignarle entidad, y la base rechaza una transferencia
    nueva sin entidad aunque se inserte fuera del API.
- Las transferencias de los casos anteriores ahora envían su entidad.
- **Ajuste de 2 pruebas existentes** que convertían «Contado – transferencia»
  sin entidad (`sales-commissions` y `sales-dispatch`): ahora envían
  `NEQUI`.
- `order-payments.spec.ts`: 6 unitarias.

**Verificación:**
- API: `build`, `oxlint`, `pnpm test` 58/58;
- `test:e2e --maxWorkers=2`: **243/243** en 31 archivos;
- web: `build`, `oxlint` y pruebas.
- **Navegador** (API aparte en el puerto 3101 y web en el 5174, «QA
  Ventas»):
  - COT-000035 con «Contado – transferencia»: el desplegable empieza en
    «Selecciona una entidad» con Nequi y Banco Caja Social, no deja convertir
    sin elegir y desaparece con efectivo. Con Nequi, OV-000033 muestra
    «Transferencia · Nequi $12.145,75».
  - En OV-000032:
    - el abono por transferencia registrado antes se ve «Sin especificar»;
    - un abono nuevo por transferencia exige la entidad; con Banco Caja Social
      se ve como tal;
    - «Editar» muestra la entidad guardada; al pasarlo a efectivo el
      desplegable desaparece y la corrección dice «Medio Transferencia →
      Efectivo · Entidad Banco Caja Social → (sin entidad)»;
    - la transferencia histórica muestra «Sin especificar (sin cambiar)» y
      deja guardar.

**Pendiente:**
- desplegar la migración en producción;
- agregar las entidades que indique el cliente (una fila por entidad, por
  migración);
- el informe por entidad, que queda para después, como se pidió.

## Buscador de familia en la cotización (24/11/2026)

Pedido: al cotizar, un campo para escribir que filtre la lista de familias, y
solo la de familias.

- **`CatalogSelectors`:** prop nueva `searchFamily`; por defecto toma el valor
  de `requireFamily`, así que Registrar paquete sigue igual.
  - Muestra «Buscar por nombre o código» sobre la lista de familias, que se
    reduce a las que contienen lo escrito (nombre o código, sin tildes ni
    mayúsculas).
  - La familia sigue siendo opcional en la cotización.
  - La referencia, el acabado y el resto de pantallas no cambian.
- **`QuoteView`:** cada renglón usa `searchFamily`.
- **Verificación:**
  - web: `build`, `oxlint` y pruebas;
  - navegador, con «QA Ventas» en una cotización nueva: «kim» deja «KALIMA -
    KIMBAYA (14)» y «puerta» deja 744, 7038 y 8025 PUERTA CORREDIZA.

## Devoluciones de clientes con saldo a favor (25/11/2026)

Pedido: desarrollar la opción 3 del plan de devoluciones (devolución formal
con saldo a favor). Caso típico: el cliente se llevó la referencia X en negro
y necesitaba la Y en blanco. Diseño completo, reglas y decisiones en
`docs/devoluciones.md`.

**Flujo:**
1. **Solicitud.** Ventas, o el administrador, registra la devolución desde la
   orden (`DV-000001`):
   - perfiles por renglón, hasta lo entregado y no devuelto;
   - motivo, saldo a favor o reintegro, y observación.
2. **Autorización.** El administrador que eligió el vendedor la autoriza o la
   rechaza, por tarea. Si la pide un administrador, queda autorizada al
   guardar.
3. **Recepción.** Un bodeguero de la ubicación de salida la recibe por tarea:
   - cuenta los perfiles en buen estado y los dañados;
   - lee el chip de los paquetes que vuelven cerrados.
4. **Inventario.** Lo bueno vuelve a los paquetes de donde salió, con
   movimientos `RETURN`. Lo dañado no entra al inventario.
5. **Valor.** Es proporcional al renglón, con y sin IVA.
   - Primero baja lo que el cliente debía.
   - Lo pagado de más queda como saldo a favor del cliente o como reintegro
     por registrar.
6. **Orden facturada.** Facturación recibe la tarea de nota crédito.
7. **Saldo a favor.** Se usa al convertir una cotización y en «Agregar
   abono».

**Migración `20261125120000_sales_returns`** (aditiva; aplicada en
`solaluminios_dev`, `solaluminios_dev_e2e_test` y
`solaluminios_ensayo_manual`; `migrate status` con 25 migraciones y sin
diferencias):
- **Tablas:** `sales_returns` y `sales_return_lines`.
- **Enums nuevos:** estado, motivo y liquidación.
- **Valores nuevos en enums existentes:**
  - `InventoryMovementType.RETURN`;
  - `PaymentMedium.CREDIT_BALANCE`;
  - `TaskKind`: `RETURN_APPROVAL`, `RETURN_RECEPTION` y `CREDIT_NOTE`.
- **Columnas nuevas:** `inventory_movements.salesReturnLineId` y
  `tasks.salesReturnId`.
- **Secuencia:** `sales_return_number_seq`.
- **Reglas en la base:**
  - CHECK de cada estado: quién y cuándo, valor, reintegro, nota crédito y
    cancelación;
  - CHECK de los renglones;
  - `RETURN` suma al saldo y siempre va ligado a un renglón de devolución;
  - devolución recibida inmodificable (trigger);
  - pagos ≤ total neto: se reemplaza la función
    `sales_order_payments_within_total`;
  - pagos con saldo a favor ≤ lo acreditado al cliente (trigger con bloqueo
    del cliente).

**API:**
- **Módulo `returns`:**
  - `GET /sales-orders/:id/returnable`;
  - `POST /sales-orders/:id/returns`;
  - `GET /sales-returns` y `GET /sales-returns/:id`;
  - `POST /sales-returns/:id/approve`, `reject`, `cancel`, `receive`,
    `refund` y `credit-note`.
- **Roles:**
  - Ventas: solo sus órdenes;
  - Bodega: su ubicación o lo que tiene asignado, sin valores;
  - Facturación: las recibidas de órdenes con factura.
- **Ventas:**
  - `GET /customers/:id/credit`;
  - `creditAmount` al convertir, con cualquier forma de pago;
  - medio `CREDIT_BALANCE` en abonos;
  - saldo y estado de pago con devoluciones;
  - `getOrder` trae `returns`, `returnSummary` y `customerCredit`.
- **Excel y resumen:**
  - el resumen por vendedor trae `returned`;
  - el Excel suma columnas en Órdenes, la hoja «Devoluciones» y la base neta
    en el Resumen.
- **Tareas y avisos:** las tareas nuevas solo se completan con su flujo; hay
  7 avisos push nuevos.

**Web:**
- **Orden:** tarjeta «Devoluciones», con «Registrar devolución».
- **Pantalla nueva «Registrar devolución».**
- **Pantalla de la devolución:**
  - autorizar o rechazar;
  - recibir, con conteo y lectura de chips;
  - reintegro;
  - nota crédito;
  - cancelar.
- **Ventas:** pestaña «Devoluciones».
- **Pagos:**
  - total neto en el panel;
  - medio «Saldo a favor» en el panel de pagos;
  - «Usar saldo a favor» al convertir.
- **Otros:** columna «Devuelto» en el resumen por vendedor, botón de la tarea
  y textos de los avisos.

**Pruebas:**
- **`sales-returns.e2e-spec.ts`** (5 casos):
  - contado con un paquete que vuelve cerrado por chip, y saldo a favor;
  - carrera por el saldo a favor entre dos conversiones (una gana);
  - abono con perfiles sueltos y uno dañado: baja el saldo y lo demás es
    reintegro;
  - cartera facturada: rechazo, cancelación, recepción repetida con la misma
    clave y nota crédito;
  - resumen y Excel.
- **`returns.spec.ts`:** 12 unitarias (proporción, saldo, reparto en
  paquetes, saldo a favor en el contado).
- **Ajustadas:** `sales-export.spec.ts` (columnas y hoja nuevas) y
  `sales-commissions.e2e-spec.ts` (4 hojas).

**Verificación:**
- **API:**
  - `build` y `oxlint`;
  - `pnpm test`: 72/72;
  - `test:e2e --maxWorkers=2`: **248/248** en 32 archivos (corrida final,
    después de ajustar el nombre de las hojas en `sales-commissions`).
- **Web:** `tsc`, `oxlint`, `build` y pruebas.
- **Recorrido en `solaluminios_dev`** (API aparte en el puerto 3101), con
  las mismas llamadas que hacen las pantallas, rol por rol:
  1. OV-000036: 10 perfiles PRUEBA-001 NP entregados.
  2. QA Ventas pide DV-000001 (aprox. $65.725,25); Bodega todavía no la ve.
  3. QA Admin la autoriza; la tarea de recepción le llega a un bodeguero de
     «Bodega de prueba».
  4. Bodega la ve sin valores: 9 buenos y 1 dañado; los 9 vuelven a su
     paquete.
  5. Saldo a favor de $65.725,25; la orden queda con neto $0.
  6. El reemplazo OV-000037, en CH, se paga con saldo a favor $65.725,25 +
     efectivo $78.809,18.
- **Navegador** (web en el puerto 5174 y API en el 3101; el usuario inició
  cada sesión de prueba):
  - **QA Accesorios:** no ve Ventas ni devoluciones.
  - **QA Ventas:**
    - cantidades 11, 2,5 y −1 bloqueadas; motivo y administrador
      obligatorios;
    - una observación con `'; DROP TABLE sales_returns;-- <script>…` se
      guarda literal y se muestra como texto;
    - el doble clic en «Enviar» crea una sola DV (DV-000002), y sin nada
      por devolver no deja pedir otra.
  - **QA Admin:**
    - un rechazo con motivo de 2 letras queda bloqueado;
    - el doble clic al autorizar crea una sola tarea de recepción (le tocó
      a QA Bodega por turno) y una sola aprobación auditada;
    - la recepción bloquea 11 buenos y 0 + 0; con 8 buenos y 1 dañado, el
      paquete pasa de 799 a 807 una sola vez y el valor es $59.152,73;
    - al convertir COT-000040 se bloquea un saldo a favor mayor al
      disponible o con texto hostil; con saldo $59.152,73 + efectivo
      $50.000 + Nequi $35.381,70 queda OV-000038, una sola orden;
    - la DV-000003, pedida por el administrador para el perfil que faltó,
      sale autorizada y se recibe como dañado, sin volver al inventario;
    - el reintegro con fecha futura se rechaza y por Banco Caja Social se
      registra;
    - las dos DV de la OV-000035 suman exactamente su total;
    - el resumen por vendedor muestra lo devuelto (base $110.462,60).
  - **Corregido durante la prueba:**
    - el valor aproximado redondeaba ($65.725,30 en vez de $65.725,25);
    - faltaba el aviso «no queda nada por devolver»;
    - la fecha del reintegro no se validaba antes de enviar y se mostraba
      como AAAA-MM-DD;
    - en la recepción faltaba «ya volvieron N».
- **Pruebas de choque, `test/sales-returns-hardening.e2e-spec.ts`** (22
  casos, base de pruebas):
  - **Concurrencia:** peticiones simultáneas reales, con barrera al inicio
    de la transacción:
    - 6 solicitudes por lo mismo, con distinta clave → 1 creada;
    - la misma clave 6 veces → 1 devolución;
    - autorizar contra rechazar, y autorizar contra cancelar;
    - 6 recepciones → el inventario se mueve una vez;
    - recibir contra cancelar;
    - dos recepciones de la misma orden → lo devuelto al cliente nunca
      supera lo pagado;
    - carrera por el saldo a favor en abonos y conversiones → nunca
      negativo;
    - nota crédito y reintegro simultáneos.
  - **Entradas hostiles:**
    - 15 ids con inyección SQL (`' OR '1'='1`, `DROP TABLE`, `UNION`…) en
      las 12 rutas → 404, sin cambios;
    - 17 filtros hostiles → 400;
    - enums e ids hostiles en el cuerpo → 400;
    - textos con SQL y `<script>` → guardados literales.
  - **Permisos:**
    - otro vendedor y otra bodega → 404;
    - bodega sin valores en pesos;
    - Facturación limitada;
    - solo lectura, accesorios y operador China → 403;
    - sin sesión → 401.
  - **Validaciones:** 31 cuerpos inválidos en la solicitud, 23 en la
    recepción, reintegro, nota crédito y saldo a favor.
  - **Reglas de la base, saltándose el API:** devolución recibida
    inmodificable, movimientos `RETURN`, saldo a favor, total neto, estados
    y tareas.
- **Defectos que encontró la batería, corregidos** (respondían 500; los
  datos nunca quedaban mal):
  1. **Misma clave de operación en dos órdenes a la vez:** ahora responde
     409 «ya se usó con otra orden».
  2. **Clave de recepción ya usada por otra devolución:** ahora responde 409.
     Se revisa antes de recibir, y el servicio traduce cualquier choque de
     clave a 409.
  3. **Carácter nulo (`\u0000`) en una ruta o un texto:** PostgreSQL no lo
     acepta y el error afectaba a **todo el API**. Nuevo pipe global
     `RejectNulPipe` (`src/infrastructure/http/reject-nul.pipe.ts`, con
     prueba unitaria), registrado en `app.setup.ts` antes de la
     validación: responde 400 en rutas, filtros y cuerpos.
- **Ajuste de una prueba existente** (`quote-discounts.e2e-spec.ts`): buscaba
  su tarea en la primera página de «todas las pendientes» del
  administrador. Con más datos en la base de pruebas quedaba en otra página.
  Ahora filtra por el administrador asignado, también en la comprobación de
  «ya no está pendiente», que antes pasaba aunque estuviera mal.
- **Verificación final:**
  - **API:** `build` y `oxlint`; `pnpm test` 75/75; `test:e2e
    --maxWorkers=2` **270/270** en 33 archivos.
  - **Web:** `tsc`, `oxlint`, `build` y pruebas.

**Datos de prueba creados en `solaluminios_dev`:**
- usuarios locales «QA Admin» (`ADMIN`) y «QA Bodega» (`WAREHOUSE`, en
  Bodega de prueba), con credenciales en `.env.browser-test` (ignorado por
  Git);
- COT-000037 → OV-000035, con DV-000002 (saldo a favor) y DV-000003
  (reintegro);
- COT-000038 → OV-000036, con DV-000001;
- COT-000039 → OV-000037;
- COT-000040 → OV-000038, pagada con saldo a favor, efectivo y Nequi.

No se borró nada.

**Pendiente:**
- desplegar la migración en producción;
- probar en el navegador la pantalla de bodega (QA Bodega) y la lectura de
  chips de paquetes cerrados (cubiertas por API y pruebas automáticas);
- confirmar las 7 decisiones por defecto de `docs/devoluciones.md`;
- desactivar los usuarios QA si ya no se usan.

## Decimales al escribir pesos (25/11/2026)

Reporte del usuario: en el reparto «Contado – efectivo y transferencia», al
escribir la coma decimal, el monto «se reiniciaba».

**Causa:**
- El campo no se borraba. `parseMoney` no aceptaba un monto con la coma o el
  punto final todavía sin decimales («3.453,»): lo dejaba como inválido.
- Mientras se escribía, el cálculo tomaba ese campo como vacío y el aviso
  saltaba a «falta por distribuir $3.453,11» hasta escribir el primer
  decimal.
- Pasaba en todos los campos de dinero: reparto, saldo a favor, abonos y
  precios manuales.

**Corrección:**
- **`lib/numbers.ts`:** el separador final sin decimales cuenta como el
  número entero («3.453,» = 3453; «3453.» = 3453). Lo demás no cambia:
  formato colombiano con punto de miles y coma decimal. Se agregaron 10
  casos a `scripts/numbers.test.mts`, que ahora tiene 24.
- **Conversión con contado repartido:** botón «Poner lo que falta: $…» en
  efectivo o en transferencia. Llena el valor exacto, centavos incluidos, y
  solo aparece cuando el otro medio ya tiene un monto.
- **«Agregar abono»:** botón «Pagar todo el saldo: $…».

**Verificación:**
- **Web:** `tsc`, `oxlint`, pruebas (24/24) y `build`.
- **Navegador** (5174, QA Ventas):
  - **COT-000042 ($14.453,44):** se escribió «11.453,44» tecla por tecla
    en transferencia, con $3.000 en efectivo.
    - Con «11.453» y con «11.453,» el aviso dice «falta $0,44», sin
      saltar.
    - Con «11.453,4» dice «falta $0,04»; con «11.453,44», «distribución
      completa».
    - «Poner lo que falta» llena «11453,44».
    - Convertida: OV-000039, efectivo $3.000 + Nequi $11.453,44.
  - **OV-000040 (abono):**
    - «5.000,» calcula el saldo después en $9.453,44;
    - «Pagar todo el saldo» llena «14453,44»;
    - guardado: la orden queda «Pagada».

## Ingreso por usuario y cédula como clave inicial (27/11/2026)

Pedido del cliente: ingresar con un usuario tipo `pedro.alvarez` y la cédula
como contraseña.

Decisión del usuario (26/11/2026): la cédula **solo como clave inicial**, con
cambio obligatorio en el primer ingreso. Diseño, protecciones y transición en
`docs/usuarios-y-contrasenas.md`.

**Migraciones** (aditivas; aplicadas en `solaluminios_dev`,
`solaluminios_dev_e2e_test` y `solaluminios_ensayo_manual`; 27 en total,
`migrate status` al día y sin diferencias):
- **`20261127120000_usernames_password_policy`:**
  - **`users.username`:** único y obligatorio, con CHECK de formato. Los
    usuarios existentes reciben lo que va antes de la @ de su correo; si dos
    coinciden, se numeran.
  - **`users.mustChangePassword` y `users.passwordChangedAt`.**
  - **`users.email`:** pasa a opcional, en minúsculas (CHECK).
  - **Tabla `login_events`** (enum `LoginEventType`), con CHECK de textos
    acotados.
- **`20261127130000_login_events_outlive_users`:** el registro se conserva si
  se borra un usuario (vínculo a `SET NULL`). La necesitaron las limpiezas de
  las pruebas.

**API:**
- **`POST /auth/login`:** con `username`. Un correo se acepta en ese mismo
  campo o en `email`, durante la transición. El mensaje es único: «Usuario o
  contraseña incorrectos».
- **Bloqueo:** el contador es por cuenta, se escriba el usuario o el correo.
- **Registro:** cada intento queda en `login_events`, con IP y navegador.
- **`POST /auth/change-password`:**
  - valida la clave actual y las reglas (`auth/password-policy.ts`);
  - devuelve una sesión nueva;
  - lo pueden usar todos los roles.
- **Guardia:**
  - con `mustChangePassword`, solo responde `/auth/me` y el cambio; lo demás
    responde 403 `PASSWORD_CHANGE_REQUIRED`;
  - los tokens emitidos antes de `passwordChangedAt` responden 401.
- **Usuarios** (rol ADMIN):
  - crear con `username` + `idNumber` (cédula de 5 a 12 dígitos) + correo
    opcional, con cambio obligatorio;
  - `POST /users/:id/reset-password`: no sobre la propia cuenta;
  - `PATCH /users/:id/username`;
  - `GET /users/login-events` (filtro por usuario y por tipo);
  - la lista trae el último ingreso.
- **Errores de reglas:** una violación de CHECK responde 400, nunca 500.
- **`create-admin` y `Create-Admin.ps1`:** piden el usuario.
  `docs/deploy/base-limpia.md`, actualizado.

**Web:**
- **Ingreso:** campo «Usuario (p. ej. pedro.alvarez)», con la ayuda del primer
  ingreso.
- **Primer ingreso:** pantalla obligatoria «Es tu primer ingreso», con las
  reglas en vivo.
- **Cambiar mi contraseña:** con el ícono de llave junto a «Cerrar sesión».
- **Administración → Usuarios:**
  - formulario con usuario sugerido desde el nombre, cédula (solo dígitos) y
    correo opcional;
  - acciones «Restablecer clave» y «Cambiar usuario»;
  - marca «Con clave inicial» y el último ingreso;
  - «Registro de ingresos» con filtros.

**Pruebas:**
- **Nuevas:**
  - `users-login.e2e-spec.ts` (6 casos): primer ingreso y bloqueo, reglas,
    fin de sesiones viejas, errores iguales, nombres hostiles, correo
    aceptado, bloqueo por cuenta, restablecimiento, cambio de usuario,
    registro sin contraseñas y reglas de la base;
  - `password-policy.spec.ts` (3 unitarias).
- **Ajustadas:**
  - `users-admin` y `accessories-role`: crean usuarios con el formato nuevo;
  - `users-admin`: cada petición sale de su propia dirección, por el límite
    de creaciones;
  - `tasks`: la lista de todas las pendientes del administrador dependía de
    la primera página de una base de pruebas compartida.
- **Defectos que encontraron las pruebas:**
  - el cambio de contraseña estaba bloqueado por el guardia de roles para
    todos menos ADMIN;
  - un usuario de 2 letras respondía 500;
  - al pegar una cédula con puntos, el límite del campo la cortaba.

**Verificación:**
- **API:** `build` y `oxlint`; `pnpm test` 78/78; `test:e2e --maxWorkers=2`
  **276/276** en 34 archivos.
- **Web:** `tsc`, `oxlint`, pruebas y `build`.
- **Navegador** (5174, el usuario ingresó como QA Admin):
  - **Lista de usuarios:** muestra usuario, correo, último ingreso y las
    acciones nuevas.
  - **Usuario de prueba creado** «Prueba Cédula Gómez»:
    - se sugirió `prueba.cedula`;
    - la cédula pegada con puntos queda completa.
  - **Primer ingreso:** con `Prueba.Cedula` (mayúsculas) y la cédula aparece
    «Es tu primer ingreso».
    - Las reglas bloquean la cédula como clave nueva, la que contiene el
      usuario y la repetición distinta.
    - Con `Perfiles2026` entra como Ventas.
  - **Después del cambio:** la cédula ya no entra y la clave nueva entra sin
    la pantalla obligatoria.
  - **«Cambiar mi contraseña»:** se abre desde la llave.
  - **Registro en la base:** 6 eventos (fallido con usuario inexistente,
    ingreso del administrador por correo, primer ingreso, cambio, fallido con
    la cédula vieja e ingreso), sin contraseñas.

**Datos de prueba en `solaluminios_dev`:**
- el usuario «Prueba Cédula Gómez» (`prueba.cedula`, Ventas);
- los eventos de ingreso de este recorrido.

**Pendiente:**
- desplegar las 2 migraciones en producción y avisar a los usuarios su nombre
  de usuario (el correo sigue sirviendo mientras tanto);
- actualizar los manuales de Ventas y Bodega, que dicen «correo»;
- botón de cambio de contraseña para el operador China;
- decidir cuándo dejar de aceptar el correo.

## Auditoría QA: autorización de descuentos, SEC-01 (27/11/2026)

**Origen:**
- informe de QA del 27/11/2026 sobre `main` en `0c499be`: calificación 0/100
  por el hallazgo SEC-01;
- verificación, corrección y evidencia en `docs/auditoria-qa-2026-11-27.md`.

**Verificación (antes de cambiar nada):**
- **SEC-01 reproducido de punta a punta** con una prueba temporal en la base de
  pruebas:
  - el vendedor guardaba un precio manual sin autorizar con 50 %;
  - lo volvía a guardar con el precio habilitado y el mismo 50 %;
  - convertía la orden con 50 % de descuento;
  - lo mismo funcionaba tras un rechazo (orden con 40 %);
  - el 10 % de un administrador se conservaba con 1.000 perfiles en vez de 10.
- **También ciertos:** la edición simultánea, el redondeo, la fecha
  inexistente y el doble sondeo.
- **Falso:** el «margen» divide por el precio, no por el costo.
- **Secretos:** no hay en el repositorio ni en su historial.
- **Decisión del usuario:** no tocar los archivos grandes ni las observaciones
  de escalabilidad. Corregir SEC-01 con registro de quién autorizó.

**Migración `20261127140000_discount_authorization`** (aditiva):
- aplicada en `solaluminios_dev`, `solaluminios_ensayo_manual` y la base de
  pruebas, sin diferencias con el esquema; 28 migraciones;
- **Columnas:**
  - `quote_lines` y `sales_order_lines`: `discountApprovedById` y
    `discountApprovedAt`;
  - `quotes`: `globalDiscountApproved{Percent,Base,ById,At}`;
  - `sales_orders`: `globalDiscountApprovedById` y `globalDiscountApprovedAt`.
- **CHECK:** quién y cuándo van juntos.
- **Traslado:** las solicitudes globales ya aprobadas, ligadas a la base actual
  de cada cotización.
- **Disparadores:** al **insertar**, rechazan órdenes o renglones con más de
  3 % sin autorización.
- **No se rellenan** los descuentos por renglón antiguos: nada registra quién
  los puso.

**API:**
- **Nuevo** `sales/discount-authorization.ts`: reglas puras con
  `LineDiscountPool`, `globalApprovalCovers` y `sellerGlobalLimit`.
- **Al guardar** (`writeQuoteLines`):
  - un descuento de más de 3 % sobre el precio habilitado lo autoriza el
    administrador que lo guarda;
  - el vendedor lo conserva para el mismo material y porcentaje, sin más
    perfiles, una vez por autorización.
  - El descuento global se autoriza con su base y el vendedor lo conserva
    mientras no suba. El mensaje explica cuando la base creció.
- **Al aprobar:**
  - aprobar la solicitud global registra la autorización;
  - autorizar precios manuales que suben la base mueve la autorización
    global a la nueva base, con auditoría.
- **Al convertir:**
  - se revisa otra vez: el vendedor recibe 409;
  - si convierte un administrador, autoriza lo que falte (auditado);
  - la orden copia quién autorizó.
- **La orden** muestra `discountApprovedBy` y `globalDiscountApprovedBy`.

**Web:**
- **Misma regla** antes de guardar, con «Autorizado por …» en el descuento.
- **Descuento global:**
  - el límite se calcula con la base del borrador;
  - si la base creció, se guarda lo que el vendedor puede aplicar solo y se
    pide de nuevo, con un aviso.
- **Redondeo exacto en la vista previa:** `percentOfCents` en
  `lib/numbers.ts`. Sin eso, una diferencia de un centavo en la base podía
  dar por perdida una autorización.

**Pruebas:**
- **Nuevas:**
  - `test/discount-authorization.e2e-spec.ts` (7 casos);
  - `discount-authorization.spec.ts` (6 unitarias);
  - 9 casos de `percentOfCents`.
- **Ajustada:** `quote-discounts`. El descuento antiguo sin autor ya no se
  conserva; es el comportamiento que el informe objetó.
- **API:**
  - `build` y `oxlint` sin advertencias nuevas;
  - `pnpm test` 84/84;
  - `test:e2e --maxWorkers=2` **283/283** en 35 archivos.
- **Web:** `tsc`, `oxlint`, pruebas (7/7 Chafon y 33/33 números) y `build`.
- **Prueba temporal del informe**, repetida después: guardar responde 400 y
  convertir 409 en los tres casos. Se borró del repositorio.

**Navegador** (5174, como `prueba.cedula`, Ventas):
- se creó COT-000044: 177 NP China, 2 perfiles, precio manual con 50 % y
  solicitud a QA Admin;
- al quitar el precio manual aparece «Puedes dar hasta 3 % por renglón» y
  «Guardar cambios» queda deshabilitado;
- **Limpieza:** COT-000044 se canceló y su solicitud quedó cancelada.
- **No recorrido en el navegador:** el descuento global ligado a la base (lo
  cubren las pruebas e2e).

**Pendiente:**
- antes de desplegar, contar los borradores afectados y revisar si la falla se
  usó (consultas en `docs/auditoria-qa-2026-11-27.md`);
- desplegar la migración;
- entregar a QA el commit correctivo;
- edición simultánea, vigencia con día inexistente y doble sondeo.

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
