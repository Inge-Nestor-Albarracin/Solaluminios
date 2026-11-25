import { ZERO, money, type Decimal } from '../../shared/money.js';

// Pure rules of sales returns (documento DV). See SalesReturn in the schema.

export const REASON_LABEL = {
  SELLER_ERROR: 'Error del vendedor',
  CUSTOMER_ERROR: 'El cliente se equivocó o cambió de idea',
  WAREHOUSE_ERROR: 'Error de bodega',
  DEFECTIVE: 'Material defectuoso',
} as const;

export const SETTLEMENT_LABEL = { CREDIT: 'Saldo a favor', REFUND: 'Reintegro' } as const;

// Value of `count` profiles of an order line, proportional to it: with tax
// (`amount`, the money) and without tax (`base`, for commissions). When the
// returns complete the whole line, the last one takes the remainder, so the
// values never differ from the line by rounding.
export function lineShare(
  line: { quantity: number; lineTotal: Decimal; base: Decimal },
  count: number,
  previous: { count: number; amount: Decimal; base: Decimal },
): { amount: Decimal; base: Decimal } {
  if (count <= 0) return { amount: ZERO, base: ZERO };
  if (previous.count + count >= line.quantity) {
    return { amount: line.lineTotal.minus(previous.amount), base: line.base.minus(previous.base) };
  }
  return {
    amount: money(line.lineTotal.times(count).dividedBy(line.quantity)),
    base: money(line.base.times(count).dividedBy(line.quantity)),
  };
}

// Money of an order with returns:
// - net total = total − value of the received returns;
// - the customer keeps paid = payments − what was given back to them
//   (saldo a favor or reintegro), never more than the net total;
// - balance = net total − kept paid.
export function orderMoney(input: { total: Decimal; paid: Decimal; returned: Decimal; settled: Decimal }) {
  const net = input.total.minus(input.returned);
  const kept = input.paid.minus(input.settled);
  return { net, kept, balance: net.minus(kept) };
}

// A return of `value` first lowers what the customer still owed; what they
// had already paid beyond the new net total goes back to them (saldo a favor
// or reintegro). Never more than the value returned.
export function returnExcess(input: { total: Decimal; paid: Decimal; returned: Decimal; settled: Decimal; value: Decimal }): Decimal {
  const { kept } = orderMoney(input);
  const net = input.total.minus(input.returned).minus(input.value);
  const excess = kept.minus(net);
  if (excess.lte(ZERO)) return ZERO;
  return excess.gt(input.value) ? input.value : excess;
}

// A bundle a returned order line left from, in the place of the return.
export interface ReturnSource {
  bundleId: string;
  // Profiles of the line that left from it (confirmed dispatches).
  picked: number;
  // Already back into it from earlier returns of the same line.
  returned: number;
  // When it left (the last one out comes back first).
  leftAt: Date;
}

// Puts `count` profiles back into the bundles they left from: the last one
// out first, each up to what left from it and has not come back. Returns
// null when they do not fit (the material did not leave from here).
export function allocateReturn(sources: ReturnSource[], count: number): { bundleId: string; quantity: number }[] | null {
  const ordered = [...sources].sort((a, b) => b.leftAt.getTime() - a.leftAt.getTime() || a.bundleId.localeCompare(b.bundleId));
  const allocations: { bundleId: string; quantity: number }[] = [];
  let left = count;
  for (const source of ordered) {
    if (left === 0) break;
    const room = source.picked - source.returned;
    if (room <= 0) continue;
    const quantity = Math.min(room, left);
    allocations.push({ bundleId: source.bundleId, quantity });
    left -= quantity;
  }
  return left === 0 ? allocations : null;
}
