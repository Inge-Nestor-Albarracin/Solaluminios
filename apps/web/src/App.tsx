import { useEffect, useEffectEvent, useState, type ComponentType, type SVGProps } from 'react'
import './App.css'
import { BrandLogo } from './components/brand/BrandLogo'
import { IconBulk, IconChart, IconHome, IconList, IconLogout, IconRegister, IconScan, IconSettings, IconTasks } from './components/icons'
import { ChinaView } from './views/ChinaView'
import { DispatchesView } from './views/DispatchesView'
import { DispatchView } from './views/DispatchView'
import { OrderView } from './views/OrderView'
import { QuoteView } from './views/QuoteView'
import { ReceiveView } from './views/ReceiveView'
import { SalesView } from './views/SalesView'
import { LogoutDialog } from './components/LogoutDialog'
import { onOpenView, takeLaunchView, type LaunchView } from './pwa/launchView'
import { PwaBanners } from './pwa/PwaBanners'
import { releasePushOnLogout, setPushLinked, syncPushOnLogin } from './pwa/push'
import { localBlockers, useUnsavedWork } from './pwa/workGuard'
import { useRegistrationQueue } from './lib/registrationQueue'
import type { TaskSummary } from './lib/tasks'
import { useLoad } from './lib/useLoad'
import { ROLE_LABELS, canDispatch, canOperate, canSell, useSession } from './session/session-context'
import { AdminView } from './views/AdminView'
import { BulkReadView, type BulkChips } from './views/BulkReadView'
import { BundleDetailView } from './views/BundleDetailView'
import { BundlesView } from './views/BundlesView'
import { HomeView } from './views/HomeView'
import { LoginView } from './views/LoginView'
import { LookupView } from './views/LookupView'
import type { View } from './views/navigation'
import { RegisterBundleView } from './views/RegisterBundleView'
import { SummaryView } from './views/SummaryView'
import { TasksView } from './views/TasksView'

function App() {
  const { user } = useSession()
  return (
    <>
      {/* Connection and new-version notices, also on the login screen. */}
      <PwaBanners />
      {/* Remount on user change so no state survives a logout/login. */}
      {!user ? <LoginView /> : user.role === 'CHINA_OPERATOR' ? <ChinaWorkspace key={user.id} /> : <Workspace key={user.id} />}
    </>
  )
}

interface NavTab {
  name: Exclude<View['name'], 'bundle' | 'quote' | 'order' | 'dispatch'>
  label: string
  short: string
  icon: ComponentType<SVGProps<SVGSVGElement>>
  bottom?: false
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')
}

// Supplier operator in China: one screen (English), no internal menus.
function ChinaWorkspace() {
  const { user, logout } = useSession()
  return (
    <div className="china-shell">
      <header className="topbar china-topbar">
        <span className="topbar-brand">
          <BrandLogo className="topbar-logo" variant="minimal" tone="negative" title="WeTracking" />
          <span className="topbar-client">
            <small>Solaluminios</small>
            <strong>China</strong>
          </span>
        </span>
        <div className="topbar-user">
          <span className="topbar-user-text">
            <strong>{user?.name}</strong>
            <small>Supplier operator</small>
          </span>
          <button type="button" className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => logout()}>
            <IconLogout />
          </button>
        </div>
      </header>
      <main className="content">
        <ChinaView />
      </main>
    </div>
  )
}

const VIEW_LABELS: Record<LaunchView, string> = {
  home: 'Inicio',
  receive: 'Recepción China',
  sales: 'Ventas',
  dispatches: 'Despachos',
  register: 'Registrar paquete',
  lookup: 'Consultar chip',
  bulk: 'Lectura masiva',
  bundles: 'Paquetes',
  summary: 'Resumen',
  tasks: 'Tareas',
  admin: 'Administración',
}

