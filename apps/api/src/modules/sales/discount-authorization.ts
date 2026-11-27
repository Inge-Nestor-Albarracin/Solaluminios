import type { MaterialOrigin } from '../../generated/prisma/client.js';
import { Decimal, dec } from '../../shared/money.js';
import { SELLER_GLOBAL_DISCOUNT_LIMIT, SELLER_LINE_DISCOUNT_LIMIT } from './pricing.js';

// Discounts above the seller's limits need an administrator, and the
// authorisation covers only what was authorised (QA finding SEC-01).

interface Material {
  referenceId: string;
  finishId: string;
  origin: MaterialOrigin;
  supplierId: string | null;
}

export interface LineDiscountApproval {
  discountApprovedById: string;
  discountApprovedAt: Date;
}

interface SavedLine extends Material {
  pricingMethod: string;
  quantity: number;
  discountPercent: Decimal;
  discountApprovedById: string | null;
  discountApprovedAt: Date | null;
}

// A discount above 3 % on a line with the enabled price.
export function lineNeedsApproval(discountPercent: Decimal) {
  return discountPercent.greaterThan(SELLER_LINE_DISCOUNT_LIMIT);
}

const materialKey = (line: Material, discountPercent: Decimal) =>
  JSON.stringify([line.referenceId, line.finishId, line.origin, line.supplierId ?? null, dec(discountPercent).toFixed(4)]);

// The authorised discounts of the saved lines (enabled price, above 3 %).
// Each one covers one new line with the same material and discount and no
// more profiles: the smallest that fits is used first, so an authorisation
// never covers two lines nor more profiles than authorised.
export class LineDiscountPool {
  private readonly byKey = new Map<string, (LineDiscountApproval & { quantity: number })[]>();

  constructor(saved: SavedLine[]) {
    for (const line of saved) {
      if (line.pricingMethod === 'MANUAL' || !line.discountApprovedById || !line.discountApprovedAt || !lineNeedsApproval(dec(line.discountPercent))) continue;
      const key = materialKey(line, line.discountPercent);
      const list = this.byKey.get(key) ?? [];
      list.push({ discountApprovedById: line.discountApprovedById, discountApprovedAt: line.discountApprovedAt, quantity: line.quantity });
      list.sort((a, b) => a.quantity - b.quantity);
      this.byKey.set(key, list);
    }
  }

  // The authorisation that covers this line (removed from the pool), or null.
  take(line: Material & { quantity: number }, discountPercent: Decimal): LineDiscountApproval | null {
    const list = this.byKey.get(materialKey(line, discountPercent)) ?? [];
    const index = list.findIndex((item) => item.quantity >= line.quantity);
    if (index < 0) return null;
    const [{ discountApprovedById, discountApprovedAt }] = list.splice(index, 1);
    return { discountApprovedById, discountApprovedAt };
  }

  // Most profiles still authorised for this material and discount (to tell
  // the seller why a larger quantity is refused), or null.
  largest(line: Material, discountPercent: Decimal): number | null {
    const list = this.byKey.get(materialKey(line, discountPercent)) ?? [];
    return list.length > 0 ? list[list.length - 1].quantity : null;
  }
}

export interface GlobalApproval {
  globalDiscountApprovedPercent: Decimal | null;
  globalDiscountApprovedBase: Decimal | null;
}

// Whether an administrator's authorisation covers this global discount at
// this base (subtotal − line discounts): no higher percentage, no larger base.
export function globalApprovalCovers(approval: GlobalApproval | null, percent: Decimal, base: Decimal) {
  if (!approval?.globalDiscountApprovedPercent || !approval.globalDiscountApprovedBase) return false;
  return !percent.greaterThan(approval.globalDiscountApprovedPercent) && !base.greaterThan(approval.globalDiscountApprovedBase);
}

// Highest global discount SALES applies alone at this base: its own limit,
// or what an administrator authorised while the base does not grow.
export function sellerGlobalLimit(approval: GlobalApproval | null, base: Decimal) {
  const approved = approval?.globalDiscountApprovedPercent;
  if (!approved || !approved.greaterThan(SELLER_GLOBAL_DISCOUNT_LIMIT)) return SELLER_GLOBAL_DISCOUNT_LIMIT;
  return globalApprovalCovers(approval, approved, base) ? approved : SELLER_GLOBAL_DISCOUNT_LIMIT;
}

// A global discount above 3 %.
export function globalNeedsApproval(percent: Decimal) {
  return percent.greaterThan(SELLER_GLOBAL_DISCOUNT_LIMIT);
}
