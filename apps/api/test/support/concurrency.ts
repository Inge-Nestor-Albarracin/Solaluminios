import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/infrastructure/database/prisma.service.js';

// Start barrier: every caller waits until `parties` callers arrived, then all
// continue together. Rejects instead of hanging if someone never arrives.
export function createBarrier(parties: number, timeoutMs = 15000) {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Barrera: llegaron ${arrived}/${parties}`)), timeoutMs);
    });
    try {
      await Promise.race([gate, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
}

// Always wrap the real $transaction, never a previous test hook.
function realTransaction(prisma: PrismaService) {
  const current: unknown = Reflect.get(prisma, '$transaction');
  if (vi.isMockFunction(current)) current.mockRestore();
  return prisma.$transaction.bind(prisma) as (fn: unknown, options?: unknown) => Promise<unknown>;
}

type InteractiveFn = (tx: Prisma.TransactionClient) => Promise<unknown>;

// Test-only hook: the next `count` interactive transactions wait at the
// barrier before starting, so their requests enter the protected section at
// the same time (instead of one after another). Array transactions (reads)
// are not affected. Returns a restore function.
export function barrierAtTransactionStart(prisma: PrismaService, count: number, barrier: () => Promise<void>) {
  const original = realTransaction(prisma);
  let remaining = count;
  const spy = vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: unknown, options?: unknown) => {
    if (typeof fn === 'function' && remaining > 0) {
      remaining -= 1;
      await barrier();
    }
    return original(fn, options);
  }) as never);
  return () => spy.mockRestore();
}

// Test-only hook: inside the next `count` interactive transactions, wait at
// the barrier right before the first `bundle.create`. All requests have then
// passed every "does it already exist?" check, which reproduces the classic
// check-then-insert race; only the database constraint can decide.
export function barrierBeforeBundleCreate(prisma: PrismaService, count: number, barrier: () => Promise<void>) {
  const original = realTransaction(prisma);
  let remaining = count;
  const spy = vi.spyOn(prisma, '$transaction').mockImplementation((async (fn: unknown, options?: unknown) => {
    if (typeof fn !== 'function' || remaining <= 0) return original(fn, options);
    remaining -= 1;
    let waited = false;
    return original(
      (tx: Prisma.TransactionClient) =>
        (fn as InteractiveFn)(
          new Proxy(tx, {
            get(target, property, receiver) {
              const value = Reflect.get(target, property, receiver) as unknown;
              if (property !== 'bundle') return value;
              return new Proxy(value as object, {
                get(delegate, method, r) {
                  const fnValue = Reflect.get(delegate, method, r) as unknown;
                  if (method !== 'create' || typeof fnValue !== 'function') return fnValue;
                  return async (...args: unknown[]) => {
                    if (!waited) {
                      waited = true;
                      await barrier();
                    }
                    return (fnValue as (...a: unknown[]) => unknown).apply(delegate, args);
                  };
                },
              });
            },
          }),
        ),
      options,
    );
  }) as never);
  return () => spy.mockRestore();
}

interface LedgerMovement {
  type: string;
  quantity: number;
  quantityBefore: number;
  quantityAfter: number;
  sourceLocationId: string | null;
  sourceRackId: string | null;
  destinationLocationId: string | null;
  destinationRackId: string | null;
  occurredAt: Date;
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i], ...tail];
  }
}

// Replays the movements of one bundle and returns an error description, or
// null when they form a valid history ending in the bundle's current state:
// balances chain (before == previous after, never negative), every exit/
// adjustment/transfer starts at the location current at that moment, and
// the final balance and location match the bundle. Movements with the same
// millisecond may appear in any order; one valid order is enough.
export function ledgerError(
  bundle: { quantity: number; inventoryLocationId: string; rackId: string | null },
  movements: LedgerMovement[],
): string | null {
  if (movements.length === 0) return 'paquete sin movimientos';
  const sorted = [...movements].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  if (movements.length > 7) return replay(bundle, chainByBalance(sorted));
  let lastError = '';
  for (const order of permutations(sorted)) {
    if (order.some((m, i) => i > 0 && m.occurredAt < order[i - 1].occurredAt)) continue;
    const error = replay(bundle, order);
    if (!error) return null;
    lastError = error;
  }
  return lastError;
}

// Long histories (load test): rebuild the order by following the balances
// (next movement starts where the previous ended), preferring occurredAt.
function chainByBalance(sorted: LedgerMovement[]): LedgerMovement[] {
  const remaining = [...sorted];
  const order: LedgerMovement[] = [];
  let balance = 0;
  while (remaining.length > 0) {
    const index = remaining.findIndex((m) => m.quantityBefore === balance);
    const next = remaining.splice(index >= 0 ? index : 0, 1)[0];
    order.push(next);
    balance = next.quantityAfter;
  }
  return order;
}

function replay(
  bundle: { quantity: number; inventoryLocationId: string; rackId: string | null },
  order: LedgerMovement[],
): string | null {
  const [first] = order;
  if (!['INITIAL_STOCK', 'ENTRY'].includes(first.type) || first.quantityBefore !== 0) return 'el primer movimiento no es el inicial';
  let balance = 0;
  let location: string | null = first.destinationLocationId;
  let rack: string | null = first.destinationRackId;
  for (const m of order) {
    if (m.quantityBefore !== balance) return `${m.type}: quantityBefore ${m.quantityBefore} ≠ saldo ${balance}`;
    if (m.quantityAfter < 0) return `${m.type}: saldo negativo`;
    switch (m.type) {
      case 'INITIAL_STOCK':
      case 'ENTRY':
      case 'ADJUSTMENT_IN':
        if (m.quantityAfter !== m.quantityBefore + m.quantity) return `${m.type}: suma incoherente`;
        if (m !== first && (m.destinationLocationId !== location || m.destinationRackId !== rack)) return `${m.type}: destino distinto de la ubicación vigente`;
        break;
      case 'EXIT':
      case 'ADJUSTMENT_OUT':
        if (m.quantityAfter !== m.quantityBefore - m.quantity) return `${m.type}: resta incoherente`;
        if (m.sourceLocationId !== location || m.sourceRackId !== rack) return `${m.type}: origen distinto de la ubicación vigente`;
        break;
      case 'TRANSFER':
        if (m.quantity !== m.quantityBefore || m.quantityAfter !== m.quantityBefore) return 'TRANSFER: cantidad distinta del saldo vigente';
        if (m.sourceLocationId !== location || m.sourceRackId !== rack) return 'TRANSFER: origen distinto de la ubicación vigente';
        location = m.destinationLocationId;
        rack = m.destinationRackId;
        break;
      case 'OPENING':
        // The bundle is opened where it is: same balance, same place.
        if (m.quantity !== m.quantityBefore || m.quantityAfter !== m.quantityBefore) return 'OPENING: cantidad distinta del saldo vigente';
        if (m.sourceLocationId !== location || m.sourceRackId !== rack) return 'OPENING: lugar distinto de la ubicación vigente';
        break;
      default:
        return `tipo desconocido ${m.type}`;
    }
    balance = m.quantityAfter;
  }
  if (balance !== bundle.quantity) return `saldo final ${bundle.quantity} ≠ último movimiento ${balance}`;
  if (location !== bundle.inventoryLocationId || rack !== bundle.rackId) return 'ubicación final distinta de la del último movimiento';
  return null;
}

// Loads bundles + movements and checks every ledger; returns problems found.
export async function ledgerProblems(prisma: PrismaService, bundleIds: string[]) {
  const bundles = await prisma.bundle.findMany({
    where: { id: { in: bundleIds } },
    include: { movements: true },
  });
  const problems: string[] = [];
  for (const bundle of bundles) {
    const error = ledgerError(bundle, bundle.movements);
    if (error) problems.push(`${bundle.epc}: ${error}`);
  }
  if (bundles.length !== new Set(bundleIds).size) problems.push('faltan paquetes');
  return problems;
}
