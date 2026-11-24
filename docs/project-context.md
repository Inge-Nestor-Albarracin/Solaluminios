# Solaluminios: contexto del proyecto

Estado al **20 de noviembre de 2026**. Este archivo reemplaza la versión del
13/10/2026 y es el que se debe leer primero, como indica `AGENTS.md`.

Resume qué es el sistema, cómo está construido, dónde corre, qué está hecho y
qué falta. El detalle de cada tarea, con fechas, pruebas y archivos, está en
`docs/development-status.md`. Las reglas para trabajar en el código están en
`AGENTS.md`.

> Ante cualquier diferencia, mandan el código y los resultados ejecutados.
> Este documento explica; no reemplaza revisar el repositorio.

---

## 1. Qué es

**Solaluminios** distribuye perfiles de aluminio, nacionales e importados de
China. Antes manejaba existencias, entradas, salidas y ubicaciones en hojas de
Excel.

El sistema digitaliza la operación con **inventario por paquete identificado
con un chip RFID**, y suma la venta, los despachos y el abastecimiento entre
bodega y almacén.

- **Nombre en pantalla:** «Solualuminios · Inventario».
- **Marca del proveedor del software:** WeTracking · Soluciones Integrales
  (logo, colores y tipografía de la app).
- **Repositorio:** `github.com/Inge-Nestor-Albarracin/Solaluminios` (rama
  `main`). El monorepo local se llama `Aduvidrios`.
- **Producción:** `https://solualuminios.wetracking.co` (el API bajo `/api`).

## 2. Qué hace

| Área | Funciones |
| --- | --- |
| **Inventario** | Registro de paquetes con su chip (EPC de fábrica): inventario existente o entrada nueva. Consulta por chip, lista de paquetes y resumen de existencias. Abrir paquete (perfiles sueltos), salida, traslado de uno o varios paquetes y ajustes (solo administrador). Historial de movimientos. Lectura masiva con la pistola. |
| **Ubicaciones** | Sucursal → bodega o almacén → pasillo → burro. Los **almacenes** (`RETAIL_STORE`) no tienen pasillo ni burro: lo que llega se abre y queda en perfiles sueltos. Acabados, sucursales, ubicaciones, pasillos y burros no tienen pantalla de creación: se crean por el API o se copian con `structure:copy`. |
| **Catálogo** | Familias, referencias (perfiles) y acabados (colores). Accesorios como familias de tipo `ACCESSORY`: solo catálogo, no se venden ni se inventarían todavía. |
| **Abastecimiento** | Proveedores, compras (orden de factura: valor sin IVA → descuento → IVA, más fletes), lotes y procedencia (China o Nacional) y precios de venta calculados desde la compra (solo administrador). |
| **Ventas** | Clientes y cotizaciones **Detal** o **Ventanería** (con ensamble e instalación). Descuento por renglón (hasta 3 %), descuento global (más de 3 % requiere autorización) y precio manual con autorización. PDF. Conversión en orden con forma de pago obligatoria, reserva en **una** ubicación, estado de pago (abono o cartera) y cancelación. La cotización muestra la disponibilidad en la ubicación del vendedor y aparte la de las demás. |
| **Facturación** | Casilla «Requiere facturación». La orden le llega como tarea al rol Facturación, que hace la factura en otro software y registra su número. Si se cancela una orden facturada, se crea la tarea de anulación. |
| **Despachos** | Ventas autoriza la entrega. Bodega lee los paquetes con la pistola; el sistema sugiere primero los sueltos y luego los más antiguos. Incidencias si se lee algo que no corresponde. Al confirmar la salida física se descuenta el inventario y se consume la reserva. Entrega parcial posible. |
| **Solicitudes de materiales** | Ventas pide perfiles de una bodega para un almacén. Bodega prepara paquetes completos y confirma la salida; el almacén marca el pedido como recibido. Enviar la solicitud no mueve ni reserva inventario. |
| **Tareas** | Propias y asignadas, con vencimiento. Las vencidas pasan a incompletas. Las tareas de despacho, solicitud, aprobación y facturación se completan solas con su flujo. |
| **Notificaciones** | App instalable (PWA) con Web Push: tareas, despachos, solicitudes, aprobaciones, facturación. |
| **Exportación** | Excel de ventas para comisiones, solo administrador: hojas Órdenes, Renglones y Resumen, con las canceladas en rojo. |
| **Lectores fijos** | Sesiones de lector de portal y simulador. Fase 1: no hay lectura continua ni movimientos automáticos. |
| **China** | Prerregistro de paquetes por el operador en China y recepción en bodega. **Por decisión del usuario no se documenta en los manuales**, porque su uso no es seguro. |

