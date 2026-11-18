import ExcelJS from 'exceljs';

// Excel workbook of sales orders for commissions (ADMIN). The service passes
// plain, already labelled data; this module only lays it out:
// - «Órdenes»: one row per order.
// - «Renglones»: one row per order line.
// - «Resumen»: the filters used and the totals per seller (as on screen).
// Cancelled orders are included (unless filtered out) and painted red in both
// detail sheets. Amounts are numeric cells so they can be summed and filtered.

type Amount = { toString(): string };

export interface ExportLine {
  lineNo: number;
  referenceCode: string;
  referenceDescription: string | null;
  finishCode: string;
  finishDescription: string | null;
  origin: string;
  supplierName: string | null;
  quantity: number;
  unitPrice: Amount;
  discountPercent: Amount;
  lineSubtotal: Amount;
  discountAmount: Amount;
  globalDiscountAmount: Amount;
  taxRatePercent: Amount;
  taxAmount: Amount;
  lineTotal: Amount;
  manualPrice: boolean;
}

export interface ExportOrder {
  number: string;
  createdAt: Date;
  seller: string;
  convertedBy: string | null;
  customerName: string;
  customerTaxId: string | null;
  saleType: string;
  paymentMethod: string | null;
  paymentTerms: string | null;
  status: string;
  cancelled: boolean;
  paymentStatus: string;
  quoteNumber: string | null;
  subtotal: Amount;
  discountTotal: Amount;
  globalDiscountAmount: Amount;
  taxTotal: Amount;
  assemblyAmount: Amount;
  installationAmount: Amount;
  total: Amount;
  cancelReason: string | null;
  // Electronic invoice (made in another software).
  requiresBilling: boolean;
  invoiceNumber: string | null;
  billedAt: Date | null;
  lines: ExportLine[];
}

interface SummaryBucket {
  orders: number;
  base: string;
  total: string;
}

export interface ExportSummaryRow {
  seller: { name: string };
  all: SummaryBucket;
  paid: SummaryBucket;
  pending: SummaryBucket;
  cash: SummaryBucket;
}

export interface SalesExportData {
  generatedAt: Date;
  generatedBy: string;
  // Labelled filters, e.g. [['Vendedor', 'Ana'], ['Desde', '2026-11-01']].
  filters: [string, string][];
  orders: ExportOrder[];
  summary: ExportSummaryRow[];
}

const MONEY = '"$"#,##0.00';
const PERCENT = '0.00"%"';
const DATE_TIME = 'dd/mm/yyyy hh:mm';
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E5A6B' } };
const CANCELLED_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
const CANCELLED_FONT: Partial<ExcelJS.Font> = { color: { argb: 'FF9C0006' } };

const num = (value: Amount) => Number(value.toString());
// first − rest (two-decimal amounts, in cents to avoid binary rounding noise).
const minus = (first: Amount | number, ...rest: Amount[]) =>
  rest.reduce<number>((total, value) => total - Math.round(num(value) * 100), Math.round(num(first) * 100)) / 100;

// Excel dates carry no time zone: write the Bogotá wall clock (UTC-05:00).
const bogota = (date: Date) => new Date(date.getTime() - 5 * 3_600_000);

interface Column {
  header: string;
  key: string;
  width: number;
  style?: Partial<ExcelJS.Style>;
}

function sheet(workbook: ExcelJS.Workbook, name: string, columns: Column[]) {
  const ws = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns;
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  return ws;
}

function finish(ws: ExcelJS.Worksheet, columns: number) {
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: columns } };
}

function paintCancelled(row: ExcelJS.Row, columns: number) {
  for (let column = 1; column <= columns; column += 1) {
    const cell = row.getCell(column);
    cell.fill = CANCELLED_FILL;
    cell.font = CANCELLED_FONT;
  }
}

