# Arranque con base de datos limpia (producción)

Objetivo: empezar a operar con una base de datos **sin ninguna prueba**:
sin paquetes, movimientos, cotizaciones, órdenes, tareas ni auditoría de
pruebas. La numeración de cotizaciones, órdenes, despachos y solicitudes
empieza de nuevo.

**Método.** La base actual no se borra: se le cambia el nombre
(`solaluminios_pruebas`) y queda guardada completa. En su lugar se crea una
`solaluminios_prod` vacía. Como el nombre es el mismo, la configuración del
API (`.env`, servicio, nginx) no cambia.

| Qué | Cómo llega a la base nueva |
| --- | --- |
| Perfiles (218 referencias, 23 familias) | `pnpm catalog:import` (CSV en Git) |
| Accesorios (128 referencias, 2 familias) | `pnpm catalog:import --file …accessories.csv` |
| Acabados, sucursales, ubicaciones, pasillos y burros | `pnpm structure:copy` desde la base vieja (no hay pantallas para crearlos) |
| Administrador | `node dist/scripts/create-admin.js` |
| Usuarios, proveedores, proveedor de China, supervisor de despachos, precios de venta, lectores fijos | Se vuelven a crear en la app (Administración) |
| Paquetes, lotes, compras, clientes, cotizaciones, órdenes, despachos, tareas, notificaciones, auditoría | **No pasan** (eso es lo que se limpia) |

Las claves JWT y de notificaciones están en `.env`, no en la base: no
cambian. Todos tendrán que **iniciar sesión de nuevo** con su cuenta nueva y
**activar otra vez las notificaciones** en el celular.

Ensayado en local el 18/11/2026 sobre una copia de la base de desarrollo.
Resultado: 20 migraciones, 25 familias, 346 referencias, 6 acabados, solo la
sucursal real, un administrador y el resto de tablas vacías. El inicio de
sesión y Registrar paquete funcionaron. Las bases del ensayo se borraron.

---

## A. Días antes del corte

**A1. Desplegar la versión que trae `structure:copy`.** Es el commit que
agrega `apps/api/src/scripts/copy-structure.ts`. Despliega como siempre (incluye
`pnpm build`) y comprueba que existe:

```bash
ls /srv/solaluminios/apps/api/dist/scripts/copy-structure.js
```

**A2. Correcciones al catálogo.** Si hay que corregir referencias (por
ejemplo las 9 «por validar»: 177, 413, 1122, 1123, 840, 3709, T166, 315,
T237), deben quedar en los CSV de `apps/api/prisma/data` **antes** del corte.
Lo que se edite a mano en la base actual se queda en la base vieja.

**A3. Revisar qué estructura se va a copiar** (solo lee; no escribe nada):

```bash
cd /srv/solaluminios/apps/api
pnpm structure:copy --from solaluminios_prod
```

Muestra los acabados, sucursales, ubicaciones, pasillos y burros activos.
Al final dirá «No se podría aplicar: origen y destino son la misma base»; es
lo esperado en este paso. Anota los **códigos de las sucursales o ubicaciones
de prueba** que no deben pasar (columna izquierda, p. ej. `TEST-…`). Los
inactivos nunca se copian.

**A4. Anotar la configuración real** que se volverá a crear en la app:
- usuarios (nombre, correo, rol, ubicación predeterminada);
- proveedores reales y cuál es el de China;
- supervisor de despachos;
- precios de venta;
- lectores fijos.

**A5. Datos del servidor.**

```bash
# Nombre del servicio del API (el que tu script de despliegue reinicia)
systemctl list-units --type=service | grep -i -E 'solal|api'

# Acceso de administración a PostgreSQL
sudo -u postgres psql -c 'select version()'

# Usuario de base de datos que usa el API (solo el usuario, sin contraseña)
sed -n 's#^DATABASE_URL=.*://\([^:@]*\).*#\1#p' /srv/solaluminios/apps/api/.env

# Dueño, codificación y configuración regional de la base actual
sudo -u postgres psql -c "SELECT pg_get_userbyid(datdba) AS dueno, pg_encoding_to_char(encoding) AS codificacion, datcollate, datctype, datlocprovider FROM pg_database WHERE datname = 'solaluminios_prod'"
```

