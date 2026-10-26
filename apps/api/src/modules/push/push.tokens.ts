// Injection tokens of the push module (separate file: no import cycles).
export const VAPID_CONFIG = Symbol('VAPID_CONFIG');
export const PUSH_RETRY_DELAYS_MS = Symbol('PUSH_RETRY_DELAYS_MS');
