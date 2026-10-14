import { HttpException } from '@nestjs/common';
import { LoginAttempts } from './login-attempts.js';

describe('LoginAttempts', () => {
  let now = 0;
  const minutes = (m: number) => m * 60 * 1000;
  const status = (fn: () => void) => {
    try {
      fn();
      return 'allowed';
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : 'other';
    }
  };

  beforeEach(() => {
    now = 1_000_000;
  });

  it('locks an account after 5 failures within 15 minutes', () => {
    const attempts = new LoginAttempts(() => now);
    for (let i = 0; i < 4; i += 1) attempts.recordFailure('a@x.co');
    expect(status(() => attempts.assertAllowed('a@x.co'))).toBe('allowed');
    attempts.recordFailure('a@x.co');
    expect(status(() => attempts.assertAllowed('a@x.co'))).toBe(429);
    // Other accounts are not affected.
    expect(status(() => attempts.assertAllowed('b@x.co'))).toBe('allowed');
  });

  it('unlocks after the lock period', () => {
    const attempts = new LoginAttempts(() => now);
    for (let i = 0; i < 5; i += 1) attempts.recordFailure('a@x.co');
    now += minutes(14);
    expect(status(() => attempts.assertAllowed('a@x.co'))).toBe(429);
    now += minutes(2);
    expect(status(() => attempts.assertAllowed('a@x.co'))).toBe('allowed');
    attempts.recordFailure('a@x.co');
    expect(status(() => attempts.assertAllowed('a@x.co'))).toBe('allowed');
  });

  it('forgets failures outside the window and on success', () => {
    const attempts = new LoginAttempts(() => now);
    for (let i = 0; i < 4; i += 1) attempts.recordFailure('a@x.co');
    now += minutes(16);
    attempts.recordFailure('a@x.co');
    expect(status(() => attempts.assertAllowed('a@x.co'))).toBe('allowed');

    for (let i = 0; i < 3; i += 1) attempts.recordFailure('c@x.co');
    attempts.recordSuccess('c@x.co');
    for (let i = 0; i < 4; i += 1) attempts.recordFailure('c@x.co');
    expect(status(() => attempts.assertAllowed('c@x.co'))).toBe('allowed');
  });
});