Avísame antes del corte si pasa algo de esto:
- el usuario del API **no es** el dueño de la base: hay que repetir sus
  permisos en la base nueva;
- `datlocprovider` **no es** `c`: B5 cambia un poco.

**A6. Avisar a los usuarios.** El día del corte nadie puede tener paquetes
**pendientes por enviar** en el celular: Inicio lo muestra. Si hay, que se
envíen antes del corte, o se descartan.

---

## B. Día del corte

Calcula de 30 a 45 minutos en el servidor, más la configuración en la app.
Haz los pasos en orden, en una sola sesión SSH. Cada comando se pega por
separado.

```bash
cd /srv/solaluminios/apps/api
SERVICIO=nombre-del-servicio      # el del paso A5
```

### B1. Detener el API

```bash
sudo systemctl stop "$SERVICIO"
systemctl is-active "$SERVICIO"    # debe decir: inactive
```

### B2. Respaldo completo de la base actual

```bash
mkdir -p ~/respaldos
sudo -u postgres pg_dump -Fc solaluminios_prod > ~/respaldos/solaluminios_prod_antes_del_corte_$(date +%F_%H%M).dump
ls -lh ~/respaldos/
```

El archivo no debe pesar 0 bytes. Si `pg_dump` da error, **detente aquí**,
vuelve a iniciar el servicio y avísame.

### B3. Anotar cómo está creada la base actual

```bash
sudo -u postgres psql -c "SELECT pg_get_userbyid(datdba) AS dueno, pg_encoding_to_char(encoding) AS codificacion, datcollate, datctype FROM pg_database WHERE datname = 'solaluminios_prod'"
sudo -u postgres psql -c "SELECT s.setconfig FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = 'solaluminios_prod'"
```

Anota `dueno`, `codificacion`, `datcollate` y `datctype`. Si la segunda
consulta devuelve algo en `setconfig`, anótalo también.

### B4. Cambiar el nombre de la base actual

```bash
sudo -u postgres psql -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = 'solaluminios_prod' AND pid <> pg_backend_pid()"
sudo -u postgres psql -c "ALTER DATABASE solaluminios_prod RENAME TO solaluminios_pruebas"
```

Desde aquí, la base vieja se llama `solaluminios_pruebas` y queda intacta.

### B5. Crear la base nueva

Reemplaza `DUENO`, `CODIFICACION`, `COLLATE` y `CTYPE` por lo anotado en B3.
Las comillas dobles van alrededor del dueño; las simples, alrededor de lo
demás:

```bash
sudo -u postgres psql -c "CREATE DATABASE solaluminios_prod WITH OWNER = \"DUENO\" TEMPLATE = template0 ENCODING = 'CODIFICACION' LC_COLLATE = 'COLLATE' LC_CTYPE = 'CTYPE'"
```

Si en B3 hubo `setconfig` (p. ej. `{TimeZone=America/Bogota}`), repítelo:

```bash
sudo -u postgres psql -c "ALTER DATABASE solaluminios_prod SET TimeZone = 'America/Bogota'"
```

### B6. Migraciones

```bash
pnpm exec prisma migrate deploy
```

Debe decir `Datasource "db": … "solaluminios_prod"`, `20 migrations found`,
aplicarlas todas y terminar con «All migrations have been successfully
applied».

### B7. Catálogo

```bash
pnpm catalog:import --apply
```

Esperado: 23 familias y 218 referencias nuevas, y «Listo: cambios aplicados».

```bash
pnpm catalog:import --file prisma/data/catalog-accessories.csv --apply
```

Esperado: 2 familias y 128 referencias nuevas, y «Listo: cambios aplicados».

### B8. Acabados y estructura

Primero la simulación, con las exclusiones anotadas en A3. Repite
`--exclude-branch` o `--exclude-location` por cada código:

```bash
pnpm structure:copy --from solaluminios_pruebas --exclude-branch CODIGO-DE-PRUEBA
```

