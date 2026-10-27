import type { PricingMethod } from '../../generated/prisma/client.js';
import { Decimal, HUNDRED, dec, money } from '../../shared/money.js';

// Sale price before tax from a cost per profile (pure, unit-tested):
//   MARKUP_ON_COST  price = cost × (1 + p)      (recargo sobre costo)
//   GROSS_MARGIN    price = cost ÷ (1 − p)      (margen bruto sobre venta)
// p is a percentage (30 = 30 %). The gross margin is not a promise of net
// profit for the company.
export function priceFromCost(cost: Decimal, method: Exclude<PricingMethod, 'MANUAL'>, percent: Decimal): Decimal {
  if (!cost.greaterThan(0)) throw new RangeError('El costo debe ser mayor que cero');
  if (percent.lessThan(0)) throw new RangeError('El porcentaje no puede ser negativo');
  const p = percent.dividedBy(HUNDRED);
  if (method === 'MARKUP_ON_COST') return money(cost.times(dec(1).plus(p)));
  if (!p.lessThan(1)) throw new RangeError('El margen bruto debe ser menor que 100 %');
  return money(cost.dividedBy(dec(1).minus(p)));
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
