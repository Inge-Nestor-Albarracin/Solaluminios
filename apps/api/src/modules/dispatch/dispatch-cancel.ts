import { audit, type Tx } from '../../shared/db.js';
import { enqueue } from '../notifications/outbox.js';

// Cancels OPEN dispatches (never confirmed ones: their exits are history).
// Reservations of a cancelled dispatch go back to the order line when the
// order stays committed (keepReservations), otherwise they are released.
// The linked tasks are cancelled and their assignees notified.
export async function cancelOpenDispatches(
  tx: Tx,
  input: { dispatchIds: string[]; reason: string; userId: string; keepReservations: boolean },
) {
  const now = new Date();
  const ids = [...new Set(input.dispatchIds)].sort();
  if (ids.length === 0) return;
  // Wait for operations in progress on these dispatches (preparation,
  // confirmation) and read their state after them: a dispatch confirmed
  // meanwhile is skipped, never cancelled over its exit.
  await tx.$queryRaw`SELECT id FROM "dispatches" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  for (const dispatchId of ids) {
    const dispatch = await tx.dispatch.findUnique({ where: { id: dispatchId }, include: { lines: { select: { id: true } } } });
    if (!dispatch || dispatch.status !== 'OPEN') continue;
    const lineIds = dispatch.lines.map((line) => line.id);
    if (input.keepReservations) {
      await tx.stockReservation.updateMany({ where: { dispatchLineId: { in: lineIds }, status: 'ACTIVE' }, data: { dispatchLineId: null } });
    } else {
      await tx.stockReservation.updateMany({ where: { dispatchLineId: { in: lineIds }, status: 'ACTIVE' }, data: { status: 'RELEASED', closedAt: now } });
    }
    await tx.dispatchPick.deleteMany({ where: { dispatchId } });
    await tx.dispatch.update({ where: { id: dispatchId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: input.reason } });
    await tx.task.updateMany({ where: { dispatchId, completedAt: null, cancelledAt: null }, data: { cancelledAt: now } });
    await tx.readerSession.updateMany({ where: { dispatchId, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: now } });
    // Nothing leaves with a cancelled dispatch: its open incidents are closed
    // with the cancellation as resolution (kept for traceability).
    await tx.dispatchIncident.updateMany({
      where: { dispatchId, status: 'OPEN' },
      data: { status: 'RESOLVED', resolution: `Despacho cancelado: ${input.reason}`.slice(0, 300), resolvedById: input.userId, resolvedAt: now },
    });
    await audit(tx, { entity: 'Dispatch', entityId: dispatchId, action: 'CANCELLED', userId: input.userId, reason: input.reason });
    await enqueue(tx, [{ userId: dispatch.assigneeId, kind: 'dispatch-cancelled', dedupeKey: `dispatch-cancelled:${dispatchId}`, dispatchId }]);
  }
}
