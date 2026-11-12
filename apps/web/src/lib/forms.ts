import type { ArrivalDatePrecision } from '../api/types'

export interface CatalogValue {
  familyId: string
  referenceId: string
  finishId: string
}

export const EMPTY_CATALOG: CatalogValue = { familyId: '', referenceId: '', finishId: '' }

export interface LocationValue {
  branchId: string
  inventoryLocationId: string
  aisleId: string
  rackId: string
  // Type of the chosen location ('' until one is chosen). Retail stores
  // (almacenes) have no aisle or rack: what is placed there is loose.
  locationType?: '' | 'WAREHOUSE' | 'RETAIL_STORE'
}

export const EMPTY_LOCATION: LocationValue = {
  branchId: '',
  inventoryLocationId: '',
  aisleId: '',
  rackId: '',
  locationType: '',
}

export const isStore = (value: LocationValue) => value.locationType === 'RETAIL_STORE'

// Complete destination: a store alone, or a warehouse with its rack.
export const placeReady = (value: LocationValue) =>
  !!value.inventoryLocationId && (isStore(value) || !!value.rackId)

// What the API receives: the rack only for warehouses.
export const placePayload = (value: LocationValue) => ({
  inventoryLocationId: value.inventoryLocationId,
  ...(!isStore(value) && value.rackId ? { rackId: value.rackId } : {}),
})

export interface ArrivalValue {
  precision: ArrivalDatePrecision
  date: string
  year: string
  month: string
}

export const EMPTY_ARRIVAL: ArrivalValue = { precision: 'UNKNOWN', date: '', year: '', month: '' }

// Only the fields of the chosen precision are sent; no day is invented.
export function arrivalPayload(value: ArrivalValue) {
  switch (value.precision) {
    case 'EXACT':
      return { arrivalDatePrecision: 'EXACT' as const, arrivalDate: value.date }
    case 'MONTH':
      return {
        arrivalDatePrecision: 'MONTH' as const,
        arrivalYear: Number(value.year),
        arrivalMonth: Number(value.month),
      }
    default:
      return { arrivalDatePrecision: 'UNKNOWN' as const }
  }
}
