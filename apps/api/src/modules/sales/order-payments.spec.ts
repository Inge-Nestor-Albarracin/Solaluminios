import { BadRequestException } from '@nestjs/common';
import { dec } from '../../shared/money.js';
import { contadoSplit, parsePaymentDay } from './order-payments.js';

describe('contadoSplit', () => {
  const total = dec('100000.50');
  const parts = (list: ReturnType<typeof contadoSplit>) => list.map((p) => [p.medium, p.amount.toFixed(2), p.transferEntityId]);

  it('records the whole total in the single medium of a plain contado; only a transfer has an entity', () => {
    expect(parts(contadoSplit('CASH', total, {}))).toEqual([['CASH', '100000.50', null]]);
    expect(parts(contadoSplit('TRANSFER', total, { transferAmount: '100000.5', transferEntityId: 'NEQUI' }))).toEqual([['TRANSFER', '100000.50', 'NEQUI']]);
  });

  it('accepts any split of a mixed contado that adds up to the total; the entity goes with the transferred part', () => {
    expect(parts(contadoSplit('CASH_TRANSFER', total, { cashAmount: '35000.25', transferAmount: '65000.25', transferEntityId: 'BANCO_CAJA_SOCIAL' }))).toEqual([
      ['CASH', '35000.25', null],
      ['TRANSFER', '65000.25', 'BANCO_CAJA_SOCIAL'],
    ]);
  });

  it('refuses a split that does not add up, a missing medium or a second medium in a plain contado', () => {
    const entity = { transferEntityId: 'NEQUI' };
    expect(() => contadoSplit('CASH_TRANSFER', total, { cashAmount: '35000', transferAmount: '65000', ...entity })).toThrow(/faltan/);
    expect(() => contadoSplit('CASH_TRANSFER', total, { cashAmount: '35001', transferAmount: '65000', ...entity })).toThrow(/sobran/);
    expect(() => contadoSplit('CASH_TRANSFER', total, { cashAmount: '100000.50', ...entity })).toThrow(BadRequestException);
    expect(() => contadoSplit('CASH_TRANSFER', total, { cashAmount: '0', transferAmount: '100000.50', ...entity })).toThrow(BadRequestException);
    expect(() => contadoSplit('CASH', total, { cashAmount: '50000' })).toThrow(/Abono/);
    expect(() => contadoSplit('CASH', total, { transferAmount: '1' })).toThrow(/efectivo y transferencia/);
  });

  it('requires the entity of every transfer and refuses one with cash', () => {
    expect(() => contadoSplit('TRANSFER', total, {})).toThrow(/dónde se recibió/);
    expect(() => contadoSplit('CASH_TRANSFER', total, { cashAmount: '35000.25', transferAmount: '65000.25' })).toThrow(/dónde se recibió/);
    expect(() => contadoSplit('CASH', total, { transferEntityId: 'NEQUI' })).toThrow(/efectivo no lleva entidad/);
  });

  it('records nothing for abono or cartera, which never take a split', () => {
    expect(contadoSplit('PARTIAL', total, {})).toEqual([]);
    expect(() => contadoSplit('CREDIT', total, { cashAmount: '1' })).toThrow(BadRequestException);
    expect(() => contadoSplit('CREDIT', total, { transferEntityId: 'NEQUI' })).toThrow(BadRequestException);
  });
});

describe('parsePaymentDay', () => {
  it('accepts a real past day and refuses impossible or future days', () => {
    expect(parsePaymentDay('2026-11-24').toISOString()).toBe('2026-11-24T00:00:00.000Z');
    expect(() => parsePaymentDay('2026-02-30')).toThrow(BadRequestException);
    expect(() => parsePaymentDay('2999-01-01')).toThrow(/posterior a hoy/);
  });
});
