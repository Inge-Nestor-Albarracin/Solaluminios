# Devoluciones de clientes (documento DV)

Estado al **25/11/2026**: implementado en desarrollo, opción 3 del plan de
devoluciones («devolución formal con saldo a favor»). Falta desplegarlo a
producción (migración `20261125120000_sales_returns`).

Caso típico: el cliente se llevó la referencia X en negro y necesitaba la Y
en blanco. Devuelve lo que se llevó (devolución DV) y compra lo correcto en
una orden nueva, pagando con el saldo a favor.

## Flujo

1. **Solicitud (Ventas o administrador).** Desde la orden, «Registrar
   devolución»:
   - por renglón, cuántos perfiles devuelve, hasta lo entregado menos lo ya
     devuelto o en trámite;
   - el **motivo**: error del vendedor, error o cambio del cliente, error de
     bodega o material defectuoso;
   - qué pasa con el **dinero pagado de más**: saldo a favor o reintegro;
   - una observación opcional;
   - el vendedor elige el **administrador que autoriza**.

   Queda un documento `DV-000001`. Mientras está en trámite, esos perfiles no
   se pueden pedir en otra devolución.
2. **Autorización (administrador).**
   - **Pedida por un vendedor:** el administrador elegido recibe una tarea
     con aviso, y la autoriza o la rechaza con motivo. Puede hacerlo
     cualquier administrador.
   - **Pedida por un administrador:** queda autorizada al guardar.
3. **Recepción (bodega).**
   - **Quién la recibe:** un bodeguero de la ubicación de donde salió el
     material recibe la tarea, por turnos. Si no hay bodegueros en esa
     ubicación, la recibe el administrador más antiguo.
   - **Qué registra:** cuenta lo que llega en **buen estado** y lo
     **dañado**.
   - **Paquetes cerrados:** si un paquete vuelve completo y sin abrir, lee su
     chip y vuelve cerrado, como salió.
   - **Bodega nunca ve valores en pesos.**
4. **Después de la recepción.**
   - **Reintegro:** el vendedor o el administrador registra la entrega del
     dinero con su medio (efectivo, o transferencia con la entidad de donde
     salió), su fecha y una nota.
   - **Orden facturada:** Facturación recibe una tarea para hacer la **nota
     crédito** en su software y registra el número.

Una devolución se puede **cancelar** antes de recibirla, con motivo. Una vez
recibida, ya no cambia: la base de datos lo impide.

## Inventario

- **Buen estado:** los perfiles en buen estado vuelven a los **paquetes de
  donde salieron**, con su origen, proveedor y lote. Primero vuelven al último
  paquete que salió.
- **Movimiento:** cada regreso queda como movimiento `RETURN` («Devolución de
  cliente»), ligado al renglón de la devolución.
- **Paquete cerrado (chip leído):** vuelve cerrado, con todos los perfiles
  con que salió.
- **Perfiles sueltos:** si un paquete que salió cerrado recibe perfiles
  sueltos, queda **abierto**.
- **Dañados:** quedan registrados en la devolución, pero **no entran al
  inventario**.

## Dinero

- **Valor de lo devuelto:** el precio neto del renglón de la orden, con
  descuentos e IVA, proporcional a los perfiles recibidos. Se cuentan los de
  buen estado y los dañados.
- **Base sin IVA:** se guarda aparte, para las comisiones.
- **Redondeo:** si las devoluciones completan el renglón, la última toma el
  remanente, así que nunca hay diferencia de centavos.
- **Orden del cálculo:** el valor devuelto **primero descuenta lo que el
  cliente todavía debía**; solo lo que ya había pagado de más va a saldo a
  favor o a reintegro.

| Caso | Orden | Devolución | Resultado |
| --- | --- | --- | --- |
| Contado | Total $1.000 pagado | $300 | $300 a saldo a favor (o reintegro). |
| Abono | Total $1.000, abonado $800 | $300 | Neto $700: se reintegran $100 y el saldo queda en 0. |
| Cartera | Total $1.000, sin pagos | $300 | Solo baja el saldo, de $1.000 a $700. |

- **Saldo a favor:** es del **cliente**, no de la orden. Se calcula: lo
  acreditado por devoluciones menos lo ya usado. Se usa como medio de pago
  «Saldo a favor»:
  - **al convertir una cotización:** con cualquier forma de pago, paga una
    parte o todo el total;
  - **en «Agregar abono»** de una orden de abono o cartera.
