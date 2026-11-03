import { Decimal, HUNDRED, ZERO, allocate, money, sum } from '../../shared/money.js';

// Sale price before SALES VAT from the unit cost of a purchase line (purchase
// VAT included), with a profit percentage ON COST (pure, unit-tested):
//   gain  = cost × p / 100
//   price = cost + gain            (30 % → cost × 1.30), rounded to cents
// Sales VAT is added afterwards, on the quote/order line.
export function markupOnCost(cost: Decimal, percent: Decimal): { gain: Decimal; price: Decimal } {
  if (!cost.greaterThan(0)) throw new RangeError('El costo debe ser mayor que cero');
  if (percent.lessThan(0)) throw new RangeError('El porcentaje de ganancia no puede ser negativo');
  const gain = cost.times(percent).dividedBy(HUNDRED);
  return { gain: money(gain), price: money(cost.plus(gain)) };
}

// Global discount of a quote: 0 (none) or from 0.1 % to 100 %. SALES applies
// up to SELLER_GLOBAL_DISCOUNT_LIMIT by itself; more needs an administrator's
// approval (QuoteDiscountRequest). ADMIN applies any valid value.
export const GLOBAL_DISCOUNT_MIN = new Decimal('0.1');
export const SELLER_GLOBAL_DISCOUNT_LIMIT = new Decimal(3);

export interface LineAmounts {
  lineSubtotal: Decimal;
  discountAmount: Decimal;
  globalDiscountAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
}

// Quote/order line without global discount: subtotal = qty × price; discount
// on the subtotal; tax on the discounted base; all rounded to 2 decimals.
export function lineAmounts(quantity: number, unitPrice: Decimal, discountPercent: Decimal, taxRatePercent: Decimal): LineAmounts {
  const lineSubtotal = money(unitPrice.times(quantity));
  const discountAmount = money(lineSubtotal.times(discountPercent).dividedBy(HUNDRED));
  return withGlobalDiscount([{ lineSubtotal, discountAmount, taxRatePercent }], ZERO)[0];
}

// Applies the global discount to lines that already carry their own discount:
//   base     = Σ (subtotal − line discount)
//   global   = base × g / 100, rounded to cents (the amount the customer sees)
//   shares   = global split over the lines in proportion to their base, to
//              the cent and adding up exactly (VAT rates may differ per line)
//   VAT      = (line base − share) × rate, per line
//   total    = line base − share + VAT
// Recomputed from stored line values, so approving a discount later never
// re-reads prices.
export function withGlobalDiscount(
  lines: { lineSubtotal: Decimal; discountAmount: Decimal; taxRatePercent: Decimal }[],
  globalDiscountPercent: Decimal,
): LineAmounts[] {
  const bases = lines.map((line) => line.lineSubtotal.minus(line.discountAmount));
  const global = money(sum(bases).times(globalDiscountPercent).dividedBy(HUNDRED));
  const shares = allocate(global, bases);
  return lines.map((line, index) => {
    const taxable = bases[index].minus(shares[index]);
    const taxAmount = money(taxable.times(line.taxRatePercent).dividedBy(HUNDRED));
    return {
      lineSubtotal: line.lineSubtotal,
      discountAmount: line.discountAmount,
      globalDiscountAmount: shares[index],
      taxAmount,
      lineTotal: taxable.plus(taxAmount),
    };
  });
}

// Document totals: total = subtotal − line discounts − global discount + VAT
// = Σ line totals.
export function documentTotals(lines: LineAmounts[]) {
  return {
    subtotal: sum(lines.map((line) => line.lineSubtotal)),
    discountTotal: sum(lines.map((line) => line.discountAmount)),
    globalDiscountAmount: sum(lines.map((line) => line.globalDiscountAmount)),
    taxTotal: sum(lines.map((line) => line.taxAmount)),
    total: sum(lines.map((line) => line.lineTotal)),
  };
}
