import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { audit, isUniqueViolation, setLockTimeout, type Tx } from '../../shared/db.js';
import { ZERO, dec, sum, unitCost } from '../../shared/money.js';
import type { SafeUser } from '../auth/auth.types.js';
import { computePurchase, computeTaxOnNetLine } from './costing.js';
import type { LinkLotsDto, PurchaseQueryDto, SavePurchaseDto } from './dto/supply.dto.js';

const purchaseInclude = {
  supplier: { select: { id: true, code: true, name: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      reference: { select: { id: true, code: true, description: true } },
      finish: { select: { id: true, code: true, description: true } },
      lots: { select: { id: true, code: true, unitCost: true, _count: { select: { bundles: true } } } },
    },
  },
  charges: { orderBy: { createdAt: 'asc' } },
  createdBy: { select: { id: true, name: true } },
  confirmedBy: { select: { id: true, name: true } },
} satisfies Prisma.PurchaseInclude;

// Purchase documents and acquisition cost (ADMIN only). Separate from sales
// quotes; connected to lots, whose cost they confirm, and to the sale prices
// built on each line. A confirmed document is frozen: later corrections are
// new documents or audited lot links.
//
// Lines are saved with the current rule (taxOnNet), in the order of the
// invoice: gross value WITHOUT purchase VAT, percentage discount, VAT on the
// discounted base, profiles → cost per profile (VAT included). Lines recorded
// with earlier rules (grossIncludesTax, or the first itemised definition)
// keep their stored amounts.
@Injectable()
export class PurchasesService {
  constructor(private readonly prisma: PrismaService) {}

