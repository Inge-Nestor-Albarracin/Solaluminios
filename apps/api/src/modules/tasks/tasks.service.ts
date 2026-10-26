import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Task } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { SafeUser } from '../auth/auth.types.js';
import { PushService } from '../push/push.service.js';
import {
  DEFAULT_PAGE_SIZE,
  type PaginationQueryDto,
} from '../inventory/dto/inventory-query.dto.js';
import type {
  CreateTaskDto,
  ListTasksQueryDto,
  TaskStatus,
  TaskSummaryQueryDto,
} from './dto/task.dto.js';

// Deadlines further away than this are almost certainly typos.
const MAX_DUE_DAYS = 366;

const personSelect = { select: { id: true, name: true, role: true } } as const;
const taskInclude = {
  assignee: personSelect,
  createdBy: personSelect,
} satisfies Prisma.TaskInclude;

// Status is derived from the server clock: a task that was not completed
// before its deadline leaves the pending list and becomes "incomplete". It is
// never deleted, so it stays in the incomplete history.
export function taskStatus(task: Pick<Task, 'completedAt' | 'dueAt'>, now: Date): TaskStatus {
  if (task.completedAt) return 'completed';
  return task.dueAt.getTime() <= now.getTime() ? 'incomplete' : 'pending';
}

function statusWhere(status: TaskStatus, now: Date): Prisma.TaskWhereInput {
  switch (status) {
    case 'completed':
      return { completedAt: { not: null } };
    case 'incomplete':
      return { completedAt: null, dueAt: { lte: now } };
    default:
      return { completedAt: null, dueAt: { gt: now } };
  }
}

const STATUS_ORDER: Record<TaskStatus, Prisma.TaskOrderByWithRelationInput[]> = {
  pending: [{ dueAt: 'asc' }, { id: 'asc' }],
  completed: [{ completedAt: 'desc' }, { id: 'desc' }],
  incomplete: [{ dueAt: 'desc' }, { id: 'desc' }],
};

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  // Employees create tasks for themselves; ADMIN (the boss) can assign them
  // to any active user. The creator always comes from the session.
  async create(dto: CreateTaskDto, user: SafeUser) {
    const assigneeId = dto.assigneeId ?? user.id;
    if (assigneeId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Solo un administrador puede asignar tareas a otras personas',
      );
    }

    const now = new Date();
    const dueAt = new Date(dto.dueAt);
    if (Number.isNaN(dueAt.getTime())) {
      throw new BadRequestException('dueAt no es una fecha válida');
    }
    if (dueAt.getTime() <= now.getTime() + 60_000) {
      throw new BadRequestException(
        'El vencimiento debe ser al menos un minuto en el futuro',
      );
    }
    if (dueAt.getTime() > now.getTime() + MAX_DUE_DAYS * 86_400_000) {
      throw new BadRequestException(
        `El vencimiento no puede superar ${MAX_DUE_DAYS} días`,
      );
    }

    if (assigneeId !== user.id) {
      const assignee = await this.prisma.user.findUnique({
        where: { id: assigneeId },
        select: { active: true },
      });
      if (!assignee) throw new NotFoundException('El usuario asignado no existe');
      if (!assignee.active) {
        throw new BadRequestException('El usuario asignado está inactivo');
      }
    }

    const task = await this.prisma.task.create({
      data: {
        title: dto.title,
        description: dto.description || null,
        dueAt,
        assigneeId,
        createdById: user.id,
        createdAt: now,
      },
      include: taskInclude,
    });
    // After the commit and without waiting: a push failure never changes or
    // repeats the task. Own tasks are not notified.
    if (assigneeId !== user.id) this.push.notifyTaskAssigned(assigneeId);
    return withStatus(task, now);
  }

  async list(query: ListTasksQueryDto, user: SafeUser) {
    const assigneeId = this.visibleAssignee(query.assigneeId, user);
    const status = query.status ?? 'pending';
    const { page, pageSize, skip } = paginate(query);
    const now = new Date();
    const where: Prisma.TaskWhereInput = {
      ...statusWhere(status, now),
      ...(assigneeId ? { assigneeId } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.task.count({ where }),
      this.prisma.task.findMany({
        where,
        include: taskInclude,
        orderBy: STATUS_ORDER[status],
        skip,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map((task) => withStatus(task, now)),
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      serverTime: now.toISOString(),
    };
  }

  async summary(query: TaskSummaryQueryDto, user: SafeUser) {
    const assigneeId = this.visibleAssignee(query.assigneeId, user);
    const now = new Date();
    const scope = assigneeId ? { assigneeId } : {};
    const endOfDay = new Date(now.getTime() + 24 * 3_600_000);
    const [pending, dueSoon, completed, incomplete] = await this.prisma.$transaction([
      this.prisma.task.count({ where: { ...scope, ...statusWhere('pending', now) } }),
      this.prisma.task.count({
        where: { ...scope, completedAt: null, dueAt: { gt: now, lte: endOfDay } },
      }),
      this.prisma.task.count({ where: { ...scope, ...statusWhere('completed', now) } }),
      this.prisma.task.count({ where: { ...scope, ...statusWhere('incomplete', now) } }),
    ]);
    return { pending, dueSoon, completed, incomplete, serverTime: now.toISOString() };
  }

  async get(id: string, user: SafeUser) {
    const task = await this.prisma.task.findUnique({ where: { id }, include: taskInclude });
    if (!task || !this.canSee(task, user)) {
      // Same answer for "does not exist" and "not yours".
      throw new NotFoundException('La tarea no existe');
    }
    return withStatus(task, new Date());
  }

  // Only the assignee completes a task, and only before its deadline. The
  // conditional update is atomic: two clicks or a click racing the deadline
  // cannot complete an expired task (also guarded by a CHECK constraint).
  async complete(id: string, user: SafeUser) {
    const now = new Date();
    const updated = await this.prisma.task.updateMany({
      where: { id, assigneeId: user.id, completedAt: null, dueAt: { gt: now } },
      data: { completedAt: now },
    });

    const task = await this.prisma.task.findUnique({ where: { id }, include: taskInclude });
    if (!task || !this.canSee(task, user)) {
      throw new NotFoundException('La tarea no existe');
    }
    if (updated.count === 1) return withStatus(task, now);
    if (task.assigneeId !== user.id) {
      throw new ForbiddenException('Solo la persona asignada puede completar la tarea');
    }
    // Retried or double click: already completed, nothing changes.
    if (task.completedAt) return withStatus(task, now);
    throw new ConflictException(
      'La tarea venció sin completarse y quedó en la lista de incompletas',
    );
  }

  private canSee(task: Pick<Task, 'assigneeId' | 'createdById'>, user: SafeUser) {
    return user.role === 'ADMIN' || task.assigneeId === user.id || task.createdById === user.id;
  }

  // ADMIN sees everyone (or one employee); other roles only their own tasks.
  private visibleAssignee(requested: string | undefined, user: SafeUser) {
    if (user.role === 'ADMIN') return requested;
    if (requested && requested !== user.id) {
      throw new ForbiddenException('Solo puedes consultar tus propias tareas');
    }
    return user.id;
  }
}

function withStatus<T extends Pick<Task, 'completedAt' | 'dueAt'>>(task: T, now: Date) {
  return { ...task, status: taskStatus(task, now) };
}

function paginate(query: PaginationQueryDto) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}
