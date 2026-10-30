# Refinamiento de compras, costos y precios de venta

Fecha: 27/10/2026. Repositorio **Solaluminios**
(`github.com/Inge-Nestor-Albarracin/Solaluminios`), no Demo-Wetracking.

## 1. Punto de partida

- Rama: `respaldo/beta/despachos`.
- Commit de partida: `e487340b` («Beta de los despachos y ventas»).
- Cambios locales previos, sin commit y conservados: el ajuste de registro
  del mismo día.
  - China y su proveedor automáticos.
  - Envío de China automático.
  - Nota de recepción opcional.
  - Supervisor de despachos opcional.

  Ese ajuste incluía una regla de ganancia por origen (`settings`
  `pricing.CHINA` y `pricing.NATIONAL`), que **este encargo sustituye**.
- No se hizo commit, push ni despliegue.

## 2. Comportamiento anterior encontrado en el código

**Compras** (`supply/purchases.service.ts`, `supply/costing.ts`)

Cada renglón pedía:
- unidad de compra y perfiles por unidad;
- cantidad y precio unitario;
- descuento del renglón (ninguno, % o valor);
- tarifa de IVA explícita;
- si el IVA era **descontable** o no.

El documento pedía además:
- moneda y tasa de cambio;
- descuento general, repartido entre renglones;
- gastos atribuibles (flete), repartidos por neto.

Costo = neto + gastos + IVA (solo si no era descontable). El IVA se calculaba
**encima** del precio digitado. El costo por perfil quedaba en
`purchase_lines.unitCostCop` y, al confirmar, en `stock_lots.unitCost` de los
lotes asociados.

**Precio de venta**

- En el commit de partida, el vendedor elegía en cada renglón:
  - el método: recargo sobre costo, margen bruto o precio manual;
  - el porcentaje.

  El costo era el **último costo confirmado de un lote** con la misma
  referencia, acabado y origen (y proveedor, si se indicaba).
- Con el ajuste local previo, el método y el porcentaje los fijaba ADMIN por
  origen. El costo seguía siendo «el último lote con costo».

En ninguno de los dos casos el precio quedaba ligado a una compra concreta.

**Ventas**

- Las líneas de cotización guardaban:
  - `unitPrice`, `pricingMethod`, `pricingPercent`;
  - `costBasis` y `costLotId`.
- No existía un identificador de «precio de venta».
- El IVA de venta no tenía valor inicial (19 % solo en el ajuste previo).

## 3. Cambios realizados y motivo

| Cambio | Motivo |
| --- | --- |
| Compra nueva: valor bruto **con IVA incluido**, descuento %, cantidad de perfiles | Regla principal: el IVA de compra ya está dentro del importe |
| Fuera del formulario y de la API de compras nuevas: IVA descontable, tarifa de IVA, moneda, tasa, descuento general y gastos | No exigir la clasificación del IVA y aplicar la fórmula pedida sin otros factores |
| Columna `purchase_lines.grossIncludesTax` | Distinguir renglones nuevos de los históricos sin reinterpretarlos |
| Modelo nuevo `SalePrice` ligado a **una línea de compra** | Compra → línea → precio. Cada compra conserva su costo y su precio |
| Clave foránea compuesta `(purchaseLineId, referenceId, finishId, origin)` | La base impide ligar un precio a un renglón de otra referencia, acabado u origen |
| Índice único parcial: un precio **habilitado** por referencia, acabado y origen | Ventas nunca recibe una elección arbitraria; ADMIN decide cuál ofrecer |
| Precios inmutables; habilitar uno deshabilita el anterior sin borrarlo | Cambiar la ganancia crea otro precio; el historial queda |
| `quote_lines.salePriceId` y `sales_order_lines.salePriceId` | La operación conserva el precio usado y, a través de él, la línea de compra |
| Eliminados `GET /sales/price-suggestion` y `GET/PATCH /supply/pricing` | Obtenían el costo solo por referencia, origen o proveedor |
| Pantallas «Compras y costos» y «Precios de venta» reescritas | Formulario y etiquetas según las reglas nuevas |
| Cotización: sin selector de proveedor; precio con y sin IVA de venta | El vendedor solo elige referencia, acabado, cantidad y origen |

## 4. Archivos

**Creados**

