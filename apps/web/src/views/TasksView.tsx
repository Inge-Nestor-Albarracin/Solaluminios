import { useEffect, useState } from 'react'
import type { Page } from '../api/types'
import { TaskCard } from '../components/TaskCard'
import { TaskForm } from '../components/TaskForm'
import { Empty, Field, Kpi, Loading, Notice, PageHeader, Pagination } from '../components/ui'
import { bogotaDay, dayLabel, sameWeekGroup, type Task, type TaskPerson, type TaskStatus, type TaskSummary } from '../lib/tasks'
import { queryString, useLoad } from '../lib/useLoad'
import { useNow } from '../lib/useNow'
import { useSession } from '../session/session-context'

const PAGE_SIZE = 50
// Expired tasks move to "incompletas" on the server clock; refresh regularly.
const REFRESH_MS = 60_000

const TABS: { status: TaskStatus; label: string }[] = [
  { status: 'pending', label: 'Pendientes' },
  { status: 'completed', label: 'Completadas' },
  { status: 'incomplete', label: 'Incompletas' },
]

interface AdminUser extends TaskPerson {
  active: boolean
}

export function TasksView({ onChanged, onOpenDispatch }: { onChanged: () => void; onOpenDispatch?: (dispatchId: string) => void }) {
  const { user } = useSession()
  const isAdmin = user?.role === 'ADMIN'
  const [status, setStatus] = useState<TaskStatus>('pending')
  const [assigneeId, setAssigneeId] = useState('')
  const [page, setPage] = useState(1)
  const now = useNow(15_000)

  const tasks = useLoad<Page<Task>>(`/tasks${queryString({ status, assigneeId, page, pageSize: PAGE_SIZE })}`)
  const summary = useLoad<TaskSummary>(`/tasks/summary${queryString({ assigneeId })}`)
  const users = useLoad<AdminUser[]>(isAdmin ? '/users' : null)
  const people = isAdmin ? (users.data ?? []).filter((u) => u.active) : null

  const { reload: reloadTasks } = tasks
  const { reload: reloadSummary } = summary
  useEffect(() => {
    const id = window.setInterval(() => {
      reloadTasks()
      reloadSummary()
    }, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [reloadTasks, reloadSummary])

  const refresh = () => {
    reloadTasks()
    reloadSummary()
    onChanged()
  }

  const showAssignee = isAdmin && !assigneeId
  const items = tasks.data?.items ?? []

  // Pending tasks grouped by day: this week day by day, then "Más adelante".
  const groups: { key: string; label: string; tasks: Task[] }[] = []
  if (status === 'pending') {
    for (const task of items) {
      const day = bogotaDay(task.dueAt)
      const key = sameWeekGroup(day) === 'week' ? day : 'later'
      let group = groups.find((g) => g.key === key)
      if (!group) {
        group = { key, label: key === 'later' ? 'Más adelante' : dayLabel(day), tasks: [] }
        groups.push(group)
      }
      group.tasks.push(task)
    }
  }

  const counts: Record<TaskStatus, number | undefined> = {
    pending: summary.data?.pending,
    completed: summary.data?.completed,
    incomplete: summary.data?.incomplete,
  }

  return (
    <>
      <PageHeader
        eyebrow="Organización · Tareas"
        title="Tareas"
        description={
          isAdmin
            ? 'Asigna tareas al equipo y sigue su avance. Las que no se completan antes de su vencimiento salen de pendientes y quedan en incompletas; un despacho atrasado sigue pendiente hasta confirmarse o cancelarse.'
            : 'Programa tus tareas y revisa las que te asignaron. Si una vence sin completarse, sale de pendientes y queda en incompletas; un despacho atrasado sigue pendiente hasta confirmar su salida.'
        }
      />

      <div className="kpis">
        <Kpi dark label="Pendientes" value={summary.data?.pending ?? '—'} hint={isAdmin && !assigneeId ? 'Todo el equipo' : undefined} />
        <Kpi label="Vencen en 24 h" value={summary.data?.dueSoon ?? '—'} />
        <Kpi label="Completadas" value={summary.data?.completed ?? '—'} />
        <Kpi label="Incompletas" value={summary.data?.incomplete ?? '—'} hint="Vencidas sin completar" />
      </div>

      <div className="tasks-layout">
        <section>
          <div className="tasks-toolbar">
            <div className="tabs" role="tablist">
              {TABS.map((tab) => (
                <button
                  key={tab.status}
                  type="button"
                  role="tab"
                  aria-selected={status === tab.status}
                  className={status === tab.status ? 'tab active' : 'tab'}
                  onClick={() => {
                    setStatus(tab.status)
                    setPage(1)
                  }}
                >
                  {tab.label}
                  {counts[tab.status] !== undefined ? <span className="tab-count">{counts[tab.status]}</span> : null}
                </button>
              ))}
            </div>
            {isAdmin ? (
              <Field label="Persona">
                <select
                  value={assigneeId}
                  onChange={(e) => {
                    setAssigneeId(e.target.value)
                    setPage(1)
                  }}
                >
                  <option value="">Todo el equipo</option>
                  {(users.data ?? []).map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                      {person.active ? '' : ' (inactivo)'}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}
          </div>

          {tasks.error ? <Notice kind="error">{tasks.error}</Notice> : null}
          {tasks.loading && !tasks.data ? <Loading label="Cargando tareas…" /> : null}

          {tasks.data && items.length === 0 ? (
            <Empty title={status === 'pending' ? 'Sin pendientes' : status === 'completed' ? 'Sin completadas' : 'Sin incompletas'}>
              {status === 'pending'
                ? 'No hay tareas pendientes. Crea una con el formulario.'
                : status === 'completed'
                  ? 'Aún no hay tareas completadas.'
                  : 'Ninguna tarea ha vencido sin completarse.'}
            </Empty>
          ) : null}

          {status === 'pending'
            ? groups.map((group) => (
                <div key={group.key} className="task-group">
                  <h2 className="task-group-title">
                    {group.label}
                    <span>{group.tasks.length}</span>
                  </h2>
                  {group.tasks.map((task) => (
                    <TaskCard key={task.id} task={task} now={now} showAssignee={showAssignee} onCompleted={refresh} onOpenDispatch={onOpenDispatch} />
                  ))}
                </div>
              ))
            : items.map((task) => (
                <TaskCard key={task.id} task={task} now={now} showAssignee={showAssignee} onCompleted={refresh} onOpenDispatch={onOpenDispatch} />
              ))}

          {tasks.data && tasks.data.totalPages > 1 ? (
            <Pagination
              page={tasks.data.page}
              totalPages={tasks.data.totalPages}
              total={tasks.data.total}
              onChange={setPage}
              disabled={tasks.loading}
            />
          ) : null}
        </section>

        <aside className="tasks-aside">
          <TaskForm people={people} onCreated={refresh} />
        </aside>
      </div>
    </>
  )
}
