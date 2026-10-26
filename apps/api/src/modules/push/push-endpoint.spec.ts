import { createECDH, randomBytes } from 'node:crypto';
import webpush from 'web-push';
import { endpointHost, hasValidKeys, isAllowedPushEndpoint } from './push-endpoint.js';
import { loadVapidConfig } from './push.sender.js';

describe('push endpoint validation', () => {
  it('accepts the push services of the major browsers over HTTPS', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
      'https://web.push.apple.com/QGuQyavXutnMHnmFKa',
      'https://db5p.notify.windows.com/w/?token=BQYAAA',
      'https://FCM.googleapis.com:443/fcm/send/x',
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it('refuses anything the server should not contact (SSRF)', () => {
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x', // plain HTTP
      'https://localhost/fcm/send/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://fcm.googleapis.com.evil.example/x', // suffix trick
      'https://evilfcm.googleapis.com.example/x',
      'https://notify.windows.com.evil.example/x',
      'https://user:pass@fcm.googleapis.com/x', // credentials
      'https://fcm.googleapis.com:8443/x', // other port
      'file:///etc/passwd',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(1100)}`,
      42,
      null,
    ]) {
      expect(isAllowedPushEndpoint(endpoint), String(endpoint).slice(0, 60)).toBe(false);
    }
  });

  it('logs only the host of an endpoint', () => {
    expect(endpointHost('https://fcm.googleapis.com/fcm/send/secret-token')).toBe('fcm.googleapis.com');
    expect(endpointHost('%%%')).toBe('invalid');
  });

  it('checks the browser keys (P-256 public key and 16-byte secret)', () => {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const p256dh = ecdh.getPublicKey().toString('base64url');
    const auth = randomBytes(16).toString('base64url');
    expect(hasValidKeys(p256dh, auth)).toBe(true);
    expect(hasValidKeys(`${p256dh}=`, `${auth}==`)).toBe(true); // padded
    expect(hasValidKeys(p256dh.slice(4), auth)).toBe(false);
    expect(hasValidKeys(p256dh, randomBytes(8).toString('base64url'))).toBe(false);
    expect(hasValidKeys(`${p256dh.slice(0, -1)}+`, auth)).toBe(false); // not base64url
  });
});

describe('VAPID configuration', () => {
  const keys = webpush.generateVAPIDKeys();

  it('is disabled when nothing is configured', () => {
    expect(loadVapidConfig({})).toBeNull();
    expect(loadVapidConfig({ VAPID_SUBJECT: ' ', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' })).toBeNull();
  });

  it('loads a complete, valid configuration', () => {
    const config = loadVapidConfig({
      VAPID_SUBJECT: 'mailto:soporte@example.com',
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
    });
    expect(config).toEqual({ subject: 'mailto:soporte@example.com', publicKey: keys.publicKey, privateKey: keys.privateKey });
  });

  it('refuses partial or invalid values without echoing them', () => {
    expect(() => loadVapidConfig({ VAPID_PUBLIC_KEY: keys.publicKey })).toThrow(/juntas/);
    const bad = () =>
      loadVapidConfig({ VAPID_SUBJECT: 'soporte', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey });
    expect(bad).toThrow(/no son válidas/);
    let message = '';
    try {
      loadVapidConfig({ VAPID_SUBJECT: 'mailto:a@b.co', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: 'x' });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/no son válidas/);
    expect(message).not.toContain(keys.publicKey);
  });
});
