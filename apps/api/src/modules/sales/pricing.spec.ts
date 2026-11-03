import { dec } from '../../shared/money.js';
import { documentTotals, lineAmounts, withGlobalDiscount } from './pricing.js';

describe('global discount of a quote', () => {
  // Line 1: 10 × 1.000 with 10 % line discount, VAT 19 % → base 9.000.
  // Line 2: 3 × 333,33 without discount, VAT 0 % → base 999,99.
  const lines = [
    { ...lineAmounts(10, dec('1000'), dec(10), dec(19)), taxRatePercent: dec(19) },
    { ...lineAmounts(3, dec('333.33'), dec(0), dec(0)), taxRatePercent: dec(0) },
  ];

  it('applies after the line discounts and before VAT, split by base', () => {
    const amounts = withGlobalDiscount(lines, dec(5));
    // 5 % of 9.999,99 = 499,9995 → 500,00, split 450,00 / 50,00.
    expect(amounts.map((line) => line.globalDiscountAmount.toFixed(2))).toEqual(['450.00', '50.00']);
    // VAT on the base after both discounts: (9.000 − 450) × 19 % = 1.624,50.
    expect(amounts.map((line) => line.taxAmount.toFixed(2))).toEqual(['1624.50', '0.00']);
    expect(amounts.map((line) => line.lineTotal.toFixed(2))).toEqual(['10174.50', '949.99']);
    const totals = documentTotals(amounts);
    expect(totals.subtotal.toFixed(2)).toBe('10999.99');
    expect(totals.discountTotal.toFixed(2)).toBe('1000.00');
    expect(totals.globalDiscountAmount.toFixed(2)).toBe('500.00');
    expect(totals.taxTotal.toFixed(2)).toBe('1624.50');
    expect(totals.total.toFixed(2)).toBe('11124.49');
    // total = subtotal − line discounts − global discount + VAT.
    expect(totals.subtotal.minus(totals.discountTotal).minus(totals.globalDiscountAmount).plus(totals.taxTotal).equals(totals.total)).toBe(true);
  });

  it('shares always add up to the rounded global amount', () => {
    const three = [1, 1, 1].map(() => ({ ...lineAmounts(1, dec('0.10'), dec(0), dec(19)), taxRatePercent: dec(19) }));
    // 2,5 % of 0,30 = 0,0075 → 0,01, given to one line only.
    const amounts = withGlobalDiscount(three, dec('2.5'));
    expect(documentTotals(amounts).globalDiscountAmount.toFixed(2)).toBe('0.01');
    expect(amounts.map((line) => line.globalDiscountAmount.toFixed(2))).toEqual(['0.01', '0.00', '0.00']);
  });

  it('without global discount keeps the line values unchanged', () => {
    const amounts = withGlobalDiscount(lines, dec(0));
    expect(amounts.map((line) => line.lineTotal.toFixed(2))).toEqual(lines.map((line) => line.lineTotal.toFixed(2)));
    expect(documentTotals(amounts).globalDiscountAmount.toFixed(2)).toBe('0.00');
  });
});
