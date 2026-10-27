import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MaterialOrigin, Prisma, SalesOrderStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, isLockTimeout, isUniqueViolation, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import { Decimal, dec, sum } from '../../shared/money.js';
import type { SafeUser } from '../auth/auth.types.js';
import { cancelOpenDispatches } from '../dispatch/dispatch-cancel.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import type {
  ConfirmOrderDto,
  ConvertQuoteDto,
  CustomerQueryDto,
  ListQueryDto,
  QuoteLineDto,
  SalePriceQueryDto,
  SaveCustomerDto,
  SaveQuoteDto,
  UpdateOrderLineDto,
} from './dto/sales.dto.js';
import { lineAmounts } from './pricing.js';
import { ReservationsService, type Allocation } from './reservations.service.js';

const orderInclude = {
  customer: { select: { id: true, name: true, taxId: true } },
  inventoryLocation: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  quote: { select: { id: true, number: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      supplier: { select: { id: true, code: true, name: true } },
      reservations: { where: { status: 'ACTIVE' }, select: { quantity: true, dispatchLineId: true } },
      dispatchLines: { select: { quantity: true, dispatchedQuantity: true, dispatch: { select: { status: true } } } },
    },
  },
  dispatches: {
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      number: true,
      status: true,
      dueAt: true,
      partial: true,
      confirmedAt: true,
      assignee: { select: { id: true, name: true } },
      _count: { select: { incidents: { where: { status: 'OPEN' } } } },
    },
  },
} satisfies Prisma.SalesOrderInclude;

type OrderWithLines = Prisma.SalesOrderGetPayload<{ include: typeof orderInclude }>;

