import { HttpException, HttpStatus } from '@nestjs/common';

const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
// Bounded memory: an attacker spraying many emails cannot grow the map forever.
const MAX_TRACKED = 10_000;

interface Entry {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

// Per-account brute-force protection, complementary to the per-IP throttler
// (which a distributed attack can bypass). Counts failures by normalized
// email whether or not the account exists, so it reveals nothing about which
// emails are registered. In memory: resets on restart and is per instance.
export class LoginAttempts {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  assertAllowed(email: string): void {
    const entry = this.entries.get(email);
    if (!entry) return;
    const now = this.now();
    if (entry.lockedUntil > now) {
      const minutes = Math.ceil((entry.lockedUntil - now) / 60000);
      throw new HttpException(
        `Demasiados intentos fallidos para esta cuenta. Inténtalo de nuevo en ${minutes} min.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (entry.lockedUntil !== 0 || now - entry.firstFailureAt > WINDOW_MS) {
      this.entries.delete(email);
    }
  }

  recordFailure(email: string): void {
    const now = this.now();
    const entry = this.entries.get(email);
    if (!entry || now - entry.firstFailureAt > WINDOW_MS) {
      this.evictIfFull();
      this.entries.set(email, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
      return;
    }
    entry.failures += 1;
    if (entry.failures >= MAX_FAILURES) entry.lockedUntil = now + LOCK_MS;
  }

  recordSuccess(email: string): void {
    this.entries.delete(email);
  }

  private evictIfFull(): void {
    if (this.entries.size < MAX_TRACKED) return;
    // Maps keep insertion order: drop the oldest entry.
    const oldest = this.entries.keys().next().value;
    if (oldest !== undefined) this.entries.delete(oldest);
  }
}
