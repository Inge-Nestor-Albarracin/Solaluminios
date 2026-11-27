import { dec } from '../../shared/money.js';
import { LineDiscountPool, globalApprovalCovers, lineNeedsApproval, sellerGlobalLimit } from './discount-authorization.js';

const at = new Date('2026-11-27T15:00:00.000Z');
const material = { referenceId: 'ref', finishId: 'black', origin: 'NATIONAL' as const, supplierId: null };
const saved = (extra: Partial<{ pricingMethod: string; quantity: number; discountPercent: string; discountApprovedById: string | null }> = {}) => ({
  ...material,
  pricingMethod: 'MARKUP_ON_COST',
  quantity: 10,
  discountApprovedAt: at,
  discountApprovedById: 'admin',
  ...extra,
  discountPercent: dec(extra.discountPercent ?? '10'),
});

describe('line discounts above the seller limit', () => {
  it('needs an administrator only above 3 %', () => {
    expect(lineNeedsApproval(dec('3'))).toBe(false);
    expect(lineNeedsApproval(dec('3.0001'))).toBe(true);
  });

  it('keeps an authorised discount for the same material and discount with no more profiles', () => {
    const pool = new LineDiscountPool([saved()]);
    expect(pool.take({ ...material, quantity: 11 }, dec('10'))).toBeNull();
    expect(pool.take({ ...material, quantity: 10 }, dec('9'))).toBeNull();
    expect(pool.take({ ...material, finishId: 'white', quantity: 10 }, dec('10'))).toBeNull();
    expect(pool.take({ ...material, quantity: 8 }, dec('10.0000'))).toEqual({ discountApprovedById: 'admin', discountApprovedAt: at });
  });

  it('never counts what nobody authorised: manual prices, missing approver', () => {
    const pool = new LineDiscountPool([saved({ pricingMethod: 'MANUAL' }), saved({ discountApprovedById: null })]);
    expect(pool.take({ ...material, quantity: 1 }, dec('10'))).toBeNull();
    expect(pool.largest(material, dec('10'))).toBeNull();
  });

  it('covers one line per authorisation, smallest fit first', () => {
    const pool = new LineDiscountPool([saved({ quantity: 50, discountApprovedById: 'big' }), saved({ quantity: 10, discountApprovedById: 'small' })]);
    expect(pool.largest(material, dec('10'))).toBe(50);
    expect(pool.take({ ...material, quantity: 5 }, dec('10'))?.discountApprovedById).toBe('small');
    expect(pool.take({ ...material, quantity: 5 }, dec('10'))?.discountApprovedById).toBe('big');
    expect(pool.take({ ...material, quantity: 5 }, dec('10'))).toBeNull();
  });
});

describe('global discount authorisation', () => {
  const approval = { globalDiscountApprovedPercent: dec('10'), globalDiscountApprovedBase: dec('1000000') };

  it('covers no higher percentage and no larger base', () => {
    expect(globalApprovalCovers(approval, dec('10'), dec('1000000'))).toBe(true);
    expect(globalApprovalCovers(approval, dec('8'), dec('900000'))).toBe(true);
    expect(globalApprovalCovers(approval, dec('10.01'), dec('1000000'))).toBe(false);
    expect(globalApprovalCovers(approval, dec('10'), dec('1000000.01'))).toBe(false);
    expect(globalApprovalCovers(null, dec('5'), dec('1'))).toBe(false);
  });

  it('gives the seller 3 % or the authorised percentage while the base does not grow', () => {
    expect(sellerGlobalLimit(null, dec('5')).toString()).toBe('3');
    expect(sellerGlobalLimit(approval, dec('1000000')).toString()).toBe('10');
    expect(sellerGlobalLimit(approval, dec('1000001')).toString()).toBe('3');
    expect(sellerGlobalLimit({ globalDiscountApprovedPercent: dec('2'), globalDiscountApprovedBase: dec('9') }, dec('1')).toString()).toBe('3');
  });
});
