# Rol Accesorios: diseño de la fase 1

**Estado (24/11/2026):** diseño propuesto. El **rol `ACCESSORIES` ya está
creado**: migración `20261124120000_accessories_role`, guard restringido,
tareas y avisos, con el menú Inicio y Tareas. El resto está sin implementar;
antes de programarlo hay que cerrar las preguntas de la última sección.

## Decisiones del usuario (24/11/2026)

**Inventario:**
- **Canastas fijas.** En la bodega de accesorios hay canastas (cajas) fijas.
  Cuando se compran, por ejemplo, 10 rodachines, se echan en la canasta de esa
  referencia y ese color. La canasta no es el empaque del proveedor.
- **Un chip por canasta**, con su referencia y su color. Los accesorios no
  llevan chip propio por su bajo precio.
- **No hay canastas repetidas:** una sola canasta por referencia y color.
- **Entrada manual con soporte:** la cantidad se digita.
  - No necesita autorización.
  - Al administrador le llega una tarea que le informa del ingreso.
- **Se venden completos** (unidades enteras), por ejemplo los Yale.
- **Colores:** los mismos acabados actuales (BM, BP, NP, CR, BR y CH).
- **Un solo origen por accesorio:** una misma referencia y color nunca se
  compra a la vez de China y nacional.

**Venta y salida:**
- **Precio desde la compra,** como los perfiles: se registra la compra de
  accesorios con su costo y el administrador habilita el precio con su
  margen.
- **Accesorios vende.** Puede crear ventas solo de accesorios, con un cliente
  genérico de mostrador, y el despacho le llega a ella misma.
- **Accesorios también registra salidas sin venta** (muestras, garantías,
  consumo interno), con motivo obligatorio y tarea informativa al
  administrador.
- **Ventas vende accesorios** en la fase 1. En una orden mixta:
  - los perfiles le llegan a Bodega (coteros y bodegueros);
  - los accesorios (familias Accesorios y Accesorios Yale) le llegan a
    Accesorios;
  - Bodega no recibe accesorios.

**Cambio de alcance explícito.** El 17/11/2026 los accesorios quedaron «solo
catálogo». Esta fase los compra, los inventaría y los vende, con estos
límites:
- solo Accesorios opera las canastas;
- las solicitudes de materiales (Bodega → almacén) los siguen rechazando;
- no se agregan `RfidTag`, `Product` ni SKU.

## Concepto: la canasta es un paquete

Cada canasta se guarda como un `Bundle`, el mismo modelo de los paquetes de
perfiles:

| Canasta | `Bundle` |
| --- | --- |
| Chip de la canasta | `epc`: único, no se recodifica |
| Accesorio | `referenceId`: referencia de una familia de tipo `ACCESSORY` |
| Color | `finishId` |
| Unidades que hay hoy | `quantity` |
| Bodega de accesorios | `inventoryLocationId` |
| Origen (China o Nacional) | `lotId`: el lote de la canasta |

Así se reutilizan la consulta por chip, la lectura con la pistola, el
historial con saldo antes y después, el responsable tomado de la sesión, la
clave de operación idempotente, las reservas y los ajustes del administrador.

**En qué se diferencia de un paquete de perfiles:**
- **Se rellena.** Una entrada (`ENTRY`) puede sumar unidades a una canasta
  que ya existe. El CHECK `inventory_movements_balance_consistent` ya lo
  admite (después = antes + cantidad); hoy solo se usa al registrar.
- **En cero sigue activa,** esperando la siguiente compra.
- **Es única por referencia y color** en la bodega de accesorios. Se
  garantiza con un índice único en la base, no solo en el código.
- **Siempre se toma por partes,** como los perfiles sueltos: se lee el chip y
  se digitan las unidades. No se abre ni se traslada.
- **Cuenta unidades,** no perfiles: los mensajes, el PDF y las pantallas
  dicen «unidades».
- **Leer el chip nunca suma.** Solo suma un ingreso con su cantidad y su
  soporte. Así se conserva la regla de que leer un EPC registrado no vuelve a
  sumar stock.

**El lote de la canasta.** Una reserva solo usa paquetes con un lote del
origen pedido (`eligibleWhere` en `reservations.service.ts`). Un paquete sin
lote nunca se vende. Un paquete de perfiles tiene el lote de su compra, pero
una canasta se rellena con muchas compras. Como un accesorio nunca se compra
de los dos orígenes:
- la canasta tiene un lote fijo que dice su **origen**;
- el costo de cada compra queda en su ingreso, vinculado a la línea de compra;
- un ingreso de una compra de otro origen se rechaza, como protección.

