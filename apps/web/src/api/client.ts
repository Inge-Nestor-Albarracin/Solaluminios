import { configureProbe, reportReachable, reportUnreachable } from '../pwa/connectivity'
import { beginWork } from '../pwa/workGuard'

export const API_URL = (import.meta.env.VITE_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')

export class ApiError extends Error {
  readonly status: number
  // Parsed error body, e.g. { itemIndex } or { epcs } from the batch save.
  readonly data: unknown

  constructor(status: number, message: string, data: unknown = null) {
    super(message)
    this.status = status
    this.data = data
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH'
  body?: unknown
  signal?: AbortSignal
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'Los datos enviados no son válidos.',
  401: 'Debes iniciar sesión.',
  403: 'No tienes permisos para esta operación.',
  404: 'No se encontró el registro solicitado.',
  409: 'La operación entra en conflicto con el estado actual.',
  429: 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
}

// The API says "EPC"; users know it as "chip". Only the displayed text changes.
function userWording(text: string): string {
  return text.replace(/\bestos EPC\b/g, 'estos chips').replace(/\bEPC\b/g, 'chip')
}

// Field names of validation errors, as users know them.
const FIELD_LABELS: Record<string, string> = {
  quantity: 'la cantidad',
  epc: 'el chip',
  discountPercent: 'el descuento',
  taxRatePercent: 'el IVA',
  manualUnitPrice: 'el precio manual',
  globalDiscountPercent: 'el descuento global',
}

// Technical validation text («bundles.1.quantity must not be greater than
// 1000000») into Spanish («Paquete 2: la cantidad no puede ser mayor que
// 1.000.000»). Messages already written in Spanish pass unchanged.
export function friendlyValidation(text: string): string {
  if (/^ThrottlerException/.test(text)) return STATUS_MESSAGES[429]
  const match = /^(?:(bundles|lines)\.(\d+)\.)?(\w+) (must .*|should .*)$/.exec(text)
  if (!match) {
    // A Spanish message with the path of a list item: «bundles.1.La cantidad…».
    const item = /^(bundles|lines)\.(\d+)\.(.+)$/.exec(text)
    return item ? `${item[1] === 'bundles' ? 'Paquete' : 'Renglón'} ${Number(item[2]) + 1}: ${item[3]}` : text
  }
  const [, list, index, field, rule] = match
  const number = (value: string) => Number(value).toLocaleString('es-CO')
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^must not be greater than (\d+)/, (m) => `no puede ser mayor que ${number(m[1])}`],
    [/^must not be less than (\d+)/, (m) => `no puede ser menor que ${number(m[1])}`],
    [/^must be an integer/, () => 'debe ser un número entero'],
    [/^should not be empty|^must be a string/, () => 'es obligatorio'],
  ]
  const translated = rules.map(([re, fn]) => { const m = re.exec(rule); return m ? fn(m) : null }).find(Boolean) ?? 'no es válido'
  const prefix = list ? `${list === 'bundles' ? 'Paquete' : 'Renglón'} ${Number(index) + 1}: ` : ''
  const label = FIELD_LABELS[field] ?? `el campo ${field}`
  return `${prefix}${label.charAt(0).toUpperCase()}${label.slice(1)} ${translated}.`
}

function errorMessage(status: number, data: unknown): string {
  // Too many requests: always the same plain explanation.
  if (status === 429) {
    const message = (data as { message?: unknown } | null)?.message
    return typeof message === 'string' && /^[A-ZÁÉÍÓÚÑ¿]/.test(message) && !/Throttler/.test(message) ? message : STATUS_MESSAGES[429]
  }
  const message = (data as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message) return userWording(friendlyValidation(message))
  if (Array.isArray(message) && message.length) return userWording(message.map((m) => friendlyValidation(String(m))).join('. '))
  return STATUS_MESSAGES[status] ?? 'Ocurrió un error en el servidor. Inténtalo de nuevo.'
}

// Without an answer in this time the request is abandoned and reported as
// "no response" (status 0). For a write that means an UNCERTAIN outcome: the
// callers keep the same operationKey for the retry, never a new one.
export const REQUEST_TIMEOUT_MS = 30_000

configureProbe(`${API_URL}/`)

function noResponseMessage(timedOut: boolean): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'Sin conexión: el dispositivo no tiene red. No se envió ni se guardó nada nuevo.'
  }
  return timedOut
    ? 'El servidor no respondió a tiempo.'
    : 'No se pudo conectar con el servidor. Verifica la conexión o que el API esté en ejecución.'
}

export async function apiRequest<T>(
  path: string,
  token: string | null,
  options: RequestOptions = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const method = options.method ?? 'GET'

  // Own controller: aborts on timeout or when the caller aborts.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  const forwardAbort = () => controller.abort()
  options.signal?.addEventListener('abort', forwardAbort)
  // A write waiting for the server must not be cut by an app update.
  const endWork = method === 'GET' ? null : beginWork('Una operación se está enviando al servidor')

  let response: Response
  let text: string
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    })
    text = await response.text()
  } catch (error) {
    if (options.signal?.aborted) throw error
    reportUnreachable()
    throw new ApiError(0, noResponseMessage(timedOut))
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
    endWork?.()
  }
  reportReachable()

  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!response.ok) throw new ApiError(response.status, errorMessage(response.status, data), data)
  return { status: response.status, data: data as T }
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return 'Ocurrió un error inesperado.'
}

// Binary download (PDF documents). Same authentication, timeout and error
// messages as apiRequest; the file name comes from Content-Disposition.
export async function apiDownload(path: string, token: string): Promise<{ blob: Blob; filename: string | null }> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  let response: Response
  let blob: Blob
  try {
    response = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
    blob = await response.blob()
  } catch {
    reportUnreachable()
    throw new ApiError(0, noResponseMessage(timedOut))
  } finally {
    clearTimeout(timer)
  }
  reportReachable()
  if (!response.ok) {
    let data: unknown = null
    try {
      data = JSON.parse(await blob.text())
    } catch {
      data = null
    }
    throw new ApiError(response.status, errorMessage(response.status, data), data)
  }
  const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')
  return { blob, filename: match?.[1] ?? null }
}
