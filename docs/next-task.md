# Próxima tarea (actualizado el 20/11/2026)

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
- resolver dudas del paso A5: el dueño de la base y la configuración regional.

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