// Sales: customers, quotes, orders and their reservations.
//
// Access: ADMIN sees every document; SALES only the documents it created.
// READ_ONLY, WAREHOUSE and CHINA_OPERATOR have no access to prices.
// Costs and profits are ADMIN only: SALES receives the sale price ENABLED by
// administration (built on one purchase line, see supply/sale-prices), and
// the cost fields of quote lines are removed from every response it gets.
// Quotes never reserve stock. Confirming an order reserves the full
// quantities of every line or nothing (shortages are reported and the order
// waits for supply); a partial delivery needs an explicit partial dispatch.
@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
  ) {}

  // --- Customers ------------------------------------------------------------

  listCustomers(query: CustomerQueryDto) {
    return this.prisma.customer.findMany({
      where: {
        active: true,
        ...(query.search
          ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { taxId: { contains: query.search } }] }
          : {}),
      },
      orderBy: { name: 'asc' },
      take: 100,
    });
  }

  createCustomer(dto: SaveCustomerDto, user: SafeUser) {
    return this.prisma.customer.create({ data: { ...this.customerData(dto), createdById: user.id } });
  }

  async updateCustomer(id: string, dto: SaveCustomerDto) {
    if (!(await this.prisma.customer.findUnique({ where: { id } }))) throw new NotFoundException('El cliente no existe');
    return this.prisma.customer.update({ where: { id }, data: this.customerData(dto) });
  }

  private customerData(dto: SaveCustomerDto) {
    return { name: dto.name, taxId: dto.taxId || null, phone: dto.phone || null, email: dto.email || null, address: dto.address || null };
  }

  // --- Prices ---------------------------------------------------------------

  // The price ADMIN enabled for this reference, finish and origin (at most
  // one, unique index). Its cost comes from one specific purchase line.
  enabledPrice(client: Tx | PrismaService, selection: { referenceId: string; finishId: string; origin: MaterialOrigin }) {
    return client.salePrice.findFirst({
      where: { referenceId: selection.referenceId, finishId: selection.finishId, origin: selection.origin, enabled: true },
    });
  }

  async salePrice(query: SalePriceQueryDto) {
    const price = await this.enabledPrice(this.prisma, query);
    if (!price) {
      return {
        available: false,
        message: `Administración aún no habilitó un precio de venta para este perfil de origen ${query.origin === 'CHINA' ? 'China' : 'Nacional'}.`,
      };
    }
    return { available: true, unitPrice: price.unitPrice.toFixed(2) };
  }

  availability(referenceId: string, finishId: string, inventoryLocationId?: string) {
    return this.reservations.availability(referenceId, finishId, inventoryLocationId);
  }

  // --- Quotes ---------------------------------------------------------------

  private quoteScope(user: SafeUser): Prisma.QuoteWhereInput {
    return user.role === 'ADMIN' ? {} : { createdById: user.id };
  }

  async listQuotes(query: ListQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.QuoteWhereInput = {
      ...this.quoteScope(user),
      ...(query.status ? { status: query.status as Prisma.EnumQuoteStatusFilter['equals'] } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.quote.count({ where }),
      this.prisma.quote.findMany({
        where,
        include: { order: { select: { id: true, number: true } }, createdBy: { select: { id: true, name: true } }, _count: { select: { lines: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async getQuote(id: string, user: SafeUser) {
    const quote = await this.prisma.quote.findFirst({
      where: { id, ...this.quoteScope(user) },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        customer: true,
        order: { select: { id: true, number: true } },
        createdBy: { select: { id: true, name: true } },
      },
    });
    // Same answer for "does not exist" and "not yours".
    if (!quote) throw new NotFoundException('La cotización no existe');
    if (user.role === 'ADMIN') return quote;
    return {
      ...quote,
      lines: quote.lines.map(({ pricingMethod: _method, pricingPercent: _percent, costBasis: _cost, costLotId: _lot, priceReason: _reason, ...line }) => line),
    };
  }

  async createQuote(dto: SaveQuoteDto, user: SafeUser) {
    const id = await this.prisma.$transaction(async (tx) => {
      const customer = await this.requireCustomer(tx, dto.customerId);
      const quote = await tx.quote.create({
        data: {
          number: await nextNumber(tx, 'quote_number_seq', 'COT'),
          customerId: customer.id,
          customerName: customer.name,
          validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null,
          notes: dto.notes || null,
          createdById: user.id,
        },
      });
      await this.writeQuoteLines(tx, quote.id, dto.lines);
      return quote.id;
    });
    return this.getQuote(id, user);
  }

  // Replaces the lines of a DRAFT quote. Prices are recomputed now; saved
  // quotes are never recalculated silently afterwards.
  async updateQuote(id: string, dto: SaveQuoteDto, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ status: string; createdById: string }[]>`
        SELECT status, "createdById" FROM "quotes" WHERE id = ${id} FOR UPDATE`;
      if (rows.length === 0 || (user.role !== 'ADMIN' && rows[0].createdById !== user.id)) {
        throw new NotFoundException('La cotización no existe');
      }
      if (rows[0].status !== 'DRAFT') throw new ConflictException('Solo se puede modificar una cotización en borrador');
      const customer = await this.requireCustomer(tx, dto.customerId);
      await tx.quoteLine.deleteMany({ where: { quoteId: id } });
      await tx.quote.update({
        where: { id },
        data: {
          customerId: customer.id,
          customerName: customer.name,
          validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null,
          notes: dto.notes || null,
        },
      });
      await this.writeQuoteLines(tx, id, dto.lines);
    });
    return this.getQuote(id, user);
  }

  async cancelQuote(id: string, user: SafeUser) {
    const { count } = await this.prisma.quote.updateMany({
      where: { id, status: 'DRAFT', ...this.quoteScope(user) },
      data: { status: 'CANCELLED' },
    });
    if (count === 0) throw new ConflictException('La cotización no existe o ya no está en borrador');
    return this.getQuote(id, user);
  }

  private async requireCustomer(tx: Tx, id: string) {
    const customer = await tx.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('El cliente no existe');
    if (!customer.active) throw new BadRequestException('El cliente está inactivo');
    return customer;
  }

  private async writeQuoteLines(tx: Tx, quoteId: string, lines: QuoteLineDto[]) {
    const totals = { subtotal: [] as Decimal[], discount: [] as Decimal[], tax: [] as Decimal[], total: [] as Decimal[] };
    for (const [index, line] of lines.entries()) {
      const reference = await tx.reference.findUnique({ where: { id: line.referenceId } });
      if (!reference?.active) throw new BadRequestException(`Renglón ${index + 1}: la referencia no existe o está inactiva`);
      const finish = await tx.finish.findUnique({ where: { id: line.finishId } });
      if (!finish?.active) throw new BadRequestException(`Renglón ${index + 1}: el color no existe o está inactivo`);
      let supplierName: string | null = null;
      if (line.supplierId) {
        const supplier = await tx.supplier.findUnique({ where: { id: line.supplierId } });
        if (!supplier?.active || !supplier.origins.includes(line.origin)) {
          throw new BadRequestException(`Renglón ${index + 1}: el proveedor no está activo o no suministra ese origen`);
        }
        supplierName = supplier.name;
      }
      const discountPercent = dec(line.discountPercent);
      const taxRatePercent = dec(line.taxRatePercent);
      if (discountPercent.greaterThan(100) || taxRatePercent.greaterThan(100)) {
        throw new BadRequestException(`Renglón ${index + 1}: los porcentajes no pueden superar 100`);
      }
      // Values copied from the enabled price: later changes never touch it.
      const price = await this.enabledPrice(tx, line);
      if (!price) {
        throw new BadRequestException(
          `Renglón ${index + 1}: no hay precio de venta habilitado para ${reference.code} ${finish.code} (${line.origin === 'CHINA' ? 'China' : 'Nacional'}). Pide a administración que lo habilite.`,
        );
      }
      const unitPrice = price.unitPrice;
      const amounts = lineAmounts(line.quantity, unitPrice, discountPercent, taxRatePercent);
      totals.subtotal.push(amounts.lineSubtotal);
      totals.discount.push(amounts.discountAmount);
      totals.tax.push(amounts.taxAmount);
      totals.total.push(amounts.lineTotal);
      await tx.quoteLine.create({
        data: {
          quoteId,
          lineNo: index + 1,
          referenceId: line.referenceId,
          finishId: line.finishId,
          origin: line.origin,
          supplierId: line.supplierId ?? null,
          quantity: line.quantity,
          pricingMethod: 'MARKUP_ON_COST',
          pricingPercent: price.markupPercent,
          costBasis: price.unitCost,
          salePriceId: price.id,
          unitPrice,
          discountPercent,
          taxRatePercent,
          ...amounts,
          referenceCode: reference.code,
          referenceDescription: reference.description,
          finishCode: finish.code,
          finishDescription: finish.description,
          supplierName,
        },
      });
    }
    await tx.quote.update({
      where: { id: quoteId },
      data: { subtotal: sum(totals.subtotal), discountTotal: sum(totals.discount), taxTotal: sum(totals.tax), total: sum(totals.total) },
    });
  }

  // One quote → one order. Idempotent: the same operationKey (double click,
  // lost response) returns the same order; the quote's unique link refuses a
  // second order with another key.
  async convertQuote(id: string, dto: ConvertQuoteDto, user: SafeUser) {
    try {
      const orderId = await this.prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<{ status: string; createdById: string }[]>`
          SELECT status, "createdById" FROM "quotes" WHERE id = ${id} FOR UPDATE`;
        if (rows.length === 0 || (user.role !== 'ADMIN' && rows[0].createdById !== user.id)) {
          throw new NotFoundException('La cotización no existe');
        }
        // Checked after the lock: a simultaneous request with the same key
        // that committed meanwhile is returned, not reported as a conflict.
        const replay = await tx.salesOrder.findUnique({ where: { convertOperationKey: dto.operationKey } });
        if (replay) {
          if (replay.quoteId !== id) throw new ConflictException('La clave de operación ya se usó con otra cotización');
          return replay.id;
        }
        const existing = await tx.salesOrder.findUnique({ where: { quoteId: id }, select: { number: true } });
        if (existing) throw new ConflictException(`La cotización ya se convirtió en la orden ${existing.number}`);
        if (rows[0].status !== 'DRAFT') throw new ConflictException('Solo se convierte una cotización vigente (borrador)');
        const quote = await tx.quote.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
        const order = await tx.salesOrder.create({
          data: {
            number: await nextNumber(tx, 'sales_order_number_seq', 'OV'),
            quoteId: quote.id,
            customerId: quote.customerId,
            customerName: quote.customerName,
            currency: quote.currency,
            subtotal: quote.subtotal,
            discountTotal: quote.discountTotal,
            taxTotal: quote.taxTotal,
            total: quote.total,
            notes: quote.notes,
            convertOperationKey: dto.operationKey,
            createdById: quote.createdById,
            lines: {
              create: quote.lines.map((line) => ({
                lineNo: line.lineNo,
                referenceId: line.referenceId,
                finishId: line.finishId,
                origin: line.origin,
                supplierId: line.supplierId,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                discountPercent: line.discountPercent,
                taxRatePercent: line.taxRatePercent,
                lineSubtotal: line.lineSubtotal,
                discountAmount: line.discountAmount,
                taxAmount: line.taxAmount,
                lineTotal: line.lineTotal,
                referenceCode: line.referenceCode,
                referenceDescription: line.referenceDescription,
                finishCode: line.finishCode,
                finishDescription: line.finishDescription,
                supplierName: line.supplierName,
                salePriceId: line.salePriceId,
              })),
            },
          },
        });
        await tx.quote.update({ where: { id }, data: { status: 'CONVERTED' } });
        return order.id;
      });
      return this.getOrder(orderId, user);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replay = await this.prisma.salesOrder.findUnique({ where: { convertOperationKey: dto.operationKey } });
        if (replay?.quoteId === id) return this.getOrder(replay.id, user);
        const existing = await this.prisma.salesOrder.findUnique({ where: { quoteId: id }, select: { number: true } });
        throw new ConflictException(existing ? `La cotización ya se convirtió en la orden ${existing.number}` : 'La cotización ya se convirtió');
      }
      throw error;
    }
  }

  // --- Orders ---------------------------------------------------------------

  orderScope(user: SafeUser): Prisma.SalesOrderWhereInput {
    return user.role === 'ADMIN' ? {} : { createdById: user.id };
  }

  async listOrders(query: ListQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.SalesOrderWhereInput = {
      ...this.orderScope(user),
      ...(query.status ? { status: query.status as SalesOrderStatus } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.salesOrder.count({ where }),
      this.prisma.salesOrder.findMany({
        where,
        include: { createdBy: { select: { id: true, name: true } }, _count: { select: { lines: true, dispatches: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async getOrder(id: string, user: SafeUser) {
    const order = await this.prisma.salesOrder.findFirst({ where: { id, ...this.orderScope(user) }, include: orderInclude });
    if (!order) throw new NotFoundException('La orden no existe');
    return this.withFulfilment(order);
  }

  // Derived fulfilment per line (single source of truth: reservations and
  // dispatch lines). Never stored on the order.
  withFulfilment(order: OrderWithLines) {
    const lines = order.lines.map((line) => {
      const reserved = line.reservations.reduce((total, r) => total + r.quantity, 0);
      const live = line.dispatchLines.filter((dl) => dl.dispatch.status !== 'CANCELLED');
      const authorised = live.reduce((total, dl) => total + dl.quantity, 0);
      const dispatched = line.dispatchLines.reduce((total, dl) => total + dl.dispatchedQuantity, 0);
      const { reservations: _reservations, dispatchLines: _dispatchLines, ...rest } = line;
      return {
        ...rest,
        reservedQuantity: reserved,
        authorisedQuantity: authorised,
        dispatchedQuantity: dispatched,
        pendingQuantity: line.quantity - dispatched,
        unauthorisedQuantity: line.quantity - authorised,
      };
    });
    return { ...order, lines };
  }

  async updateOrderLine(orderId: string, lineId: string, dto: UpdateOrderLineDto, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, orderId, user);
      if (!['DRAFT', 'PENDING_SUPPLY'].includes(order.status)) {
        throw new ConflictException('El origen solo se cambia antes de confirmar la orden');
      }
      const line = await tx.salesOrderLine.findFirst({ where: { id: lineId, salesOrderId: orderId } });
      if (!line) throw new NotFoundException('El renglón no pertenece a la orden');
      let supplierName: string | null = null;
      if (dto.supplierId) {
        const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
        if (!supplier?.active || !supplier.origins.includes(dto.origin)) {
          throw new BadRequestException('El proveedor no está activo o no suministra ese origen');
        }
        supplierName = supplier.name;
      }
      await tx.salesOrderLine.update({ where: { id: lineId }, data: { origin: dto.origin, supplierId: dto.supplierId ?? null, supplierName } });
      await audit(tx, {
        entity: 'SalesOrderLine',
        entityId: lineId,
        action: 'PROVENANCE_CHANGED',
        userId: user.id,
        reason: dto.reason,
        data: { from: { origin: line.origin, supplierId: line.supplierId }, to: { origin: dto.origin, supplierId: dto.supplierId ?? null } },
      });
    });
    return this.getOrder(orderId, user);
  }

  async lockOrder(tx: Tx, id: string, user: SafeUser) {
    await setLockTimeout(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "sales_orders" WHERE id = ${id} FOR UPDATE`;
    const order = rows.length ? await tx.salesOrder.findFirst({ where: { id, ...this.orderScope(user) } }) : null;
    if (!order) throw new NotFoundException('La orden no existe');
    return order;
  }

  // Reserves the full pending quantity of every line in the chosen location,
  // or nothing. Idempotent by state (a confirmed order is returned as is).
  async confirmOrder(id: string, dto: ConfirmOrderDto, user: SafeUser) {
    try {
      const outcome = await this.prisma.$transaction(
        async (tx) => {
          const order = await this.lockOrder(tx, id, user);
          if (order.status === 'CONFIRMED' || order.status === 'COMPLETED') return { confirmed: true, shortages: [] };
          if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada');
          const location = await tx.inventoryLocation.findUnique({ where: { id: dto.inventoryLocationId }, include: { branch: true } });
          if (!location?.active || !location.branch.active) throw new BadRequestException('La ubicación no existe o está inactiva');

          const lines = await tx.salesOrderLine.findMany({ where: { salesOrderId: id }, orderBy: { lineNo: 'asc' }, include: { dispatchLines: { include: { dispatch: true } } } });
          // Lock every candidate bundle of every line once, in id order.
          const candidates = new Set<string>();
          for (const line of lines) {
            for (const bundleId of await this.reservations.candidateIds(tx, line, dto.inventoryLocationId)) candidates.add(bundleId);
          }
          await this.reservations.lockBundles(tx, [...candidates]);

          const taken = new Map<string, number>();
          const plans: { lineId: string; allocations: Allocation[] }[] = [];
          const shortages: { lineNo: number; referenceCode: string; finishCode: string; origin: MaterialOrigin; required: number; available: number; missing: number }[] = [];
          for (const line of lines) {
            // Quantities already authorised in partial dispatches keep their own reservations.
            const authorised = line.dispatchLines.filter((dl) => dl.dispatch.status !== 'CANCELLED').reduce((total, dl) => total + dl.quantity, 0);
            const required = line.quantity - authorised;
            if (required <= 0) continue;
            const plan = await this.reservations.plan(tx, line, dto.inventoryLocationId, required, taken);
            if (plan.shortage > 0) {
              shortages.push({ lineNo: line.lineNo, referenceCode: line.referenceCode, finishCode: line.finishCode, origin: line.origin, required, available: plan.available, missing: plan.shortage });
            }
            for (const allocation of plan.allocations) taken.set(allocation.bundleId, (taken.get(allocation.bundleId) ?? 0) + allocation.quantity);
            plans.push({ lineId: line.id, allocations: plan.allocations });
          }
          if (shortages.length > 0) {
            await tx.salesOrder.update({ where: { id }, data: { status: 'PENDING_SUPPLY', inventoryLocationId: dto.inventoryLocationId } });
            return { confirmed: false, shortages };
          }
          for (const plan of plans) {
            for (const allocation of plan.allocations) {
              await tx.stockReservation.create({
                data: { bundleId: allocation.bundleId, salesOrderLineId: plan.lineId, quantity: allocation.quantity, createdById: user.id },
              });
            }
          }
          await tx.salesOrder.update({ where: { id }, data: { status: 'CONFIRMED', inventoryLocationId: dto.inventoryLocationId, confirmedAt: new Date() } });
          return { confirmed: true, shortages: [] };
        },
        { maxWait: 10000, timeout: 30000 },
      );
      return { ...outcome, order: await this.getOrder(id, user) };
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('Hay paquetes ocupados por otra operación; reintenta la confirmación en unos segundos.');
      throw error;
    }
  }

  // Releases pending reservations and open dispatches; confirmed exits stay.
  async cancelOrder(id: string, reason: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.status === 'CANCELLED') return;
      if (order.status === 'COMPLETED') throw new ConflictException('La orden ya fue entregada por completo');
      const open = await tx.dispatch.findMany({ where: { salesOrderId: id, status: 'OPEN' }, select: { id: true } });
      await cancelOpenDispatches(tx, { dispatchIds: open.map((d) => d.id), reason, userId: user.id, keepReservations: false });
      await tx.stockReservation.updateMany({
        where: { salesOrderLine: { salesOrderId: id }, status: 'ACTIVE' },
        data: { status: 'RELEASED', closedAt: new Date() },
      });
      await tx.salesOrder.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await audit(tx, { entity: 'SalesOrder', entityId: id, action: 'CANCELLED', userId: user.id, reason });
    });
    return this.getOrder(id, user);
  }

  // SALES may act only on its own orders (BOLA). ADMIN on any.
  assertOwner(order: { createdById: string }, user: SafeUser) {
    if (user.role !== 'ADMIN' && order.createdById !== user.id) throw new ForbiddenException('No tienes permisos sobre esta orden');
  }
}