## 3. Roles

| Rol | Nombre en pantalla | Qué ve y hace |
| --- | --- | --- |
| `ADMIN` | Administrador | Todo: catálogo, usuarios, proveedores, compras, precios, lectores y ajustes; aprueba descuentos y precios manuales; exporta a Excel. |
| `WAREHOUSE` | Bodega | Registrar, consultar y operar paquetes; preparar despachos y solicitudes; recibir en el almacén. Tiene una ubicación asignada. |
| `SALES` | Ventas | Cotizaciones y órdenes propias, despachos, solicitudes a bodega y consulta de inventario. No ve costos. Su ubicación asignada define la disponibilidad principal en la cotización. |
| `BILLING` | Facturación | Solo Inicio, Facturación y Tareas. Ve las órdenes que requieren factura, descarga el PDF y registra el número de factura. |
| `READ_ONLY` | Solo lectura | Consultas. |
| `CHINA_OPERATOR` | Operador China | Solo prerregistro del proveedor chino (interfaz en inglés). |
| `ACCESSORIES` | Accesorios | Bodega de accesorios (`docs/accesorios-fase-1.md`). Rol creado el 24/11/2026: por ahora solo Inicio y Tareas; canastas, ingresos, ventas de mostrador y despachos de accesorios llegan por entregas. |

- **Guard global de roles:** `CHINA_OPERATOR`, `BILLING` y `ACCESSORIES` solo
  llegan a las rutas que los nombran explícitamente. Los demás roles tienen GET en las rutas
  sin `@Roles`, y las escrituras requieren su rol explícito.
- **Responsable de cada operación:** sale siempre de la sesión, nunca del
  cuerpo de la petición.

## 4. Reglas del negocio que no se deben romper

- **Paquete y chip:**
  - un paquete tiene **una referencia y un acabado**;
  - el **EPC** de fábrica se guarda directo en `Bundle`, como texto, sin perder
    ceros iniciales, y es único;
  - no se recodifican etiquetas.
- **Fuera del alcance actual:** no hay `RfidTag`, `Product`, SKU ni longitud;
  agregarlos requiere un cambio de alcance explícito.
- **Inventario existente** (`INITIAL_STOCK`) y **entrada nueva** (`ENTRY`) son
  operaciones distintas. Leer un EPC ya registrado no vuelve a sumar stock.
  - En el inventario antiguo se carga la cantidad que queda hoy, no la de
    llegada.
  - No se inventan salidas históricas.
- **Fechas:** la llegada física (exacta, mes y año, o desconocida) y el registro
  digital son fechas distintas. No se inventa un día.
- **Cantidades:** van en **perfiles enteros**. Todo cambio de cantidad o de
  ubicación queda como movimiento.
- **Cotizar no reserva ni descuenta inventario.**
- **Confirmar una orden** reserva todo en una sola ubicación, o nada; si no
  alcanza, la orden queda «Pendiente de abastecimiento».
- **China y Nacional son materiales distintos.** El material de origen
  desconocido no se usa hasta que se clasifique.
- **Precios:** el precio de venta lo habilita el administrador por referencia,
  acabado y origen. Los costos solo los ve el administrador.