- **Lo que se refleja en la orden:**
  - total neto = total − devuelto;
  - pagado = pagos − lo devuelto al cliente;
  - una orden de abono o cartera queda «Pagada» cuando su saldo llega a cero.
- **Reglas en la base:**
  - los pagos nunca superan el total neto;
  - los pagos con saldo a favor nunca superan lo que el cliente tiene,
    también cuando dos ventas compiten por el mismo saldo.

## Facturación y reportes

- **Orden facturada:** la recepción crea la tarea `CREDIT_NOTE` para
  Facturación. La nota crédito se hace fuera del sistema y aquí solo se
  registra su número.
- **Orden por facturar:** si la orden pidió factura y aún no se ha facturado,
  la tarea de facturación recibe una nota: «factura el valor neto».
- **Excel de comisiones:**
  - **Órdenes:** columnas «Devuelto (con IVA)», «Base devuelta (sin IVA)» y
    «Total neto»;
  - **hoja nueva «Devoluciones»:** una fila por renglón recibido;
  - **Resumen:** «Base devuelta» y «Base neta».
- **Resumen por vendedor en pantalla:** columna «Devuelto».
- **Ventas → pestaña «Devoluciones»:** la lista; el vendedor ve las suyas.

## Datos

| Tabla o campo | Contenido |
| --- | --- |
| `sales_returns` | Cabecera: número, orden, cliente, ubicación, estado, motivo, liquidación, quién y cuándo en cada paso, valor, base, monto devuelto al cliente, reintegro y nota crédito. |
| `sales_return_lines` | Por renglón de la orden: pedidos, buenos, dañados, valor y base. |
| `inventory_movements.salesReturnLineId` | Los movimientos `RETURN`. |
| `tasks.salesReturnId` | Las tareas `RETURN_APPROVAL`, `RETURN_RECEPTION` y `CREDIT_NOTE`. |
| `PaymentMedium.CREDIT_BALANCE` | El pago con saldo a favor. |
| Secuencia `sales_return_number_seq` | Los números DV. |

**Endpoints:**
- `GET /sales-orders/:id/returnable`
- `POST /sales-orders/:id/returns`
- `GET /sales-returns` y `GET /sales-returns/:id`
- `POST /sales-returns/:id/approve`, `/reject`, `/cancel`, `/receive`,
  `/refund` y `/credit-note`
- `GET /customers/:id/credit`

## Decisiones tomadas por defecto (confirmar con el cliente)

Las preguntas del plan no se respondieron antes de construir. Se eligió lo
más prudente, fácil de cambiar después:

1. **Autorización:** toda devolución pedida por un vendedor necesita
   autorización del administrador.
2. **Plazo:** no hay plazo máximo para devolver.
3. **Dinero:** se ofrecen saldo a favor y reintegro; se elige al pedir.
4. **Precio:** el de la venta original, con sus descuentos. El reemplazo es
   una cotización normal, con el precio de hoy.
5. **Dañados:** lo dañado se le reconoce al cliente igual que lo bueno, pero
   no vuelve al inventario. Si llega dañado por culpa del cliente, bodega
   puede recibir menos.
6. **Lugar de recepción:** la ubicación de donde salió el material.
7. **Comisiones:** el Excel resta la base devuelta a las órdenes del rango
   (por la fecha de la orden, no de la devolución). El sistema no calcula
   comisiones.

## Límites conocidos

- **Una ubicación por devolución:** si los renglones salieron de ubicaciones
  distintas, se pide una devolución por cada una.
- **Órdenes canceladas:** no reciben devoluciones.
- **Accesorios:** no aplica, porque no se venden todavía.
- **Saldo a favor:** no vence ni se puede reintegrar después. Un pago con
  saldo a favor hecho en una orden que luego se cancela queda en esa orden,
  igual que el efectivo (hueco que ya existía).
- **Material dañado:** no tiene un destino propio (merma). Solo queda
  registrado en la devolución.
- **Cambio directo:** no hay un cambio en un solo paso (opción 4 del plan).
  Hoy son dos documentos: la devolución y la orden nueva pagada con el saldo
  a favor.
