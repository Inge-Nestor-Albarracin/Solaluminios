import type { Tx } from '../../shared/db.js';

// Business notification kinds delivered by Web Push. The text shown on the
// device is decided by the service worker from the kind (discreet, no
// commercial data on a locked screen).
export type NotificationKind =
  | 'dispatch-assigned'
  | 'dispatch-reassigned'
  | 'dispatch-cancelled'
  | 'dispatch-incident'
  | 'dispatch-confirmed'
  | 'dispatch-overdue';

export interface OutboxItem {
  userId: string;
  kind: NotificationKind;
  // Logical identity of the notice: the same key is never queued twice
  // (retries of the business operation, repeated reads of a chip…).
  dedupeKey: string;
  dispatchId?: string | null;
}

// Written in the SAME transaction as the business change: if the change
// commits the notice exists; if it rolls back, there is no notice. Delivery
// happens later in OutboxService (at least once, never exactly once).
export async function enqueue(tx: Tx, items: OutboxItem[]) {
  const unique = new Map<string, OutboxItem>();
  for (const item of items) unique.set(`${item.dedupeKey}|${item.userId}`, item);
  if (unique.size === 0) return;
  await tx.notificationOutbox.createMany({
    data: [...unique.values()].map((item) => ({
      userId: item.userId,
      kind: item.kind,
      dedupeKey: `${item.dedupeKey}:${item.userId}`,
      dispatchId: item.dispatchId ?? null,
    })),
    skipDuplicates: true,
  });
}
