import type { UserRole } from '../api/types'
import { BUSINESS_TIME_ZONE, todayIso } from './format'

export type TaskStatus = 'pending' | 'completed' | 'incomplete'

export interface TaskPerson {
  id: string
  name: string
  role: UserRole
}

export interface Task {
  id: string
  title: string
  description: string | null
  dueAt: string
  completedAt: string | null
  createdAt: string
  assigneeId: string
  createdById: string
  status: TaskStatus
  assignee: TaskPerson
  createdBy: TaskPerson
  // DISPATCH tasks are completed by confirming their dispatch and stay
  // pending (overdue) after the deadline.
  kind?: 'GENERAL' | 'DISPATCH'
  dispatchId?: string | null
  dispatch?: { id: string; number: string; status: 'OPEN' | 'CONFIRMED' | 'CANCELLED' } | null
  overdue?: boolean
}

export interface TaskSummary {
  pending: number
  dueSoon: number
  completed: number
  incomplete: number
  serverTime: string
}

// Colombia has no daylight saving time: Bogotá is always UTC-05:00. The API
// requires an explicit offset, so the deadline the user picks is unambiguous.
const BOGOTA_OFFSET = '-05:00'

export function dueAtIso(date: string, time: string): string {
  return `${date}T${time}:00${BOGOTA_OFFSET}`
}

export function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Calendar day (YYYY-MM-DD) of an instant, in Bogotá.
export function bogotaDay(value: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value))
}

export function bogotaTime(value: string | Date): string {
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: BUSINESS_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value))
}

// Group label for the pending list (weekly view).
export function dayLabel(day: string): string {
  const today = todayIso()
  if (day === today) return 'Hoy'
  if (day === addDaysIso(today, 1)) return 'Mañana'
  const weekday = new Intl.DateTimeFormat('es-CO', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date(`${day}T12:00:00Z`))
  return weekday.charAt(0).toUpperCase() + weekday.slice(1)
}

export function sameWeekGroup(day: string): 'week' | 'later' {
  return day <= addDaysIso(todayIso(), 6) ? 'week' : 'later'
}

// "en 3 h", "en 2 días", "hace 5 min".
export function relative(to: string, now: number = Date.now()): string {
  const diff = new Date(to).getTime() - now
  const abs = Math.abs(diff)
  const minutes = Math.round(abs / 60000)
  const text =
    minutes < 1
      ? 'menos de 1 min'
      : minutes < 60
        ? `${minutes} min`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} h`
          : `${Math.round(minutes / 1440)} días`
  return diff >= 0 ? `en ${text}` : `hace ${text}`
}
