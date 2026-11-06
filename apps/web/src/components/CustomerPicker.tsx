import { useEffect, useState } from 'react'
import type { Customer } from '../lib/commerce'
import { useLoad } from '../lib/useLoad'

// Customer of a quote: type part of the name or NIT and pick one of the
// results shown below (click, or Enter for the first). The API ignores case,
// accents and the dots/dashes of the NIT.
export function CustomerPicker({
  selected,
  disabled,
  onSelect,
}: {
  selected: Pick<Customer, 'id' | 'name' | 'taxId'> | null
  disabled: boolean
  onSelect: (customer: Customer | null) => void
}) {
  const [text, setText] = useState('')
  const [term, setTerm] = useState('')
  // «Cambiar» opens the search for the customer chosen at that moment; a
  // customer chosen from outside (e.g. just created) is shown as chosen.
  const [changing, setChanging] = useState<string | null>(null)
  const editing = !selected || changing === selected.id
  // Waits for a short pause in typing instead of asking on every key.
  useEffect(() => {
    const timer = window.setTimeout(() => setTerm(text.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [text])
  const results = useLoad<Customer[]>(editing && !disabled ? `/customers${term ? `?search=${encodeURIComponent(term)}` : ''}` : null)
  const shown = (results.data ?? []).slice(0, 8)
  const pending = text.trim() !== term || results.loading

  if (selected && !editing) {
    return (
      <div className="customer-picked">
        <span>
          <strong>{selected.name}</strong>
          {selected.taxId ? <span className="cell-sub"> · NIT {selected.taxId}</span> : null}
        </span>
        {disabled ? null : (
          <button type="button" className="text-button" onClick={() => {
              setText('')
              setChanging(selected.id)
            }}>
            Cambiar
          </button>
        )}
      </div>
    )
  }

  const pick = (customer: Customer) => {
    onSelect(customer)
    setText('')
    setChanging(null)
  }

  return (
    <div className="customer-picker">
      <input
        value={text}
        disabled={disabled}
        autoComplete="off"
        placeholder="Escribe el nombre o el NIT"
        aria-label="Buscar cliente por nombre o NIT"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (!pending && shown[0]) pick(shown[0])
          } else if (e.key === 'Escape' && selected) {
            setText('')
            setChanging(null)
          }
        }}
      />
      {results.error ? <p className="field-error">{results.error}</p> : null}
      {pending && shown.length === 0 ? <p className="field-hint">Buscando…</p> : null}
      {!pending && shown.length === 0 && !results.error ? (
        <p className="field-hint">{term ? `Ningún cliente coincide con «${term}». Puedes crearlo con «+ Cliente nuevo».` : 'Aún no hay clientes.'}</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="customer-results" role="listbox" aria-label="Clientes encontrados">
          {shown.map((customer) => (
            <li key={customer.id}>
              <button type="button" role="option" aria-selected={customer.id === selected?.id} onClick={() => pick(customer)}>
                <strong>{customer.name}</strong>
                {customer.taxId ? <span className="cell-sub"> · NIT {customer.taxId}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {(results.data ?? []).length > shown.length ? <p className="field-hint">Hay más resultados: escribe más del nombre o el NIT.</p> : null}
      {selected ? (
        <button type="button" className="text-button" onClick={() => { setText(''); setChanging(null) }}>
          Mantener {selected.name}
        </button>
      ) : null}
    </div>
  )
}
