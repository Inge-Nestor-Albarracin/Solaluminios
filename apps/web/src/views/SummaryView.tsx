import { Fragment, useState } from 'react'
import type { SummaryPage } from '../api/types'
import { CatalogSelectors } from '../components/CatalogSelectors'
import { IconPin } from '../components/icons'
import { LocationSelectors } from '../components/LocationSelectors'
import { Empty, FilterPanel, Kpi, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { EMPTY_CATALOG, EMPTY_LOCATION, type CatalogValue, type LocationValue } from '../lib/forms'
import { queryString, useLoad } from '../lib/useLoad'
import type { Navigate } from './navigation'

const PAGE_SIZE = 25
const number = new Intl.NumberFormat('es-CO')

// Available profiles per reference + finish, computed by the API from the
// current bundles. Empty bundles are not counted.
export function SummaryView({ navigate }: { navigate: Navigate }) {
  const [catalog, setCatalog] = useState<CatalogValue>(EMPTY_CATALOG)
  const [location, setLocation] = useState<LocationValue>(EMPTY_LOCATION)
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const summary = useLoad<SummaryPage>(
    `/inventory/summary${queryString({
      familyId: catalog.familyId,
      branchId: location.branchId,
      inventoryLocationId: location.inventoryLocationId,
      page,
      pageSize: PAGE_SIZE,
    })}`,
  )

  const activeCount = [catalog.familyId, location.branchId, location.inventoryLocationId].filter(Boolean).length

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const data = summary.data

  return (
    <>
      <PageHeader
        eyebrow="Inventario · Existencias"
        title="Resumen de inventario"
        description="Perfiles disponibles por referencia y acabado, calculados desde los paquetes actuales. Los paquetes agotados no se cuentan."
      />

      <div className="kpis">
        <Kpi
          dark
          label="Perfiles disponibles"
          value={data ? number.format(data.totals.profiles) : '—'}
          hint={activeCount > 0 ? 'Con los filtros aplicados' : 'Todo el inventario'}
        />
        <Kpi label="Paquetes cerrados" value={data ? number.format(data.totals.bundles) : '—'} />
        <Kpi label="Perfiles sueltos" value={data ? number.format(data.totals.looseProfiles) : '—'} hint="De paquetes abiertos (incluidos en el total)" />
        <Kpi label="Referencia + acabado" value={data ? number.format(data.total) : '—'} hint="Combinaciones con stock" />
      </div>

      <FilterPanel
        activeCount={activeCount}
        onClear={() => {
          setCatalog(EMPTY_CATALOG)
          setLocation(EMPTY_LOCATION)
          setPage(1)
        }}
      >
        <CatalogSelectors
          mode="filter"
          showReference={false}
          showFinish={false}
          value={catalog}
          onChange={(value) => {
            setCatalog(value)
            setPage(1)
          }}
        />
        <LocationSelectors
          mode="filter"
          depth="location"
          value={location}
          onChange={(value) => {
            setLocation(value)
            setPage(1)
          }}
        />
      </FilterPanel>

      {summary.error ? <Notice kind="error">{summary.error}</Notice> : null}
      {summary.loading && !data ? <Loading label="Calculando existencias…" /> : null}

      {data && data.items.length === 0 ? (
        <Empty title="Sin existencias">
          {activeCount > 0 ? 'No hay perfiles disponibles con estos filtros.' : 'Todavía no hay paquetes con perfiles disponibles.'}
        </Empty>
      ) : null}

      {data && data.items.length > 0 ? (
        <>
          <div className="table-wrap stack" aria-busy={summary.loading}>
            <table>
              <thead>
                <tr>
                  <th>Referencia</th>
                  <th>Familia</th>
                  <th>Acabado</th>
                  <th className="num">Perfiles</th>
                  <th className="num">Paquetes</th>
                  <th>
                    <span className="sr-only">Acciones</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((group) => {
                  const key = `${group.reference.id}|${group.finish.id}`
                  const expanded = open.has(key)
                  return (
                    <Fragment key={key}>
                      <tr>
                        <td className="card-title" data-label="Referencia">
                          <span className="cell-main">{group.reference.code}</span>
                          {group.reference.description ? <span className="cell-sub">{group.reference.description}</span> : null}
                        </td>
                        <td data-label="Familia">{group.reference.family ? group.reference.family.name : '—'}</td>
                        <td data-label="Acabado">
                          <span className="cell-main">{group.finish.code}</span>
                          {group.finish.description ? <span className="cell-sub">{group.finish.description}</span> : null}
                        </td>
                        <td className="num" data-label="Perfiles">
                          <strong>{number.format(group.profiles)}</strong>
                        </td>
                        <td className="num" data-label="Paquetes">
                          {group.bundles}
                          {group.looseProfiles > 0 ? <span className="cell-sub">+ {number.format(group.looseProfiles)} sueltos</span> : null}
                        </td>
                        <td className="no-label" data-label="Acciones">
                          <div className="actions">
                            <button type="button" className="text-button" aria-expanded={expanded} onClick={() => toggle(key)}>
                              {expanded ? 'Ocultar ubicaciones' : `Ubicaciones (${group.locations.length})`}
                            </button>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                navigate({
                                  name: 'bundles',
                                  catalog: { referenceId: group.reference.id, finishId: group.finish.id },
                                })
                              }
                            >
                              Ver paquetes
                            </button>
                          </div>
                        </td>
                      </tr>
                      {expanded
                        ? group.locations.map((row) => (
                            <tr key={`${key}|${row.inventoryLocation.id}|${row.rack?.id ?? ''}`} className="subrow">
                              <td colSpan={3} className="no-label" data-label="Ubicación">
                                <span className="location-line">
                                  <IconPin />
                                  <span>
                                    <span className="cell-main">
                                      {row.inventoryLocation.name}
                                      {row.aisle ? ` · Pasillo ${row.aisle.number}` : ''}
                                      {row.rack ? ` · Burro ${row.rack.number}` : ' · Sin burro'}
                                    </span>
                                    <span className="cell-sub">{row.inventoryLocation.branch.name}</span>
                                  </span>
                                </span>
                              </td>
                              <td className="num" data-label="Perfiles">{number.format(row.profiles)}</td>
                              <td className="num" data-label="Paquetes">
                                {row.bundles}
                                {row.looseProfiles > 0 ? <span className="cell-sub">+ {number.format(row.looseProfiles)} sueltos</span> : null}
                              </td>
                              <td className="no-label" aria-hidden="true" />
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            totalPages={data.totalPages}
            total={data.total}
            onChange={setPage}
            disabled={summary.loading}
          />
        </>
      ) : null}
    </>
  )
}