function Workspace() {
  const { user, logout, request } = useSession()
  const operator = canOperate(user?.role)
  // Pending registration list (not saved yet), shared by the register view,
  // the menu badge and the logout prompt.
  const queue = useRegistrationQueue(user?.id ?? 'anonymous')
  const pending = queue.items.length
  const [logoutPrompt, setLogoutPrompt] = useState(false)
  // Bulk reading session: survives navigation (e.g. opening a bundle), not
  // the logout (Workspace remounts per user).
  const [bulkChips, setBulkChips] = useState<BulkChips>(() => new Map())

  // Closing or reloading the tab with unsaved bundles asks for confirmation.
  useEffect(() => {
    if (pending === 0) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [pending])

  // Pending tasks for the menu badge, refreshed every minute.
  const taskSummary = useLoad<TaskSummary>('/tasks/summary')
  const { reload: reloadTaskSummary } = taskSummary
  useEffect(() => {
    const id = window.setInterval(reloadTaskSummary, 60_000)
    return () => window.clearInterval(id)
  }, [reloadTaskSummary])
  const openTasks = taskSummary.data?.pending ?? 0

  // Views this user may open from a URL, a shortcut or a notification.
  const allowed = (name: LaunchView) =>
    (name !== 'register' || operator) &&
    (name !== 'receive' || operator) &&
    (name !== 'sales' || canSell(user?.role)) &&
    (name !== 'dispatches' || canDispatch(user?.role)) &&
    (name !== 'admin' || user?.role === 'ADMIN')
  const [view, setView] = useState<View>(() => {
    const launch = takeLaunchView()
    return { name: launch && allowed(launch) ? launch : 'home' }
  })
  // A notification asked for a view while there is work in progress: offered
  // instead of navigating (changing view could interrupt a reading or a form).
  const [viewRequest, setViewRequest] = useState<LaunchView | null>(null)

  // Work that a reload (app update) would lose; see pwa/workGuard.ts.
  useUnsavedWork(pending > 0 ? `Lista de registro con ${pending} ${pending === 1 ? 'paquete' : 'paquetes'} sin guardar` : null)
  useUnsavedWork(bulkChips.size > 0 ? `Lectura masiva con ${bulkChips.size} chips en pantalla` : null)

  // This device's notifications: a subscription left by another account is
  // dropped here, so this account never receives someone else's notices.
  useEffect(() => {
    let active = true
    syncPushOnLogin(request)
      .then((linked) => active && setPushLinked(linked))
      .catch(() => active && setPushLinked(null))
    return () => {
      active = false
      setPushLinked(null)
    }
  }, [request])

  // Logging out unlinks this device's notifications from the account first.
  const [loggingOut, setLoggingOut] = useState(false)
  const endSession = () => {
    if (loggingOut) return
    setLoggingOut(true)
    void releasePushOnLogout(request).finally(() => logout())
  }
  const requestLogout = () => (pending > 0 ? setLogoutPrompt(true) : endSession())
  // Remount register/bundles when they receive initial values (EPC, filters).
  const [remountKey, setRemountKey] = useState(0)

  const navigate = (next: View) => {
    if (next.name === 'register' || next.name === 'bundles') setRemountKey((k) => k + 1)
    setView(next)
    setViewRequest(null)
    window.scrollTo({ top: 0 })
  }

  // Notification clicked while the app is open.
  const openRequested = useEffectEvent((name: LaunchView) => {
    if (!allowed(name)) return
    if (localBlockers().length > 0) setViewRequest(name)
    else navigate({ name })
  })
  useEffect(() => onOpenView((name) => openRequested(name)), [])

  const tabs: NavTab[] = [
    { name: 'home', label: 'Inicio', short: 'Inicio', icon: IconHome },
    ...(operator ? [{ name: 'register' as const, label: 'Registrar paquete', short: 'Registrar', icon: IconRegister }] : []),
    { name: 'lookup', label: 'Consultar chip', short: 'Chip', icon: IconScan },
    // Not in the phone bottom bar (already full): reached from Inicio and
    // from "Consultar chip".
    { name: 'bulk', label: 'Lectura masiva', short: 'Masiva', icon: IconBulk, bottom: false },
    { name: 'bundles', label: 'Paquetes', short: 'Paquetes', icon: IconList },
    { name: 'summary', label: 'Resumen', short: 'Resumen', icon: IconChart },
    { name: 'tasks', label: 'Tareas', short: 'Tareas', icon: IconTasks },
    ...(canSell(user?.role) ? [{ name: 'sales' as const, label: 'Ventas', short: 'Ventas', icon: IconChart, bottom: false as const }] : []),
    ...(canDispatch(user?.role) ? [{ name: 'dispatches' as const, label: 'Despachos', short: 'Despachos', icon: IconList, bottom: false as const }] : []),
    ...(operator ? [{ name: 'receive' as const, label: 'Recepción China', short: 'Recepción', icon: IconScan, bottom: false as const }] : []),
    // UI hint only: the API enforces ADMIN on every admin endpoint.
    ...(user?.role === 'ADMIN' ? [{ name: 'admin' as const, label: 'Administración', short: 'Admin', icon: IconSettings }] : []),
  ]
  // The bundle detail belongs to the section the user came from; highlight lookup.
  const current =
    view.name === 'bundle' ? 'lookup' : view.name === 'quote' || view.name === 'order' ? 'sales' : view.name === 'dispatch' ? 'dispatches' : view.name

  const navButtons = (variant: 'side' | 'bottom' | 'top') =>
    tabs.filter((tab) => variant !== 'bottom' || tab.bottom !== false).map((tab) => {
      const Icon = tab.icon
      const active = current === tab.name
      return (
        <button
          key={tab.name}
          type="button"
          className={`nav-${variant}-item${active ? ' active' : ''}`}
          aria-current={active ? 'page' : undefined}
          onClick={() => navigate({ name: tab.name })}
        >
          <Icon />
          <span>{variant === 'bottom' ? tab.short : tab.label}</span>
          {tab.name === 'register' && pending > 0 ? (
            <span className="nav-badge" title={`${pending} paquetes sin guardar`}>
              {pending}
              <span className="sr-only"> sin guardar</span>
            </span>
          ) : null}
          {tab.name === 'tasks' && openTasks > 0 ? (
            <span className="nav-badge nav-badge-info" title={`${openTasks} tareas pendientes`}>
              {openTasks}
              <span className="sr-only"> pendientes</span>
            </span>
          ) : null}
        </button>
      )
    })

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Navegación principal">
        <button type="button" className="sidebar-brand" onClick={() => navigate({ name: 'home' })} aria-label="WeTracking · Ir al inicio">
          <BrandLogo variant="full" tone="negative" title="WeTracking" />
        </button>
        <div className="sidebar-client">
          <small>Inventario</small>
          <strong>Solaluminios</strong>
        </div>
        <nav className="nav-side">{navButtons('side')}</nav>
        <div className="sidebar-user">
          <span className="avatar" aria-hidden="true">{initials(user?.name ?? '')}</span>
          <span className="sidebar-user-text">
            <strong>{user?.name}</strong>
            <small>{user ? ROLE_LABELS[user.role] : ''}</small>
          </span>
          <button type="button" className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={requestLogout}>
            <IconLogout />
          </button>
        </div>
      </aside>

      <header className="topbar">
        <button type="button" className="topbar-brand" onClick={() => navigate({ name: 'home' })} aria-label="WeTracking · Ir al inicio">
          <BrandLogo className="topbar-logo" variant="minimal" tone="negative" title="WeTracking" />
          <BrandLogo className="topbar-mark" variant="mark" tone="negative" title="WeTracking" />
          <span className="topbar-client">
            <small>Inventario</small>
            <strong>Solaluminios</strong>
          </span>
        </button>
        <div className="topbar-user">
          <span className="topbar-user-text">
            <strong>{user?.name}</strong>
            <small>{user ? ROLE_LABELS[user.role] : ''}</small>
          </span>
          <span className="avatar" aria-hidden="true">{initials(user?.name ?? '')}</span>
          <button type="button" className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={requestLogout}>
            <IconLogout />
          </button>
        </div>
        <nav className="nav-top" aria-label="Secciones">{navButtons('top')}</nav>
      </header>

      <main className="content">
        {viewRequest ? (
          <div className="notice notice-info view-request" role="status">
            Te llegó un aviso para <strong>{VIEW_LABELS[viewRequest]}</strong>. Ábrelo cuando termines lo que estás haciendo.{' '}
            <button type="button" className="link" onClick={() => navigate({ name: viewRequest })}>
              Abrir ahora
            </button>{' '}
            <button type="button" className="link" onClick={() => setViewRequest(null)}>
              Cerrar
            </button>
          </div>
        ) : null}
        {view.name === 'home' ? (
          <HomeView
            name={user?.name ?? ''}
            operator={operator}
            admin={user?.role === 'ADMIN'}
            seller={canSell(user?.role)}
            dispatcher={canDispatch(user?.role)}
            pendingQueue={pending}
            openTasks={openTasks}
            navigate={navigate}
          />
        ) : null}
        {view.name === 'register' ? (
          <RegisterBundleView key={remountKey} initialEpc={view.epc} navigate={navigate} queue={queue} />
        ) : null}
        {view.name === 'lookup' ? <LookupView navigate={navigate} /> : null}
        {view.name === 'bulk' ? <BulkReadView navigate={navigate} chips={bulkChips} setChips={setBulkChips} /> : null}
        {view.name === 'bundles' ? (
          <BundlesView key={remountKey} navigate={navigate} initialCatalog={view.catalog} />
        ) : null}
        {view.name === 'summary' ? <SummaryView navigate={navigate} /> : null}
        {view.name === 'tasks' ? <TasksView onChanged={reloadTaskSummary} onOpenDispatch={(id) => navigate({ name: 'dispatch', id })} /> : null}
        {view.name === 'receive' && operator ? <ReceiveView navigate={navigate} /> : null}
        {view.name === 'sales' && canSell(user?.role) ? <SalesView key={view.tab ?? 'quotes'} navigate={navigate} initialTab={view.tab} /> : null}
        {view.name === 'quote' ? <QuoteView key={view.id ?? 'new'} id={view.id} navigate={navigate} /> : null}
        {view.name === 'order' ? <OrderView key={view.id} id={view.id} navigate={navigate} /> : null}
        {view.name === 'dispatches' ? <DispatchesView navigate={navigate} /> : null}
        {view.name === 'dispatch' ? <DispatchView key={view.id} id={view.id} navigate={navigate} onChanged={reloadTaskSummary} /> : null}
        {view.name === 'admin' && user?.role === 'ADMIN' ? <AdminView /> : null}
        {view.name === 'bundle' ? <BundleDetailView key={view.id} id={view.id} navigate={navigate} /> : null}
      </main>

      <nav className="nav-bottom" aria-label="Secciones">{navButtons('bottom')}</nav>

      {logoutPrompt ? (
        <LogoutDialog
          pending={pending}
          canKeep={queue.status !== 'unavailable'}
          onCancel={() => setLogoutPrompt(false)}
          onReview={() => {
            setLogoutPrompt(false)
            navigate({ name: 'register' })
          }}
          onKeep={endSession}
          onDiscard={() => {
            queue.clear()
            endSession()
          }}
        />
      ) : null}
    </div>
  )
}

export default App