const ORDER_COLUMNS: Column[] = [
  { header: 'Orden', key: 'number', width: 13 },
  { header: 'Fecha', key: 'createdAt', width: 17, style: { numFmt: DATE_TIME } },
  { header: 'Vendedor', key: 'seller', width: 22 },
  { header: 'Convertida por', key: 'convertedBy', width: 22 },
  { header: 'Cliente', key: 'customerName', width: 30 },
  { header: 'NIT / Cédula', key: 'customerTaxId', width: 16 },
  { header: 'Modalidad', key: 'saleType', width: 12 },
  { header: 'Forma de pago', key: 'paymentMethod', width: 22 },
  { header: 'Condiciones de pago', key: 'paymentTerms', width: 24 },
  { header: 'Estado de la orden', key: 'status', width: 22 },
  { header: 'Estado de pago', key: 'paymentStatus', width: 18 },
  { header: 'Cotización', key: 'quoteNumber', width: 13 },
  { header: 'Renglones', key: 'lines', width: 10 },
  { header: 'Materiales antes de descuentos', key: 'subtotal', width: 18, style: { numFmt: MONEY } },
  { header: 'Descuentos', key: 'discounts', width: 15, style: { numFmt: MONEY } },
  { header: 'Base de comisión (sin IVA)', key: 'base', width: 18, style: { numFmt: MONEY } },
  { header: 'IVA', key: 'tax', width: 15, style: { numFmt: MONEY } },
  { header: 'Ensamble (sin IVA)', key: 'assembly', width: 15, style: { numFmt: MONEY } },
  { header: 'Instalación (sin IVA)', key: 'installation', width: 15, style: { numFmt: MONEY } },
  { header: 'Total', key: 'total', width: 18, style: { numFmt: MONEY } },
  { header: 'Requiere facturación', key: 'requiresBilling', width: 12 },
  { header: 'N° de factura', key: 'invoiceNumber', width: 16 },
  { header: 'Facturada el', key: 'billedAt', width: 17, style: { numFmt: DATE_TIME } },
  { header: 'Motivo de cancelación', key: 'cancelReason', width: 30 },
];

const LINE_COLUMNS: Column[] = [
  { header: 'Orden', key: 'number', width: 13 },
  { header: 'Fecha', key: 'createdAt', width: 17, style: { numFmt: DATE_TIME } },
  { header: 'Vendedor', key: 'seller', width: 22 },
  { header: 'Cliente', key: 'customerName', width: 30 },
  { header: 'Estado de la orden', key: 'status', width: 22 },
  { header: 'Renglón', key: 'lineNo', width: 9 },
  { header: 'Referencia', key: 'referenceCode', width: 14 },
  { header: 'Descripción', key: 'referenceDescription', width: 30 },
  { header: 'Color', key: 'finishCode', width: 10 },
  { header: 'Descripción del color', key: 'finishDescription', width: 18 },
  { header: 'Origen', key: 'origin', width: 10 },
  { header: 'Proveedor', key: 'supplierName', width: 20 },
  { header: 'Cantidad (perfiles)', key: 'quantity', width: 11 },
  { header: 'Precio unitario', key: 'unitPrice', width: 15, style: { numFmt: MONEY } },
  { header: 'Precio manual', key: 'manualPrice', width: 9 },
  { header: 'Descuento del renglón', key: 'discountPercent', width: 11, style: { numFmt: PERCENT } },
  { header: 'Valor antes de descuentos', key: 'lineSubtotal', width: 17, style: { numFmt: MONEY } },
  { header: 'Descuento del renglón ($)', key: 'discountAmount', width: 15, style: { numFmt: MONEY } },
  { header: 'Descuento global ($)', key: 'globalDiscountAmount', width: 15, style: { numFmt: MONEY } },
  { header: 'Base de comisión (sin IVA)', key: 'base', width: 18, style: { numFmt: MONEY } },
  { header: 'IVA %', key: 'taxRatePercent', width: 8, style: { numFmt: PERCENT } },
  { header: 'IVA', key: 'taxAmount', width: 14, style: { numFmt: MONEY } },
  { header: 'Total del renglón', key: 'lineTotal', width: 17, style: { numFmt: MONEY } },
];

