import { readFileSync } from 'node:fs';
import PDFDocument from 'pdfkit';

// Printable PDF of a quote or a sales order, laid out like an invoice
// (Letter size, standard Helvetica: no font files to deploy). It prints only
// what the customer may see: never costs, profits nor the material's origin
// (China / National), which is internal. It is a
// commercial document, not a DIAN electronic invoice, and says so.

export const COMPANY = { name: 'Solualuminios', taxId: '901882638' } as const;

type Amount = { toString(): string };

export interface SalesPdfLine {
  lineNo: number;
  referenceCode: string;
  referenceDescription: string | null;
  finishCode: string;
  finishDescription: string | null;
  quantity: number;
  unitPrice: Amount;
  discountPercent: Amount;
  taxRatePercent: Amount;
  lineTotal: Amount;
}

export interface SalesPdfData {
  title: 'COTIZACIÓN' | 'ORDEN DE VENTA';
  number: string;
  issuedAt: Date;
  validUntil?: Date | null;
  status: string;
  related?: string | null;
  seller: string;
  // Agreed payment method (and terms); null on documents saved before it existed.
  payment?: string | null;
  customer: { name: string; taxId: string | null; address: string | null; phone: string | null; email: string | null };
  lines: SalesPdfLine[];
  subtotal: Amount;
  discountTotal: Amount;
  taxTotal: Amount;
  total: Amount;
  notes: string | null;
}

let logo: Buffer | null = null;
// Copied next to the compiled file by nest-cli "assets".
const logoImage = () => (logo ??= readFileSync(new URL('./assets/solualuminios-logo.png', import.meta.url)));

const COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (value: Amount) => COP.format(Number(value.toString()));
const percent = (value: Amount) => `${Number(value.toString()).toLocaleString('es-CO', { maximumFractionDigits: 4 })} %`;
const date = (value: Date) =>
  new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', day: '2-digit', month: '2-digit', year: 'numeric' }).format(value);

const INK = '#1f2933';
const MUTED = '#6b7280';
const RULE = '#cbd2d9';
const BAND = '#eef1f4';
const LEFT = 40;
const WIDTH = 532; // Letter 612 pt − 2 × 40 margins.
const BOTTOM = 742; // Above the footer.

// Table columns (x offset, width, alignment).
const COLUMNS = [
  { key: 'no', label: '#', width: 20, align: 'left' },
  { key: 'item', label: 'Referencia / descripción', width: 212, align: 'left' },
  { key: 'qty', label: 'Cant.', width: 40, align: 'right' },
  { key: 'price', label: 'Precio unit. sin IVA', width: 82, align: 'right' },
  { key: 'disc', label: 'Desc.', width: 40, align: 'right' },
  { key: 'tax', label: 'IVA', width: 40, align: 'right' },
  { key: 'total', label: 'Total', width: 98, align: 'right' },
] as const;

