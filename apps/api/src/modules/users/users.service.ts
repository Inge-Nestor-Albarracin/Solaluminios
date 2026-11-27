import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma, type UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { hashPassword } from '../../infrastructure/security/password.js';
import { isCheckViolation } from '../../shared/db.js';
import { USERNAME_MESSAGE } from '../auth/password-policy.js';
import type { CreateUserDto, LoginEventQueryDto } from './dto/user.dto.js';

const SAFE_SELECT = {
  id: true, name: true, username: true, email: true, role: true, active: true,
  defaultInventoryLocationId: true, mustChangePassword: true, passwordChangedAt: true,
  createdAt: true, updatedAt: true,
} as const;

// Which unique field a P2002 error was about (user name or e-mail).
function duplicateMessage(error: Prisma.PrismaClientKnownRequestError) {
  const target = JSON.stringify(error.meta ?? {});
  if (target.includes('email')) return 'Ya existe un usuario con ese correo';
  return 'Ya existe un usuario con ese nombre de usuario';
}

// A value the validation let through but a database rule refused (format of
// the user name, lowercase e-mail): a client error, never a 500.
function refusedByRule(error: unknown) {
  if (isCheckViolation(error)) return new BadRequestException(USERNAME_MESSAGE);
  return error;
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // With the last successful login of each one (from the login log).
  async list() {
    const [users, last] = await Promise.all([
      this.prisma.user.findMany({ select: SAFE_SELECT, orderBy: { name: 'asc' } }),
      this.prisma.loginEvent.groupBy({ by: ['userId'], where: { type: 'LOGIN_OK', userId: { not: null } }, _max: { at: true } }),
    ]);
    const lastLogin = new Map(last.map((row) => [row.userId, row._max.at]));
    return users.map((user) => ({ ...user, lastLoginAt: lastLogin.get(user.id) ?? null }));
  }

  // The ID number is the initial password, never stored as such (only its
  // hash, like any password); the user must replace it at the first login.
  async create(dto: CreateUserDto) {
    const passwordHash = await hashPassword(dto.idNumber);
    try {
      return await this.prisma.user.create({
        data: {
          name: dto.name,
          username: dto.username,
          email: dto.email ?? null,
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          role: dto.role ?? 'READ_ONLY',
        },
        select: SAFE_SELECT,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(duplicateMessage(error));
      }
      throw refusedByRule(error);
    }
  }

  // Forgotten password: back to the ID number, to be changed at the next
  // login. Open sessions of that user end (passwordChangedAt). Logged with
  // the administrator who did it.
  async resetPassword(id: string, idNumber: string, actorId: string) {
    if (id === actorId) {
      throw new BadRequestException('Para tu propia cuenta usa «Cambiar mi contraseña»');
    }
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true, username: true } });
    if (!user) throw new NotFoundException('El usuario no existe');
    const passwordHash = await hashPassword(idNumber);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, passwordChangedAt: new Date() },
        select: SAFE_SELECT,
      });
      await tx.loginEvent.create({ data: { type: 'PASSWORD_RESET', identifier: user.username, userId: id, actorId } });
      return updated;
    });
  }

  async setUsername(id: string, username: string) {
    try {
      return await this.prisma.user.update({ where: { id }, data: { username }, select: SAFE_SELECT });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('El usuario no existe');
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(duplicateMessage(error));
      }
      throw refusedByRule(error);
    }
  }

  // Logins, failed attempts and password changes, newest first.
  async loginEvents(query: LoginEventQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: Prisma.LoginEventWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.loginEvent.count({ where }),
      this.prisma.loginEvent.findMany({
        where,
        include: { user: { select: { id: true, name: true, username: true } }, actor: { select: { id: true, name: true } } },
        orderBy: [{ at: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async setActive(id: string, active: boolean, actorId: string) {
    if (!active && id === actorId) {
      throw new BadRequestException('No puedes desactivar tu propia cuenta');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (!active) {
          // Lock the active administrators so two admins deactivating each
          // other concurrently cannot leave the system without any admin.
          const admins = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "users" WHERE role = 'ADMIN' AND active = true FOR UPDATE`;
          if (admins.length === 1 && admins[0].id === id) {
            throw new BadRequestException('No se puede desactivar al último administrador activo');
          }
        }
        return tx.user.update({ where: { id }, data: { active }, select: SAFE_SELECT });
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('El usuario no existe');
      }
      throw error;
    }
  }

  // Changes take effect on the user's next request: the guard re-reads the
  // role from the database every time.
  async setLocation(id: string, inventoryLocationId: string | null) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!user) throw new NotFoundException('El usuario no existe');
    if (inventoryLocationId) {
      const location = await this.prisma.inventoryLocation.findUnique({ where: { id: inventoryLocationId } });
      if (!location?.active) throw new BadRequestException('La ubicación no existe o está inactiva');
    }
    return this.prisma.user.update({ where: { id }, data: { defaultInventoryLocationId: inventoryLocationId }, select: SAFE_SELECT });
  }

  async setRole(id: string, role: UserRole, actorId: string) {
    if (id === actorId) {
      throw new BadRequestException('No puedes cambiar tu propio rol');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (role !== 'ADMIN') {
          // Same lock as deactivation: concurrent demotions cannot leave the
          // system without an active administrator.
          const admins = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "users" WHERE role = 'ADMIN' AND active = true FOR UPDATE`;
          if (admins.length === 1 && admins[0].id === id) {
            throw new BadRequestException('No se puede quitar el rol al último administrador activo');
          }
        }
        return tx.user.update({ where: { id }, data: { role }, select: SAFE_SELECT });
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('El usuario no existe');
      }
      throw error;
    }
  }
}