export async function renderSalesExport(data: SalesExportData): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Solualuminios';
  workbook.created = data.generatedAt;

  const orders = sheet(workbook, 'Órdenes', ORDER_COLUMNS);
  const lines = sheet(workbook, 'Renglones', LINE_COLUMNS);
  for (const order of data.orders) {
    const createdAt = bogota(order.createdAt);
    const row = orders.addRow({
      number: order.number,
      createdAt,
      seller: order.seller,
      convertedBy: order.convertedBy ?? '',
      customerName: order.customerName,
      customerTaxId: order.customerTaxId ?? '',
      saleType: order.saleType,
      paymentMethod: order.paymentMethod ?? 'Sin forma de pago registrada',
      paymentTerms: order.paymentTerms ?? '',
      status: order.status,
      paymentStatus: order.paymentStatus,
      quoteNumber: order.quoteNumber ?? '',
      lines: order.lines.length,
      subtotal: num(order.subtotal),
      discounts: -minus(0, order.discountTotal, order.globalDiscountAmount) || 0,
      base: minus(order.subtotal, order.discountTotal, order.globalDiscountAmount),
      tax: num(order.taxTotal),
      assembly: num(order.assemblyAmount),
      installation: num(order.installationAmount),
      total: num(order.total),
      requiresBilling: order.requiresBilling ? 'Sí' : 'No',
      invoiceNumber: order.invoiceNumber ?? (order.requiresBilling && !order.cancelled ? 'Pendiente' : ''),
      billedAt: order.billedAt ? bogota(order.billedAt) : null,
      cancelReason: order.cancelReason ?? '',
    });
    if (order.cancelled) paintCancelled(row, ORDER_COLUMNS.length);
    for (const line of order.lines) {
      const lineRow = lines.addRow({
        number: order.number,
        createdAt,
        seller: order.seller,
        customerName: order.customerName,
        status: order.status,
        lineNo: line.lineNo,
        referenceCode: line.referenceCode,
        referenceDescription: line.referenceDescription ?? '',
        finishCode: line.finishCode,
        finishDescription: line.finishDescription ?? '',
        origin: line.origin,
        supplierName: line.supplierName ?? '',
        quantity: line.quantity,
        unitPrice: num(line.unitPrice),
        manualPrice: line.manualPrice ? 'Sí' : 'No',
        discountPercent: num(line.discountPercent),
        lineSubtotal: num(line.lineSubtotal),
        discountAmount: num(line.discountAmount),
        globalDiscountAmount: num(line.globalDiscountAmount),
        base: minus(line.lineSubtotal, line.discountAmount, line.globalDiscountAmount),
        taxRatePercent: num(line.taxRatePercent),
        taxAmount: num(line.taxAmount),
        lineTotal: num(line.lineTotal),
      });
      if (order.cancelled) paintCancelled(lineRow, LINE_COLUMNS.length);
    }
  }
  finish(orders, ORDER_COLUMNS.length);
  finish(lines, LINE_COLUMNS.length);

  const summary = workbook.addWorksheet('Resumen');
  summary.columns = [
    { key: 'a', width: 26 },
    { key: 'b', width: 10 },
    { key: 'c', width: 20, style: { numFmt: MONEY } },
    { key: 'd', width: 20, style: { numFmt: MONEY } },
    { key: 'e', width: 20, style: { numFmt: MONEY } },
    { key: 'f', width: 20, style: { numFmt: MONEY } },
    { key: 'g', width: 20, style: { numFmt: MONEY } },
  ];
  summary.addRow(['Ventas por vendedor (base para comisiones)']).font = { bold: true, size: 14 };
  summary.addRow(['Generado', bogota(data.generatedAt)]).getCell(2).numFmt = DATE_TIME;
  summary.addRow(['Por', data.generatedBy]);
  for (const [label, value] of data.filters) summary.addRow([label, value]);
  summary.addRow([]);
  summary.addRow([
    'Base de comisión = materiales sin IVA después de descuentos. No incluye ensamble ni instalación. Las órdenes canceladas aparecen en rojo en las otras hojas y no suman aquí (salvo que se filtre por «Cancelada»).',
  ]).getCell(1).alignment = { wrapText: false };
  summary.addRow([]);
  const header = summary.addRow(['Vendedor', 'Órdenes', 'Base de comisión', 'Total con IVA', 'Base pagadas', 'Base pago pendiente', 'Base de contado']);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  const totals = { orders: 0, base: 0, total: 0, paid: 0, pending: 0, cash: 0 };
  for (const row of data.summary) {
    const values = { base: num(row.all.base), total: num(row.all.total), paid: num(row.paid.base), pending: num(row.pending.base), cash: num(row.cash.base) };
    summary.addRow([row.seller.name, row.all.orders, values.base, values.total, values.paid, values.pending, values.cash]);
    totals.orders += row.all.orders;
    for (const key of ['base', 'total', 'paid', 'pending', 'cash'] as const) totals[key] = Math.round((totals[key] + values[key]) * 100) / 100;
  }
  summary.addRow(['Total', totals.orders, totals.base, totals.total, totals.paid, totals.pending, totals.cash]).font = { bold: true };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