- `apps/api/prisma/migrations/20261027160000_sale_prices_from_purchases/migration.sql`
- `apps/api/src/modules/supply/sale-prices.service.ts`
- `apps/web/src/components/admin/SalePricesAdmin.tsx`
- `docs/refinamiento-registro-precios.md`

**Modificados en este encargo**

- `apps/api/prisma/schema.prisma`
- API, módulo `supply`:
  - `costing.ts`, `costing.spec.ts`;
  - `dto/supply.dto.ts`;
  - `purchases.service.ts`;
  - `settings.service.ts`;
  - `supply.controller.ts`, `supply.module.ts`.
- API, módulo `sales`:
  - `pricing.ts`;
  - `dto/sales.dto.ts`;
  - `sales.service.ts`;
  - `sales.controller.ts`, `sales.module.ts`.
- Pruebas e2e: `apps/api/test/sales-dispatch.e2e-spec.ts` y
  `sales-dispatch-concurrency.e2e-spec.ts`.
- Web:
  - `apps/web/src/components/admin/PurchasesAdmin.tsx`;
  - `apps/web/src/views/AdminView.tsx`, `views/QuoteView.tsx`;
  - `apps/web/src/lib/commerce.ts`.
- Documentación: `README-VENTAS-DESPACHOS.md`, `docs/development-status.md`.

**Eliminado**

- `apps/web/src/components/admin/PricingAdmin.tsx`. Lo había creado el ajuste
  previo, sin commit.

## 5. Fórmulas e IVA

**Actualizado el 29/10/2026.** Las compras nuevas usan el orden de la factura
(`computeTaxOnNetLine`): el descuento se aplica antes del IVA.

```text
descuento        = valor bruto SIN IVA × descuento % / 100    → centavos
base             = valor bruto − descuento
IVA de compra    = base × IVA % / 100                         → centavos (tarifa explícita, puede ser 0)
total            = base + IVA
costo por perfil = total ÷ perfiles                           → 6 decimales (el IVA de compra sigue dentro del costo)
```

La regla siguiente se conserva para los renglones ya registrados con ella
(`grossIncludesTax`).

Compra anterior (`computeTaxIncludedLine`, decimales de Prisma):

```text
descuento        = valor bruto (IVA incluido) × descuento % / 100     → redondeo a centavos
costo total      = valor bruto − descuento                             (el IVA de compra queda dentro)
costo por perfil = costo total ÷ perfiles                              → 6 decimales
```

Precio (`markupOnCost`), sobre el costo de **la línea elegida**:

```text
ganancia por perfil = costo × ganancia % / 100            → se muestra a centavos
precio sin IVA      = costo + ganancia                    → redondeo a centavos (30 % = costo × 1,30)
```

Cotización (`lineAmounts`, sin cambios):

```text
subtotal  = cantidad × precio sin IVA
IVA venta = (subtotal − descuento comercial) × IVA de venta % / 100   → centavos
total     = subtotal − descuento + IVA venta
```

- El IVA de compra **no se suma, no se extrae y no se divide**.
- El único IVA que se añade es el de venta: precargado en 19 % y editable
  en cada renglón.
- El redondeo es medio hacia arriba (`ROUND_HALF_UP`), como en el resto del
  proyecto.

Ejemplo comprobado en pruebas unitarias, e2e y navegador:

| Concepto | Resultado |
| --- | ---: |
| Descuento de 1.190.000 al 3 % | 35.700 |
| Costo total | 1.154.300 |
| Costo por perfil (100 perfiles) | 11.543 |
| Ganancia 30 % | 3.462,90 |
| Precio sin IVA de venta | 15.005,90 |
| IVA de venta 19 % | 2.851,12 |
| Precio con IVA | 17.857,02 |

Etiquetas en pantalla:
- «Valor bruto de compra — IVA incluido».
- «Costo por perfil (IVA de compra incluido)».
- «Precio de venta sin IVA (antes del IVA de venta)».
- «IVA de venta (%)».

## 6. Relación compra → precio y configuración por ADMIN

```text
purchases (id)
  └─ purchase_lines (id, referenceId, finishId, origin, unitCostCop, grossIncludesTax)
       └─ sale_prices (purchaseLineId + referenceId + finishId + origin → FK compuesta,
                       unitCost, markupPercent, unitPrice, enabled)
            ├─ quote_lines.salePriceId
            └─ sales_order_lines.salePriceId
```

