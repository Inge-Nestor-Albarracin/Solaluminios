import { useId, type ReactNode } from 'react'
import { IconChevron } from '../components/icons'
import { DevicePanel } from '../pwa/DevicePanel'
import type { Navigate, View } from './navigation'

type Section = Exclude<View['name'], 'bundle' | 'home' | 'quote' | 'order' | 'dispatch'>

interface Tile {
  name: Section
  title: string
  subtitle: string
  icon: (stroke: string) => ReactNode
}

// Tile icons in the app-design style: thin line drawings in the brand
// aqua → cyan gradient (white on the highlighted tile).
const TILE_ICONS: Record<Section, (stroke: string) => ReactNode> = {
  register: (s) => (
    <g stroke={s}>
      <rect x="14" y="6" width="22" height="38" rx="4" />
      <path d="M21 39h8" />
      <path d="M19 17h12M19 22h7" />
      <path d="M37 13a7 7 0 0 1 0 9M40.5 10a12 12 0 0 1 0 15" />
    </g>
  ),
  lookup: (s) => (
    <g stroke={s}>
      <circle cx="21" cy="21" r="13" />
      <path d="m30.5 30.5 11 11" strokeWidth="2.6" />
      <path d="M15 21a6 6 0 0 1 12 0M18 21a3 3 0 0 1 6 0M21 21v6M12 21a9 9 0 0 1 18 0" />
    </g>
  ),
  bulk: (s) => (
    <g stroke={s}>
      <rect x="6" y="10" width="12" height="28" rx="3" />
      <path d="M10 33h4" />
      <path d="M22 16a10 10 0 0 1 0 16M27 12a16 16 0 0 1 0 24" />
      <path d="M33 14h9M33 20h9M35 26h7M33 32h9" />
    </g>
  ),
  bundles: (s) => (
    <g stroke={s}>
      <path d="m8 16 16-8 16 8-16 8-16-8Z" />
      <path d="m8 24 16 8 16-8M8 32l16 8 16-8" />
    </g>
  ),
  summary: (s) => (
    <g stroke={s}>
      <path d="M7 41h34" />
      <rect x="10" y="24" width="6" height="13" rx="1.5" />
      <rect x="21" y="12" width="6" height="25" rx="1.5" />
      <rect x="32" y="19" width="6" height="18" rx="1.5" />
      <path d="m9 15 9-6 8 4 12-7" />
    </g>
  ),
  tasks: (s) => (
    <g stroke={s}>
      <rect x="9" y="7" width="30" height="36" rx="4" />
      <path d="M18 7V4h12v3M15 18l3 3 5-5M15 30l3 3 5-5M27 19h6M27 31h6" />
    </g>
  ),
  receive: (s) => (
    <g stroke={s}>
      <path d="M6 30h10l3 5h10l3-5h10" />
      <path d="M6 30 11 14h26l5 16v10H6V30Z" />
      <path d="M24 6v14M19 15l5 5 5-5" />
    </g>
  ),
  sales: (s) => (
    <g stroke={s}>
      <rect x="10" y="6" width="28" height="36" rx="4" />
      <path d="M16 15h16M16 21h16M16 27h9" />
      <path d="M29 32h5M31.5 29.5v5" />
    </g>
  ),
  dispatches: (s) => (
    <g stroke={s}>
      <path d="M5 13h22v20H5z" />
      <path d="M27 19h8l6 7v7H27" />
      <circle cx="13" cy="35" r="3.5" />
      <circle cx="34" cy="35" r="3.5" />
    </g>
  ),
  admin: (s) => (
    <g stroke={s}>
      <circle cx="24" cy="24" r="6" />
      <path d="M24 6v5M24 37v5M6 24h5M37 24h5M11.3 11.3l3.5 3.5M33.2 33.2l3.5 3.5M11.3 36.7l3.5-3.5M33.2 14.8l3.5-3.5" />
      <circle cx="24" cy="24" r="13" />
    </g>
  ),
}

export function HomeView({
  name,
  operator,
  admin,
  seller,
  dispatcher,
  pendingQueue,
  openTasks,
  navigate,
}: {
  name: string
  operator: boolean
  admin: boolean
  seller: boolean
  dispatcher: boolean
  pendingQueue: number
  openTasks: number
  navigate: Navigate
}) {
  const gradient = `tile-${useId().replace(/:/g, '')}`
  const tiles: Tile[] = [
    ...(operator
      ? [{ name: 'register' as const, title: 'Registrar', subtitle: pendingQueue > 0 ? `${pendingQueue} sin guardar` : 'Paquete nuevo', icon: TILE_ICONS.register }]
      : []),
    { name: 'lookup', title: 'Consultar', subtitle: 'Leer chip', icon: TILE_ICONS.lookup },
    { name: 'bulk', title: 'Lectura masiva', subtitle: 'Muchos chips a la vez', icon: TILE_ICONS.bulk },
    { name: 'bundles', title: 'Paquetes', subtitle: 'Listado y filtros', icon: TILE_ICONS.bundles },
    { name: 'summary', title: 'Resumen', subtitle: 'Existencias', icon: TILE_ICONS.summary },
    { name: 'tasks', title: 'Tareas', subtitle: openTasks > 0 ? `${openTasks} ${openTasks === 1 ? 'pendiente' : 'pendientes'}` : 'Al día', icon: TILE_ICONS.tasks },
    ...(dispatcher ? [{ name: 'dispatches' as const, title: 'Despachos', subtitle: 'Preparar y confirmar salidas', icon: TILE_ICONS.dispatches }] : []),
    ...(operator ? [{ name: 'receive' as const, title: 'Recepción China', subtitle: 'Paquetes prerregistrados', icon: TILE_ICONS.receive }] : []),
    ...(seller ? [{ name: 'sales' as const, title: 'Ventas', subtitle: 'Cotizaciones y órdenes', icon: TILE_ICONS.sales }] : []),
    ...(admin ? [{ name: 'admin' as const, title: 'Administración', subtitle: 'Catálogo y usuarios', icon: TILE_ICONS.admin }] : []),
  ]
  const firstName = name.trim().split(/\s+/)[0] ?? ''

  return (
    <div className="home">
      <header className="home-greeting">
        <h1>
          <span>¡Hola!</span> {firstName}
        </h1>
        <p>¿Qué quieres hacer hoy?</p>
      </header>

      <section className="home-banner" aria-label="Empresa">
        <span className="home-banner-pill home-banner-pill-1" aria-hidden="true" />
        <span className="home-banner-pill home-banner-pill-2" aria-hidden="true" />
        <small>Inventario de perfiles</small>
        <strong>Solaluminios</strong>
      </section>

      <svg width="0" height="0" className="sr-only" aria-hidden="true">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#00FFD7" />
            <stop offset="1" stopColor="#00A5D7" />
          </linearGradient>
        </defs>
      </svg>

      <nav className="home-tiles" aria-label="Accesos">
        {tiles.map((tile) => (
          <button key={tile.name} type="button" className="home-tile" onClick={() => navigate({ name: tile.name })}>
            <svg className="home-tile-icon" viewBox="0 0 48 48" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <g className="tile-art-color">{tile.icon(`url(#${gradient})`)}</g>
              <g className="tile-art-white">{tile.icon('#ffffff')}</g>
            </svg>
            <span className="home-tile-text">
              <strong className="home-tile-title">{tile.title}</strong>
              <small>{tile.subtitle}</small>
            </span>
            <IconChevron className="home-tile-chevron" />
          </button>
        ))}
      </nav>

      <DevicePanel />
    </div>
  )
}
