import { Inject, Injectable } from '@nestjs/common';
import webpush from 'web-push';
import { VAPID_CONFIG } from './push.tokens.js';

// VAPID identity of this server (env only). The private key never leaves the
// backend; the public key is given to browsers so they accept our messages.
export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

// null: Web Push not configured (all three variables missing). Partial or
// invalid values are a configuration error and stop the API at start-up.
export function loadVapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const subject = env.VAPID_SUBJECT?.trim();
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  if (!subject && !publicKey && !privateKey) return null;
  if (!subject || !publicKey || !privateKey) {
    throw new Error('Configura VAPID_SUBJECT, VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY juntas (o ninguna)');
  }
  const config = { subject, publicKey, privateKey };
  try {
    // Validates the subject (mailto:/https:) and both key formats.
    webpush.getVapidHeaders('https://fcm.googleapis.com', subject, publicKey, privateKey, 'aes128gcm');
  } catch {
    // The library message could contain configuration values: not repeated.
    throw new Error('Las claves VAPID o VAPID_SUBJECT no son válidas (ver scripts/Configure-Vapid.mjs)');
  }
  return config;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessageOptions {
  ttlSeconds: number;
  urgency: 'low' | 'normal' | 'high';
  topic?: string;
}

// Error of one delivery attempt. statusCode is absent for network errors and
// timeouts. Never carries the endpoint or keys.
export class PushDeliveryError extends Error {
  constructor(
    readonly statusCode: number | null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(statusCode === null ? 'push: network error' : `push: HTTP ${statusCode}`);
  }
}

// Sends one encrypted message to one browser push service. Replaced by a
// fake in the e2e tests, which never contact real push services.
export abstract class PushSender {
  abstract send(target: PushTarget, payload: string, options: PushMessageOptions): Promise<void>;
}

@Injectable()
export class WebPushSender extends PushSender {
  constructor(@Inject(VAPID_CONFIG) private readonly vapid: VapidConfig | null) {
    super();
  }

  async send(target: PushTarget, payload: string, options: PushMessageOptions): Promise<void> {
    if (!this.vapid) throw new PushDeliveryError(null);
    try {
      await webpush.sendNotification(target, payload, {
        vapidDetails: this.vapid,
        TTL: options.ttlSeconds,
        urgency: options.urgency,
        topic: options.topic,
        contentEncoding: 'aes128gcm',
        timeout: 10_000,
      });
    } catch (error) {
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      const headers = (error as { headers?: Record<string, string> }).headers;
      const retryAfter = Number(headers?.['retry-after']);
      throw new PushDeliveryError(
        typeof statusCode === 'number' ? statusCode : null,
        Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
  }
}
