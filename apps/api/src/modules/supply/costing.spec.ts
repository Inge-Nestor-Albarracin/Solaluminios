import { allocate, dec } from '../../shared/money.js';
import { lineAmounts, priceFromCost } from '../sales/pricing.js';
import { computePurchase, type CostingLineInput } from './costing.js';

const line = (lineNo: number, quantity: string, unitPrice: string, extra: Partial<CostingLineInput> = {}): CostingLineInput => ({
  lineNo,
  quantity: dec(quantity),
  profilesPerUnit: dec(1),
  unitPrice: dec(unitPrice),
  lineDiscountType: 'NONE',
  lineDiscountValue: dec(0),
  taxRatePercent: dec(19),
  taxRecoverable: true,
  ...extra,
});

describe('purchase costing', () => {
  it('allocates a 3 % general discount exactly: 1.000.000 → 30.000 (18.000 / 12.000)', () => {
    const result = computePurchase({
      currency: 'COP',
      exchangeRate: null,
      globalDiscountType: 'PERCENT',
      globalDiscountValue: dec(3),
      charges: [],
      lines: [line(1, '60', '10000'), line(2, '40', '10000')],
    });
    expect(result.issues).toEqual([]);
    expect(result.globalDiscountTotal.toFixed(2)).toBe('30000.00');
    expect(result.lines.map((l) => l.globalDiscountAmount.toFixed(2))).toEqual(['18000.00', '12000.00']);
    expect(result.lines.map((l) => l.netAmount.toFixed(2))).toEqual(['582000.00', '388000.00']);
    expect(result.netTotal.toFixed(2)).toBe('970000.00');
    // Recoverable VAT is not part of the acquisition cost: 582.000 / 60 = 9.700.
    expect(result.lines[0].unitCostCop?.toFixed(6)).toBe('9700.000000');
    expect(result.documentTotal.toFixed(2)).toBe('1154300.00');
  });

  it('applies line discounts before the general one, without adding percentages', () => {
    const result = computePurchase({
      currency: 'COP',
      exchangeRate: null,
      globalDiscountType: 'PERCENT',
      globalDiscountValue: dec(10),
      charges: [],
      lines: [line(1, '10', '1000', { lineDiscountType: 'PERCENT', lineDiscountValue: dec(10) })],
    });
    // 10.000 − 10 % = 9.000; − 10 % = 8.100 (not 10.000 − 20 % = 8.000).
    expect(result.lines[0].netAmount.toFixed(2)).toBe('8100.00');
  });

  it('adds non-recoverable tax and attributable charges to cost; converts currency with the stated rate', () => {
    const result = computePurchase({
      currency: 'USD',
      exchangeRate: dec('4000'),
      globalDiscountType: 'NONE',
      globalDiscountValue: dec(0),
      charges: [dec('30')],
      lines: [
        line(1, '2', '50', { unitName: 'bundle', profilesPerUnit: dec(10), taxRecoverable: false, taxRatePercent: dec(10) } as Partial<CostingLineInput>),
        line(2, '20', '5', { taxRecoverable: true }),
      ],
    });
    expect(result.issues).toEqual([]);
    expect(result.lines.map((l) => l.chargesAmount.toFixed(2))).toEqual(['15.00', '15.00']);
    // Line 1: net 100 + charges 15 + tax 10 = 125 USD → 500.000 COP / 20 profiles.
    expect(result.lines[0].costAmountCop.toFixed(2)).toBe('500000.00');
    expect(result.lines[0].profiles).toBe(20);
    expect(result.lines[0].unitCostCop?.toFixed(2)).toBe('25000.00');
    // Line 2: net 100 + charges 15 = 115 USD → 460.000 COP / 20.
    expect(result.lines[1].unitCostCop?.toFixed(2)).toBe('23000.00');
  });

  it('reports what blocks confirmation instead of inventing values', () => {
    const result = computePurchase({
      currency: 'USD',
      exchangeRate: null,
      globalDiscountType: 'AMOUNT',
      globalDiscountValue: dec('999999'),
      charges: [],
      lines: [line(1, '1.5', '10', { taxRatePercent: null, taxRecoverable: null })],
    });
    expect(result.issues.join(' | ')).toMatch(/tasa de cambio/);
    expect(result.issues.join(' | ')).toMatch(/tarifa de impuesto/);
    expect(result.issues.join(' | ')).toMatch(/descontable/);
    expect(result.issues.join(' | ')).toMatch(/número entero/);
    expect(result.issues.join(' | ')).toMatch(/descuento general supera/);
    expect(result.lines[0].unitCostCop).toBeNull();
  });

  it('allocation always reconciles and assigns residual cents deterministically', () => {
    const shares = allocate(dec('100.00'), [dec(1), dec(1), dec(1)]);
    expect(shares.map((s) => s.toFixed(2))).toEqual(['33.34', '33.33', '33.33']);
    const odd = allocate(dec('0.05'), [dec('3'), dec('3'), dec('4')]);
    expect(odd.reduce((a, b) => a.plus(b)).toFixed(2)).toBe('0.05');
    expect(odd.map((s) => s.toFixed(2))).toEqual(['0.02', '0.01', '0.02']);
  });
});

describe('sale pricing', () => {
  it('distinguishes markup on cost from gross margin on sale (cost 9.700, 30 %)', () => {
    expect(priceFromCost(dec(9700), 'MARKUP_ON_COST', dec(30)).toFixed(2)).toBe('12610.00');
    expect(priceFromCost(dec(9700), 'GROSS_MARGIN', dec(30)).toFixed(2)).toBe('13857.14');
  });

  it('validates the margin denominator and the cost', () => {
    expect(() => priceFromCost(dec(9700), 'GROSS_MARGIN', dec(100))).toThrow(/menor que 100/);
    expect(() => priceFromCost(dec(0), 'MARKUP_ON_COST', dec(30))).toThrow(/mayor que cero/);
    expect(() => priceFromCost(dec(10), 'MARKUP_ON_COST', dec(-1))).toThrow(/negativo/);
  });

  it('computes line amounts with discount before tax', () => {
    const amounts = lineAmounts(20, dec('12610.00'), dec(5), dec(19));
    expect(amounts.lineSubtotal.toFixed(2)).toBe('252200.00');
    expect(amounts.discountAmount.toFixed(2)).toBe('12610.00');
    expect(amounts.taxAmount.toFixed(2)).toBe('45522.10');
    expect(amounts.lineTotal.toFixed(2)).toBe('285112.10');
  });
});