  // Filters combine freely (AND); with none, the latest documents.
  async list(query: PurchaseQueryDto) {
    const day = (value: string, field: string) => {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException(`${field}: la fecha no existe`);
      return date;
    };
    const from = query.dateFrom ? day(query.dateFrom, 'Desde') : undefined;
    const to = query.dateTo ? day(query.dateTo, 'Hasta') : undefined;
    if (from && to && from > to) throw new BadRequestException('La fecha «desde» es posterior a la fecha «hasta»');
    const lineFilter: Prisma.PurchaseLineWhereInput = {
      ...(query.referenceId ? { referenceId: query.referenceId } : {}),
      ...(query.familyId ? { reference: { familyId: query.familyId } } : {}),
    };
    return this.prisma.purchase.findMany({
      where: {
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(from || to ? { documentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(Object.keys(lineFilter).length > 0 ? { lines: { some: lineFilter } } : {}),
      },
      include: { supplier: { select: { id: true, code: true, name: true } }, _count: { select: { lines: true } } },
      orderBy: [{ documentDate: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    });
  }

  async get(id: string) {
    const purchase = await this.prisma.purchase.findUnique({ where: { id }, include: purchaseInclude });
    if (!purchase) throw new NotFoundException('La compra no existe');
    return { ...purchase, issues: this.issuesOf(purchase) };
  }

  create(dto: SavePurchaseDto, user: SafeUser) {
    return this.save(null, dto, user);
  }

  update(id: string, dto: SavePurchaseDto, user: SafeUser) {
    return this.save(id, dto, user);
  }

  // Replaces the whole draft (lines, charges, lot links) and recomputes it.
  private async save(id: string | null, dto: SavePurchaseDto, user: SafeUser) {
    try {
      const saved = await this.prisma.$transaction(async (tx) => {
        await setLockTimeout(tx);
        const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
        if (!supplier) throw new NotFoundException('El proveedor no existe');
        if (id) {
          const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "purchases" WHERE id = ${id} FOR UPDATE`;
          if (rows.length === 0) throw new NotFoundException('La compra no existe');
          if (rows[0].status !== 'DRAFT') throw new ConflictException('La compra está confirmada y no se puede modificar');
        }
        for (const line of dto.lines) {
          if (!supplier.origins.includes(line.origin)) {
            throw new BadRequestException(`El proveedor ${supplier.name} no está habilitado para material de origen ${line.origin}`);
          }
        }
        dto.lines.forEach((line, index) => {
          if (dec(line.discountPercent).greaterThan(100)) throw new BadRequestException(`Renglón ${index + 1}: el descuento no puede superar 100 %`);
          if (dec(line.taxRatePercent).greaterThan(100)) throw new BadRequestException(`Renglón ${index + 1}: el IVA no puede superar 100 %`);
        });
        const costing = dto.lines.map((line) => computeTaxOnNetLine(dec(line.grossAmount), dec(line.discountPercent), dec(line.taxRatePercent), line.quantity));
        const grossTotal = sum(dto.lines.map((line) => dec(line.grossAmount)));
        const discountTotal = sum(costing.map((line) => line.discountAmount));
        const netTotal = sum(costing.map((line) => line.netAmount));
        const taxTotal = sum(costing.map((line) => line.taxAmount));
        const header = {
          supplierId: dto.supplierId,
          documentNumber: dto.documentNumber,
          documentDate: new Date(`${dto.documentDate}T00:00:00.000Z`),
          currency: 'COP',
          exchangeRate: null,
          exchangeRateDate: null,
          exchangeRateSource: null,
          globalDiscountType: 'NONE' as const,
          globalDiscountValue: ZERO,
          conditionalDiscountNote: null,
          notes: dto.notes || null,
          grossTotal,
          lineDiscountTotal: discountTotal,
          globalDiscountTotal: ZERO,
          // Without VAT, after the discount.
          netTotal,
          taxTotal,
          chargesTotal: ZERO,
          documentTotal: netTotal.plus(taxTotal),
        };
        let purchaseId = id;
        if (purchaseId) {
          await tx.stockLot.updateMany({ where: { purchaseLine: { purchaseId } }, data: { purchaseLineId: null } });
          await tx.purchaseLine.deleteMany({ where: { purchaseId } });
          await tx.purchaseCharge.deleteMany({ where: { purchaseId } });
          await tx.purchase.update({ where: { id: purchaseId }, data: header });
        } else {
          purchaseId = (await tx.purchase.create({ data: { ...header, createdById: user.id }, select: { id: true } })).id;
        }
        for (const [index, line] of dto.lines.entries()) {
          const computed = costing[index];
          const discountPercent = dec(line.discountPercent);
          const created = await tx.purchaseLine.create({
            data: {
              purchaseId,
              lineNo: index + 1,
              referenceId: line.referenceId,
              finishId: line.finishId,
              origin: line.origin,
              unitName: 'perfil',
              profilesPerUnit: dec(1),
              quantity: dec(line.quantity),
              // Gross value per profile, without VAT (informative).
              unitPrice: unitCost(dec(line.grossAmount).dividedBy(line.quantity)),
              lineDiscountType: discountPercent.isZero() ? 'NONE' : 'PERCENT',
              lineDiscountValue: discountPercent,
              taxRatePercent: dec(line.taxRatePercent),
              // VAT is part of the cost (not treated as recoverable).
              taxRecoverable: false,
              grossIncludesTax: false,
              taxOnNet: true,
              grossAmount: dec(line.grossAmount),
              lineDiscountAmount: computed.discountAmount,
              globalDiscountAmount: ZERO,
              netAmount: computed.netAmount,
              taxAmount: computed.taxAmount,
              chargesAmount: ZERO,
              costAmount: computed.costAmount,
              costAmountCop: computed.costAmount,
              profiles: line.quantity,
              unitCostCop: computed.unitCost,
            },
          });
          if (line.lotIds?.length) await this.linkLots(tx, created.id, line.lotIds, dto.supplierId);
        }
        return purchaseId;
      });
      return this.get(saved);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe una compra de ese proveedor con ese número de documento');
      throw error;
    }
  }

  // A lot can document its cost with one purchase line only: same material,
  // origin and supplier; never a lot whose cost was confirmed elsewhere.
  private async linkLots(tx: Tx, lineId: string, lotIds: string[], supplierId: string) {
    const line = await tx.purchaseLine.findUniqueOrThrow({ where: { id: lineId } });
    const lots = await tx.stockLot.findMany({ where: { id: { in: lotIds } } });
    if (lots.length !== lotIds.length) throw new NotFoundException('Algún lote no existe');
    for (const lot of lots) {
      if (lot.referenceId !== line.referenceId || lot.finishId !== line.finishId || lot.origin !== line.origin) {
        throw new BadRequestException(`El lote ${lot.code} no es del material y origen del renglón ${line.lineNo}`);
      }
      if (lot.supplierId && lot.supplierId !== supplierId) {
        throw new BadRequestException(`El lote ${lot.code} es de otro proveedor`);
      }
      if (lot.unitCost !== null || (lot.purchaseLineId && lot.purchaseLineId !== line.id)) {
        throw new ConflictException(`El lote ${lot.code} ya tiene su costo documentado por otra compra`);
      }
    }
    await tx.stockLot.updateMany({ where: { id: { in: lotIds } }, data: { purchaseLineId: line.id } });
  }

  private issuesOf(purchase: Prisma.PurchaseGetPayload<{ include: typeof purchaseInclude }>): string[] {
    if (purchase.status !== 'DRAFT') return [];
    if (purchase.lines.every((line) => line.taxOnNet || line.grossIncludesTax)) {
      const issues = purchase.lines.length === 0 ? ['La compra no tiene renglones'] : [];
      for (const line of purchase.lines) {
        if (!line.unitCostCop) issues.push(`Renglón ${line.lineNo}: el costo resultante es cero`);
      }
      return issues;
    }
    // Draft recorded with the earlier definition: its own checks.
    return computePurchase({
      currency: purchase.currency,
      exchangeRate: purchase.exchangeRate,
      globalDiscountType: purchase.globalDiscountType,
      globalDiscountValue: purchase.globalDiscountValue,
      charges: purchase.charges.map((charge) => charge.amount),
      lines: purchase.lines.map((line) => ({
        lineNo: line.lineNo,
        quantity: line.quantity,
        profilesPerUnit: line.profilesPerUnit,
        unitPrice: line.unitPrice,
        lineDiscountType: line.lineDiscountType,
        lineDiscountValue: line.lineDiscountValue,
        taxRatePercent: line.taxRatePercent,
        taxRecoverable: line.taxRecoverable,
      })),
    }).issues.concat(
      purchase.currency !== 'COP' && (!purchase.exchangeRateDate || !purchase.exchangeRateSource)
        ? ['Moneda extranjera: indica la fecha y la fuente de la tasa aplicada']
        : [],
    );
  }

  // Freezes the document and confirms the cost of its linked lots.
  async confirm(id: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM "purchases" WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundException('La compra no existe');
      if (rows[0].status !== 'DRAFT') throw new ConflictException('La compra ya estaba confirmada');
      const purchase = await tx.purchase.findUniqueOrThrow({ where: { id }, include: purchaseInclude });
      const issues = this.issuesOf(purchase);
      if (issues.length > 0) {
        throw new BadRequestException({ statusCode: 400, message: 'La compra tiene datos pendientes y no se confirmó', issues });
      }
      const now = new Date();
      await tx.purchase.update({ where: { id }, data: { status: 'CONFIRMED', confirmedById: user.id, confirmedAt: now } });
      for (const line of purchase.lines) {
        for (const lot of line.lots) {
          await tx.stockLot.update({ where: { id: lot.id }, data: { unitCost: line.unitCostCop, costConfirmedAt: now } });
          await audit(tx, {
            entity: 'StockLot',
            entityId: lot.id,
            action: 'COST_CONFIRMED',
            userId: user.id,
            data: { purchaseId: id, lineNo: line.lineNo, unitCostCop: line.unitCostCop?.toString() ?? null },
          });
        }
      }
    });
    return this.get(id);
  }

  // Links lots to a line of a CONFIRMED purchase (e.g. bundles received after
  // the invoice). Audited; never overwrites a cost already confirmed.
  async linkAfterConfirmation(id: string, dto: LinkLotsDto, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      await setLockTimeout(tx);
      const purchase = await tx.purchase.findUnique({ where: { id } });
      if (!purchase) throw new NotFoundException('La compra no existe');
      if (purchase.status !== 'CONFIRMED') throw new BadRequestException('Para un borrador, asocia los lotes al guardar la compra');
      const line = await tx.purchaseLine.findFirst({ where: { id: dto.lineId, purchaseId: id } });
      if (!line) throw new NotFoundException('El renglón no pertenece a esta compra');
      await tx.$queryRaw`SELECT id FROM "stock_lots" WHERE id = ANY(${[...dto.lotIds].sort()}::text[]) ORDER BY id FOR UPDATE`;
      await this.linkLots(tx, line.id, dto.lotIds, purchase.supplierId);
      const now = new Date();
      await tx.stockLot.updateMany({ where: { id: { in: dto.lotIds } }, data: { unitCost: line.unitCostCop, costConfirmedAt: now } });
      for (const lotId of dto.lotIds) {
        await audit(tx, {
          entity: 'StockLot',
          entityId: lotId,
          action: 'COST_LINKED_AFTER_CONFIRMATION',
          userId: user.id,
          reason: dto.reason,
          data: { purchaseId: id, lineNo: line.lineNo, unitCostCop: line.unitCostCop?.toString() ?? null },
        });
      }
    });
    return this.get(id);
  }
}
