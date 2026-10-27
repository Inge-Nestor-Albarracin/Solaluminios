import {
  ServiceUnavailableException,
  type ArgumentsHost,
  Catch,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { Prisma } from '../../generated/prisma/client.js';
import { sqlState } from '../../shared/db.js';

// A temporary condition: the request was NOT applied and can be sent again
// unchanged (same operationKey). Clients must not treat it as a definitive
// conflict and must not generate a new key for the retry.
export class RetryableException extends ServiceUnavailableException {
  constructor(
    message: string,
    readonly retryAfterSeconds = 2,
  ) {
    super({ statusCode: 503, error: 'Service Unavailable', message, retryable: true });
  }
}

// PostgreSQL / Prisma conditions where the transaction was rolled back and an
// identical retry is safe: lock or statement timeout, deadlock, serialization
// failure, no free connection or transaction that could not start in time.
const RETRYABLE_SQLSTATES = ['55P03', '57014', '40P01', '40001'];
const RETRYABLE_PRISMA_CODES = ['P2028', 'P2024', 'P2034', 'P1001', 'P1002', 'P1017'];
const RETRYABLE_MESSAGES = [
  /timeout exceeded when trying to connect/i,
  /Unable to start a transaction in the given time/i,
  /Transaction API error/i,
  /lock timeout/i,
  /deadlock detected/i,
  /could not serialize access/i,
];

export function isTransientDatabaseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  const text = `${error.message} ${JSON.stringify(meta ?? {})}`;
  if (error instanceof Prisma.PrismaClientKnownRequestError && RETRYABLE_PRISMA_CODES.includes(error.code)) return true;
  if (typeof code === 'string' && (RETRYABLE_SQLSTATES.includes(code) || RETRYABLE_PRISMA_CODES.includes(code))) return true;
  const state = sqlState(error);
  if (state && RETRYABLE_SQLSTATES.includes(state)) return true;
  if (RETRYABLE_SQLSTATES.some((state) => text.includes(state))) return true;
  return RETRYABLE_MESSAGES.some((pattern) => pattern.test(text));
}

// Global filter: answers retryable conditions with 503 + Retry-After instead
// of a generic 500. Everything else keeps Nest's default handling (internal
// details are never sent to the client).
@Catch()
export class RetryableErrorFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const retryable =
      exception instanceof RetryableException
        ? exception
        : isTransientDatabaseError(exception)
          ? new RetryableException('El servidor está ocupado. Reintenta en unos segundos; la operación no se aplicó.')
          : null;
    if (retryable && host.getType() === 'http') {
      host.switchToHttp().getResponse<Response>().setHeader('Retry-After', String(retryable.retryAfterSeconds));
      return super.catch(retryable, host);
    }
    return super.catch(exception, host);
  }
}