- **Acabados:**

  | Código | Notación del cliente | Acabado |
  | --- | --- | --- |
  | BM | B/M | Blanco mate |
  | BP | B/P | Blanco pintura |
  | NP | N/P | Negro pintura |
  | CR | CR | Crudo |
  | BR | BR | Brillo |
  | CH | CH | Champaña |

  BP no es «plata» ni NP es «negro perla». CR reemplazó al código CRUDO. Los
  acabados reales se ajustaron por SQL: no volver a cargarlos ni renombrar sus
  IDs. La equivalencia del «Silver» de China está pendiente.
- **Descripciones:** la descripción es por referencia y no es única (dos
  referencias pueden llamarse «Jamba»). El acabado se muestra aparte.

## 5. Arquitectura

**Flujo:** React (PWA) → API NestJS (reglas y permisos) → Prisma → PostgreSQL.
El navegador nunca se conecta a la base.

| Parte | Tecnología |
| --- | --- |
| Monorepo | pnpm **11.4.0** (fijado en `devEngines`), Node **24** (local 24.11) |
| API (`apps/api`) | NestJS 12 en ESM, TypeScript 6, Prisma **7.8.0** con `@prisma/adapter-pg`, pg 8, class-validator, ExcelJS 4.4, PDFKit 0.18, web-push 3.6, vitest 4, oxlint |
| Web (`apps/web`) | React 19, Vite 8, vite-plugin-pwa 2.0 (service worker propio `src/sw/sw.ts`), TypeScript 6, oxlint; fuente Nunito Sans |
| Base de datos | PostgreSQL **18** (local); en el servidor, PostgreSQL en 127.0.0.1 |

- **Módulos del API** (`apps/api/src/modules`):
  - `auth`, `users`;
  - `catalog`, `locations`, `inventory`;
  - `supply` (proveedores, compras, lotes, precios, ajustes, China);
  - `sales` (clientes, cotizaciones, órdenes, reservas, facturación,
    exportación);
  - `dispatch`, `material-requests`, `tasks`;
  - `notifications` (outbox), `push`, `readers`.
- **Base de datos:** acceso único por `PrismaService` en
  `src/infrastructure/database`.
- **Prisma:**
  - el generador `prisma-client` escribe en `src/generated/prisma`;
  - la URL de la base se carga en `prisma.config.ts`;
  - el cliente generado no se edita a mano.
- **Validación:** `ValidationPipe` global con `transform`, `whitelist` y
  `forbidNonWhitelisted`.
- **Autenticación:**
  - JWT HS256 de 1 hora;
  - contraseñas con scrypt;
  - en cada petición se verifican el usuario activo y su rol;
  - sin registro público ni recuperación de contraseña;
  - al recargar la página se vuelve a ingresar.
- **Modelo:** 41 modelos en `apps/api/prisma/schema.prisma`, entre ellos
  Branch, InventoryLocation (tabla `warehouses`), Aisle (columna
  `warehouseId`), Rack, ProductFamily, Reference, Finish, Bundle,
  InventoryMovement, StockLot, Supplier, Purchase*, SalePrice, Customer,
  Quote*, SalesOrder*, StockReservation, Dispatch*, MaterialRequest*, Task,
  NotificationOutbox, PushSubscription, Reader*, AuditEvent y Setting.
- **Integridad en PostgreSQL:** CHECKs, índices únicos parciales y triggers de
  lotes, reservas y entregas.
- **Concurrencia:** bloqueos de fila e `operationKey` idempotente en las
  operaciones que se pueden repetir desde el frontend.
- **Migraciones:** 21 en total; la última es
  `20261124120000_accessories_role` (aplicada en la base local el 24/11/2026,
  todavía no en producción).
  No se modifican las ya aplicadas, no se usa `db push` y no se resetea la base.

## 6. Entornos

### Local (equipo de desarrollo)

- **Carpeta:** el equipo original usaba `C:\Users\ASUS\Pictures\Aduvidrios`.
  En un equipo nuevo, usa la carpeta donde clonaste el repositorio (se
  recomienda una ruta corta, por ejemplo `C:\dev\Aduvidrios`); no supongas una
  ruta fija.
