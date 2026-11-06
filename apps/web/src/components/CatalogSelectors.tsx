import { useEffect, useState } from 'react'
import type { Family, Finish, Reference } from '../api/types'
import { finishLabel, referenceLabel } from '../lib/format'
import type { CatalogValue } from '../lib/forms'
import { useLoad } from '../lib/useLoad'
import { Field } from './ui'

export interface CatalogLabels {
  family: string
  reference: string
  finish: string
}

// Family only filters the reference list. Changing it clears the reference.
// In "filter" mode every level accepts "Todas"; in "form" mode only active
// records are offered for new registrations. With `requireFamily` (bundle
// registration) the reference stays locked until a family is chosen, and
// then lists only that family's references.

// Natural order: «744 …» before «3831 …», «386» before «3809».
const natural = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true })
// Lower case without accents, to search families («kim» finds «KIMBAYA»).
const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
export function CatalogSelectors({
  value,
  onChange,
  mode,
  showReference = true,
  showFinish = true,
  requireFamily = false,
  disabled,
  onDescribe,
}: {
  value: CatalogValue
  onChange: (value: CatalogValue) => void
  mode: 'form' | 'filter'
  showReference?: boolean
  showFinish?: boolean
  requireFamily?: boolean
  disabled?: boolean
  // Receives readable labels of the current selection.
  onDescribe?: (labels: CatalogLabels) => void
}) {
  const families = useLoad<Family[]>('/catalog/families')
  const familyMissing = requireFamily && !value.familyId
  const references = useLoad<Reference[]>(
    showReference && !familyMissing
      ? `/catalog/references${value.familyId ? `?familyId=${encodeURIComponent(value.familyId)}` : ''}`
      : null,
  )
  const finishes = useLoad<Finish[]>(showFinish ? '/catalog/finishes' : null)

  const onlyActive = <T extends { active: boolean }>(list: T[] | null) =>
    (list ?? []).filter((item) => mode === 'filter' || item.active)

  const referenceOptions = requireFamily
    ? onlyActive(references.data).sort((a, b) => natural(a.code, b.code))
    : onlyActive(references.data)
  const finishOptions = onlyActive(finishes.data)
  const familyOptions = requireFamily
    ? onlyActive(families.data).sort((a, b) => natural(a.name, b.name))
    : onlyActive(families.data)

  // requireFamily: a text box narrows the family list (name or code); empty,
  // every family. The chosen family stays listed while it does not match.
  const [familySearch, setFamilySearch] = useState('')
  const familyTerm = fold(familySearch.trim())
  const familyMatches = familyTerm ? familyOptions.filter((f) => fold(`${f.name} ${f.code}`).includes(familyTerm)) : familyOptions
  const shownFamilies =
    familyTerm && value.familyId && !familyMatches.some((f) => f.id === value.familyId)
      ? [...familyOptions.filter((f) => f.id === value.familyId), ...familyMatches]
      : familyMatches

  const family = families.data?.find((f) => f.id === value.familyId)
  const reference = references.data?.find((r) => r.id === value.referenceId)
  const finish = finishes.data?.find((f) => f.id === value.finishId)
  const familyText = family ? `${family.code} — ${family.name}` : ''
  const referenceText = reference ? referenceLabel(reference) : ''
  const finishText = finish ? finishLabel(finish) : ''
  useEffect(() => {
    onDescribe?.({ family: familyText, reference: referenceText, finish: finishText })
  }, [familyText, referenceText, finishText, onDescribe])

  const familySelect = (
    <select
      value={value.familyId}
      required={requireFamily}
      aria-label={requireFamily ? 'Familia' : undefined}
      disabled={disabled || families.loading}
      onChange={(e) => onChange({ ...value, familyId: e.target.value, referenceId: '' })}
    >
      <option value="">
        {requireFamily
          ? familyTerm
            ? familyMatches.length === 0
              ? `Ninguna familia coincide con «${familySearch.trim()}»`
              : `Selecciona una familia (${familyMatches.length} ${familyMatches.length === 1 ? 'coincide' : 'coinciden'})`
            : 'Selecciona una familia'
          : mode === 'form'
            ? 'Todas las familias'
            : 'Todas'}
      </option>
      {shownFamilies.map((family) => (
        <option key={family.id} value={family.id}>
          {requireFamily
            ? `${family.name}${family.activeReferences !== undefined ? ` (${family.activeReferences})` : ''}`
            : `${family.code} — ${family.name}`}
          {family.active ? '' : ' (inactiva)'}
        </option>
      ))}
    </select>
  )

  return (
    <>
      {requireFamily ? (
        <div className="field">
          <span className="field-label">
            Familia <span className="required-mark">*</span>
          </span>
          <label className="field-sublabel">
            <span>Buscar por nombre o código</span>
            <input
              value={familySearch}
              disabled={disabled}
              autoComplete="off"
              placeholder="Ej. Kim, 744 o puerta"
              onChange={(e) => setFamilySearch(e.target.value)}
            />
          </label>
          {familySelect}
          <span className="field-hint">Elige primero la familia: la referencia muestra solo las de esa familia.</span>
          {families.error ? <span className="field-error">{families.error}</span> : null}
        </div>
      ) : (
      <Field
        label="Familia"
        hint={mode === 'form' ? 'Opcional: filtra la lista de referencias.' : undefined}
      >
        {familySelect}
        {families.error ? <span className="field-error">{families.error}</span> : null}
      </Field>
      )}

      {showReference ? (
        <Field label="Referencia">
          <select
            value={value.referenceId}
            required={mode === 'form'}
            disabled={disabled || familyMissing || references.loading}
            onChange={(e) => onChange({ ...value, referenceId: e.target.value })}
          >
            <option value="">
              {familyMissing
                ? 'Elige primero la familia'
                : references.loading
                ? 'Cargando…'
                : mode === 'form'
                  ? referenceOptions.length
                    ? 'Selecciona una referencia'
                    : 'Sin referencias disponibles'
                  : 'Todas'}
            </option>
            {referenceOptions.map((reference) => (
              <option key={reference.id} value={reference.id}>
                {referenceLabel(reference)}
                {reference.active ? '' : ' (inactiva)'}
              </option>
            ))}
          </select>
          {references.error ? <span className="field-error">{references.error}</span> : null}
          {reference?.familyHint ? <span className="field-hint">También aparece en: {reference.familyHint}.</span> : null}
        </Field>
      ) : null}

      {showFinish ? (
        <Field label="Acabado (color)">
          <select
            value={value.finishId}
            required={mode === 'form'}
            disabled={disabled || finishes.loading}
            onChange={(e) => onChange({ ...value, finishId: e.target.value })}
          >
            <option value="">{mode === 'form' ? 'Selecciona un acabado' : 'Todos'}</option>
            {finishOptions.map((finish) => (
              <option key={finish.id} value={finish.id}>
                {finishLabel(finish)}
                {finish.active ? '' : ' (inactivo)'}
              </option>
            ))}
          </select>
          {finishes.error ? <span className="field-error">{finishes.error}</span> : null}
        </Field>
      ) : null}
    </>
  )
}
