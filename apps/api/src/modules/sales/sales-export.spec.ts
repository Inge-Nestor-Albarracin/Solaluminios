import ExcelJS from 'exceljs';
import { renderSalesExport, type ExportLine, type ExportOrder, type SalesExportData } from './sales-export.js';

const line = (patch: Partial<ExportLine> = {}): ExportLine => ({
  lineNo: 1,
  referenceCode: '17.30',
  referenceDescription: 'Perfil',
  finishCode: 'BM',
  finishDescription: 'Blanco mate',
  origin: 'Nacional',
  supplierName: null,
  quantity: 10,
  unitPrice: '10000.00',
  discountPercent: '10',
  lineSubtotal: '100000.00',
  discountAmount: '10000.00',
  globalDiscountAmount: '2700.00',
  taxRatePercent: '19',
  taxAmount: '16587.00',
  lineTotal: '103887.00',
  manualPrice: false,
  ...patch,
});

const order = (patch: Partial<ExportOrder> = {}): ExportOrder => ({
  number: 'OV-000001',
  createdAt: new Date('2026-11-10T02:30:00Z'), // 9 Nov 21:30 in Bogotá
  seller: 'Wesales',
  convertedBy: 'Wesales',
  customerName: 'Cliente uno',
  customerTaxId: '900000001',
  saleType: 'Detal',
  paymentMethod: 'Cartera (crédito)',
  paymentTerms: '30 días',
  status: 'Reservada',
  cancelled: false,
  paymentStatus: 'Pago pendiente',
  quoteNumber: 'COT-000001',
  subtotal: '100000.00',
  discountTotal: '10000.00',
  globalDiscountAmount: '2700.00',
  taxTotal: '16587.00',
  assemblyAmount: '0',
  installationAmount: '0',
  total: '103887.00',
  cancelReason: null,
  requiresBilling: true,
  invoiceNumber: 'FE-1001',
  billedAt: new Date('2026-11-10T15:00:00Z'),
  lines: [line()],
  returns: [],
  ...patch,
});

const data: SalesExportData = {
  generatedAt: new Date('2026-11-17T15:00:00Z'),
  generatedBy: 'Admin',
  filters: [['Vendedor', 'Wesales'], ['Desde', '2026-11-01']],
  orders: [
    order(),
    order({
      number: 'OV-000002',
      saleType: 'Ventanería',
      status: 'Cancelada',
      cancelled: true,
      cancelReason: 'El cliente desistió',
      assemblyAmount: '150000.00',
      installationAmount: '50000.00',
      total: '303887.00',
      lines: [line(), line({ lineNo: 2, referenceCode: '8025', origin: 'China', manualPrice: true })],
    }),
  ],
  summary: [{ seller: { name: 'Wesales' }, all: { orders: 1, base: '87300.00', total: '103887.00' }, paid: { orders: 0, base: '0.00', total: '0.00' }, pending: { orders: 1, base: '87300.00', total: '103887.00' }, cash: { orders: 0, base: '0.00', total: '0.00' }, returned: { returns: 0, base: '0.00', total: '0.00' } }],
};

async function read(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  return workbook;
}

const header = (ws: ExcelJS.Worksheet) => (ws.getRow(1).values as unknown[]).slice(1);
const value = (ws: ExcelJS.Worksheet, row: number, title: string) => ws.getRow(row).getCell(header(ws).indexOf(title) + 1);

