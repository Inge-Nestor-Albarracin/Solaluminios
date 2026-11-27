# Próxima tarea (actualizado el 24/11/2026)

El contexto vigente está en `docs/project-context.md` y la bitácora detallada
en `docs/development-status.md`. Las tareas de octubre que estaban aquí
(familias, cotizador) ya están hechas.

## Antes de empezar, en cualquier equipo

1. Lee `AGENTS.md`, `docs/project-context.md` y el final de
   `docs/development-status.md`.
2. Revisa `git status`. El repositorio debe estar al día con `origin/main`.
3. Comprueba que existan los `.env` de `apps/api`. Si faltan, pídeselos al
   usuario; no los inventes ni muestres su contenido.
4. Verifica el estado:
   - en `apps/api`: `pnpm build`, `pnpm lint`, `pnpm test` y `pnpm test:e2e`
     (última vez: 52/52 y 225/225);
   - en `apps/web`: `pnpm build`, `pnpm lint` y `pnpm test`.

## Tareas en orden

### 1. Corte a base limpia en producción (semana del 25/11/2026, por confirmar)

Lo ejecuta el usuario en el servidor con `docs/deploy/base-limpia.md`. El papel
de Claude es acompañarlo:
- revisar las salidas que pegue;
- ajustar el CSV del catálogo si hay correcciones (por ejemplo, las 9
  referencias «por validar»);
- resolver dudas del paso A5: el dueño de la base y la configuración regional;
- si la salida del paso A3 muestra una ubicación o sucursal «116», preparar el
  `UPDATE` para renombrarla a «139» después del paso B8 (decisión del usuario
  del 24/11/2026: solo en producción).

Nunca se ejecuta nada contra producción desde aquí.

### 2. Manual de usuario de Administración

Con el mismo formato que `docs/manual/manual-ventas.html` y
`manual-bodega.html`:
- **Herramientas y pasos:** en `docs/manual/herramientas/README.md` (base de
  demostración, API contra esa base y capturas con Edge sin ventana).
- **Qué cubrir:**
  - usuarios y roles, con la ubicación predeterminada;
  - proveedores, el proveedor de China y el supervisor de despachos;
  - familias, referencias y accesorios;
  - compras y costos, lotes y procedencia, precios de venta;
  - aprobar o rechazar descuentos y precios manuales;
  - ajustes de inventario;
  - exportación a Excel;
  - lectores fijos;
  - tareas asignadas a otros;
  - lo que el administrador ve de ventas y despachos.
- **Excluir:** Recepción China, por decisión del usuario.

Al terminar, borrar la base de demostración `solaluminios_ensayo_manual` si ya
no se necesita.

### 3. Configuración real en producción (tras el corte, con el usuario)

- Usuario de Facturación.
- Ubicación predeterminada de cada usuario.
- Proveedores reales, proveedor de China y supervisor de despachos.
- Precios de venta.
- Carga del inventario real como «Inventario existente».

### 4. Rol Accesorios, fase 1 (diseño propuesto el 24/11/2026)

El diseño completo está en `docs/accesorios-fase-1.md`:
- cada canasta de la bodega de accesorios es un paquete con chip, único por
  referencia y color;
- la canasta se rellena con un ingreso (cantidad digitada y su soporte), y
  al administrador le llega una tarea informativa;
- el precio nace de la compra, como en los perfiles;
- Accesorios vende solo accesorios en mostrador (cliente genérico), con el
  despacho para ella misma, y registra salidas sin venta con motivo y tarea
  al administrador;
- Ventas también vende accesorios: una orden mixta genera dos despachos, los
  perfiles para Bodega y los accesorios para Accesorios;
- toda salida tiene un documento detrás y queda como movimiento auditable;
- se sugiere entregarla en tres partes: inventario, venta de mostrador y
  ventas mixtas.

**Hecho el 24/11/2026, en local:**
- el rol `ACCESSORIES`;
- la **entrega 1**: canastas, ingresos, salidas sin venta, aviso al
  administrador y protecciones de los flujos de perfiles.

Migraciones `20261124120000_accessories_role` y
`20261124130000_accessory_inventory`, todavía no desplegadas.

**Siguiente: entrega 2** (compras y precios de accesorios, y venta de
mostrador de Accesorios).
- Antes de la entrega 3, confirmar con el usuario qué pasa con una orden mixta
  sin existencias.
- El orden frente a las tareas 1 a 3 está por confirmar con el usuario.
- **En producción hace falta:** desplegar las dos migraciones y crear la
  «Bodega de accesorios» (tipo `ACCESSORY_WAREHOUSE`) en la sede de la 139,
  por el API (`POST /locations/inventory-locations`). Luego asignarla al
  usuario de Accesorios en Administración → Usuarios.

### Hecho en local el 24/11/2026: pagos mixtos y abonos

- **Qué hace:**
  - contado en efectivo, en transferencia o repartido entre ambos, que se
    registra al convertir;
  - abonos con fecha, valor y medio en la orden, con «Agregar abono» y
    «Editar».
- **Migración:** `20261124140000_order_payments`, todavía no desplegada.
- **Detalle y decisiones pendientes:** en la bitácora, «Pagos de contado
  mixtos y abonos en la orden».

### Hecho en local el 25/11/2026: devoluciones de clientes

- **Qué hace:** devolución formal (DV) desde la orden, autorizada por el
  administrador y recibida por bodega. Lo pagado de más queda como saldo a
  favor o reintegro, y la orden facturada genera la tarea de nota crédito.
- **Migración:** `20261125120000_sales_returns`, todavía no desplegada.
- **Detalle, decisiones por confirmar y límites:** `docs/devoluciones.md`.

### Hecho en local el 27/11/2026: ingreso por usuario y cédula como clave inicial

- **Qué hace:**
  - ingreso con un usuario tipo `pedro.alvarez`;
  - la cédula es la clave inicial y se cambia obligatoriamente en el primer
    ingreso;
  - el administrador restablece claves y cambia usuarios;
  - registro de ingresos.
- **Usuarios existentes:** reciben como usuario lo que va antes de la @ de su
  correo, y el correo sigue sirviendo para ingresar durante la transición.
- **Migraciones:** `20261127120000_usernames_password_policy` y
  `20261127130000_login_events_outlive_users`, todavía no desplegadas.
- **Después de desplegar:**
  - avisar a cada persona su nombre de usuario;
  - actualizar los manuales de Ventas y Bodega, que dicen «correo».
- **Detalle y pendientes:** `docs/usuarios-y-contrasenas.md`.

## Pendientes sin fecha (no empezar sin decisión del usuario)

- Pruebas con la pistola Chafon real y con Android por HTTPS.
- Venta de accesorios: color y unidad.
- Equivalencia «Silver».
- Importación conciliada del Excel histórico.
- División de paquetes.
- Recurrencia de tareas.
- Actualizar Prisma, por el aviso de `pg`.

## No incluir sin pedido explícito

- Cambios de esquema que no pida la tarea (cada uno va en una migración nueva
  y revisada).
- Push, despliegues o acciones en el servidor.
- Recepción China en manuales.