- **Bases:**

  | Base | Uso |
  | --- | --- |
  | `solaluminios_dev` | Desarrollo. Tiene datos de prueba y un administrador «7 de agosto» creado para QA. |
  | `solaluminios_dev_e2e_test` | Pruebas automáticas; se crea con `pnpm test:db:setup`. |
  | `solaluminios_dev_isolated_test` | Pruebas aisladas. |
  | `solaluminios_ensayo_manual` | Demostración temporal para los pantallazos de los manuales: catálogo real y personas ficticias `*@demo.local`. Se recrea con las herramientas de `docs/manual/herramientas/`. |

- **Configuración, fuera de Git** (nunca se comparte ni se pega en chats):
  - `apps/api/.env`: `DATABASE_URL`, `JWT_SECRET`, claves VAPID, CORS;
  - `apps/api/.env.test`: `TEST_DATABASE_URL`;
  - `apps/api/.env.push-test`;
  - `apps/api/.env.example` muestra qué variables existen.
- **Puertos:** API 3000 y web 5173. Configuraciones alternas en
  `.claude/launch.json`: `api-alt`, `api-test` y `web-alt` (3101 y 5174).

### Producción

- **Servidor Linux:**
  - usuario `deploy`;
  - código en `/srv/solaluminios`;
  - base `solaluminios_prod`;
  - nginx como proxy (ejemplos en `docs/deploy/*.example`);
  - el API corre como servicio del sistema.
- **Despliegue (el usuario tiene un script):** compila web y API, ejecuta
  `prisma migrate deploy` e inicia el servicio. Para comprobar: la página
  responde HTTP 200 y `/api/tasks` sin sesión responde 401.
- **Estado al 18/11/2026:**
  - las 20 migraciones están aplicadas;
  - catálogo cargado con 23 familias y 218 referencias de perfiles, más 2
    familias y 128 referencias de accesorios.

## 7. Comandos

Desde `apps/api`:

```powershell
pnpm build                     # compila el API (también los scripts de dist/)
pnpm lint                      # oxlint
pnpm test                      # pruebas unitarias
pnpm test:e2e                  # integración (usa la base de pruebas)
pnpm test:db:setup             # crea la base de pruebas si no existe
pnpm exec prisma migrate deploy
pnpm catalog:import [--file prisma/data/catalog-accessories.csv] [--apply] [--overwrite]
pnpm structure:copy --from <base> [--exclude-branch CODIGO] [--apply]
pnpm start:test-db             # API contra la base de pruebas (puerto 3101)
```

Desde `apps/web`: `pnpm dev`, `pnpm build`, `pnpm lint` y `pnpm test`.

- **Primer administrador:** `node dist/scripts/create-admin.js`, con las
  variables `BOOTSTRAP_ADMIN_*`, o `scripts/Create-Admin.ps1` en Windows.
- **Catálogo:** los datos están en `apps/api/prisma/data/catalog-references.csv`
  y `catalog-accessories.csv`. El importador simula por defecto y nunca borra.

**Última verificación completa:** API con 52/52 pruebas unitarias y 225/225 de
integración (28 suites), `oxlint` y build. Web con `tsc`, `oxlint`, sus pruebas
y build.

## 8. Estado actual

- **Código:** en GitHub, rama `main`.
- **Funciones terminadas** (detalle en `development-status.md`):
  - inventario fase 1 completo;
  - almacenes sin pasillo;
  - traslados múltiples;
  - compras y precios;
  - ventas completas (descuentos, precio manual, Ventanería, forma de pago al
    convertir, avisos al vendedor);
  - disponibilidad por ubicación en la cotización;
  - despachos con RFID;
  - solicitudes de materiales;
  - rol Facturación;
  - exportación a Excel;
  - catálogo de accesorios;
  - PWA con notificaciones;
  - manuales de **Ventas** (29 páginas) y **Bodega** (27 páginas) en
    `docs/manual/`.
- **Avisos conocidos, sin impacto:**
  - `pg` muestra un aviso de deprecación («client.query() when the client is
    already executing a query»). Viene de Prisma 7.8 y no afecta datos. Se
    revisa al actualizar Prisma, en una tarea aparte.