En Administración → «Precios de venta», ADMIN:
1. Elige una compra **confirmada**.
2. Elige el renglón. Ve proveedor, referencia, acabado, origen y costo por
   perfil (IVA de compra incluido).
3. Escribe la ganancia sobre el costo. La pantalla muestra la ganancia por
   perfil, el precio sin IVA y un ejemplo con IVA de venta del 19 %.
4. Guarda, con «Habilitar para ventas» marcado o no.
5. En la lista puede habilitar o deshabilitar cualquier precio.

Validaciones del servidor (`POST /sale-prices`):
- el renglón debe pertenecer a la compra indicada (404 si no);
- la compra debe estar confirmada;
- el renglón debe usar la regla IVA incluido;
- debe tener costo por perfil.

El costo se copia de esa línea. Nunca se usa un promedio, el menor costo ni
la última compra.

Si dos administradores habilitan a la vez, un candado por perfil y el índice
único parcial dejan exactamente uno habilitado (probado en e2e).

## 7. Permisos y respuestas de la API

| Endpoint | ADMIN | SALES | Otros |
| --- | --- | --- | --- |
| `GET/POST/PATCH /purchases`, confirmar, asociar lotes | ✔ | 403 | 403 |
| `GET/POST /sale-prices`, `POST /sale-prices/:id/enable` y `/disable` | ✔ | 403 | 403 |
| `GET /sales/price` → `{ available, unitPrice }` | ✔ | ✔ | 403 |
| `POST/PATCH /quotes` | ✔ | ✔ (sin campos de precio) | 403 |

- `QuoteLineDto` ya no tiene `pricingMethod`, `pricingPercent`, `unitPrice`
  ni `priceReason`. Enviarlos responde 400 (lista blanca estricta).
- Cada línea usa el precio habilitado.
- A ventas se le quitan de las cotizaciones `pricingMethod`,
  `pricingPercent`, `costBasis`, `costLotId` y `priceReason`. Recibe
  `salePriceId`, que es solo un identificador: sin permiso no da acceso a
  costos.
- Las órdenes de venta nunca tuvieron costos.
- `GET /sales/price-suggestion` y `/supply/pricing` ya no existen (404).

## 8. Datos existentes

La migración es aditiva: no modifica ni borra filas.

- **Compras históricas**: `grossIncludesTax = false`. Se conservan tal como
  se guardaron (neto, IVA descontable o no, gastos) y la pantalla lo indica.
  No se convierten ni se usan para precios de venta.
  - En `solaluminios_dev` hay 2 compras confirmadas con 2 renglones de ese
    tipo (conteo de solo lectura).
  - Un borrador antiguo puede editarse: el formulario pide de nuevo el valor
    bruto con IVA.
- **Cotizaciones y órdenes existentes**: `salePriceId = NULL`. No se inventa
  ninguna asociación. Conservan sus importes, `costBasis` y `costLotId`.
  - En desarrollo hay 2 líneas de cotización y 2 de orden.
- **Lotes**: el costo por lote (`stock_lots.unitCost`) se sigue confirmando
  al asociar lotes a una compra, pero ya no interviene en el precio.
- **`settings` `pricing.*`**: en desarrollo hay 1 fila de la regla por origen
  del ajuste previo. Queda sin uso y no se borró; puede eliminarla
  administración cuando lo decida.
- **Ventas en desarrollo**: tras aplicar la migración, ventas no podrá
  cotizar hasta que ADMIN registre una compra con IVA incluido y habilite su
  precio.

## 9. Pruebas ejecutadas (resultados reales)

**API**

| Comprobación | Resultado |
| --- | --- |
| `pnpm build` | Correcto |
| `pnpm lint` (oxlint) | Sin avisos |
| `tsc --noEmit` | Correcto, salvo un error previo, ajeno al cambio, en `test/load/inventory.load-spec.ts` |
| `pnpm test` (unitarias) | 30/30 |
| e2e en la base de pruebas | 17/17 archivos, 141/141 pruebas |

Las pruebas unitarias incluyen el ejemplo completo y los tres precios
13.000 / 15.600 / 11.700.

Casos e2e nuevos o adaptados:
- compra de 1.190.000 con IVA, 3 % y 100 perfiles → 11.543. No acepta
  `taxRecoverable`, moneda ni un descuento mayor que 100 %;
- precio de 15.005,90 ligado a su línea; ventas recibe solo
  `{ available, unitPrice }`;