Revisa que la lista tenga solo lo real y que diga «Destino vacío: se puede
aplicar». Luego, el mismo comando con `--apply`:

```bash
pnpm structure:copy --from solaluminios_pruebas --exclude-branch CODIGO-DE-PRUEBA --apply
```

Debe terminar con «Listo: acabados y estructura copiados». Si no hay nada que
excluir, quita `--exclude-branch …`.

### B9. Administrador

La contraseña no se ve al escribirla ni queda en el historial:

```bash
read -rp 'Nombre del administrador: ' BOOTSTRAP_ADMIN_NAME
read -rp 'Usuario para ingresar (p. ej. pedro.alvarez): ' BOOTSTRAP_ADMIN_USERNAME
read -rp 'Correo del administrador (opcional, Enter para omitir): ' BOOTSTRAP_ADMIN_EMAIL
read -rsp 'Contraseña (12 a 128 caracteres): ' BOOTSTRAP_ADMIN_PASSWORD; echo
export BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
node dist/scripts/create-admin.js
unset BOOTSTRAP_ADMIN_NAME BOOTSTRAP_ADMIN_USERNAME BOOTSTRAP_ADMIN_EMAIL BOOTSTRAP_ADMIN_PASSWORD
```

Debe imprimir «Administrador creado» con el nombre y el usuario. Se ingresa
con ese usuario (desde la migración `20261127120000_usernames_password_policy`
el ingreso es por usuario; el correo todavía se acepta durante la
transición).

### B10. Iniciar el API y comprobar

```bash
sudo systemctl start "$SERVICIO"
systemctl is-active "$SERVICIO"    # debe decir: active
curl -sS -o /dev/null -w 'Página: HTTP %{http_code}\n' https://solualuminios.wetracking.co/
curl -sS -o /dev/null -w 'API tareas sin sesión: HTTP %{http_code}\n' https://solualuminios.wetracking.co/api/tasks
```

Esperado: `Página: HTTP 200` y `API tareas sin sesión: HTTP 401`.

### B11. Configuración en la app

Entra con el administrador nuevo. **No hagas pruebas en esta base**: todo lo
que se registre queda.

1. **Administración → Proveedores:**
   - crear los proveedores reales;
   - en la misma pantalla, elegir el **proveedor de China**.
2. **Administración → Usuarios:** crear cada usuario con su rol y su
   **ubicación predeterminada**. De ella depende la disponibilidad que ve el
   vendedor en la cotización. Incluye el usuario de **Facturación**.
3. **Administración → Proveedores:** elegir el **supervisor de despachos**
   (necesita que su usuario ya exista).
4. **Administración → Precios de venta:** cargar los precios.
5. **Administración → Lectores fijos:** solo si se usan.
6. Cada persona entra con su cuenta nueva y activa las notificaciones en su
   celular.

### B12. Verificación final

- Paquetes, Ventas y Tareas aparecen vacíos.
- Administración → Referencias muestra perfiles y accesorios.
- Registrar paquete ofrece solo sucursales y ubicaciones reales y los
  acabados.
- La primera carga real de inventario se hace como **inventario inicial**,
  no como entrada nueva.

---

## C. Si algo sale mal (volver atrás)

Se puede volver al estado anterior en cualquier paso desde B4. La base
vieja está intacta con el nombre `solaluminios_pruebas`:

```bash
sudo systemctl stop "$SERVICIO"
sudo -u postgres psql -c "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = 'solaluminios_prod' AND pid <> pg_backend_pid()"
sudo -u postgres psql -c "ALTER DATABASE solaluminios_prod RENAME TO solaluminios_corte_fallido"
sudo -u postgres psql -c "ALTER DATABASE solaluminios_pruebas RENAME TO solaluminios_prod"
sudo systemctl start "$SERVICIO"
```

La app queda como antes del corte. Guarda la salida del paso que falló y
revisamos.

## D. Después

- Conserva `solaluminios_pruebas` y el respaldo de B2 al menos un mes.
- Borrar `solaluminios_pruebas` es irreversible (`DROP DATABASE`). Hazlo
  solo cuando estés seguro y con el respaldo guardado en otro lugar.
