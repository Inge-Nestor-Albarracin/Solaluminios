import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { SafeUser } from '../auth/auth.types.js';
import type { PushSubscriptionDto } from './dto/push-subscription.dto.js';
import { endpointHost, hasValidKeys, isAllowedPushEndpoint } from './push-endpoint.js';
import {
  PushDeliveryError,
  PushSender,
  type PushMessageOptions,
  type VapidConfig,
} from './push.sender.js';
import { PUSH_RETRY_DELAYS_MS, VAPID_CONFIG } from './push.tokens.js';

// Devices kept per user; the oldest are dropped beyond this.
export const MAX_DEVICES_PER_USER = 10;
// One test notification per user in this window.
export const TEST_COOLDOWN_MS = 30_000;
// HTTP statuses after which the same request may succeed later.
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// The push service says the subscription no longer exists.
const GONE_STATUS = new Set([404, 410]);
const MAX_RETRY_AFTER_MS = 10_000;

// What the device shows is decided by the service worker from the type: the
// payload never carries titles, names or other business data.
export type PushKind = 'test' | 'task-assigned';

const MESSAGES: Record<PushKind, PushMessageOptions> = {
  test: { ttlSeconds: 300, urgency: 'normal' },
  'task-assigned': { ttlSeconds: 24 * 3600, urgency: 'normal', topic: 'task-assigned' },
};

export interface DeliveryReport {
  devices: number;
  delivered: number;
  removed: number;
  failed: number;
}

