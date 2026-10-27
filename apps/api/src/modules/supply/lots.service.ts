import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MaterialOrigin, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { audit, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import type { SafeUser } from '../auth/auth.types.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import type { AssignBundlesDto, CreateOpeningLotDto, LotQueryDto } from './dto/supply.dto.js';
import { SETTING_KEYS, SettingsService } from './settings.service.js';

// The lot is the canonical source of origin, supplier and acquisition cost;
// a Bundle only points to it. Lots are found or created by the flows that
// bring material in, and administration classifies historical stock.
@Injectable()
export class LotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // The configured Chinese supplier, active and able to supply China material.
  async requireChinaSupplier(tx: Tx, language: 'es' | 'en' = 'es') {
    const id = await this.settings.get(SETTING_KEYS.chinaSupplierId, tx);
    const supplier = id ? await tx.supplier.findUnique({ where: { id } }) : null;
    if (!supplier || !supplier.active || !supplier.origins.includes('CHINA')) {
      throw new ConflictException(
        language === 'en'
          ? 'The Chinese supplier is not configured. Ask the administrator to configure it before registering bundles.'
          : 'El proveedor de China no está configurado (Administración → Proveedores). No se guardó nada.',
      );
    }
    return supplier;
  }

  // Origin and supplier chosen in a Colombian entry form, validated here.
  async resolveEntryProvenance(tx: Tx, origin: MaterialOrigin, supplierId: string | undefined) {
    if (origin === 'CHINA' && !supplierId) {
      const supplier = await this.requireChinaSupplier(tx);
      return { origin, supplierId: supplier.id };
    }
    if (!supplierId) {
      throw new BadRequestException('Para material nacional el proveedor es obligatorio');
    }
    const supplier = await tx.supplier.findUnique({ where: { id: supplierId } });
    if (!supplier) throw new NotFoundException('El proveedor no existe');
    if (!supplier.active) throw new BadRequestException('El proveedor está inactivo');
    if (!supplier.origins.includes(origin)) {
      throw new BadRequestException(
        `El proveedor ${supplier.name} no está habilitado para material de origen ${origin === 'CHINA' ? 'China' : 'Nacional'}`,
      );
    }
    return { origin, supplierId: supplier.id };
  }

  async findOrCreateShipmentLot(tx: Tx, shipment: { id: string; supplierId: string }, referenceId: string, finishId: string, userId: string) {
    const existing = await tx.stockLot.findUnique({
      where: { shipmentId_referenceId_finishId: { shipmentId: shipment.id, referenceId, finishId } },
    });
    if (existing) return existing;
    return tx.stockLot.create({
      data: {
        code: await nextNumber(tx, 'stock_lot_code_seq', 'LOT'),
        kind: 'CHINA_SHIPMENT',
        referenceId,
        finishId,
        origin: 'CHINA',
        supplierId: shipment.supplierId,
        shipmentId: shipment.id,
        createdById: userId,
      },
    });
  }

  // One lot per entry group (registration list), reference and finish: the
  // supplier/purchase context is chosen once per group.
  async findOrCreateEntryLot(
    tx: Tx,
    input: { entryKey: string; origin: MaterialOrigin; supplierId: string; referenceId: string; finishId: string },
    userId: string,
  ) {
    const existing = await tx.stockLot.findUnique({
      where: { entryKey_referenceId_finishId: { entryKey: input.entryKey, referenceId: input.referenceId, finishId: input.finishId } },
    });
    if (existing) {
      if (existing.origin !== input.origin || existing.supplierId !== input.supplierId) {
        throw new BadRequestException('Un mismo grupo de ingreso no puede mezclar orígenes o proveedores');
      }
      return existing;
    }
    return tx.stockLot.create({
      data: {
        code: await nextNumber(tx, 'stock_lot_code_seq', 'LOT'),
        kind: 'MANUAL_ENTRY',
        referenceId: input.referenceId,
        finishId: input.finishId,
        origin: input.origin,
        supplierId: input.supplierId,
        entryKey: input.entryKey,
        createdById: userId,
      },
    });
  }

  // --- Administration -------------------------------------------------------

  async list(query: LotQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.StockLotWhereInput = {
      ...(query.referenceId ? { referenceId: query.referenceId } : {}),
      ...(query.finishId ? { finishId: query.finishId } : {}),
      ...(query.origin ? { origin: query.origin } : {}),
      ...(query.costPending === 'true' ? { unitCost: null } : query.costPending === 'false' ? { unitCost: { not: null } } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.stockLot.count({ where }),
      this.prisma.stockLot.findMany({
        where,
        include: {
          reference: { select: { id: true, code: true, description: true } },
          finish: { select: { id: true, code: true, description: true } },
          supplier: { select: { id: true, code: true, name: true } },
          shipment: { select: { id: true, code: true } },
          purchaseLine: { select: { id: true, lineNo: true, purchase: { select: { id: true, documentNumber: true } } } },
          _count: { select: { bundles: true, preRegistrations: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: await this.withTotals(items), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  // What each lot holds, to match it with a purchase document: profiles that
  // came in (its bundles' registration movement, unaffected by later exits),
  // profiles still in stock and, for China, what is announced but not received.
  private async withTotals<T extends { id: string }>(lots: T[]) {
    const ids = lots.map((lot) => lot.id);
    if (ids.length === 0) return [];
    const [entered, current, pending] = await Promise.all([
      this.prisma.$queryRaw<{ lotId: string; bundles: number; profiles: number }[]>`
        SELECT b."lotId", COUNT(*)::int AS bundles, COALESCE(SUM(m.quantity), 0)::int AS profiles
        FROM "bundles" b
        JOIN "inventory_movements" m ON m."bundleId" = b.id AND m.type IN ('INITIAL_STOCK', 'ENTRY')
        WHERE b."lotId" = ANY(${ids}::text[])
        GROUP BY b."lotId"`,
      this.prisma.bundle.groupBy({ by: ['lotId'], where: { lotId: { in: ids } }, _sum: { quantity: true } }),
      this.prisma.inboundPreRegistration.groupBy({
        by: ['lotId'],
        where: { lotId: { in: ids }, status: 'PENDING' },
        _count: { _all: true },
        _sum: { expectedQuantity: true },
      }),
    ]);
    const enteredBy = new Map(entered.map((row) => [row.lotId, row]));
    const currentBy = new Map(current.map((row) => [row.lotId, row._sum.quantity ?? 0]));
    const pendingBy = new Map(pending.map((row) => [row.lotId, row]));
    return lots.map((lot) => ({
      ...lot,
      totals: {
        bundles: enteredBy.get(lot.id)?.bundles ?? 0,
        profiles: enteredBy.get(lot.id)?.profiles ?? 0,
        inStock: currentBy.get(lot.id) ?? 0,
        pendingBundles: pendingBy.get(lot.id)?._count._all ?? 0,
        pendingProfiles: pendingBy.get(lot.id)?._sum.expectedQuantity ?? 0,
      },
    }));
  }

  // Historical stock without provenance, grouped for classification.
  async unclassified() {
    const groups = await this.prisma.bundle.groupBy({
      by: ['referenceId', 'finishId', 'inventoryLocationId'],
      where: { lotId: null, quantity: { gt: 0 } },
      _count: { _all: true },
      _sum: { quantity: true },
    });
    const [references, finishes, locations] = await Promise.all([
      this.prisma.reference.findMany({ where: { id: { in: groups.map((g) => g.referenceId) } }, select: { id: true, code: true, description: true } }),
      this.prisma.finish.findMany({ where: { id: { in: groups.map((g) => g.finishId) } }, select: { id: true, code: true, description: true } }),
      this.prisma.inventoryLocation.findMany({ where: { id: { in: groups.map((g) => g.inventoryLocationId) } }, select: { id: true, code: true, name: true } }),
    ]);
    const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((row) => [row.id, row]));
    const refs = byId(references);
    const fins = byId(finishes);
    const locs = byId(locations);
    return groups.map((group) => ({
      reference: refs.get(group.referenceId),
      finish: fins.get(group.finishId),
      location: locs.get(group.inventoryLocationId),
      bundles: group._count._all,
      profiles: group._sum.quantity ?? 0,
    }));
  }

  async createOpening(dto: CreateOpeningLotDto, user: SafeUser) {
    return this.prisma.$transaction(async (tx) => {
      const reference = await tx.reference.findUnique({ where: { id: dto.referenceId } });
      if (!reference) throw new NotFoundException('La referencia no existe');
      const finish = await tx.finish.findUnique({ where: { id: dto.finishId } });
      if (!finish) throw new NotFoundException('El color no existe');
      if (dto.supplierId) {
        const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
        if (!supplier) throw new NotFoundException('El proveedor no existe');
        if (!supplier.origins.includes(dto.origin)) {
          throw new BadRequestException('El proveedor no está habilitado para ese origen');
        }
      } else if (dto.origin === 'CHINA') {
        const supplier = await this.requireChinaSupplier(tx);
        dto.supplierId = supplier.id;
      }
      const lot = await tx.stockLot.create({
        data: {
          code: await nextNumber(tx, 'stock_lot_code_seq', 'LOT'),
          kind: 'OPENING',
          referenceId: dto.referenceId,
          finishId: dto.finishId,
          origin: dto.origin,
          supplierId: dto.supplierId ?? null,
          notes: dto.notes,
          createdById: user.id,
        },
      });
      await audit(tx, { entity: 'StockLot', entityId: lot.id, action: 'OPENING_CREATED', userId: user.id, reason: dto.notes });
      return lot;
    });
  }

  // Classifies existing bundles into a lot. It never creates stock or
  // movements. Moving a bundle that already had a lot is a correction: it
  // needs a reason and is refused while the bundle has active reservations.
  async assignBundles(lotId: string, dto: AssignBundlesDto, user: SafeUser) {
    return this.prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const lot = await tx.stockLot.findUnique({ where: { id: lotId } });
      if (!lot) throw new NotFoundException('El lote no existe');
      const ids = [...dto.bundleIds].sort();
      await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
      const bundles = await tx.bundle.findMany({
        where: { id: { in: ids } },
        include: { reservations: { where: { status: 'ACTIVE' }, select: { id: true } } },
      });
      if (bundles.length !== ids.length) throw new NotFoundException('Algún paquete no existe');
      for (const bundle of bundles) {
        if (bundle.referenceId !== lot.referenceId || bundle.finishId !== lot.finishId) {
          throw new BadRequestException(`El paquete ${bundle.epc} no es de la referencia y color del lote`);
        }
        if (bundle.lotId === lot.id) continue;
        if (bundle.lotId) {
          if (!dto.reason) {
            throw new BadRequestException(`El paquete ${bundle.epc} ya tiene lote: indica el motivo de la corrección`);
          }
          if (bundle.reservations.length > 0) {
            throw new ConflictException(`El paquete ${bundle.epc} está reservado para una orden; libera la reserva antes de corregir su procedencia`);
          }
        }
        await tx.bundle.update({ where: { id: bundle.id }, data: { lotId: lot.id } });
        await audit(tx, {
          entity: 'Bundle',
          entityId: bundle.id,
          action: bundle.lotId ? 'LOT_CORRECTED' : 'LOT_CLASSIFIED',
          userId: user.id,
          reason: dto.reason ?? null,
          data: { fromLotId: bundle.lotId, toLotId: lot.id },
        });
      }
      return { lotId: lot.id, assigned: bundles.length };
    });
  }
}
