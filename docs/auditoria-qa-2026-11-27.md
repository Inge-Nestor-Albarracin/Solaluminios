# Auditoría QA del 27/11/2026: verificación y corrección

El informe evaluó `main` en el commit `0c499be` y calificó **0/100** por el
hallazgo SEC-01 (autofail de seguridad). Este documento registra qué se
verificó contra el código, qué se corrigió y con qué evidencia.

## Verificación de cada hallazgo

Cada hallazgo se comprobó leyendo el código y, cuando se podía, con una prueba
temporal en la base de pruebas (`solaluminios_dev_e2e_test`).

| Hallazgo del informe | ¿Cierto? | Evidencia | Estado |
| --- | --- | --- | --- |
| **SEC-01**: descuento sin autorización | **Sí** | Reproducido de punta a punta: un vendedor convirtió órdenes con 50 % y 40 % (ver abajo) | **Corregido** |
| Edición simultánea de una cotización | Sí | El administrador puso 25 perfiles y un guardado viejo del vendedor lo devolvió a 10 sin aviso | Pendiente |
| Redondeo de $10.010 al 2,05 % | Sí | Vista previa $205,20 y servidor $205,21 | **Corregido** (la corrección de SEC-01 lo necesitaba) |
| Vigencia del 30 de febrero | Sí | Se guardaba como 2 de marzo; la web usa calendario, solo pasa por el API | Pendiente |
| «Margen» sobre el costo | **No** | La fórmula divide por el precio: costo $100.000 y precio $125.000 muestran 20 %. Lo engañoso era un comentario del código | Sin cambio |
| Dos sondeos de avisos en Ventas | Sí | `App.tsx` y `SalesView.tsx` usan `useRequestUpdates` | Pendiente |
| Archivos grandes y controlador de 39 rutas | Sí | 1.926 y 1.491 líneas | No se tocan (decisión del 27/11/2026: riesgo alto) |
| Consultas por renglón, resumen paginado en memoria, bloqueo de paquetes | Sí, como observaciones de diseño | — | No se tocan sin medir (decisión del 27/11/2026) |

Revisión adicional:
- **Secretos:** nunca se subió un `.env` real. No hay llaves privadas, cadenas
  de conexión con clave, `JWT_SECRET` ni tokens en el historial de Git.
- **Mismo patrón en el descuento global:** la aprobación quedaba ligada a la
  cotización y no al monto. Se corrigió junto con SEC-01.

## SEC-01: cómo ocurría

La excepción para «conservar un descuento guardado antes» comparaba material
y porcentaje con los renglones anteriores, sin exigir que un administrador lo
hubiera autorizado. La introdujo el commit del 12/11/2026.

1. El vendedor guardaba un precio manual con 50 % de descuento: quedaba
   pendiente de autorización y la conversión se bloqueaba (409).
2. Guardaba el mismo renglón con el precio habilitado y el mismo 50 %: el
   sistema lo aceptaba como «guardado antes».
3. Convertía: la orden salía con 50 % de descuento y sin registro de quién lo
   autorizó.

Pasaba lo mismo con una solicitud **rechazada** (orden con 40 %). Además, el
descuento que puso un administrador se conservaba aunque el vendedor cambiara
la cantidad de 10 a 1.000 perfiles.

## Regla corregida

**Por renglón**, sobre el precio habilitado, por encima del 3 %:
- lo autoriza un administrador al guardarlo, y queda registrado quién y cuándo
  (`quote_lines.discountApprovedById` y `discountApprovedAt`);
- el vendedor lo conserva solo para el mismo material (referencia, color,
  origen y proveedor), el mismo porcentaje y **sin más perfiles**. Bajar la
  cantidad lo conserva; subirla pide autorización;
- cada autorización cubre un solo renglón;
- un precio manual sin autorizar, una solicitud rechazada o un descuento
  antiguo sin autor nunca cuentan como autorizados;
- el precio manual sigue igual: el administrador autoriza el precio con su
  descuento.

**Global**, por encima del 3 %:
- lo autoriza un administrador al aprobar la solicitud o al guardar la
  cotización. Se registran quién, cuándo, el porcentaje y la **base** (valor
  de los materiales sin IVA ni descuentos por renglón);
- el vendedor lo conserva mientras no suba el porcentaje ni la base;
- si el administrador corrige al alza un precio manual, la autorización sigue
  la nueva base y queda en la auditoría.

**Al convertir**, se revisa otra vez:
- el vendedor no puede convertir sin las autorizaciones (409, con el renglón o
  el descuento global que falta);
