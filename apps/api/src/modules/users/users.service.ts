import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import { Prisma, type UserRole } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { hashPassword } from '../../infrastructure/security/password.js';
import type { CreateUserDto } from './dto/user.dto.js';

const SAFE_SELECT = {
  id: true, name: true, email: true, role: true, active: true,
  defaultInventoryLocationId: true, createdAt: true, updatedAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.user.findMany({ select: SAFE_SELECT, orderBy: { name: 'asc' } });
  }

  async create(dto: CreateUserDto) {
    const passwordHash = await hashPassword(dto.password);
    try {
      return await this.prisma.user.create({
        data: {
          name: dto.name, email: dto.email, passwordHash,
          role: dto.role ?? 'READ_ONLY',
        },
        select: SAFE_SELECT,
      });
    } catch (error: unknown) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('Ya existe un usuario con ese correo');
      }
      throw error;
    }
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
