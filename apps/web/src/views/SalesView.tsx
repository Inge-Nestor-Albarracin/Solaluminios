import { useState } from 'react'
import type { Page } from '../api/types'
import { Empty, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { ORDER_STATUS_LABEL, formatMoney, type OrderStatus } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import type { Navigate } from './navigation'

interface QuoteRow {
  id: string
  number: string
  customerName: string
  status: 'DRAFT' | 'CONVERTED' | 'CANCELLED'
  total: string
  createdAt: string
  order: { id: string; number: string } | null
  createdBy: { name: string }
  _count: { lines: number }
}

interface OrderRow {
  id: string
  number: string
  customerName: string
  status: OrderStatus
  total: string
  createdAt: string
  createdBy: { name: string }
  _count: { lines: number; dispatches: number }
}

const QUOTE_STATUS = { DRAFT: 'Borrador', CONVERTED: 'Convertida en orden', CANCELLED: 'Cancelada' } as const

// Sales: quotes (no stock effect) and orders (reservations and dispatches).
// SALES sees only its own documents; ADMIN all (enforced by the API).
export function SalesView({ navigate, initialTab = 'quotes' }: { navigate: Navigate; initialTab?: 'quotes' | 'orders' }) {
  const [tab, setTab] = useState<'quotes' | 'orders'>(initialTab)
  const [page, setPage] = useState(1)
  const quotes = useLoad<Page<QuoteRow>>(tab === 'quotes' ? `/quotes?page=${page}&pageSize=20` : null)
  const orders = useLoad<Page<OrderRow>>(tab === 'orders' ? `/sales-orders?page=${page}&pageSize=20` : null)
  const current = tab === 'quotes' ? quotes : orders

  return (
    <>
      <PageHeader
        eyebrow="Ventas"
        title="Cotizaciones y órdenes"
        description="Una cotización no reserva inventario. Al confirmar una orden se reserva el material; las entregas se hacen con despachos."
        actions={
          <button type="button" className="button" onClick={() => navigate({ name: 'quote' })}>
            Nueva cotización
          </button>
        }
      />
      <div className="tabs" role="tablist">
        {(['quotes', 'orders'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'tab active' : 'tab'}
            onClick={() => {
              setTab(id)
              setPage(1)
            }}
          >
            {id === 'quotes' ? 'Cotizaciones' : 'Órdenes de venta'}
          </button>
        ))}
      </div>
      {current.error ? <Notice kind="error">{current.error}</Notice> : null}
      {current.loading && !current.data ? <Loading /> : null}
      {tab === 'quotes' && quotes.data ? (
        quotes.data.items.length === 0 ? (
          <Empty title="Sin cotizaciones">Crea la primera con «Nueva cotización».</Empty>
        ) : (
          <ul className="doc-list">
            {quotes.data.items.map((quote) => (
              <li key={quote.id}>
                <button type="button" className="doc-row" onClick={() => navigate({ name: 'quote', id: quote.id })}>
                  <span className="doc-main">
                    <strong>{quote.number}</strong>
                    <small>{quote.customerName} · {quote._count.lines} renglones · {formatDateTime(quote.createdAt)}</small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(quote.total)}</strong>
                    <span className={`badge ${quote.status === 'DRAFT' ? '' : 'badge-muted'}`}>{quote.order ? `Orden ${quote.order.number}` : QUOTE_STATUS[quote.status]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {tab === 'orders' && orders.data ? (
        orders.data.items.length === 0 ? (
          <Empty title="Sin órdenes">Las órdenes se crean al convertir una cotización.</Empty>
        ) : (
          <ul className="doc-list">
            {orders.data.items.map((order) => (
              <li key={order.id}>
                <button type="button" className="doc-row" onClick={() => navigate({ name: 'order', id: order.id })}>
                  <span className="doc-main">
                    <strong>{order.number}</strong>
                    <small>{order.customerName} · {order._count.dispatches} despachos · {formatDateTime(order.createdAt)}</small>
                  </span>
                  <span className="doc-side">
                    <strong>{formatMoney(order.total)}</strong>
                    <span className={`badge status-${order.status.toLowerCase()}`}>{ORDER_STATUS_LABEL[order.status]}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {current.data && current.data.totalPages > 1 ? (
        <Pagination page={current.data.page} totalPages={current.data.totalPages} total={current.data.total} onChange={setPage} />
      ) : null}
    </>
  )
}
