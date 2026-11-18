import { useState } from 'react'
import type { Page } from '../api/types'
import { Empty, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { ORDER_STATUS_LABEL, formatMoney, paymentLabel, type OrderStatus, type PaymentMethod } from '../lib/commerce'
import { formatDateTime } from '../lib/format'
import { useLoad } from '../lib/useLoad'
import type { Navigate } from './navigation'

interface BillingRow {
  id: string
  number: string
  customerName: string
  status: OrderStatus
  total: string
  paymentMethod: PaymentMethod | null
  paymentTerms: string | null
  billingRequestedAt: string | null
  invoiceNumber: string | null
  billedAt: string | null
  billedBy?: { id: string; name: string } | null
  createdBy?: { id: string; name: string }
}

const TABS = { PENDING: 'Por facturar', BILLED: 'Facturadas' } as const
type Tab = keyof typeof TABS

// Billing: the sales orders that need an electronic invoice. The invoice is
// made in another software; here the PDF is downloaded and its number is
// recorded (from the order).
export function BillingView({ navigate }: { navigate: Navigate }) {
  const [tab, setTab] = useState<Tab>('PENDING')
  const [page, setPage] = useState(1)
  const orders = useLoad<Page<BillingRow>>(`/sales-orders?billing=${tab}&page=${page}&pageSize=20`)

  return (
    <>
      <PageHeader
        eyebrow="Facturación"
        title="Órdenes para facturar"
        description="Descarga el PDF de cada orden, genera la factura en el software de facturación y registra aquí su número."
      />
      <div className="tabs" role="tablist">
        {(Object.keys(TABS) as Tab[]).map((id) => (
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
            {TABS[id]}
          </button>
        ))}
      </div>
      {orders.error ? <Notice kind="error">{orders.error}</Notice> : null}
      {orders.loading && !orders.data ? <Loading /> : null}
      {orders.data ? (
        orders.data.items.length === 0 ? (
          <Empty title={tab === 'PENDING' ? 'Nada por facturar' : 'Sin órdenes facturadas'}>
            {tab === 'PENDING' ? 'Cuando ventas marque una orden con «Requiere facturación», aparece aquí y te llega como tarea.' : 'Las órdenes aparecen aquí al registrar su número de factura.'}
          </Empty>
        ) : (
          <>
            <ul className="doc-list">
              {orders.data.items.map((order) => (
                <li key={order.id}>
                  <button type="button" className="doc-row" onClick={() => navigate({ name: 'order', id: order.id })}>
                    <span className="doc-main">
                      <strong>{order.number}</strong>
                      <small>
                        {order.customerName} · {paymentLabel(order)}
                        {order.createdBy ? <> · vendedor {order.createdBy.name}</> : null}
                        {tab === 'PENDING' && order.billingRequestedAt ? <> · enviada {formatDateTime(order.billingRequestedAt)}</> : null}
                        {tab === 'BILLED' && order.billedAt ? (
                          <> · facturada {formatDateTime(order.billedAt)}{order.billedBy ? ` por ${order.billedBy.name}` : ''}</>
                        ) : null}
                      </small>
                    </span>
                    <span className="doc-side">
                      <strong>{formatMoney(order.total)}</strong>
                      {order.invoiceNumber ? <span className="badge badge-paid">Factura {order.invoiceNumber}</span> : <span className="badge badge-warning">Por facturar</span>}
                      {order.status === 'CANCELLED' ? <span className="badge status-cancelled">{ORDER_STATUS_LABEL[order.status]}</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <Pagination page={orders.data.page} totalPages={orders.data.totalPages} total={orders.data.total} onChange={setPage} disabled={orders.loading} />
          </>
        )
      ) : null}
    </>
  )
}