describe('renderSalesExport', () => {
  it('writes orders, lines, returns and summary sheets in that order', async () => {
    const workbook = await read(await renderSalesExport(data));
    expect(workbook.worksheets.map((ws) => ws.name)).toEqual(['Órdenes', 'Renglones', 'Devoluciones', 'Resumen']);
    expect(workbook.getWorksheet('Órdenes')!.rowCount).toBe(3);
    expect(workbook.getWorksheet('Renglones')!.rowCount).toBe(4);
  });

  it('writes amounts as numbers: commission base without VAT nor services', async () => {
    const ws = (await read(await renderSalesExport(data))).getWorksheet('Órdenes')!;
    expect(value(ws, 2, 'Base de comisión (sin IVA)').value).toBe(87300);
    expect(value(ws, 2, 'Descuentos').value).toBe(12700);
    expect(value(ws, 2, 'Total').value).toBe(103887);
    expect(value(ws, 3, 'Ensamble (sin IVA)').value).toBe(150000);
    expect(value(ws, 3, 'Base de comisión (sin IVA)').value).toBe(87300);
    expect(value(ws, 2, 'Base de comisión (sin IVA)').numFmt).toContain('#,##0.00');
    expect(value(ws, 2, 'NIT / Cédula').value).toBe('900000001');
    expect(value(ws, 2, 'Requiere facturación').value).toBe('Sí');
    expect(value(ws, 2, 'N° de factura').value).toBe('FE-1001');
    expect((value(ws, 2, 'Facturada el').value as Date).toISOString()).toBe('2026-11-10T10:00:00.000Z');
  });

  it('marks orders still to invoice as pending', async () => {
    const pending = order({ invoiceNumber: null, billedAt: null });
    const none = order({ number: 'OV-000009', requiresBilling: false, invoiceNumber: null, billedAt: null });
    const ws = (await read(await renderSalesExport({ ...data, orders: [pending, none] }))).getWorksheet('Órdenes')!;
    expect(value(ws, 2, 'N° de factura').value).toBe('Pendiente');
    expect(value(ws, 3, 'Requiere facturación').value).toBe('No');
    expect(value(ws, 3, 'N° de factura').value ?? '').toBe('');
  });

  it('writes the date as the Bogotá wall clock', async () => {
    const ws = (await read(await renderSalesExport(data))).getWorksheet('Órdenes')!;
    const date = value(ws, 2, 'Fecha').value as Date;
    expect(date.toISOString()).toBe('2026-11-09T21:30:00.000Z');
  });

  it('paints cancelled orders red in both detail sheets, and only them', async () => {
    const workbook = await read(await renderSalesExport(data));
    const red = (cell: ExcelJS.Cell) => (cell.fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb === 'FFFFC7CE';
    const orders = workbook.getWorksheet('Órdenes')!;
    expect(red(value(orders, 2, 'Orden'))).toBe(false);
    expect(red(value(orders, 3, 'Orden'))).toBe(true);
    expect(red(value(orders, 3, 'Motivo de cancelación'))).toBe(true);
    expect(value(orders, 3, 'Motivo de cancelación').value).toBe('El cliente desistió');
    const lines = workbook.getWorksheet('Renglones')!;
    expect(red(value(lines, 2, 'Orden'))).toBe(false);
    expect(red(value(lines, 3, 'Total del renglón'))).toBe(true);
    expect(red(value(lines, 4, 'Total del renglón'))).toBe(true);
    expect(value(lines, 4, 'Origen').value).toBe('China');
    expect(value(lines, 4, 'Precio manual').value).toBe('Sí');
    expect(value(lines, 2, 'Base de comisión (sin IVA)').value).toBe(87300);
  });

  it('keeps text that looks like a formula as plain text', async () => {
    const workbook = await read(await renderSalesExport({ ...data, orders: [order({ customerName: '=HYPERLINK("http://x")' })] }));
    const cell = value(workbook.getWorksheet('Órdenes')!, 2, 'Cliente');
    expect(cell.type).toBe(ExcelJS.ValueType.String);
    expect(cell.value).toBe('=HYPERLINK("http://x")');
  });

  it('summarises per seller with a total row', async () => {
    const ws = (await read(await renderSalesExport(data))).getWorksheet('Resumen')!;
    const rows = (ws.getSheetValues() as unknown[][]).filter(Boolean).map((row) => row.slice(1));
    expect(rows).toContainEqual(['Wesales', 1, 87300, 103887, 0, 87300, 0, 0, 87300]);
    expect(rows).toContainEqual(['Total', 1, 87300, 103887, 0, 87300, 0, 0, 87300]);
    expect(rows).toContainEqual(['Vendedor', 'Wesales']);
  });

  it('subtracts received returns: order columns, a row per returned line and the net base', async () => {
    const returned = order({
      returns: [
        {
          number: 'DV-000001',
          receivedAt: new Date('2026-11-12T15:00:00Z'),
          reason: 'Error del vendedor',
          settlement: 'Saldo a favor',
          settledAmount: '10388.70',
          creditNoteNumber: 'NC-7',
          lines: [
            { lineNo: 1, referenceCode: '744', referenceDescription: 'Jamba', finishCode: 'NP', origin: 'Nacional', good: 9, damaged: 1, amount: '10388.70', baseAmount: '8730.00' },
          ],
        },
      ],
    });
    const summary = [{ ...data.summary[0], returned: { returns: 1, base: '8730.00', total: '10388.70' } }];
    const workbook = await read(await renderSalesExport({ ...data, orders: [returned], summary }));
    const orders = workbook.getWorksheet('Órdenes')!;
    expect(value(orders, 2, 'Devuelto (con IVA)').value).toBe(10388.7);
    expect(value(orders, 2, 'Base devuelta (sin IVA)').value).toBe(8730);
    expect(value(orders, 2, 'Total neto').value).toBe(93498.3);
    const returns = workbook.getWorksheet('Devoluciones')!;
    expect(returns.rowCount).toBe(2);
    expect(value(returns, 2, 'Devolución').value).toBe('DV-000001');
    expect(value(returns, 2, 'Orden').value).toBe('OV-000001');
    expect(value(returns, 2, 'En buen estado (perfiles)').value).toBe(9);
    expect(value(returns, 2, 'Dañados (perfiles)').value).toBe(1);
    expect(value(returns, 2, 'Valor devuelto (con IVA)').value).toBe(10388.7);
    expect(value(returns, 2, 'N° de nota crédito').value).toBe('NC-7');
    const rows = (workbook.getWorksheet('Resumen')!.getSheetValues() as unknown[][]).filter(Boolean).map((row) => row.slice(1));
    expect(rows).toContainEqual(['Wesales', 1, 87300, 103887, 0, 87300, 0, 8730, 78570]);
  });
});
