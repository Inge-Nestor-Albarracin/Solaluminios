import { Decimal, HUNDRED, money } from '../../shared/money.js';

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

export interface LineAmounts {
  lineSubtotal: Decimal;
  discountAmount: Decimal;
  taxAmount: Decimal;
  lineTotal: Decimal;
}

// Quote/order line: subtotal = qty × price; discount on the subtotal; tax on
// the discounted base; all rounded to 2 decimals.
export function lineAmounts(quantity: number, unitPrice: Decimal, discountPercent: Decimal, taxRatePercent: Decimal): LineAmounts {
  const lineSubtotal = money(unitPrice.times(quantity));
  const discountAmount = money(lineSubtotal.times(discountPercent).dividedBy(HUNDRED));
  const taxable = lineSubtotal.minus(discountAmount);
  const taxAmount = money(taxable.times(taxRatePercent).dividedBy(HUNDRED));
  return { lineSubtotal, discountAmount, taxAmount, lineTotal: taxable.plus(taxAmount) };
}
