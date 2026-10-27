import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Tx } from '../../shared/db.js';

// Administrative configuration (no secrets). Real supplier names are entered
// by administration; nothing is invented here.
export const SETTING_KEYS = {
  chinaSupplierId: 'china.supplierId',
  dispatchSupervisorId: 'dispatch.supervisorUserId',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(key: SettingKey, client: Tx | PrismaService = this.prisma): Promise<string | null> {
    const row = await client.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  // Name only: forms show which supplier China entries are assigned to.
  async chinaSupplier() {
    const id = await this.get(SETTING_KEYS.chinaSupplierId);
    const supplier = id
      ? await this.prisma.supplier.findUnique({ where: { id }, select: { id: true, code: true, name: true, active: true, origins: true } })
      : null;
    if (!supplier || !supplier.active || !supplier.origins.includes('CHINA')) return null;
    return { id: supplier.id, code: supplier.code, name: supplier.name };
  }

  async view() {
    const chinaSupplierId = await this.get(SETTING_KEYS.chinaSupplierId);
    const dispatchSupervisorId = await this.get(SETTING_KEYS.dispatchSupervisorId);
    const [supplier, supervisor] = await Promise.all([
      chinaSupplierId
        ? this.prisma.supplier.findUnique({ where: { id: chinaSupplierId }, select: { id: true, code: true, name: true, active: true } })
        : null,
      dispatchSupervisorId
        ? this.prisma.user.findUnique({ where: { id: dispatchSupervisorId }, select: { id: true, name: true, role: true, active: true } })
        : null,
    ]);
    return { chinaSupplier: supplier, dispatchSupervisor: supervisor };
  }

  async update(input: { chinaSupplierId?: string | null; dispatchSupervisorId?: string | null }, userId: string) {
    await this.prisma.$transaction(async (tx) => {
      if (input.chinaSupplierId !== undefined) {
        if (input.chinaSupplierId) {
          const supplier = await tx.supplier.findUnique({ where: { id: input.chinaSupplierId } });
          if (!supplier) throw new NotFoundException('El proveedor no existe');
          if (!supplier.active || !supplier.origins.includes('CHINA')) {
            throw new BadRequestException('El proveedor de China debe estar activo y suministrar material de origen China');
          }
          // Shipments are opened automatically per supplier: the previous
          // supplier's open shipment is closed so provenances never mix. Its
          // pre-registered bundles can still be received.
          await tx.inboundShipment.updateMany({
            where: { status: 'OPEN', supplierId: { not: supplier.id } },
            data: { status: 'CLOSED', closedAt: new Date() },
          });
        }
        await this.write(tx, SETTING_KEYS.chinaSupplierId, input.chinaSupplierId, userId);
      }
      if (input.dispatchSupervisorId !== undefined) {
        if (input.dispatchSupervisorId) {
          const user = await tx.user.findUnique({ where: { id: input.dispatchSupervisorId } });
          if (!user) throw new NotFoundException('El usuario no existe');
          if (!user.active || !['ADMIN', 'WAREHOUSE'].includes(user.role)) {
            throw new BadRequestException('El supervisor de despachos debe ser un usuario activo de administración o bodega');
          }
        }
        await this.write(tx, SETTING_KEYS.dispatchSupervisorId, input.dispatchSupervisorId, userId);
      }
    });
    return this.view();
  }

  private async write(tx: Tx, key: SettingKey, value: string | null, userId: string) {
    if (value === null) {
      await tx.setting.deleteMany({ where: { key } });
      return;
    }
    await tx.setting.upsert({
      where: { key },
      create: { key, value, updatedById: userId },
      update: { value, updatedById: userId },
    });
  }
}
