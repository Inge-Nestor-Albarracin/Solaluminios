import { describe, expect, it } from 'vitest';
import { contadoSplit } from '../sales/order-payments.js';
import { Decimal, ZERO } from '../../shared/money.js';
import { allocateReturn, lineShare, orderMoney, returnExcess } from './returns.js';

const d = (value: string | number) => new Decimal(value);

describe('lineShare', () => {
  const line = { quantity: 3, lineTotal: d('100.00'), base: d('84.03') };

  it('is proportional to the line, with and without tax', () => {
    const share = lineShare(line, 1, { count: 0, amount: ZERO, base: ZERO });
    expect(share.amount.toFixed(2)).toBe('33.33');
    expect(share.base.toFixed(2)).toBe('28.01');
  });

  it('gives the remainder when the returns complete the line (no rounding gap)', () => {
    const first = lineShare(line, 1, { count: 0, amount: ZERO, base: ZERO });
    const second = lineShare(line, 1, { count: 1, amount: first.amount, base: first.base });
    const third = lineShare(line, 1, { count: 2, amount: first.amount.plus(second.amount), base: first.base.plus(second.base) });
    expect(first.amount.plus(second.amount).plus(third.amount).toFixed(2)).toBe('100.00');
    expect(third.amount.toFixed(2)).toBe('33.34');
    expect(first.base.plus(second.base).plus(third.base).toFixed(2)).toBe('84.03');
  });

  it('is zero when nothing came back', () => {
    expect(lineShare(line, 0, { count: 0, amount: ZERO, base: ZERO }).amount.toFixed(2)).toBe('0.00');
  });
});

describe('returnExcess and orderMoney', () => {
  it('contado (paid in full): the whole value goes back to the customer', () => {
    expect(returnExcess({ total: d(1000), paid: d(1000), returned: ZERO, settled: ZERO, value: d(300) }).toFixed(2)).toBe('300.00');
  });

  it('cartera without payments: the value only lowers the balance', () => {
    const input = { total: d(1000), paid: ZERO, returned: ZERO, settled: ZERO, value: d(300) };
    expect(returnExcess(input).toFixed(2)).toBe('0.00');
    expect(orderMoney({ total: d(1000), paid: ZERO, returned: d(300), settled: ZERO }).balance.toFixed(2)).toBe('700.00');
  });

  it('abono: lowers the balance first, the rest goes back', () => {
    // Paid 800 of 1000; returns 300 → net 700; 100 paid beyond it goes back.
    const settled = returnExcess({ total: d(1000), paid: d(800), returned: ZERO, settled: ZERO, value: d(300) });
    expect(settled.toFixed(2)).toBe('100.00');
    const money = orderMoney({ total: d(1000), paid: d(800), returned: d(300), settled });
    expect(money.net.toFixed(2)).toBe('700.00');
    expect(money.balance.toFixed(2)).toBe('0.00');
  });

  it('a second return counts what was already given back', () => {
    const first = returnExcess({ total: d(1000), paid: d(1000), returned: ZERO, settled: ZERO, value: d(200) });
    const second = returnExcess({ total: d(1000), paid: d(1000), returned: d(200), settled: first, value: d(100) });
    expect(second.toFixed(2)).toBe('100.00');
    expect(orderMoney({ total: d(1000), paid: d(1000), returned: d(300), settled: first.plus(second) }).balance.toFixed(2)).toBe('0.00');
  });
});

describe('allocateReturn', () => {
  const at = (iso: string) => new Date(iso);

  it('puts profiles back into the last bundles out first, up to what left from each', () => {
    const sources = [
      { bundleId: 'a', picked: 10, returned: 0, leftAt: at('2026-11-01T10:00:00Z') },
      { bundleId: 'b', picked: 5, returned: 0, leftAt: at('2026-11-03T10:00:00Z') },
    ];
    expect(allocateReturn(sources, 7)).toEqual([
      { bundleId: 'b', quantity: 5 },
      { bundleId: 'a', quantity: 2 },
    ]);
  });

  it('skips what already came back and refuses more than left', () => {
    const sources = [{ bundleId: 'a', picked: 10, returned: 8, leftAt: at('2026-11-01T10:00:00Z') }];
    expect(allocateReturn(sources, 2)).toEqual([{ bundleId: 'a', quantity: 2 }]);
    expect(allocateReturn(sources, 3)).toBeNull();
  });
});

describe('contadoSplit with saldo a favor', () => {
  it('pays part with saldo a favor and the rest in cash', () => {
    const parts = contadoSplit('CASH', d(1000), { creditAmount: '300' });
    expect(parts.map((p) => [p.medium, p.amount.toFixed(2)])).toEqual([
      ['CREDIT_BALANCE', '300.00'],
      ['CASH', '700.00'],
    ]);
  });

  it('may cover the whole contado (no entity needed then)', () => {
    const parts = contadoSplit('TRANSFER', d(1000), { creditAmount: '1000' });
    expect(parts.map((p) => p.medium)).toEqual(['CREDIT_BALANCE']);
  });

  it('checks the mixed contado against what is left after the saldo a favor', () => {
    expect(() => contadoSplit('CASH_TRANSFER', d(1000), { creditAmount: '200', cashAmount: '500', transferAmount: '500', transferEntityId: 'NEQUI' })).toThrow(
      /sobran \$200 sobre lo que queda después del saldo a favor/,
    );
    const parts = contadoSplit('CASH_TRANSFER', d(1000), { creditAmount: '200', cashAmount: '300', transferAmount: '500', transferEntityId: 'NEQUI' });
    expect(parts.map((p) => p.medium)).toEqual(['CREDIT_BALANCE', 'CASH', 'TRANSFER']);
  });

  it('records only the saldo a favor of an abono order, and never more than the total', () => {
    expect(contadoSplit('PARTIAL', d(1000), { creditAmount: '250' }).map((p) => [p.medium, p.amount.toFixed(2)])).toEqual([['CREDIT_BALANCE', '250.00']]);
    expect(() => contadoSplit('PARTIAL', d(1000), { creditAmount: '1200' })).toThrow(/supera el total/);
  });
});
