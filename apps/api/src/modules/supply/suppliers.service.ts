import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { isUniqueViolation } from '../../shared/db.js';
import type { CreateSupplierDto, SupplierQueryDto, UpdateSupplierDto } from './dto/supply.dto.js';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  list(query: SupplierQueryDto) {
    return this.prisma.supplier.findMany({
      where: {
        ...(query.origin ? { origins: { has: query.origin } } : {}),
        ...(query.active ? { active: query.active === 'true' } : {}),
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      take: 500,
    });
  }

  async create(dto: CreateSupplierDto) {
    try {
      return await this.prisma.supplier.create({
        data: { code: dto.code, name: dto.name, origins: dto.origins, taxId: dto.taxId || null, notes: dto.notes || null },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe un proveedor con ese código');
      throw error;
    }
  }

  async update(id: string, dto: UpdateSupplierDto) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('El proveedor no existe');
    return this.prisma.supplier.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.taxId !== undefined ? { taxId: dto.taxId || null } : {}),
        ...(dto.origins !== undefined ? { origins: dto.origins } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes || null } : {}),
      },
    });
  }
}
