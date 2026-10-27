import { Prisma } from '../generated/prisma/client.js';

// Decimal arithmetic for money (never JavaScript floats). Scales:
//   amounts      2 decimals (COP or document currency), ROUND_HALF_UP
//   unit costs   6 decimals per profile
//   percentages  4 decimals (30 = 30 %)
export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

export const ZERO = new Decimal(0);
export const HUNDRED = new Decimal(100);

export function dec(value: string | number | Decimal | null | undefined): Decimal {
  return new Decimal(value ?? 0);
}

export function money(value: Decimal): Decimal {
  return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function unitCost(value: Decimal): Decimal {
  return value.toDecimalPlaces(6, Decimal.ROUND_HALF_UP);
}

export function sum(values: Decimal[]): Decimal {
  return values.reduce((total, value) => total.plus(value), ZERO);
}

// Splits `total` (2 decimals) over `weights` proportionally. Every share is
// rounded down to the cent and the remaining cents go, one by one, to the
// shares with the largest discarded fraction (ties: lower index). The result
// always adds up exactly to `total` and does not depend on input order beyond
// the tie rule.
export function allocate(total: Decimal, weights: Decimal[]): Decimal[] {
  const weightSum = sum(weights);
  if (weights.length === 0) return [];
  if (weightSum.isZero() || total.isZero()) return weights.map(() => ZERO);
  const cents = total.times(100);
  const raw = weights.map((weight) => cents.times(weight).dividedBy(weightSum));
  const floors = raw.map((value) => value.floor());
  let remaining = cents.minus(sum(floors)).toNumber();
  const order = raw
    .map((value, index) => ({ index, fraction: value.minus(floors[index]) }))
    .sort((a, b) => b.fraction.comparedTo(a.fraction) || a.index - b.index);
  const result = [...floors];
  for (const { index } of order) {
    if (remaining <= 0) break;
    result[index] = result[index].plus(1);
    remaining -= 1;
  }
  return result.map((value) => value.dividedBy(100));
}

// Accepts decimal strings only ("12.5", "1000000"): amounts never travel as
// JSON floats.
export const DECIMAL_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;
