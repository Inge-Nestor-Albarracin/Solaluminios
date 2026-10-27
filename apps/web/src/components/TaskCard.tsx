import { useRef, useState } from 'react'
import { describeError } from '../api/client'
import { formatDateTime } from '../lib/format'
import { bogotaTime, relative, type Task } from '../lib/tasks'
import { useSession } from '../session/session-context'
import { IconCheck, IconClock, IconUser } from './icons'

const STATUS_LABEL = { pending: 'Pendiente', completed: 'Completada', incomplete: 'Incompleta' } as const

export function TaskCard({
  task,
  now,
  showAssignee,
  onCompleted,
  onOpenDispatch,
}: {
  task: Task
  now: number
  showAssignee: boolean
  onCompleted: () => void
  onOpenDispatch?: (dispatchId: string) => void
}) {
  const { request, user } = useSession()
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)

  // The list refreshes every minute; meanwhile a task past its deadline is
  // shown as expired and can no longer be completed.
  const isDispatch = task.kind === 'DISPATCH'
  // Dispatch tasks never become "incomplete": they stay pending, overdue.
  const expiredLocally = !isDispatch && task.status === 'pending' && new Date(task.dueAt).getTime() <= now
  const status = expiredLocally ? 'incomplete' : task.status
  const overdue = isDispatch && status === 'pending' && new Date(task.dueAt).getTime() <= now
  const canComplete = !isDispatch && status === 'pending' && task.assigneeId === user?.id
  const dueSoon = status === 'pending' && new Date(task.dueAt).getTime() - now < 3 * 3_600_000
  const assignedByOther = task.createdById !== task.assigneeId

  const complete = async () => {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try {
      await request(`/tasks/${encodeURIComponent(task.id)}/complete`, { method: 'PATCH' })
      onCompleted()
    } catch (err) {
      setError(describeError(err))
      setConfirming(false)
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  return (
    <article className={`task-card ${status}${dueSoon ? ' due-soon' : ''}`}>
      <div className="task-main">
        <div className="task-title-row">
          <h3>{task.title}</h3>
          <span className={`task-status ${status}${overdue ? ' overdue' : ''}`}>{expiredLocally ? 'Vencida' : overdue ? 'Atrasada' : STATUS_LABEL[status]}</span>
        </div>
        {task.description ? <p className="task-description">{task.description}</p> : null}
        <p className="task-meta">
          <span>
            <IconClock />
            {status === 'completed' && task.completedAt
              ? `Completada ${formatDateTime(task.completedAt)}`
              : status === 'incomplete'
                ? `Venció ${formatDateTime(task.dueAt)}`
                : `Vence ${relative(task.dueAt, now)} · ${bogotaTime(task.dueAt)}`}
          </span>
          {showAssignee ? (
            <span>
              <IconUser />
              {task.assignee.name}
            </span>
          ) : null}
          {assignedByOther ? <span className="task-assigned-by">Asignada por {task.createdBy.name}</span> : null}
        </p>
        {error ? <p className="field-error">{error}</p> : null}
      </div>

      {isDispatch && task.dispatchId && onOpenDispatch ? (
        <div className="task-actions">
          <button type="button" className="button" onClick={() => onOpenDispatch(task.dispatchId!)}>
            {status === 'pending' ? 'Abrir despacho' : 'Ver despacho'}
          </button>
        </div>
      ) : null}

      {canComplete ? (
        <div className="task-actions">
          {confirming ? (
            <>
              <button type="button" className="button" disabled={pending} onClick={complete}>
                <IconCheck />
                {pending ? 'Guardando…' : 'Confirmar'}
              </button>
              <button type="button" className="text-button" disabled={pending} onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </>
          ) : (
            <button type="button" className="button button-secondary" onClick={() => setConfirming(true)}>
              <IconCheck />
              Marcar completada
            </button>
          )}
        </div>
      ) : null}
    </article>
  )
}