export function renderSalesPdf(data: SalesPdfData): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: 40, bottom: 40, left: LEFT, right: LEFT },
    bufferPages: true,
    info: { Title: `${data.title} ${data.number}`, Author: COMPANY.name, Subject: `${data.title} para ${data.customer.name}` },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // --- Header: logo and company | document box -------------------------------
  doc.image(logoImage(), LEFT, 36, { fit: [96, 86] });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(COMPANY.name.toUpperCase(), LEFT + 108, 52, { width: 220 });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(`NIT ${COMPANY.taxId}`, LEFT + 108, 74, { width: 220 });

  const boxX = LEFT + WIDTH - 200;
  doc.roundedRect(boxX, 36, 200, 90, 4).fillAndStroke(BAND, RULE);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(data.title, boxX + 12, 46, { width: 176, align: 'right' });
  doc.fontSize(12).text(`No. ${data.number}`, boxX + 12, 64, { width: 176, align: 'right' });
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  const facts = [`Fecha: ${date(data.issuedAt)}`];
  if (data.validUntil) facts.push(`Válida hasta: ${date(data.validUntil)}`);
  facts.push(`Estado: ${data.status}`);
  if (data.related) facts.push(data.related);
  doc.text(facts.join('\n'), boxX + 12, 82, { width: 176, align: 'right', lineGap: 1 });

  // --- Customer and seller ---------------------------------------------------
  let y = 142;
  doc.moveTo(LEFT, y).lineTo(LEFT + WIDTH, y).lineWidth(0.6).strokeColor(RULE).stroke();
  y += 10;
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('CLIENTE', LEFT, y);
  doc.text('VENDEDOR', LEFT + 340, y);
  y += 12;
  doc.fillColor(INK).font('Helvetica').fontSize(10).text(data.seller, LEFT + 340, y, { width: 192 });
  let side = doc.y;
  if (data.payment) {
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('FORMA DE PAGO', LEFT + 340, side + 8);
    doc.fillColor(INK).font('Helvetica').fontSize(10).text(data.payment, LEFT + 340, doc.y + 2, { width: 192 });
    side = doc.y;
  }
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(10).text(data.customer.name, LEFT, y, { width: 320 });
  y = doc.y + 2;
  const contact = [
    data.customer.taxId ? `NIT / CC: ${data.customer.taxId}` : null,
    data.customer.address,
    [data.customer.phone, data.customer.email].filter(Boolean).join(' · ') || null,
  ].filter(Boolean);
  if (contact.length) doc.fontSize(9).fillColor(MUTED).text(contact.join('\n'), LEFT, y, { width: 320, lineGap: 1 });
  y = Math.max(doc.y, y, side) + 14;

  // --- Lines -------------------------------------------------------------------
  const header = (top: number) => {
    doc.rect(LEFT, top, WIDTH, 18).fill(INK);
    let x = LEFT;
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(8);
    for (const column of COLUMNS) {
      doc.text(column.label, x + 4, top + 5, { width: column.width - 8, align: column.align, lineBreak: false });
      x += column.width;
    }
    return top + 18;
  };
  y = header(y);

  data.lines.forEach((line, index) => {
    const finish = line.finishDescription ?? line.finishCode;
    const description = [line.referenceDescription, finish].filter(Boolean).join(' · ');
    const cells: Record<(typeof COLUMNS)[number]['key'], string> = {
      no: String(line.lineNo),
      item: line.referenceCode,
      qty: line.quantity.toLocaleString('es-CO'),
      price: money(line.unitPrice),
      disc: percent(line.discountPercent),
      tax: percent(line.taxRatePercent),
      total: money(line.lineTotal),
    };
    doc.font('Helvetica').fontSize(8.5);
    const itemWidth = COLUMNS[1].width - 8;
    const height = Math.max(20, 8 + doc.heightOfString(line.referenceCode, { width: itemWidth }) + (description ? doc.fontSize(7.5).heightOfString(description, { width: itemWidth }) + 2 : 0));
    if (y + height > BOTTOM) {
      doc.addPage();
      y = header(40);
    }
    if (index % 2 === 1) doc.rect(LEFT, y, WIDTH, height).fill(BAND);
    let x = LEFT;
    for (const column of COLUMNS) {
      doc.fillColor(INK).font(column.key === 'item' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      doc.text(cells[column.key], x + 4, y + 5, { width: column.width - 8, align: column.align });
      if (column.key === 'item' && description) {
        doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(description, x + 4, doc.y + 1, { width: column.width - 8 });
      }
      x += column.width;
    }
    y += height;
    doc.moveTo(LEFT, y).lineTo(LEFT + WIDTH, y).lineWidth(0.4).strokeColor(RULE).stroke();
  });

  // --- Totals ------------------------------------------------------------------
  if (y + 96 > BOTTOM) {
    doc.addPage();
    y = 40;
  }
  y += 12;
  const totals: [string, string][] = [
    ['Subtotal sin IVA', money(data.subtotal)],
    ['Descuentos', money(data.discountTotal)],
    ['IVA', money(data.taxTotal)],
  ];
  const labelX = LEFT + WIDTH - 230;
  doc.font('Helvetica').fontSize(9.5);
  for (const [label, value] of totals) {
    doc.fillColor(MUTED).text(label, labelX, y, { width: 120 });
    doc.fillColor(INK).text(value, labelX + 120, y, { width: 110, align: 'right' });
    y += 16;
  }
  doc.rect(labelX, y - 2, 230, 22).fill(INK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('TOTAL', labelX + 8, y + 4, { width: 110 });
  doc.text(money(data.total), labelX + 120, y + 4, { width: 102, align: 'right' });
  y += 34;

  if (data.notes) {
    if (y + 40 > BOTTOM) {
      doc.addPage();
      y = 40;
    }
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text('NOTAS', LEFT, y);
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(data.notes, LEFT, y + 11, { width: WIDTH });
  }

  // --- Footer on every page ------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let page = range.start; page < range.start + range.count; page += 1) {
    doc.switchToPage(page);
    // Writing inside the bottom margin must not open a new page.
    const margin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(
      `${COMPANY.name} · NIT ${COMPANY.taxId} · Documento comercial; no es una factura electrónica de venta.`,
      LEFT,
      752,
      { width: WIDTH - 80, lineBreak: false },
    );
    doc.text(`Página ${page - range.start + 1} de ${range.count}`, LEFT + WIDTH - 80, 752, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = margin;
  }
  doc.end();
  return done;
}
