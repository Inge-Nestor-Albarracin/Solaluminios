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

function errorMessage(status: number, data: unknown): string {
  const message = (data as { message?: unknown } | null)?.message
  if (typeof message === 'string' && message) return userWording(message)
  if (Array.isArray(message) && message.length) return userWording(message.join('. '))
  return STATUS_MESSAGES[status] ?? 'Ocurrió un error en el servidor. Inténtalo de nuevo.'
}

export async function apiRequest<T>(
  path: string,
  token: string | null,
  options: RequestOptions = {},
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'No se pudo conectar con el servidor. Verifica que el API esté en ejecución.')
  }

  const text = await response.text()
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
