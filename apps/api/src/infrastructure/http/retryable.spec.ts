import { isCheckViolation, isLockTimeout, sqlState } from '../../shared/db.js';
import { isTransientDatabaseError } from './retryable.js';

// The pg driver adapter wraps errors raised inside interactive transactions:
// the SQLSTATE travels in `cause.originalCode` and the message is in the
// server's language (Spanish here), so it must be recognised by its code.
function adapterError(code: string, message: string) {
  const error = new Error(message) as Error & { cause: unknown };
  error.name = 'DriverAdapterError';
  error.cause = { originalCode: code, originalMessage: message, kind: 'postgres', code, message };
  return error;
}

describe('database error codes', () => {
  it('recognises a deadlock reported in Spanish as retryable', () => {
    const deadlock = adapterError('40P01', 'se ha detectado un deadlock');
    expect(sqlState(deadlock)).toBe('40P01');
    expect(isTransientDatabaseError(deadlock)).toBe(true);
  });

  it('recognises lock timeouts and check violations by their code', () => {
    const timeout = adapterError('55P03', 'cancelando la sentencia debido a que se agotó el tiempo de espera de candados');
    expect(isLockTimeout(timeout)).toBe(true);
    expect(isTransientDatabaseError(timeout)).toBe(true);
    expect(isCheckViolation(adapterError('23514', 'el nuevo registro viola la restricción «check»'))).toBe(true);
  });

  it('does not treat other errors or Prisma codes as SQLSTATEs', () => {
    expect(isTransientDatabaseError(adapterError('23505', 'llave duplicada viola restricción de unicidad'))).toBe(false);
    expect(sqlState(Object.assign(new Error('x'), { code: 'P2002' }))).toBeNull();
    expect(sqlState('not an error')).toBeNull();
  });
});
