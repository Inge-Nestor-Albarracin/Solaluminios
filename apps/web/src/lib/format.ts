import type { Bundle, Movement, MovementPlace, MovementType } from '../api/types'

export const BUSINESS_TIME_ZONE = 'America/Bogota'

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  INITIAL_STOCK: 'Inventario inicial',
  ENTRY: 'Entrada',
  EXIT: 'Salida',
  TRANSFER: 'Traslado',
  ADJUSTMENT_IN: 'Ajuste (+)',
  ADJUSTMENT_OUT: 'Ajuste (−)',
  OPENING: 'Apertura (pasa a sueltos)',
}

export const MONTHS = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

// YYYY-MM-DD in the business time zone, same rule as the API.
export function todayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

export function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('es-CO', {
    timeZone: BUSINESS_TIME_ZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

type Arrival = Pick<Bundle, 'arrivalDatePrecision' | 'arrivalDate' | 'arrivalYear' | 'arrivalMonth'>

export function formatArrival(bundle: Arrival): string {
  switch (bundle.arrivalDatePrecision) {
    case 'EXACT': {
      const [year, month, day] = (bundle.arrivalDate ?? '').slice(0, 10).split('-')
      return `${day}/${month}/${year}`
    }
    case 'MONTH':
      return `${MONTHS[(bundle.arrivalMonth ?? 1) - 1]} de ${bundle.arrivalYear}`
    default:
      return 'Desconocida'
  }
}

export function referenceLabel(reference: { code: string; description: string | null }): string {
  return reference.description ? `${reference.code} — ${reference.description}` : reference.code
}

export function finishLabel(finish: { code: string; description: string | null }): string {
  return finish.description ? `${finish.code} — ${finish.description}` : finish.code
}

export function bundlePlace(bundle: Pick<Bundle, 'inventoryLocation' | 'rack'>): string {
  const parts = [bundle.inventoryLocation.branch.name, bundle.inventoryLocation.name]
  if (bundle.rack) parts.push(`Pasillo ${bundle.rack.aisle.number}`, `Burro ${bundle.rack.number}`)
  return parts.join(' · ')
}

function place(location?: MovementPlace | null, rack?: MovementPlace | null): string {
  if (!location) return ''
  const parts = [location.name ?? location.code ?? '']
  if (rack?.aisle) parts.push(`P${rack.aisle.number}/B${rack.number}`)
  return parts.join(' ')
}

export function movementPlaces(movement: Movement): string {
  const from = place(movement.sourceLocation, movement.sourceRack)
  const to = place(movement.destinationLocation, movement.destinationRack)
  if (from && to) return `${from} → ${to}`
  return from || to || '—'
}
