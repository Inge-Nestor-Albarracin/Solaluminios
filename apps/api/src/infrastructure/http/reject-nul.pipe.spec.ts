import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { RejectNulPipe, hasNul } from './reject-nul.pipe.js';

describe('RejectNulPipe', () => {
  const pipe = new RejectNulPipe();

  it('finds a NUL character in strings, nested values and keys', () => {
    expect(hasNul('Nota\u0000nula')).toBe(true);
    expect(hasNul({ lines: [{ note: 'ok' }, { note: 'x\u0000' }] })).toBe(true);
    expect(hasNul({ ['clave\u0000']: 1 })).toBe(true);
    expect(hasNul(['a', 'b'])).toBe(false);
  });

  it('lets every other value through unchanged', () => {
    const body = { notes: "'; DROP TABLE x;-- <script>", quantity: 3, ok: true, none: null, epcs: ['E200', 'E201'] };
    expect(pipe.transform(body)).toBe(body);
    expect(pipe.transform('cmww8a2th0007w05msvqpjm5e')).toBe('cmww8a2th0007w05msvqpjm5e');
    expect(pipe.transform(undefined)).toBeUndefined();
    const buffer = Buffer.from([0, 1, 2]);
    expect(pipe.transform(buffer)).toBe(buffer);
  });

  it('refuses a value with a NUL character with a 400', () => {
    expect(() => pipe.transform('id\u0000')).toThrow(BadRequestException);
    expect(() => pipe.transform({ reason: 'Motivo\u0000nulo' })).toThrow(/carácter nulo/);
  });
});