## 9. Pendiente

La próxima tarea concreta está en `docs/next-task.md`.

### Corte a base limpia (prioridad)

Antes de empezar a operar, la base de producción debe quedar **sin pruebas**,
solo con el catálogo. Está previsto para la semana del 25/11/2026 (fecha por
confirmar). La guía completa y ensayada es `docs/deploy/base-limpia.md`:
1. renombrar `solaluminios_prod` a `solaluminios_pruebas`;
2. crear una base vacía;
3. migraciones;
4. catálogo;
5. `structure:copy` (acabados y ubicaciones);
6. administrador nuevo;
7. configuración en la app.

Incluye cómo volver atrás. El corte lo ejecuta el usuario en el servidor.

**Antes del corte:**
- desplegar la versión con `structure:copy`;
- pasar al CSV las correcciones del catálogo;
- revisar la estructura con la simulación;
- confirmar quién es el dueño de la base (paso A5).

### Configuración en producción

- **Usuarios:** crear el de **Facturación**. Mientras no exista, las órdenes por
  facturar van al administrador más antiguo.
- **Ubicaciones:** asignar a cada vendedor y bodeguero su **ubicación
  predeterminada**.
- **Proveedores:** reales, el proveedor de China y el supervisor de despachos.
- **Precios de venta.**
- **Catálogo:** validar las 9 referencias «por validar» (177, 413, 1122, 1123,
  840, 3709, T166, 315 y T237).
- **Inventario real:** cargarlo como «Inventario existente».

### Manuales

- Falta el manual de **Administración**.
- Faltan los pantallazos que requieren celular o hardware real (marcados como
  «Pantallazo pendiente»): instalar la app, notificaciones, lector Bluetooth.
- Las herramientas de captura y el seed de la base de demostración están en
  `docs/manual/herramientas/`. Para regenerar los PDF basta Edge: ver
  `docs/manual/README.md`.

### Hardware y campo

- Probar la pistola **Chafon** real (Bluetooth y modo teclado) en registro,
  lectura masiva y despachos.
- Notificaciones en Android real con HTTPS.
- Lector fijo de portal físico.

### Definiciones de negocio abiertas

- Vender accesorios: color, unidad (unidad, metro o rollo) y cómo se muestran.
- Equivalencia «Silver» de China.
- Unidad del stock histórico de Excel e importación conciliada.
- División de paquetes y traslado parcial.
- Recurrencia de tareas.
- Uso de Recepción China.

### Orden y limpieza

- **Base de pruebas:** quedan datos de corridas fallidas antiguas (usuarios
  e2e con sufijos 2D24CE05, 3A580E3A y 855BB9D1, y QB7862). No afectan.
- **Plantillas:** `apps/api/README.md` y `apps/web/README.md` son las de NestJS
  y Vite.

## 10. Al cambiar de computador

1. **Instalar:** Git, Node 24, pnpm 11.4.0, PostgreSQL 18, VS Code y la app de
   Claude.
2. **Código:** `git clone` del repositorio y copiar los `.env` de `apps/api`
   (por USB o archivo cifrado).
3. **Dependencias:**
   ```powershell
   pnpm install --frozen-lockfile
   ```
4. **Base local:** restaurar un respaldo (`pg_dump` / `pg_restore`) o crear una
   base y aplicar las migraciones. Las bases de pruebas se recrean con
   `pnpm test:db:setup`.
5. **Comprobar:** `pnpm build`, `pnpm lint` y las pruebas.
6. **Opcional:** copiar `C:\Users\<usuario>\.claude` para conservar las
   conversaciones y la memoria de Claude Code. El nombre de cada subcarpeta
   depende de la ruta del proyecto; si la ruta cambia, hay que renombrarla.
7. **Servidor:** tener a mano el acceso de `deploy@…` (llave o contraseña).

## 11. Documentos del repositorio

