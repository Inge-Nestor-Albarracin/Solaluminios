import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { NotificationOutbox } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { businessToday } from '../../shared/db.js';
import { PushService } from '../push/push.service.js';
import { SETTING_KEYS, SettingsService } from '../supply/settings.service.js';
import { enqueue, type NotificationKind } from './outbox.js';

const BATCH = 20;
const LEASE_MS = 120_000;
const MAX_ATTEMPTS = 5;
// Backoff after a failed delivery: 1 min, 5 min, 15 min, 1 h.
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000];
const POLL_MS = 10_000;
const OVERDUE_SCAN_MS = 15 * 60_000;

// Delivers the persistent outbox with Web Push. Runs inside the API (no
// external broker): a timer claims due rows with FOR UPDATE SKIP LOCKED and a
// lease, so several API instances or a restart never lose or double-claim a
// row; delivery itself is at-least-once. Before sending, each notice is
// re-validated against the current state (e.g. the dispatch is still OPEN
// and still assigned to that user); stale notices are SKIPPED.
@Injectable()
export class OutboxService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Outbox');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastOverdueScan = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit() {
    // Tests drive processOnce() explicitly.
    if (process.env.NODE_ENV === 'test' || process.env.OUTBOX_WORKER === 'off') return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      if (Date.now() - this.lastOverdueScan > OVERDUE_SCAN_MS) {
        this.lastOverdueScan = Date.now();
        await this.enqueueOverdue();
      }
      await this.processOnce();
    } catch {
      this.logger.warn('No se pudo procesar la cola de avisos; se reintentará');
    } finally {
      this.running = false;
    }
  }

  // Claims due rows (lease) and delivers them. Returns what happened.
  async processOnce(now = new Date()) {
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "notification_outbox"
        WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now}
        ORDER BY "createdAt" LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      await tx.notificationOutbox.updateMany({
        where: { id: { in: ids } },
        data: { nextAttemptAt: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
      });
      return tx.notificationOutbox.findMany({ where: { id: { in: ids } } });
    });
    const result = { sent: 0, skipped: 0, retried: 0, failed: 0 };
    for (const row of claimed) {
      const outcome = await this.deliver(row, now).catch(() => 'retry' as const);
      result[outcome === 'sent' ? 'sent' : outcome === 'skipped' ? 'skipped' : outcome === 'failed' ? 'failed' : 'retried'] += 1;
    }
    return result;
  }

  private async deliver(row: NotificationOutbox, now: Date): Promise<'sent' | 'skipped' | 'retry' | 'failed'> {
    const relevant = await this.stillRelevant(row);
    if (!relevant) {
      await this.prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'ya no corresponde al estado actual' } });
      return 'skipped';
    }
    const report = await this.push.sendToUser(row.userId, row.kind as NotificationKind);
    if (report.devices === 0 || (report.delivered === 0 && report.removed === report.devices)) {
      // No device to notify: the task/incident remains visible in the app.
      await this.prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SKIPPED', lastError: 'sin dispositivos con notificaciones activas' } });
      return 'skipped';
    }
    if (report.delivered > 0) {
      await this.prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), lastError: null } });
      return 'sent';
    }
    if (row.attempts >= MAX_ATTEMPTS) {
      await this.prisma.notificationOutbox.update({ where: { id: row.id }, data: { status: 'FAILED', lastError: 'servicio push sin respuesta tras varios intentos' } });
      return 'failed';
    }
    const wait = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)];
    await this.prisma.notificationOutbox.update({
      where: { id: row.id },
      data: { nextAttemptAt: new Date(now.getTime() + wait), lastError: 'entrega fallida; reintento programado' },
    });
    return 'retry';
  }

  // Current state check: notices about a dispatch that changed hands, was
  // closed or no longer concerns the recipient are not sent late.
  private async stillRelevant(row: NotificationOutbox): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: row.userId }, select: { active: true } });
    if (!user?.active) return false;
    if (!row.dispatchId) return true;
    const dispatch = await this.prisma.dispatch.findUnique({ where: { id: row.dispatchId }, select: { status: true, assigneeId: true } });
    if (!dispatch) return false;
    switch (row.kind) {
      case 'dispatch-assigned':
        return dispatch.status === 'OPEN' && dispatch.assigneeId === row.userId;
      case 'dispatch-incident':
      case 'dispatch-overdue':
        return dispatch.status === 'OPEN';
      default:
        return true;
    }
  }

  // Overdue OPEN dispatches: one reminder per day to the assignee and the
  // configured supervisor (dedupe key with the date). Overdue never releases
  // reservations nor confirms anything.
  async enqueueOverdue(now = new Date()) {
    const supervisorId = await this.settings.get(SETTING_KEYS.dispatchSupervisorId);
    const overdue = await this.prisma.dispatch.findMany({
      where: { status: 'OPEN', dueAt: { lt: now } },
      select: { id: true, assigneeId: true },
      take: 500,
    });
    const day = businessToday(now);
    await this.prisma.$transaction(async (tx) => {
      for (const dispatch of overdue) {
        await enqueue(tx, [
          { userId: dispatch.assigneeId, kind: 'dispatch-overdue', dedupeKey: `dispatch-overdue:${dispatch.id}:${day}`, dispatchId: dispatch.id },
          ...(supervisorId ? [{ userId: supervisorId, kind: 'dispatch-overdue' as const, dedupeKey: `dispatch-overdue:${dispatch.id}:${day}`, dispatchId: dispatch.id }] : []),
        ]);
      }
    });
    return overdue.length;
  }

  // Diagnosis (ADMIN): queue state without payloads or device data.
  async status() {
    const groups = await this.prisma.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } });
    const recent = await this.prisma.notificationOutbox.findMany({
      where: { status: { in: ['FAILED', 'PENDING'] } },
      select: { id: true, kind: true, status: true, attempts: true, nextAttemptAt: true, lastError: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { counts: Object.fromEntries(groups.map((g) => [g.status, g._count._all])), recent };
  }
}
