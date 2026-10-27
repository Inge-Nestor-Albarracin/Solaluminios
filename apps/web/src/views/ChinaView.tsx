import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, describeError } from '../api/client'
import type { Page } from '../api/types'
import { Field, Notice, PageHeader } from '../components/ui'
import { useLoad } from '../lib/useLoad'
import { uuid } from '../lib/uuid'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'

// China operator (English UI). One bundle at a time: read the EPC, choose
// Reference and Finish / Color, type the quantity of profiles, save, next.
// Supplier, origin and shipment are assigned by the server from the
// configuration; nothing here becomes stock in Colombia until it is received.

interface ChinaContext {
  supplier: { code: string; name: string } | null
  problem: string | null
}

interface CatalogItem {
  id: string
  code: string
  description: string | null
}

interface PreRegistration {
  id: string
  epc: string
  reference: CatalogItem
  finish: CatalogItem
  quantity: number
  status: 'PENDING' | 'RECEIVED' | 'CANCELLED'
  createdAt: string
}

const EPC = /^[A-Z0-9]{1,128}$/
const label = (item: CatalogItem) => (item.description ? `${item.code} — ${item.description}` : item.code)

export function ChinaView() {
  const { request } = useSession()
  const context = useLoad<ChinaContext>('/china/context')
  const catalog = useLoad<{ references: CatalogItem[]; finishes: CatalogItem[] }>('/china/catalog')
  const recent = useLoad<Page<PreRegistration>>('/china/pre-registrations?pageSize=10')
  const [epc, setEpc] = useState('')
  const [referenceId, setReferenceId] = useState('')
  const [finishId, setFinishId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null)
  const epcInput = useRef<HTMLInputElement>(null)
  // Retry key of the bundle being saved: kept while the outcome is unknown.
  const key = useRef<string | null>(null)
  const lock = useRef(false)

  useUnsavedWork(epc.trim() || quantity ? 'Pre-registration form with unsaved data' : null)

  useEffect(() => {
    epcInput.current?.focus()
  }, [])

  const normalized = epc.trim().toUpperCase()
  const amount = Number(quantity)
  const supplier = context.data?.supplier ?? null
  const valid = EPC.test(normalized) && !!referenceId && !!finishId && Number.isInteger(amount) && amount >= 1 && !!supplier

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!valid || lock.current) return
    lock.current = true
    setSaving(true)
    setMessage(null)
    key.current ??= uuid()
    try {
      const { data } = await request<{ replayed: boolean; preRegistration: PreRegistration }>('/china/pre-registrations', {
        method: 'POST',
        body: { epc: normalized, referenceId, finishId, quantity: amount, operationKey: key.current },
      })
      key.current = null
      setMessage({ kind: 'success', text: `Saved: ${data.preRegistration.epc} · ${amount} profiles${data.replayed ? ' (already saved before)' : ''}. Read the next bundle.` })
      // Reference and finish stay for the next bundle of the same kind.
      setEpc('')
      setQuantity('')
      recent.reload()
      requestAnimationFrame(() => epcInput.current?.focus())
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0
      const retryable = err instanceof ApiError && (err.data as { retryable?: boolean } | null)?.retryable === true
      if (status === 0 || (status >= 500 && !retryable)) {
        setMessage({ kind: 'warning', text: 'No answer from the server: this bundle may have been saved. Press Save again without changing anything; it will not be duplicated.' })
      } else {
        if (!retryable) key.current = null
        setMessage({ kind: 'error', text: `${describeError(err)} ${retryable ? 'Retry in a few seconds.' : 'Nothing was saved.'}` })
        if (status === 409) context.reload()
      }
    } finally {
      lock.current = false
      setSaving(false)
    }
  }

  return (
    <div className="china">
      <PageHeader
        eyebrow="Solaluminios · Supplier"
        title="Pre-register bundles"
        description="Read the RFID tag, choose the reference and the finish, type the number of profiles and save. Supplier and origin are set automatically."
      />

      {context.data ? (
        <div className="china-context card">
          <span>
            <small>Supplier</small>
            <strong>{supplier?.name ?? '—'}</strong>
          </span>
          <span>
            <small>Origin</small>
            <strong>China</strong>
          </span>
        </div>
      ) : null}
      {context.data?.problem ? <Notice kind="warning">{context.data.problem}</Notice> : null}
      {context.error ? <Notice kind="error">{context.error}</Notice> : null}

      <form className="card china-form" onSubmit={(e) => void save(e)}>
        <Field label="1. RFID tag (EPC)" hint="Point the reader at the tag: the code is typed here. You can also type it.">
          <input
            ref={epcInput}
            className="mono"
            value={epc}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            placeholder="E280…"
            onChange={(e) => setEpc(e.target.value)}
          />
        </Field>
        {epc && !EPC.test(normalized) ? <span className="field-error">Letters and digits only.</span> : null}
        <Field label="2. Reference">
          <select value={referenceId} onChange={(e) => setReferenceId(e.target.value)}>
            <option value="">Choose…</option>
            {(catalog.data?.references ?? []).map((item) => (
              <option key={item.id} value={item.id}>{label(item)}</option>
            ))}
          </select>
        </Field>
        <Field label="3. Finish / Color">
          <select value={finishId} onChange={(e) => setFinishId(e.target.value)}>
            <option value="">Choose…</option>
            {(catalog.data?.finishes ?? []).map((item) => (
              <option key={item.id} value={item.id}>{label(item)}</option>
            ))}
          </select>
        </Field>
        <Field label="4. Quantity — profiles">
          <input inputMode="numeric" type="number" min={1} step={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
        </Field>
        {catalog.error ? <Notice kind="error">{catalog.error}</Notice> : null}
        {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}
        <button type="submit" className="button china-save" disabled={!valid || saving}>
          {saving ? 'Saving…' : '5. Save and next'}
        </button>
      </form>

      <section className="card" aria-label="Recent">
        <h2 className="subtitle">Your latest bundles</h2>
        {recent.data && recent.data.items.length === 0 ? <p className="field-hint">Nothing registered yet.</p> : null}
        <ul className="china-recent">
          {(recent.data?.items ?? []).map((item) => (
            <li key={item.id}>
              <span className="mono">{item.epc}</span>
              <span>{item.reference.code} · {item.finish.description ?? item.finish.code}</span>
              <span>{item.quantity} profiles</span>
              <span className="badge badge-muted">{item.status === 'RECEIVED' ? 'Received in Colombia' : 'Waiting for reception'}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