- un renglón de otra compra → 404; una compra en borrador → 400;
- la base rechaza un precio con material distinto al de su línea;
- tres compras (Pardo 10.000, Pardo 12.000, otro proveedor 9.000) con 30 %
  dan 13.000, 15.600 y 11.700, cada una con su línea;
- sin precio habilitado no se elige ninguno; habilitar sustituye al
  anterior; dos habilitaciones simultáneas dejan uno solo;
- la cotización guarda `salePriceId`. Una compra posterior más cara, con su
  precio habilitado (26.000), no cambia la cotización ni la orden ya
  creadas;
- ventas, bodega y solo lectura reciben 403 en compras, precios por compra y
  detalle de compra.

Las suites e2e borran al final solo lo que cada ejecución creó (proceso
habitual de las pruebas del proyecto).

**Web**

- `tsc -b`, `oxlint` y `pnpm build` correctos.

**Navegador** (base `*_test`, API 3101 y Vite 5174):

1. ADMIN registró la compra QA-001 de «Ventanas Pardo QB7862»: 100 perfiles,
   1.190.000 y 3 %. Pantalla: descuento 35.700, costo 1.154.300 y
   11.543,00 por perfil.
2. ADMIN confirmó la compra y creó el precio al 30 %. Vista previa: ganancia
   3.462,90, precio sin IVA 15.005,90, IVA 2.851,12 y precio con IVA
   17.857,02. Lo guardó habilitado.
3. Ventas cotizó 1 perfil Nacional: precio 15.005,90, IVA de venta 19 % y
   total 17.857,02. Con IVA 5 %: 750,30 y 15.756,20.

Los registros de esta verificación **se dejaron** en la base de pruebas (no
se ejecutó ninguna limpieza):
- usuarios `qa-admin-qb7862@test.local` y `qa-sales-qb7862@test.local`;
- proveedor `PARDO-QB7862`;
- referencia `17.30-QB7862` y acabado `BM-QB7862`;
- compra `QA-001` y su precio de venta;
- eventos de auditoría.

No se ejecutó en el navegador el permiso de ventas contra la API: está
cubierto por e2e.

## 10. Migraciones

- **Nueva:** `20261027160000_sale_prices_from_purchases`. Generada con
  `prisma migrate diff` desde la base de pruebas, más restricciones escritas
  a mano:
  - CHECK de valores;
  - CHECK de `enabledAt`;
  - índice único parcial `sale_prices_one_enabled`.
- **Aplicada:**
  - en la base de pruebas (`prisma migrate deploy`);
  - en `solaluminios_dev` (localhost), con `prisma migrate deploy`, por
    autorización expresa del usuario.

  En las dos bases quedó sin diferencias con el esquema.

  Comprobación en desarrollo (solo lectura), tras aplicarla:
  - `migrate status`: «Database schema is up to date» (8 migraciones);
  - `migrate diff`: migración vacía;
  - `sale_prices` existe con:
    - la FK compuesta hacia `purchase_lines`;
    - los CHECK `sale_prices_values` y `sale_prices_enabled_consistent`;
    - el índice único parcial `sale_prices_one_enabled`.
  - Las filas existentes quedaron como se esperaba:
    - 0 precios de venta;
    - 2 renglones de compra con `grossIncludesTax = false`;
    - 2 líneas de cotización y 2 de orden con `salePriceId` nulo.
- **Pendiente:** VPS.
- No se editó ninguna migración aplicada ni se hizo un reset.

## 11. Pendiente o por decidir

- Aplicar la migración en el VPS. En desarrollo ya está aplicada: hay que
  registrar compras con IVA incluido y habilitar sus precios antes de que
  ventas pueda cotizar.
- Decidir si las 2 compras históricas de desarrollo se vuelven a registrar
  con la regla nueva. No se convierten solas.
- Los gastos de flete y las compras en moneda extranjera ya no se pueden
  registrar en compras nuevas. Si se necesitan, hay que definir cómo entran
  en «valor bruto con IVA incluido».
- **Proveedor exigido**: la API de cotizaciones aún acepta `supplierId`
  opcional (se respeta al reservar y despachar), pero la pantalla ya no lo
  ofrece. El precio sigue siendo el habilitado para la referencia, acabado y
  origen, aunque su compra sea de otro proveedor.
- La fila `pricing.*` de `settings` en desarrollo quedó sin uso.
