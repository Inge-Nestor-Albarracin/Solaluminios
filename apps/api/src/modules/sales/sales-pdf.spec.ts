import { inflateSync } from 'node:zlib';
import { renderSalesPdf, type SalesPdfData } from './sales-pdf.js';

// Visible text of the PDF: pdfkit writes standard-font text as hex strings
// inside TJ arrays (split by kerning), one array per text run.
function visibleText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const runs: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n/g)) {
    const start = match.index + match[0].length;
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, raw.indexOf('endstream', start))).toString('latin1');
    } catch {
      continue; // Not a deflated content stream (e.g. image data).
    }
    for (const array of content.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const hex = [...array[1].matchAll(/<([0-9a-fA-F]*)>/g)].map((part) => part[1]).join('');
      runs.push(Buffer.from(hex, 'hex').toString('latin1'));
    }
  }
  return runs.join('\n');
}

const data: SalesPdfData = {
  title: 'COTIZACIÓN',
  number: 'COT-000001',
  issuedAt: new Date('2026-10-27T15:00:00Z'),
  validUntil: new Date('2026-11-10T00:00:00Z'),
  status: 'Vigente',
  seller: 'Vendedor',
  payment: 'Cartera (crédito) · 30 días',
  customer: { name: 'Cliente', taxId: '900000000', address: null, phone: null, email: null },
  lines: [
    { lineNo: 1, referenceCode: '17.30', referenceDescription: 'Perfil', finishCode: 'BM', finishDescription: 'Blanco mate', quantity: 20, unitPrice: '15005.90', discountPercent: '0', taxRatePercent: '19', lineTotal: '357140.42' },
  ],
  subtotal: '300118.00',
  discountTotal: '0',
  taxTotal: '57022.42',
  total: '357140.42',
  notes: null,
};

describe('sales PDF', () => {
  it('omits the payment section on documents saved before it existed', async () => {
    expect(visibleText(await renderSalesPdf({ ...data, payment: null })).includes('FORMA DE PAGO')).toBe(false);
  });

  it('shows the company, NIT and line, never the origin of the material', async () => {
    const pdf = await renderSalesPdf(data);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const text = visibleText(pdf);
    for (const word of ['SOLUALUMINIOS', 'NIT 901882638', 'COT-000001', '17.30', 'Blanco mate', 'FORMA DE PAGO', 'Cartera (crédito) · 30 días']) expect(text.includes(word), word).toBe(true);
    for (const word of ['origen', 'nacional', 'china']) expect(text.toLowerCase().includes(word), word).toBe(false);
  });
});