@Injectable()
export class PushService {
  private readonly logger = new Logger('Push');
  private readonly lastTest = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: PushSender,
    @Inject(VAPID_CONFIG) private readonly vapid: VapidConfig | null,
    @Inject(PUSH_RETRY_DELAYS_MS) private readonly retryDelays: readonly number[],
  ) {
    if (!vapid) this.logger.warn('Web Push desactivado: faltan VAPID_SUBJECT, VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY');
  }

  // Only the public key: browsers need it to subscribe.
  config() {
    return { enabled: this.vapid !== null, publicKey: this.vapid?.publicKey ?? null };
  }

  // Links this device to the session user. The endpoint identifies the device
  // and belongs to one account at a time: subscribing from a device that was
  // linked to another account moves it (only the browser that holds the
  // subscription knows its endpoint and keys).
  async subscribe(dto: PushSubscriptionDto, user: SafeUser, userAgent: string | undefined) {
    this.requireEnabled();
    const { endpoint } = dto;
    const { p256dh, auth } = dto.keys;
    if (!isAllowedPushEndpoint(endpoint)) {
      throw new BadRequestException('El destino de la suscripción no es un servicio push permitido');
    }
    if (!hasValidKeys(p256dh, auth)) {
      throw new BadRequestException('Las claves de la suscripción no son válidas');
    }
    const data = { userId: user.id, p256dh, auth, userAgent: userAgent?.slice(0, 255) || null };

    try {
      await this.prisma.pushSubscription.upsert({
        where: { endpoint },
        create: { endpoint, ...data },
        update: data,
      });
    } catch (error) {
      // Two simultaneous first subscriptions of the same device: the loser
      // updates the row the other one created.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      await this.prisma.pushSubscription.update({ where: { endpoint }, data });
    }

    const stale = await this.prisma.pushSubscription.findMany({
      where: { userId: user.id },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: MAX_DEVICES_PER_USER,
      select: { id: true },
    });
    if (stale.length > 0) {
      await this.prisma.pushSubscription.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
    return { subscribed: true };
  }

  // Whether this device is linked to the session user (never reveals owners).
  async isLinked(endpoint: string, user: SafeUser) {
    const row = await this.prisma.pushSubscription.findFirst({
      where: { endpoint, userId: user.id },
      select: { id: true },
    });
    return { linked: row !== null };
  }

  // Unlinks this device from the session user only (logout or "desactivar").
  // Other devices of the user and other accounts are not affected.
  async unsubscribe(endpoint: string, user: SafeUser) {
    const { count } = await this.prisma.pushSubscription.deleteMany({ where: { endpoint, userId: user.id } });
    return { removed: count > 0 };
  }

  async sendTest(user: SafeUser): Promise<DeliveryReport> {
    this.requireEnabled();
    const now = Date.now();
    const last = this.lastTest.get(user.id);
    if (last !== undefined && now - last < TEST_COOLDOWN_MS) {
      const wait = Math.ceil((TEST_COOLDOWN_MS - (now - last)) / 1000);
      throw new HttpException(
        { statusCode: 429, message: `Espera ${wait} s antes de enviar otra notificación de prueba` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.lastTest.set(user.id, now);
    for (const [id, at] of this.lastTest) if (now - at >= TEST_COOLDOWN_MS) this.lastTest.delete(id);

    const report = await this.sendToUser(user.id, 'test');
    if (report.devices === 0) {
      throw new BadRequestException('Este usuario no tiene dispositivos con notificaciones activadas');
    }
    return report;
  }

  // Called after the task was committed. Never throws: a push failure must
  // not change, repeat or roll back the task.
  notifyTaskAssigned(assigneeId: string): void {
    if (!this.vapid) return;
    void this.sendToUser(assigneeId, 'task-assigned').catch(() => {
      this.logger.warn('No se pudo notificar la asignación de una tarea');
    });
  }

  async sendToUser(userId: string, kind: PushKind): Promise<DeliveryReport> {
    const report: DeliveryReport = { devices: 0, delivered: 0, removed: 0, failed: 0 };
    if (!this.vapid) return report;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { active: true, pushSubscriptions: true },
    });
    if (!user?.active) return report;

    report.devices = user.pushSubscriptions.length;
    const payload = JSON.stringify({ type: kind });
    await Promise.all(
      user.pushSubscriptions.map(async (row) => {
        const outcome = await this.deliver(row, payload, MESSAGES[kind]);
        report[outcome] += 1;
      }),
    );
    return report;
  }

  private async deliver(
    row: { id: string; endpoint: string; p256dh: string; auth: string },
    payload: string,
    options: PushMessageOptions,
  ): Promise<'delivered' | 'removed' | 'failed'> {
    const host = endpointHost(row.endpoint);
    // Re-checked before every request (rows may predate a rule change).
    if (!isAllowedPushEndpoint(row.endpoint) || !hasValidKeys(row.p256dh, row.auth)) {
      await this.remove(row.id);
      this.logger.warn(`Suscripción ${row.id} (${host}) eliminada: destino o claves no válidos`);
      return 'removed';
    }

    const target = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.sender.send(target, payload, options);
        await this.prisma.pushSubscription
          .updateMany({ where: { id: row.id }, data: { lastSuccessAt: new Date() } })
          .catch(() => undefined);
        return 'delivered';
      } catch (error) {
        const status = error instanceof PushDeliveryError ? error.statusCode : null;
        if (status !== null && GONE_STATUS.has(status)) {
          await this.remove(row.id);
          this.logger.log(`Suscripción ${row.id} (${host}) eliminada: el servicio push respondió ${status}`);
          return 'removed';
        }
        const transient = status === null || TRANSIENT_STATUS.has(status);
        if (!transient || attempt >= this.retryDelays.length) {
          this.logger.warn(`Envío push fallido a ${row.id} (${host}): ${status ?? 'sin respuesta'} tras ${attempt + 1} intento(s)`);
          return 'failed';
        }
        const retryAfter = error instanceof PushDeliveryError && error.retryAfterSeconds !== null
          ? Math.min(error.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
          : 0;
        await sleep(Math.max(this.retryDelays[attempt], retryAfter));
      }
    }
  }

  private async remove(id: string) {
    await this.prisma.pushSubscription.deleteMany({ where: { id } }).catch(() => undefined);
  }

  private requireEnabled() {
    if (!this.vapid) {
      throw new ServiceUnavailableException('Las notificaciones push no están configuradas en el servidor');
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
