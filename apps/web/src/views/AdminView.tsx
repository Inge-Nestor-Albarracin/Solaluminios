import { useState } from 'react'
import { FamiliesAdmin } from '../components/admin/FamiliesAdmin'
import { LotsAdmin } from '../components/admin/LotsAdmin'
import { PurchasesAdmin } from '../components/admin/PurchasesAdmin'
import { ReadersAdmin } from '../components/admin/ReadersAdmin'
import { ReferencesAdmin } from '../components/admin/ReferencesAdmin'
import { SuppliersAdmin } from '../components/admin/SuppliersAdmin'
import { UsersAdmin } from '../components/admin/UsersAdmin'
import { PageHeader } from '../components/ui'

type Section = 'families' | 'references' | 'suppliers' | 'lots' | 'purchases' | 'readers' | 'users'

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'families', label: 'Familias' },
  { id: 'references', label: 'Referencias' },
  { id: 'suppliers', label: 'Proveedores' },
  { id: 'lots', label: 'Lotes y procedencia' },
  { id: 'purchases', label: 'Compras y costos' },
  { id: 'readers', label: 'Lectores fijos' },
  { id: 'users', label: 'Usuarios' },
]

// ADMIN only (the menu hides it for other roles and the API enforces it).
export function AdminView() {
  const [section, setSection] = useState<Section>('families')

  return (
    <>
      <PageHeader
        eyebrow="Administración"
        title="Catálogo, abastecimiento y usuarios"
        description="Catálogo, proveedores reales y el proveedor fijo de China, procedencia y costos, lectores fijos y quién accede a la aplicación."
      />
      <div className="tabs admin-tabs" role="tablist">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={section === item.id}
            className={section === item.id ? 'tab active' : 'tab'}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {section === 'families' ? <FamiliesAdmin /> : null}
      {section === 'references' ? <ReferencesAdmin /> : null}
      {section === 'suppliers' ? <SuppliersAdmin /> : null}
      {section === 'lots' ? <LotsAdmin /> : null}
      {section === 'purchases' ? <PurchasesAdmin /> : null}
      {section === 'readers' ? <ReadersAdmin /> : null}
      {section === 'users' ? <UsersAdmin /> : null}
    </>
  )
}
