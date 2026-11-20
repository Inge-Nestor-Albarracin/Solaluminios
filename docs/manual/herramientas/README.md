# Herramientas para los pantallazos de los manuales

Con estas herramientas se hicieron los manuales de Ventas y Bodega. Sirven
para hacer el de Administración o rehacer pantallazos cuando cambien las
pantallas.

Todo es **local**: una base de demostración con personas ficticias y la app
apuntando a ella. Nunca se usan datos reales ni producción.

| Archivo | Para qué |
| --- | --- |
| `demo-db.mjs` | Crear o borrar la base de demostración y correr comandos contra ella. Solo acepta bases `solaluminios_ensayo*`. |
| `seed-manual.mjs` | Cargar los datos de demostración: acabados, 7 de agosto, Bodega 116, usuarios por rol, proveedores, clientes, compras, precios y paquetes. |
| `demo-api.mjs` | Preparar estados por el API: aprobar solicitudes de una cotización, registrar una factura u otras llamadas. |
| `driver.mjs` + `m.sh` | Edge sin ventana, controlado por HTTP local: evalúa JavaScript en la página, cambia el tamaño y toma pantallazos nítidos en `out/`. |

`seed-manual.json` (contraseñas de los usuarios de demostración), `out/` y
`edge-profile/` no se suben a Git.

## Requisitos

- Node 24 y Microsoft Edge (`EDGE_PATH` cambia su ruta).
- Git Bash, para `m.sh`.
- `apps/api/.env` con un `DATABASE_URL` local cuyo usuario pueda crear bases.
- El API compilado: `pnpm --dir apps/api build`.

## 1. Crear y llenar la base de demostración

Desde la raíz del repositorio (Git Bash):

```bash
H=docs/manual/herramientas
node $H/demo-db.mjs sql postgres "CREATE DATABASE solaluminios_ensayo_manual TEMPLATE = template0 ENCODING = 'UTF8'"
node $H/demo-db.mjs run solaluminios_ensayo_manual pnpm exec prisma migrate deploy
node $H/demo-db.mjs run solaluminios_ensayo_manual pnpm catalog:import --apply
node $H/demo-db.mjs run solaluminios_ensayo_manual pnpm catalog:import --file prisma/data/catalog-accessories.csv --apply
node $H/seed-manual.mjs base
```

## 2. Levantar la app contra esa base

- **API en el puerto 3101:** configuración `api-manual` de `.claude/launch.json`
  (en Claude, `preview_start` con ese nombre), o a mano:
  `PORT=3101 CORS_ORIGIN=http://localhost:5174 node $H/demo-db.mjs run solaluminios_ensayo_manual node dist/main`.
- **Web en el puerto 5174:** configuración `web-alt`, o
  `VITE_API_URL=http://localhost:3101 pnpm --dir apps/web dev --port 5174`.

Con el API arriba, termina la carga (compras, precios y paquetes):

```bash
node $H/seed-manual.mjs http
```

Los usuarios son `admin@`, `ventas@`, `ventas2@`, `bodega@`, `almacen7@` y
`facturacion@demo.local`. Sus contraseñas están en `seed-manual.json`.

## 3. Pantallazos

```bash
node $H/driver.mjs &        # deja Edge sin ventana escuchando en 127.0.0.1:9444
bash $H/m.sh viewport '{"width":1280,"height":800,"scale":1.5,"mobile":false}'
bash $H/m.sh goto http://localhost:5174/
bash $H/m.sh eval <<'EOF'
const m = window.__m;
m.set(document.querySelector('input[type=email]'), 'admin@demo.local');
m.set(document.querySelector('input[type=password]'), '<de seed-manual.json>');
m.click(m.byText('button', 'Iniciar sesión'));
await m.until(() => document.body.innerText.includes('¡Hola!'));
m.nav('Ventas');
EOF
bash $H/m.sh shot admin-01-ventas              # pantalla completa → out/admin-01-ventas.jpg
bash $H/m.sh shot admin-02-tarjeta "main .card" 16   # solo un elemento, con 16 px de margen
bash $H/m.sh quit
```

- **Ayudas dentro de la página** (`window.__m`): `set`, `pick`, `click`, `nav`,
  `byText`, `field`, `top`, `until` y `sleep`.
- **En celular:** `viewport` con `{"width":390,"height":844,"scale":2,"mobile":true}`.
- **Columnas fijas o paneles laterales:** captura la ventana completa en vez de
  un elemento.
- **Navegación:** al recargar o ir a otra dirección la app cierra la sesión.
  Navega con el menú (`m.nav`).

Copia los pantallazos elegidos de `out/` a `docs/manual/img/` y genera el PDF
como dice `docs/manual/README.md`.

## 4. Al terminar

```bash
node $H/demo-db.mjs sql postgres "DROP DATABASE solaluminios_ensayo_manual"
rm $H/seed-manual.json
```
