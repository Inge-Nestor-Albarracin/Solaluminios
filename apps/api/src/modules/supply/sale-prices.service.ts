import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MaterialOrigin, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { audit, isUniqueViolation, setLockTimeout, type Tx } from '../../shared/db.js';
import { dec } from '../../shared/money.js';
import type { SafeUser } from '../auth/auth.types.js';
import { markupOnCost } from '../sales/pricing.js';
import type { CreateSalePriceDto, SalePriceQueryDto } from './dto/supply.dto.js';

const salePriceInclude = {
  purchaseLine: {
    select: {
      id: true,
      lineNo: true,
      profiles: true,
      grossAmount: true,
      lineDiscountValue: true,
      reference: { select: { id: true, code: true, description: true } },
      finish: { select: { id: true, code: true, description: true } },
      purchase: {
        select: { id: true, documentNumber: true, documentDate: true, supplier: { select: { id: true, code: true, name: true } } },
      },
    },
  },
  createdBy: { select: { id: true, name: true } },
} satisfies Prisma.SalePriceInclude;

// Sale prices built on ONE line of ONE confirmed purchase (ADMIN only).
//
//   Purchase → PurchaseLine (cost per profile, purchase VAT included)
//            → SalePrice (profit on that cost, sale price before sales VAT)
//
// The cost always comes from the chosen line: never an average, the lowest
// or the latest purchase. A price is immutable (another margin is another
// price). The administrator decides which price sales receive for a
// reference, finish and origin by enabling it; enabling disables the
// previous one (kept, never deleted). Quotes copy the values they used.
@Injectable()
export class SalePricesService {
  constructor(private readonly prisma: PrismaService) {}

  list(query: SalePriceQueryDto) {
    return this.prisma.salePrice.findMany({
      where: {
        ...(query.referenceId ? { referenceId: query.referenceId } : {}),
        ...(query.finishId ? { finishId: query.finishId } : {}),
        ...(query.origin ? { origin: query.origin } : {}),
        ...(query.purchaseId ? { purchaseLine: { purchaseId: query.purchaseId } } : {}),
      },
      include: salePriceInclude,
      orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
  }

  async create(dto: CreateSalePriceDto, user: SafeUser) {
    return this.inTransaction(async (tx) => {
      const line = await tx.purchaseLine.findUnique({ where: { id: dto.purchaseLineId }, include: { purchase: true } });
      // The line must belong to the purchase the administrator selected.
      if (!line || line.purchaseId !== dto.purchaseId) throw new NotFoundException('El renglón no pertenece a esa compra');
      if (line.purchase.status !== 'CONFIRMED') throw new BadRequestException('Confirma la compra antes de crear su precio de venta');
      if (!line.taxOnNet && !line.grossIncludesTax) {
        throw new BadRequestException('Este renglón se registró con la definición de costo anterior; registra la compra con valor bruto, descuento e IVA');
      }
      if (!line.unitCostCop) throw new BadRequestException('El renglón no tiene costo por perfil');
      const markupPercent = dec(dto.markupPercent);
      if (markupPercent.greaterThan(1000)) throw new BadRequestException('La ganancia no puede superar 1000 %');
      const { price } = markupOnCost(line.unitCostCop, markupPercent);
      if (dto.enabled) await this.disableEnabled(tx, line);
      const now = new Date();
      // Material copied from the line; the composite foreign key makes any
      // other combination impossible in the database.
      const created = await tx.salePrice.create({
        data: {
          purchaseLineId: line.id,
          referenceId: line.referenceId,
          finishId: line.finishId,
          origin: line.origin,
          unitCost: line.unitCostCop,
          markupPercent,
          unitPrice: price,
          enabled: dto.enabled === true,
          enabledAt: dto.enabled ? now : null,
          createdById: user.id,
        },
      });
      await audit(tx, {
        entity: 'SalePrice',
        entityId: created.id,
        action: dto.enabled ? 'CREATED_ENABLED' : 'CREATED',
        userId: user.id,
        data: { purchaseLineId: line.id, unitCost: line.unitCostCop.toString(), markupPercent: markupPercent.toString(), unitPrice: price.toFixed(2) },
      });
      return created.id;
    });
  }

  async enable(id: string, user: SafeUser) {
    return this.inTransaction(async (tx) => {
      const price = await tx.salePrice.findUnique({ where: { id } });
      if (!price) throw new NotFoundException('El precio de venta no existe');
      if (price.enabled) return id;
      await this.disableEnabled(tx, price);
      await tx.salePrice.update({ where: { id }, data: { enabled: true, enabledAt: new Date(), disabledAt: null } });
      await audit(tx, { entity: 'SalePrice', entityId: id, action: 'ENABLED', userId: user.id });
      return id;
    });
  }

  async disable(id: string, user: SafeUser) {
    return this.inTransaction(async (tx) => {
      const price = await tx.salePrice.findUnique({ where: { id } });
      if (!price) throw new NotFoundException('El precio de venta no existe');
      if (!price.enabled) return id;
      await tx.salePrice.update({ where: { id }, data: { enabled: false, disabledAt: new Date() } });
      await audit(tx, { entity: 'SalePrice', entityId: id, action: 'DISABLED', userId: user.id });
      return id;
    });
  }

  // Serialised per reference, finish and origin; the partial unique index
  // guarantees a single enabled price even if this lock were bypassed.
  private async disableEnabled(tx: Tx, selection: { referenceId: string; finishId: string; origin: MaterialOrigin }) {
    const key = `sale-price:${selection.referenceId}:${selection.finishId}:${selection.origin}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
    await tx.salePrice.updateMany({
      where: { referenceId: selection.referenceId, finishId: selection.finishId, origin: selection.origin, enabled: true },
      data: { enabled: false, disabledAt: new Date() },
    });
  }

  private async inTransaction(work: (tx: Tx) => Promise<string>) {
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await setLockTimeout(tx);
        return work(tx);
      });
      return this.prisma.salePrice.findUniqueOrThrow({ where: { id }, include: salePriceInclude });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Otro precio se habilitó a la vez para el mismo perfil; recarga e inténtalo de nuevo');
      throw error;
    }
  }
}
