import { useRef, useState, type FormEvent } from 'react'
import { describeError } from '../api/client'
import { todayIso } from '../lib/format'
import { addDaysIso, bogotaTime, dueAtIso, relative, type Task, type TaskPerson } from '../lib/tasks'
import { useNow } from '../lib/useNow'
import { useUnsavedWork } from '../pwa/workGuard'
import { useSession } from '../session/session-context'
import { IconArrow } from './icons'
import { Field, Notice } from './ui'

const DEFAULT_TIME = '18:00'

// Today at 18:00 if still ahead, otherwise tomorrow (Bogotá time).
function defaultDate(): string {
  const today = todayIso()
  return new Date(dueAtIso(today, DEFAULT_TIME)).getTime() > Date.now() + 60_000 ? today : addDaysIso(today, 1)
}

// New task. Employees create tasks for themselves; ADMIN can also assign
// them to another active user ("people" is only passed for ADMIN).
export function TaskForm({ people, onCreated }: { people: TaskPerson[] | null; onCreated: (task: Task) => void }) {
  const { request, user } = useSession()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState(DEFAULT_TIME)
  const [assigneeId, setAssigneeId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<Task | null>(null)
  const lock = useRef(false)
  useUnsavedWork(title.trim() || description.trim() ? 'Formulario de tarea sin guardar' : null)
  const now = useNow(30_000)

  const dueAt = date && time ? dueAtIso(date, time) : null
  const dueValid = dueAt !== null && new Date(dueAt).getTime() > now + 60_000

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    if (!title.trim()) {
      setError('Escribe un título para la tarea.')
      return
    }
    if (!dueValid || !dueAt) {
      setError('El vencimiento debe ser al menos un minuto en el futuro.')
      return
    }
    lock.current = true
    setPending(true)
    setError(null)
    setCreated(null)
    try {
      const { data } = await request<Task>('/tasks', {
        method: 'POST',
        body: {
          title: title.trim(),
          description: description.trim() || undefined,
          dueAt,
          assigneeId: assigneeId || undefined,
        },
      })
      setCreated(data)
      setTitle('')
      setDescription('')
      onCreated(data)
    } catch (err) {
      setError(describeError(err))
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  const others = (people ?? []).filter((p) => p.id !== user?.id)

  return (
    <form className="task-form" onSubmit={submit}>
      <header>
        <p className="eyebrow">{people ? 'Nueva tarea o asignación' : 'Nueva tarea'}</p>
        <h2>{people ? 'Crear y asignar' : 'Programar una tarea'}</h2>
      </header>
      <div className="task-form-body">
        {created ? (
          <Notice kind="success">
            Tarea creada{created.assigneeId !== user?.id ? ` y asignada a ${created.assignee.name}` : ''}. Vence{' '}
            {relative(created.dueAt, now)} ({bogotaTime(created.dueAt)}).
          </Notice>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}

        <Field label="Título">
          <input
            type="text"
            required
            maxLength={120}
            placeholder="Ej. Contar perfiles del burro 7"
            disabled={pending}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Detalle (opcional)">
          <textarea
            rows={3}
            maxLength={1000}
            placeholder="Instrucciones o contexto"
            disabled={pending}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <div className="task-form-due">
          <Field label="Vence el día">
            <input type="date" required min={todayIso()} disabled={pending} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Hora">
            <input type="time" required disabled={pending} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <p className={dueValid ? 'field-hint' : 'field-error'}>
          {dueValid && dueAt
            ? `Vence ${relative(dueAt, now)} (hora de Bogotá). Si no se completa antes, pasará a incompletas.`
            : 'Elige una fecha y hora futuras.'}
        </p>

        {people ? (
          <Field label="Asignar a" hint="Como administrador puedes asignar tareas a cualquier persona activa.">
            <select value={assigneeId} disabled={pending} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">A mí ({user?.name})</option>
              {others.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <button type="submit" className="cta" disabled={pending}>
          <span aria-live="polite">{pending ? 'Guardando…' : people && assigneeId ? 'Asignar tarea' : 'Crear tarea'}</span>
          <span className="cta-icon" aria-hidden="true">
            {pending ? <span className="cta-progress" /> : <IconArrow />}
          </span>
        </button>
      </div>
    </form>
  )
}
