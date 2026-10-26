// Validation of browser push subscriptions before the server stores them or
// sends a request to them. The endpoint is a URL chosen by the browser, so
// the server only ever contacts the push services of the major browsers over
// HTTPS (no arbitrary hosts, ports, credentials or plain HTTP: no SSRF).

export const MAX_ENDPOINT_LENGTH = 1024;

// Exact hosts and host suffixes of the browsers' push services.
const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Android, Opera, Samsung Internet
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari / iOS
];
const PUSH_HOST_SUFFIXES = [
  '.notify.windows.com', // Edge (WNS)
  '.push.apple.com',
];

export function isAllowedPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Host only, for logs: the full endpoint identifies the device and is never
// logged.
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return 'invalid';
  }
}

function base64UrlBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ''), 'base64url');
}

// p256dh: uncompressed P-256 public key (65 bytes, 0x04 prefix). auth: 16
// random bytes. Anything else cannot be encrypted for and is refused.
export function hasValidKeys(p256dh: string, auth: string): boolean {
  const key = base64UrlBytes(p256dh);
  const secret = base64UrlBytes(auth);
  return !!key && key.length === 65 && key[0] === 0x04 && !!secret && secret.length === 16;
}
