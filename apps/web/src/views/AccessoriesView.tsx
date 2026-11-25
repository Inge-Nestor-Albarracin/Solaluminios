import { useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import { IconScan } from '../components/icons'
import { Empty, Field, Kpi, Loading, Notice, PageHeader } from '../components/ui'
import { ORIGIN_LABEL, basketLabel, units, type Basket } from '../lib/accessories'
import { useLoad } from '../lib/useLoad'
import { useSession } from '../session/session-context'
import type { Navigate } from './navigation'

// Baskets of the accessories warehouse: one chip per fixed basket, one basket
// per accessory and colour. Reading a chip here never changes anything.
export function AccessoriesView({ navigate }: { navigate: Navigate }) {
  const { request, user } = useSession()
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notFound, setNotFound] = useState<string | null>(null)
  const list = useLoad<{ items: Basket[]; totals: { baskets: number; units: number } }>(
    `/accessories/baskets${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  )
  const admin = user?.role === 'ADMIN'

  // A chip (letters and digits, long) opens its basket; any other text filters.
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = text.trim()
    setError(null)
    setNotFound(null)
    if (!/^[A-Za-z0-9]{8,}$/.test(value)) {
      setQuery(value)
      return
    }
    setPending(true)
    try {
      const { data } = await request<Basket>(`/accessories/baskets/epc/${encodeURIComponent(value.toUpperCase())}`)
      navigate({ name: 'basket', id: data.id })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(value.toUpperCase())
        setQuery(value)
      } else setError(describeError(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Accesorios"
        title="Canastas"
        description="Cada canasta tiene un chip, un accesorio y un color. Las compras se le suman con un ingreso y lo que sale sin venta se registra con una salida."
        actions={
          <>
            <button type="button" className="button" onClick={() => navigate({ name: 'voucherNew', kind: 'ENTRY' })}>
              Ingreso
            </button>
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'voucherNew', kind: 'EXIT' })}>
              Salida sin venta
            </button>
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'basketNew' })}>
              Registrar canasta
            </button>
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'vouchers' })}>
              Comprobantes
            </button>
          </>
        }
      />

      <form className="card lookup-card" onSubmit={submit}>
        <div className="lookup-form">
          <Field label="Chip o accesorio" hint="Lee el chip de la canasta para abrirla, o escribe un código, una descripción o un color para filtrar.">
            <span className="input-wrap large">
              <IconScan />
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                placeholder="E2003412… o rodachín"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setNotFound(null)
                  if (!e.target.value.trim()) setQuery('')
                }}
              />
            </span>
          </Field>
          <button type="submit" className="button" disabled={pending}>
            {pending ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
      </form>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {notFound ? (
        <Notice kind="info">
          <div className="notfound">
            <span>
              No hay una canasta con el chip <strong className="mono">{notFound}</strong>.
            </span>
            <button type="button" className="button button-secondary" onClick={() => navigate({ name: 'basketNew', epc: notFound })}>
              Registrar canasta con este chip
            </button>
          </div>
        </Notice>
      ) : null}

      {list.data ? (
        <div className="kpis">
          <Kpi label="Canastas" value={list.data.totals.baskets.toLocaleString('es-CO')} />
          <Kpi label="Unidades" value={list.data.totals.units.toLocaleString('es-CO')} dark />
        </div>
      ) : null}
      {list.error ? <Notice kind="error">{list.error}</Notice> : null}
      {list.loading && !list.data ? <Loading /> : null}
      {list.data && list.data.items.length === 0 ? (
        <Empty title={query ? 'Sin resultados' : 'Aún no hay canastas'}>
          {query ? 'Ninguna canasta coincide con la búsqueda.' : 'Registra cada canasta con su chip, su accesorio, su color y lo que tiene hoy.'}
        </Empty>
      ) : null}
      <ul className="doc-list">
        {(list.data?.items ?? []).map((basket) => (
          <li key={basket.id}>
            <button type="button" className="doc-row" onClick={() => navigate({ name: 'basket', id: basket.id })}>
              <span className="doc-main">
                <strong>{basketLabel(basket)}</strong>
                <small>
                  <span className="mono">{basket.epc}</span>
                  {basket.reference.brand ? ` · ${basket.reference.brand}` : ''}
                  {basket.origin ? ` · ${ORIGIN_LABEL[basket.origin]}` : ''}
                  {admin ? ` · ${basket.inventoryLocation.branch.name} · ${basket.inventoryLocation.name}` : ''}
                </small>
              </span>
              <span className="doc-side">
                <strong>{units(basket.quantity)}</strong>
                {basket.reserved > 0 ? <small>{basket.reserved.toLocaleString('es-CO')} reservadas</small> : null}
                {basket.quantity === 0 ? <span className="badge">Vacía</span> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}