## Rol `ACCESSORIES` («Accesorios»)

- **Acceso restringido:** como Facturación y Operador China, solo entra a las
  rutas que lo nombran.
- **Menú:** Inicio, Canastas, Ingresos, Ventas de mostrador, Despachos,
  Salidas sin venta y Tareas.
- **Lo que no ve:** perfiles, costos, compras ni usuarios. Ve los precios de
  venta de los accesorios.
- **Ubicación asignada:** la «Bodega de accesorios», una ubicación aparte de
  la bodega de perfiles. Solo opera canastas de esa ubicación.
- **El administrador** ve y hace todo: compras, precios y ajustes.

## Flujo

### 1. Arranque: registrar canastas (una sola vez)

1. Se pega un chip a cada canasta y se lee.
2. Se eligen referencia, color y origen.
3. Se cuenta lo que hay hoy: queda como inventario existente
   (`INITIAL_STOCK`), sin inventar salidas viejas.

Una segunda canasta de la misma referencia y el mismo color se rechaza.

### 2. Compra y precio (administrador)

- Compras acepta referencias de accesorios, con su costo, descuento, IVA y
  fletes, como hoy.
- El administrador habilita el precio de venta por referencia, color y
  origen, con su margen.
- Un accesorio sin precio habilitado no se puede vender, igual que un perfil.

### 3. Ingreso de accesorios (Accesorios)

- **Documento.** Tiene número consecutivo (por ejemplo `IA-0001`) y su
  soporte: proveedor, número de factura o remisión y fecha de llegada. Si la
  compra ya está registrada, se vincula a ella.
- **Renglones.** Por cada canasta se lee el chip (o se busca la canasta) y se
  digitan las unidades.
- **Al guardar:**
  - cada canasta deja una entrada `ENTRY` vinculada al ingreso;
  - al administrador le llega una **tarea informativa** («Ingreso IA-0001:
    rodachín NP +10, …»), con aviso. No autoriza nada: la marca como vista.

### 4. Venta de mostrador (Accesorios)

Usa la misma cotización, orden y despacho de Ventas. Así la venta queda en
el Excel de comisiones, en Facturación y en los reportes. La pantalla une los
pasos:

1. **Cliente.** Por defecto, el cliente genérico «Mostrador». Si piden
   factura, se elige o se crea el cliente real, porque Facturación exige NIT
   y correo.
2. **Renglones.** Solo accesorios, con su precio habilitado. Rigen las mismas
   reglas de descuento y de precio manual que en Ventas.
3. **Forma de pago,** obligatoria como hoy. Se convierte en orden y se
   reserva en la bodega de accesorios.
4. **Despacho.** Se crea asignado a ella misma, con su tarea.
5. **Salida.** Lee el chip de cada canasta, digita las unidades y confirma la
   salida física.

### 5. Venta de Ventas con accesorios

- **Cotización.** Ventas puede elegir accesorios. La disponibilidad sale de la
  bodega de accesorios y el PDF muestra «unid.».
- **Confirmar la orden.**
  - Los perfiles se reservan en una ubicación, como hoy.
  - Los accesorios se reservan en la bodega de accesorios.
  - Propuesta: todo o nada para la orden completa. Si falta algo, la orden
    queda «Pendiente de abastecimiento», como hoy.
- **Autorizar la entrega.** Una orden mixta genera **dos despachos**:
  - **perfiles:** asignado a un bodeguero, como hoy;
  - **accesorios:** asignado a Accesorios, con su tarea y su aviso.

  Una orden solo de accesorios genera solo el despacho de Accesorios.
- **Cierre de la orden.** La orden se completa cuando sus dos despachos están
  confirmados.

### 6. Preparar y confirmar un despacho de accesorios

Vale para los dos tipos de venta:
- Accesorios lee el chip de cada canasta y digita las unidades.
- El sistema sugiere la canasta de esa referencia y ese color.
- Si se lee una canasta de otra referencia o de otro color, no se descuenta
  nada y queda una incidencia, como en los despachos de perfiles.
- Al confirmar la salida física, cada canasta deja una salida `EXIT`
  vinculada al despacho (`dispatchId`, como hoy) y se consume la reserva.

### 7. Salida sin venta (Accesorios)

- **Documento.** Tiene número consecutivo (por ejemplo `SS-0001`), tipo
  obligatorio (muestra, garantía, consumo interno u otro), detalle y quién
  recibe.
