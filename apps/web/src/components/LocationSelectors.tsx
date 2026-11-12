import { useEffect } from 'react'
import type { Aisle, Branch, InventoryLocation, Rack } from '../api/types'
import { EMPTY_LOCATION, isStore, type LocationValue } from '../lib/forms'
import { useLoad } from '../lib/useLoad'
import { Field } from './ui'

type Level = 'branch' | 'location' | 'aisle' | 'rack'
const LEVELS: Level[] = ['branch', 'location', 'aisle', 'rack']

// Dependent selectors Branch → Location → Aisle → Rack. Changing an upper
// level always clears the lower ones. The API lists only active records.
// Retail stores (almacenes) have no aisle or rack: choosing one hides them.
export function LocationSelectors({
  value,
  onChange,
  mode,
  depth = 'rack',
  disabled,
  labels,
  onDescribe,
}: {
  value: LocationValue
  onChange: (value: LocationValue) => void
  mode: 'form' | 'filter'
  depth?: Level
  disabled?: boolean
  labels?: Partial<Record<Level, string>>
  // Receives a readable description of the selection, e.g. for confirmations.
  onDescribe?: (description: string) => void
}) {
  const store = isStore(value)
  const show = (level: Level) =>
    LEVELS.indexOf(level) <= LEVELS.indexOf(depth) && !(store && (level === 'aisle' || level === 'rack'))
  const enc = encodeURIComponent

  const branches = useLoad<Branch[]>('/locations/branches')
  const locations = useLoad<InventoryLocation[]>(
    show('location') && value.branchId
      ? `/locations/branches/${enc(value.branchId)}/inventory-locations`
      : null,
  )
  const aisles = useLoad<Aisle[]>(
    show('aisle') && value.inventoryLocationId
      ? `/locations/inventory-locations/${enc(value.inventoryLocationId)}/aisles`
      : null,
  )
  const racks = useLoad<Rack[]>(
    show('rack') && value.aisleId ? `/locations/aisles/${enc(value.aisleId)}/racks` : null,
  )

  const branch = branches.data?.find((b) => b.id === value.branchId)
  const location = locations.data?.find((l) => l.id === value.inventoryLocationId)
  const aisle = aisles.data?.find((a) => a.id === value.aisleId)
  const rack = racks.data?.find((r) => r.id === value.rackId)
  const description = [
    branch?.name,
    location ? `${location.name}${location.type === 'RETAIL_STORE' ? ' (almacén)' : ''}` : undefined,
    aisle ? `Pasillo ${aisle.number}` : undefined,
    rack ? `Burro ${rack.number}` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  useEffect(() => {
    onDescribe?.(description)
  }, [description, onDescribe])

  const required = mode === 'form'
  const all = mode === 'filter' ? 'Todas' : null
  const placeholder = (parentChosen: boolean, loading: boolean, empty: boolean, text: string) => {
    if (!parentChosen) return all ?? 'Elige el nivel anterior'
    if (loading) return 'Cargando…'
    if (empty) return 'Sin opciones activas'
    return all ?? text
  }

  return (
    <>
      <Field label={labels?.branch ?? 'Sucursal'}>
        <select
          value={value.branchId}
          required={required}
          disabled={disabled || branches.loading}
          onChange={(e) => onChange({ ...EMPTY_LOCATION, branchId: e.target.value })}
        >
          <option value="">
            {branches.loading ? 'Cargando…' : all ?? 'Selecciona una sucursal'}
          </option>
          {(branches.data ?? []).map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name} ({branch.code})
            </option>
          ))}
        </select>
        {branches.error ? <span className="field-error">{branches.error}</span> : null}
      </Field>

      {show('location') ? (
        <Field label={labels?.location ?? 'Bodega / almacén'}>
          <select
            value={value.inventoryLocationId}
            required={required}
            disabled={disabled || !value.branchId || locations.loading}
            onChange={(e) =>
              onChange({
                ...EMPTY_LOCATION,
                branchId: value.branchId,
                inventoryLocationId: e.target.value,
                locationType: locations.data?.find((l) => l.id === e.target.value)?.type ?? '',
              })
            }
          >
            <option value="">
              {placeholder(!!value.branchId, locations.loading, locations.data?.length === 0, 'Selecciona una bodega o almacén')}
            </option>
            {(locations.data ?? []).map((location) => (
              <option key={location.id} value={location.id}>
                {location.name} ({location.code}){location.type === 'RETAIL_STORE' ? ' · almacén' : ''}
              </option>
            ))}
          </select>
          {locations.error ? <span className="field-error">{locations.error}</span> : null}
          {store && mode === 'form' && LEVELS.indexOf(depth) >= LEVELS.indexOf('aisle') ? (
            <span className="field-hint">Almacén: sin pasillo ni burro. Los paquetes quedan abiertos y sus perfiles, sueltos.</span>
          ) : null}
        </Field>
      ) : null}

      {show('aisle') ? (
        <Field label={labels?.aisle ?? 'Pasillo'}>
          <select
            value={value.aisleId}
            required={required}
            disabled={disabled || !value.inventoryLocationId || aisles.loading}
            onChange={(e) => onChange({ ...value, aisleId: e.target.value, rackId: '' })}
          >
            <option value="">
              {placeholder(!!value.inventoryLocationId, aisles.loading, aisles.data?.length === 0, 'Selecciona un pasillo')}
            </option>
            {(aisles.data ?? []).map((aisle) => (
              <option key={aisle.id} value={aisle.id}>
                Pasillo {aisle.number}
                {aisle.floorNumber !== null ? ` · piso ${aisle.floorNumber}` : ''}
              </option>
            ))}
          </select>
          {aisles.error ? <span className="field-error">{aisles.error}</span> : null}
        </Field>
      ) : null}

      {show('rack') ? (
        <Field label={labels?.rack ?? 'Burro'}>
          <select
            value={value.rackId}
            required={required}
            disabled={disabled || !value.aisleId || racks.loading}
            onChange={(e) => onChange({ ...value, rackId: e.target.value })}
          >
            <option value="">
              {placeholder(!!value.aisleId, racks.loading, racks.data?.length === 0, 'Selecciona un burro')}
            </option>
            {(racks.data ?? []).map((rack) => (
              <option key={rack.id} value={rack.id}>
                Burro {rack.number}
              </option>
            ))}
          </select>
          {racks.error ? <span className="field-error">{racks.error}</span> : null}
        </Field>
      ) : null}
    </>
  )
}