| Documento | Contenido |
| --- | --- |
| `AGENTS.md` / `CLAUDE.md` | Reglas para trabajar en el código: convenciones, base de datos, seguridad, pruebas |
| `docs/project-context.md` | Este resumen |
| `docs/next-task.md` | Próxima tarea concreta |
| `docs/development-status.md` | Bitácora detallada de cada tarea: decisiones, archivos, pruebas, pendientes |
| `docs/deploy/base-limpia.md` | Guía del corte a base limpia en producción |
| `docs/manual/` | Manuales de usuario (HTML, PDF y pantallazos), sus herramientas y cómo regenerarlos |
| `README-VENTAS-DESPACHOS.md` | Detalle de compras, ventas, despachos, roles y lector |
| `README-PWA.md` | Instalación como app y notificaciones push |
| `docs/roles-permissions-idor-audit.md` | Auditoría de roles y permisos |
| `docs/concurrency-audit.md` | Auditoría de concurrencia e idempotencia |
| `docs/refinamiento-registro-precios.md` | Diseño del registro y los precios |
| `START-HERE.md` | Cómo abrir el proyecto con Claude Code |

## 12. Reglas de seguridad y de trabajo (resumen de `AGENTS.md`)

- **Secretos:** no se muestran ni se copian contraseñas, tokens, connection
  strings ni el contenido de `.env`.
- **Base de datos:** no se resetea, no se borran datos reales y no se
  modifican migraciones aplicadas. Cada cambio de esquema va en una migración
  nueva, revisada.
- **Autenticación:** no se cambia `JWT_SECRET`, no se recrea el administrador y
  no se vuelven públicas las rutas protegidas.
- **Pruebas:** usan identificadores únicos y se limpian por IDs exactos, nunca
  por prefijos amplios.
- **Publicación:** sin push, despliegue ni publicación salvo pedido del
  usuario.
- **Cierre de cada tarea:** se actualiza `docs/development-status.md` con los
  archivos, las pruebas ejecutadas y los pendientes.

---

## Anexo: hallazgos de fase 1 que siguen vigentes

### Ubicaciones y pisos

- Bogotá puede tener bodega y almacén contiguos en la misma sucursal.
- Se mencionaron cuatro pisos y pasillos numerados en secuencia (1–3, 4–6,
  7–9, 10–12): hay que verificar la distribución física.
- `floorNumber` es configurable; no se deduce de una fórmula.
- El código histórico P12B7-173BM significa pasillo 12, burro 7, referencia
  173, acabado BM. Un traslado no cambia la referencia.

### Excel histórico

- **Archivos revisados:** `Inventario 07-08-26.xlsx`, con las hojas BODEGA
  PRINCIPAL, ALMACEN IMPORTADO y ALMACEN VITRAL, y `Contenedor #10.xlsx`. Los
  nombres de hoja no prueban cuántos locales físicos hay.
- **Estructura:**
  - encabezados como «3831 VENTANA PROYECTANTE» agrupan referencias;
  - el resumen de stock y las tablas de entradas y salidas son tablas
    independientes;
  - stock = existencia inicial + entradas − salidas.
- **Por qué no se importa a ciegas:**
  - hay saldos negativos y códigos especiales (CURVO, sufijos antiguos, MADERA)
    que requieren conciliación;
  - las cantidades están agrupadas por ubicación, no por paquete;
  - hay que confirmar la unidad de STOCK antes de importar;
  - un conteo físico no se suma a un saldo ya importado sin conciliación.

### Documentos de China

- Item No. = código del proveedor.
- Surface/Description = acabado.
- Length (M) = longitud.
- Quantity (pcs) = perfiles.
- Bundles = paquetes.

El reparto por paquete no se deduce de un promedio. SLU173 → 173 es candidato,
no equivalencia confirmada.

### Fase 2 (no implementar sin decisión)

- Codificación de etiquetas en China.
- Cargamentos esperados y ubicación planeada antes de llegar; posible cálculo
  de capacidad.
- Antena de portal para entradas y salidas automáticas.
- Pantallas o tablets con la referencia y el destino.

Stock esperado no es disponible, y una ubicación planeada no es una ubicación
física confirmada. Una lectura de antena no se convierte en movimiento sin
validación.