- **Renglones.** Se lee cada canasta y se digitan las unidades. No puede
  tomar unidades reservadas para órdenes de venta.
- **Al guardar:**
  - cada canasta deja una salida `EXIT` vinculada al documento;
  - al administrador le llega una tarea informativa, como con el ingreso.

### 8. Consulta y ajustes

- **Canastas:** cada una con su saldo, lo reservado y su historial, que
  funciona como kárdex de esa referencia y ese color.
- **Ajustes:** solo el administrador, con motivo. Es la regla actual. Se usan
  cuando un conteo físico no cuadra.

## Auditoría

- Cada entrada y cada salida es un movimiento inmutable, con saldo antes y
  después, la fecha y la hora, el responsable de la sesión y su clave de
  operación (un reintento no duplica).
- **Toda salida tiene un documento detrás:**
  - una venta: despacho → orden → cliente;
  - o una salida sin venta, con su tipo y su motivo.

  La salida directa de paquetes no se habilita para accesorios.
- **Toda entrada tiene su ingreso y su soporte,** vinculado a la compra
  cuando existe.
- **El administrador se entera** de cada ingreso y de cada salida sin venta
  por su tarea. Además tiene un reporte de ingresos y salidas por día, por
  persona, por referencia y por tipo.
- **Inmutabilidad:** un ingreso, una salida sin venta o un despacho
  confirmados no se editan. Solo un ajuste del administrador, con motivo,
  corrige.

## Cambios técnicos previstos (esbozo)

- **Migración aditiva:**
  - `UserRole.ACCESSORIES`;
  - los comprobantes de ingreso y de salida sin venta con sus renglones (un
    modelo con tipo o dos modelos), con numeración propia y vínculo opcional
    a la línea de compra;
  - el vínculo del comprobante en `inventory_movements`;
  - `TaskKind` para las tareas informativas;
  - el índice único de canasta por referencia y color;
  - en `dispatches`, de qué tipo es el despacho (perfiles o accesorios);
  - el cliente genérico «Mostrador».
- **API:**
  - un módulo `accessories` en `src/modules` con canastas, ingresos y salidas
    sin venta;
  - `RolesGuard` restringe `ACCESSORIES` como a `BILLING`, y le abre las
    rutas de venta solo para accesorios;
  - `supply` (compras, lotes y precios), `sales` y `dispatch` aceptan
    accesorios: reserva en la bodega de accesorios y división del despacho
    por tipo;
  - `eligibleAssignees` filtra por rol según el tipo del despacho;
  - las solicitudes de materiales y la salida directa siguen rechazando
    accesorios.
- **Web:**
  - menú del rol, Canastas, Ingresos, Venta de mostrador y Salidas sin
    venta;
  - despacho con pistola;
  - los selectores de Compras y de la cotización ofrecen accesorios.

## Entregas sugeridas

La fase 1 es grande. Conviene entregarla en tres partes, cada una con sus
pruebas, su verificación en el navegador y su despliegue:

1. **Inventario de accesorios:**
   - rol y bodega;
   - canastas;
   - compras y precios;
   - ingresos y salidas sin venta, con sus tareas al administrador;
   - ajustes.
2. **Venta de mostrador de Accesorios:** cotización, orden y despacho a sí
   misma, con cliente genérico.
3. **Ventas con accesorios:**
   - cotizaciones y órdenes mixtas;
   - reserva en dos ubicaciones;
   - despacho dividido entre Bodega y Accesorios.

## Fuera de la fase 1

- **Las 47 referencias «por metro»:** no se venden completas. Quedan por
  definir.
- **Traslados** de canastas y **solicitudes de materiales** de accesorios.

## Por confirmar antes de programar

1. **Accesorios sin color** (tornillería, por ejemplo). Toda canasta necesita
   un acabado. ¿Se usa uno de los actuales o hace falta agregar «Sin color»?
2. **Rollos (21 referencias).** ¿En la fase 1 se venden como rollo completo,
   es decir, una unidad?
3. **Orden mixta sin existencias.** ¿Todo o nada (si falta un accesorio, toda
   la orden queda pendiente) o se confirma por separado?
4. **Tipos de salida sin venta.** ¿Basta con muestra, garantía, consumo
   interno y otro?
5. **Ubicación.** ¿En qué sucursal queda la bodega de accesorios? ¿Cuántas
   personas tendrán el rol? Si son varias, ¿el despacho se reparte por turno,
   como Facturación?
