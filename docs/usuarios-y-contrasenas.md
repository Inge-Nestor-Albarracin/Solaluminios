# Usuarios y contraseñas

Estado al **27/11/2026**: hecho en desarrollo. Faltan las migraciones en
producción: `20261127120000_usernames_password_policy` y
`20261127130000_login_events_outlive_users`.

Pedido del cliente: ingresar con un usuario tipo `pedro.alvarez`, en vez del
correo, y que la contraseña sea la cédula.

Decisión del 26/11/2026: la cédula **solo como clave inicial**. Se cambia
obligatoriamente en el primer ingreso, porque no es secreta: está en facturas,
nómina y fotocopias, y la conocen los compañeros. Como contraseña permanente,
cualquiera podría entrar como otro y la auditoría (quién autorizó, despachó o
reintegró) dejaría de servir.

## Cómo funciona

1. **Crear al usuario (Administración → Usuarios).** El administrador escribe:
   - el nombre;
   - el usuario: se sugiere con el nombre («Pedro Álvarez Gómez» →
     `pedro.alvarez`) y se puede cambiar;
   - la **cédula como clave inicial**;
   - el correo, opcional;
   - el rol.

   La cédula se guarda solo cifrada, como cualquier contraseña; nunca como
   dato.
2. **Primer ingreso:** con su usuario y su cédula. La aplicación muestra solo
   «Es tu primer ingreso», que pide la cédula y la contraseña nueva dos
   veces. El API no responde nada más hasta que se cambia: devuelve 403 con
   `code: PASSWORD_CHANGE_REQUIRED`, salvo en `GET /auth/me` y
   `POST /auth/change-password`.
3. **Reglas de la contraseña propia** (iguales en el API y en la pantalla):
   - al menos 8 caracteres;
   - al menos **una letra y un número**, así que nunca puede ser la cédula
     (solo números);
   - no contiene el usuario;
   - es distinta de la actual.
4. **Cambiar la contraseña después:** con el ícono de llave junto a «Cerrar
   sesión» (pantalla «Cambiar mi contraseña»).
5. **Olvidó la contraseña:** el administrador usa «Restablecer clave» y
   escribe la cédula. La clave vuelve a ser la cédula, y en el siguiente
   ingreso hay que cambiarla otra vez. No se puede restablecer la propia.
6. **Cambiar el usuario:** el administrador usa «Cambiar usuario». El usuario
   anterior deja de funcionar.

## Protecciones

- **Sesiones viejas:** al cambiar o restablecer la contraseña, las sesiones
  abiertas antes de ese momento dejan de funcionar (`passwordChangedAt`
  contra la fecha del token). El cambio propio entrega una sesión nueva.
- **Bloqueo por cuenta:** 5 intentos fallidos en 15 minutos bloquean la
  cuenta 15 minutos, aunque se use el usuario o el correo. Los usuarios que
  no existen se bloquean igual, para no revelar cuáles existen.
- **Límites por conexión:** 30 ingresos por minuto, 10 cambios de contraseña
  por minuto y 10 creaciones o restablecimientos por minuto.
- **Mensaje único:** «Usuario o contraseña incorrectos», tanto para un
  usuario inexistente o inactivo como para una clave mala.
- **Registro de ingresos** (Administración → Usuarios), tabla `login_events`:
  - registra ingresos, intentos fallidos (también con usuarios que no
    existen), cuentas bloqueadas, usuarios inactivos, cambios y
    restablecimientos;
  - en cada restablecimiento queda qué administrador lo hizo;
  - guarda la fecha, lo escrito como usuario, la IP y el navegador; **nunca la
    contraseña**;
  - la lista de usuarios muestra el último ingreso y si la persona todavía
    tiene la clave inicial.
- **Lo de siempre:** contraseñas cifradas con scrypt, sesión de 1 hora,
  HTTPS en producción y desactivación de usuarios.

## Reglas en la base de datos

| Campo | Regla |
| --- | --- |
| `users.username` | Único y obligatorio; minúsculas y números separados por `.`, `-` o `_`, de 3 a 50 caracteres (CHECK). Los usuarios creados por scripts o pruebas sin usuario reciben `usuario.<10 hex>`. |
| `users.email` | Opcional y en minúsculas (CHECK). |
| `users.mustChangePassword` | `true` con la clave inicial. |
| `users.passwordChangedAt` | Fecha del último cambio o restablecimiento. |
| `login_events` | Textos acotados. Solo un restablecimiento nombra al administrador. Si se borra un usuario, el registro se conserva sin el vínculo. |

## Transición (usuarios existentes)

- **Usuario asignado por la migración:** lo que va antes de la @ de su
  correo, en minúsculas; los demás caracteres pasan a punto
  (`ana_perez@…` → `ana.perez`). Si dos coinciden, se numeran
  (`ana.perez.2`).
- **Sin cambio de contraseña:** conservan la suya y no se les obliga a
  cambiarla.
- **El correo todavía sirve para ingresar,** escrito en el campo de usuario.
  Se puede quitar más adelante.
- **Primer administrador de una base vacía:** `create-admin` pide además el
  usuario (`BOOTSTRAP_ADMIN_USERNAME`). Ver `docs/deploy/base-limpia.md`.

## Pendiente

- Actualizar los manuales de Ventas y Bodega: hoy dicen que se ingresa con el
  correo.
- El operador China (pantalla en inglés) tiene el cambio obligatorio, pero no
  un botón para cambiar su contraseña después.
- Decidir cuándo deja de aceptarse el correo para ingresar.
