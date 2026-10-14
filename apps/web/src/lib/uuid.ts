// UUID v4 for operation keys and queue items. crypto.randomUUID only exists in
// secure contexts (HTTPS or localhost); warehouse tablets may open the app over
// plain HTTP on the local network, so fall back to crypto.getRandomValues,
// which is available everywhere.
export function uuid(): string {
  if (typeof crypto.randomUUID === 'function' && window.isSecureContext) {
    return crypto.randomUUID()
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
