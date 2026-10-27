import { Prisma } from '../generated/prisma/client.js';

export type Tx = Prisma.TransactionClient;

// Fixed server-side value (never user input), used in SET LOCAL lock_timeout.
export const LOCK_TIMEOUT = '5s';

export async function setLockTimeout(tx: Tx) {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
}

// One identity lock per chip shared by every flow that can create a record
// for that EPC (China pre-registration, reception, manual registration):
// the unique indexes of each table cannot see the other table, this lock
// serialises them. Released at the end of the transaction.
export async function lockEpc(tx: Tx, epc: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'epc:' + epc}, 0))`;
}

// PostgreSQL 55P03 lock_not_available, raised when lock_timeout expires.
export function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  return meta?.code === '55P03' || /55P03|lock timeout/i.test(`${error.message} ${JSON.stringify(meta ?? {})}`);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

// A CHECK constraint or trigger raised check_violation (23514).
export function isCheckViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  return /23514|check_violation|violates check constraint/i.test(`${error.message} ${JSON.stringify(meta ?? {})}`);
}

export async function nextNumber(tx: Tx, sequence: 'quote_number_seq' | 'sales_order_number_seq' | 'dispatch_number_seq' | 'stock_lot_code_seq', prefix: string) {
  // Sequence names come from the fixed union above, never from input.
  const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT nextval('${sequence}') AS n`);
  return `${prefix}-${String(rows[0].n).padStart(6, '0')}`;
}

export interface AuditInput {
  entity: string;
  entityId: string;
  action: string;
  userId?: string | null;
  reason?: string | null;
  data?: Prisma.InputJsonValue;
}

export function audit(tx: Tx, input: AuditInput) {
  return tx.auditEvent.create({
    data: {
      entity: input.entity,
      entityId: input.entityId,
      action: input.action,
      userId: input.userId ?? null,
      reason: input.reason ?? null,
      data: input.data,
    },
  });
}

// Today in the business time zone (America/Bogota) as YYYY-MM-DD.
export function businessToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(now);
}