- si convierte un administrador, autoriza lo que falte y queda en la
  auditoría (`LINE_DISCOUNT_AUTHORISED` y `GLOBAL_DISCOUNT_AUTHORISED`);
- la orden copia quién autorizó cada descuento.

**En la base de datos**, unos disparadores rechazan **insertar** una orden o
un renglón con más de 3 % sin autorización. Las órdenes anteriores se siguen
actualizando como siempre.

**En la pantalla**, la cotización aplica la misma regla antes de guardar y
muestra quién autorizó cada descuento. La vista previa usa el mismo redondeo
exacto del servidor.

## Evidencia

- **Migración** `20261127140000_discount_authorization`, aditiva:
  - columnas nuevas opcionales en cotizaciones, renglones y órdenes, con sus
    CHECK;
  - traslado de las aprobaciones globales ya dadas;
  - dos disparadores al insertar órdenes.
- **Pruebas nuevas** `test/discount-authorization.e2e-spec.ts` (7 casos):
  - los tres casos del informe quedan rechazados;
  - el descuento de un administrador se conserva y queda en la orden;
  - un descuento antiguo sin autor queda bloqueado;
  - el descuento global queda ligado a su base;
  - la base de datos rechaza la inserción.
- **Unitarias** `discount-authorization.spec.ts` (6) y redondeo exacto en
  `apps/web/scripts/numbers.test.mts`.
- **Prueba temporal del informe**, repetida después de la corrección:

  | Paso | Antes | Después |
  | --- | --- | --- |
  | Guardar con el precio habilitado y 50 % | 200 | 400 |
  | Convertir | 200 (orden con 50 %) | 409 |
  | Lo mismo tras el rechazo | 200 (orden con 40 %) | 400 / 409 |
  | Subir de 10 a 1.000 perfiles con el 10 % del administrador | 200 | 400 |

- **Suites:** API 84/84 unitarias y 283/283 e2e (35 archivos); web con
  `tsc`, lint, pruebas y compilación.
- **Navegador:** quitar el precio manual de un renglón guardado con 50 % deja
  el error en el campo y «Guardar cambios» deshabilitado.

## Antes de desplegar en producción

1. **Contar los borradores afectados** (solo lectura, antes de la migración).
   Los vendedores no podrán convertir estas cotizaciones hasta que un
   administrador las revise.

   ```sql
   -- Renglones con más de 3 % sobre el precio habilitado.
   SELECT q.number, u.name, l."lineNo", l."discountPercent"
   FROM quote_lines l
   JOIN quotes q ON q.id = l."quoteId"
   JOIN users u ON u.id = q."createdById"
   WHERE q.status::text = 'DRAFT' AND l."pricingMethod"::text <> 'MANUAL'
     AND l."discountPercent" > 3 AND u.role::text <> 'ADMIN';

   -- Descuento global de más de 3 % sin solicitud aprobada.
   SELECT q.number, u.name, q."globalDiscountPercent"
   FROM quotes q
   JOIN users u ON u.id = q."createdById"
   WHERE q.status::text = 'DRAFT' AND q."globalDiscountPercent" > 3
     AND u.role::text <> 'ADMIN'
     AND NOT EXISTS (SELECT 1 FROM quote_discount_requests r
       WHERE r."quoteId" = q.id AND r.kind::text = 'GLOBAL_DISCOUNT'
         AND r.status::text = 'APPROVED');
   ```

2. **Revisar si la falla se usó** (solo lectura): órdenes de vendedores con
   renglones de más de 3 % sin precio manual autorizado. Un resultado no
   prueba abuso: también aparecen los descuentos legítimos que puso un
   administrador.

   ```sql
   SELECT o.number, o.status, o."createdAt"::date, u.name,
          l."lineNo", l."referenceCode", l."finishCode", l.quantity,
          l."discountPercent", l."discountAmount"
   FROM sales_order_lines l
   JOIN sales_orders o ON o.id = l."salesOrderId"
   JOIN users u ON u.id = o."createdById"
   WHERE l."discountPercent" > 3
     AND (l."manualPrice" = false OR l."manualApprovedById" IS NULL)
     AND u.role::text <> 'ADMIN'
   ORDER BY o."createdAt" DESC, l."lineNo";
   ```

3. **Desplegar** las migraciones pendientes, incluida esta.

## Pendiente para la siguiente calificación

- Edición simultánea: comprobar la versión al guardar y avisar del conflicto.
- Validar el día calendario de la vigencia en el servidor.
- Un solo sondeo de avisos en Ventas.
- Entregar a QA el commit correctivo y estos resultados.
