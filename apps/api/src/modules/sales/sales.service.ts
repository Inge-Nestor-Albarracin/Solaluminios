import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { MaterialOrigin, PaymentMethod, PaymentStatus, Prisma, QuoteStatus, SalesOrderStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, isLockTimeout, isUniqueViolation, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import { Decimal, dec } from '../../shared/money.js';
import type { SafeUser } from '../auth/auth.types.js';
import { cancelOpenDispatches } from '../dispatch/dispatch-cancel.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import { enqueue } from '../notifications/outbox.js';
import type {
  ConfirmOrderDto,
  ConvertQuoteDto,
  CustomerQueryDto,
  DiscountRequestDto,
  ListQueryDto,
  QuoteLineDto,
  SalePriceQueryDto,
  SaveCustomerDto,
  SaveQuoteDto,
  UpdateOrderLineDto,
} from './dto/sales.dto.js';
import {
  GLOBAL_DISCOUNT_MIN,
  SELLER_GLOBAL_DISCOUNT_LIMIT,
  documentTotals,
  lineAmounts,
  withGlobalDiscount,
  type LineAmounts,
} from './pricing.js';
import { renderSalesPdf } from './sales-pdf.js';
import { ReservationsService, type Allocation } from './reservations.service.js';

const orderInclude = {
  customer: { select: { id: true, name: true, taxId: true } },
  inventoryLocation: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  convertedBy: { select: { id: true, name: true } },
  paymentStatusBy: { select: { id: true, name: true } },
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

const QUOTE_STATUS = { DRAFT: 'Vigente', CONVERTED: 'Convertida en orden', CANCELLED: 'Cancelada' } as const;
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Contado – efectivo',
  TRANSFER: 'Contado – transferencia',
  PARTIAL: 'Abono',
  CREDIT: 'Cartera (crédito)',
};

// Who created a quote or an order (and who changed its payment state) is
// shown to ADMIN only: other roles get the documents without `createdBy`,
// `convertedBy` and `paymentStatusBy` (SALES only sees its own documents
// anyway). Printable documents keep the seller's name.
function forViewer<T extends object>(document: T, user: SafeUser): T {
  if (user.role === 'ADMIN') return document;
  const { createdBy: _createdBy, convertedBy: _convertedBy, paymentStatusBy: _paymentStatusBy, ...rest } = document as T & {
    createdBy?: unknown;
    convertedBy?: unknown;
    paymentStatusBy?: unknown;
  };
  return rest as T;
}

// Payment methods whose collection is followed (paid / pending).
const COLLECTED_LATER: readonly PaymentMethod[] = ['PARTIAL', 'CREDIT'];

const authorSelect = { select: { id: true, name: true } } as const;

// Time the chosen administrator has to answer a discount request. After it the
// task stays pending, flagged as overdue (it is never lost).
const DISCOUNT_ANSWER_HOURS = 24;
const DISCOUNT_STATUS = { PENDING: 'pendiente', APPROVED: 'aprobada', REJECTED: 'rechazada', CANCELLED: 'cancelada' } as const;
// «2,5» for messages and task titles.
const percentText = (value: Decimal) => Number(value.toString()).toLocaleString('es-CO', { maximumFractionDigits: 2 });
const moneyText = (value: Decimal) =>
  new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(Number(value.toString()));
const ORDER_STATUS = {
  DRAFT: 'Por confirmar',
  PENDING_SUPPLY: 'Pendiente de abastecimiento',
  CONFIRMED: 'Reservada',
  COMPLETED: 'Entregada',
  CANCELLED: 'Cancelada',
} as const;

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
        include: { order: { select: { id: true, number: true } }, ...(user.role === 'ADMIN' ? { createdBy: authorSelect } : {}), _count: { select: { lines: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async getQuote(id: string, user: SafeUser) {
    return forViewer(await this.loadQuote(id, user), user);
  }

  // Full quote (with its author) for internal use, e.g. the printable copy.
  private async loadQuote(id: string, user: SafeUser) {
    const quote = await this.prisma.quote.findFirst({
      where: { id, ...this.quoteScope(user) },
      include: {
        lines: { orderBy: { lineNo: 'asc' } },
        customer: true,
        order: { select: { id: true, number: true } },
        createdBy: { select: { id: true, name: true } },
        discountRequests: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
          include: { requestedBy: authorSelect, approver: authorSelect },
        },
      },
    });
    // Same answer for "does not exist" and "not yours".
    if (!quote) throw new NotFoundException('La cotización no existe');
    const limit = user.role === 'ADMIN' ? new Decimal(100) : await this.sellerLimit(this.prisma, quote.id);
    // The open request shows what the quote would become if approved.
    const discountRequests = quote.discountRequests.map((request) => ({
      ...request,
      projected: request.status === 'PENDING' ? documentTotals(withGlobalDiscount(quote.lines, request.requestedPercent)) : null,
    }));
    const withRequests = { ...quote, discountRequests, globalDiscountLimit: limit.toString() };
    if (user.role === 'ADMIN') return withRequests;
    return {
      ...withRequests,
      lines: quote.lines.map(({ pricingMethod: _method, pricingPercent: _percent, costBasis: _cost, costLotId: _lot, priceReason: _reason, ...line }) => line),
    };
  }

  // Highest global discount SALES may apply to this quote by itself: its own
  // limit, or the largest one an administrator approved for it.
  private async sellerLimit(client: Tx | PrismaService, quoteId: string | null) {
    if (!quoteId) return SELLER_GLOBAL_DISCOUNT_LIMIT;
    const approved = await client.quoteDiscountRequest.aggregate({ where: { quoteId, status: 'APPROVED' }, _max: { requestedPercent: true } });
    const max = approved._max.requestedPercent;
    return max && max.greaterThan(SELLER_GLOBAL_DISCOUNT_LIMIT) ? max : SELLER_GLOBAL_DISCOUNT_LIMIT;
  }

  // Validates the global discount of a save: 0, or 0.1–100 %; SALES only up
  // to its limit for this quote.
  private async globalDiscount(tx: Tx, quoteId: string | null, value: string | undefined, user: SafeUser) {
    const percent = dec(value ?? '0');
    if (percent.isZero()) return percent;
    if (percent.lessThan(GLOBAL_DISCOUNT_MIN) || percent.greaterThan(100)) {
      throw new BadRequestException('El descuento global va de 0,1 % a 100 % (0 = sin descuento global)');
    }
    if (user.role === 'ADMIN') return percent;
    const limit = await this.sellerLimit(tx, quoteId);
    if (percent.greaterThan(limit)) {
      throw new ForbiddenException(
        `Puedes aplicar hasta ${percentText(limit)} % de descuento global. Para ${percentText(percent)} % envía una solicitud de autorización a un administrador.`,
      );
    }
    return percent;
  }

  // Locks the quote row; SALES only reaches its own quotes (404 otherwise).
  private async lockQuote(tx: Tx, id: string, user: SafeUser) {
    const rows = await tx.$queryRaw<{ status: QuoteStatus; createdById: string }[]>`
      SELECT status, "createdById" FROM "quotes" WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0 || (user.role !== 'ADMIN' && rows[0].createdById !== user.id)) {
      throw new NotFoundException('La cotización no existe');
    }
    return rows[0];
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
          paymentMethod: dto.paymentMethod,
          paymentTerms: dto.paymentTerms || null,
          createdById: user.id,
        },
      });
      await this.writeQuoteLines(tx, quote.id, dto.lines, await this.globalDiscount(tx, null, dto.globalDiscountPercent, user));
      return quote.id;
    });
    return this.getQuote(id, user);
  }

  // Replaces the lines of a DRAFT quote. Prices are recomputed now; saved
  // quotes are never recalculated silently afterwards.
  async updateQuote(id: string, dto: SaveQuoteDto, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockQuote(tx, id, user);
      if (locked.status !== 'DRAFT') throw new ConflictException('Solo se puede modificar una cotización en borrador');
      const globalDiscount = await this.globalDiscount(tx, id, dto.globalDiscountPercent, user);
      const customer = await this.requireCustomer(tx, dto.customerId);
      await tx.quoteLine.deleteMany({ where: { quoteId: id } });
      await tx.quote.update({
        where: { id },
        data: {
          customerId: customer.id,
          customerName: customer.name,
          validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null,
          notes: dto.notes || null,
          paymentMethod: dto.paymentMethod,
          paymentTerms: dto.paymentTerms || null,
        },
      });
      await this.writeQuoteLines(tx, id, dto.lines, globalDiscount);
    });
    return this.getQuote(id, user);
  }

  // Also withdraws an open discount request (and its administrator's task).
  async cancelQuote(id: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockQuote(tx, id, user);
      if (locked.status !== 'DRAFT') throw new ConflictException('La cotización no existe o ya no está en borrador');
      await tx.quote.update({ where: { id }, data: { status: 'CANCELLED' } });
      const pending = await tx.quoteDiscountRequest.findFirst({ where: { quoteId: id, status: 'PENDING' } });
      if (pending) await this.closeDiscountRequest(tx, pending.id, 'CANCELLED', null, user);
    });
    return this.getQuote(id, user);
  }

  private async requireCustomer(tx: Tx, id: string) {
    const customer = await tx.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('El cliente no existe');
    if (!customer.active) throw new BadRequestException('El cliente está inactivo');
    return customer;
  }

  private async writeQuoteLines(tx: Tx, quoteId: string, lines: QuoteLineDto[], globalDiscountPercent: Decimal) {
    const rows: Omit<Prisma.QuoteLineUncheckedCreateInput, keyof LineAmounts>[] = [];
    const bases: (LineAmounts & { taxRatePercent: Decimal })[] = [];
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
      bases.push({ ...lineAmounts(line.quantity, unitPrice, discountPercent, taxRatePercent), taxRatePercent });
      rows.push({
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
        referenceCode: reference.code,
        referenceDescription: reference.description,
        finishCode: finish.code,
        finishDescription: finish.description,
        supplierName,
      });
    }
    // The global discount needs every line: it is split over them by base.
    const amounts = withGlobalDiscount(bases, globalDiscountPercent);
    for (const [index, row] of rows.entries()) await tx.quoteLine.create({ data: { ...row, ...amounts[index] } });
    await tx.quote.update({ where: { id: quoteId }, data: { ...documentTotals(amounts), globalDiscountPercent } });
  }

  // Applies a global discount to the saved lines (prices and line discounts
  // stay as saved; only the global share, VAT and totals change).
  private async reapplyGlobalDiscount(tx: Tx, quoteId: string, globalDiscountPercent: Decimal) {
    const lines = await tx.quoteLine.findMany({ where: { quoteId }, orderBy: { lineNo: 'asc' } });
    const amounts = withGlobalDiscount(lines, globalDiscountPercent);
    for (const [index, line] of lines.entries()) {
      const { globalDiscountAmount, taxAmount, lineTotal } = amounts[index];
      await tx.quoteLine.update({ where: { id: line.id }, data: { globalDiscountAmount, taxAmount, lineTotal } });
    }
    await tx.quote.update({ where: { id: quoteId }, data: { ...documentTotals(amounts), globalDiscountPercent } });
  }

  // --- Global discount requests -------------------------------------------------

  // Administrators a seller may ask (active ADMIN users).
  discountApprovers() {
    return this.prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  // SALES asks the administrator it chooses for a global discount above its
  // limit. It becomes a task of that administrator; the quote keeps its
  // current discount until the request is approved. One open request per
  // quote: repeating the same request (double click, lost answer) is a no-op.
  async requestDiscount(quoteId: string, dto: DiscountRequestDto, user: SafeUser) {
    if (user.role === 'ADMIN') {
      throw new BadRequestException('Como administrador aplicas el descuento global directamente al guardar la cotización');
    }
    const percent = dec(dto.percent);
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await this.lockQuote(tx, quoteId, user);
        if (locked.status !== 'DRAFT') throw new ConflictException('Solo se pide descuento para una cotización vigente (borrador)');
        const pending = await tx.quoteDiscountRequest.findFirst({ where: { quoteId, status: 'PENDING' } });
        if (pending) {
          if (pending.requestedPercent.equals(percent) && pending.approverId === dto.approverId) return;
          throw new ConflictException('Esta cotización ya tiene una solicitud de descuento pendiente; cancélala para enviar otra');
        }
        if (percent.greaterThan(100)) throw new BadRequestException('El descuento global no puede superar 100 %');
        const limit = await this.sellerLimit(tx, quoteId);
        if (!percent.greaterThan(limit)) {
          throw new BadRequestException(`Hasta ${percentText(limit)} % aplicas el descuento global tú mismo; la solicitud es para un descuento mayor`);
        }
        const approver = await tx.user.findUnique({ where: { id: dto.approverId }, select: { role: true, active: true } });
        if (!approver || approver.role !== 'ADMIN' || !approver.active) {
          throw new BadRequestException('Elige un administrador activo para autorizar el descuento');
        }
        const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { number: true, customerName: true, total: true } });
        const request = await tx.quoteDiscountRequest.create({
          data: { quoteId, requestedPercent: percent, reason: dto.reason || null, requestedById: user.id, approverId: dto.approverId },
        });
        const now = new Date();
        await tx.task.create({
          data: {
            title: `Autorizar descuento global de ${percentText(percent)} % · ${quote.number}`,
            description:
              `${user.name} pide un descuento global de ${percentText(percent)} % en la cotización ${quote.number} ` +
              `para ${quote.customerName} (total actual ${moneyText(quote.total)}).${dto.reason ? ` Motivo: ${dto.reason}` : ''}`,
            dueAt: new Date(now.getTime() + DISCOUNT_ANSWER_HOURS * 3_600_000),
            createdAt: now,
            assigneeId: dto.approverId,
            createdById: user.id,
            kind: 'DISCOUNT_APPROVAL',
            discountRequestId: request.id,
          },
        });
        await enqueue(tx, [{ userId: dto.approverId, kind: 'discount-requested', dedupeKey: `discount-requested:${request.id}` }]);
        await audit(tx, {
          entity: 'Quote',
          entityId: quoteId,
          action: 'DISCOUNT_REQUESTED',
          userId: user.id,
          reason: dto.reason || undefined,
          data: { requestId: request.id, percent: percent.toString(), approverId: dto.approverId },
        });
      });
    } catch (error) {
      // Only one open request per quote (unique index), even if two arrive at once.
      if (isUniqueViolation(error)) throw new ConflictException('Esta cotización ya tiene una solicitud de descuento pendiente');
      throw error;
    }
    return this.getQuote(quoteId, user);
  }

  // Only the administrator the seller chose answers. Approving applies the
  // discount to the quote at once. Repeating the same answer is a no-op.
  async resolveDiscount(quoteId: string, requestId: string, decision: 'APPROVED' | 'REJECTED', resolution: string | undefined, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockQuote(tx, quoteId, user);
      const request = await tx.quoteDiscountRequest.findFirst({ where: { id: requestId, quoteId } });
      if (!request) throw new NotFoundException('La solicitud de descuento no existe');
      if (request.approverId !== user.id) {
        throw new ForbiddenException('Solo el administrador elegido por el vendedor responde esta solicitud');
      }
      if (request.status === decision) return;
      if (request.status !== 'PENDING') throw new ConflictException(`La solicitud ya está ${DISCOUNT_STATUS[request.status]}`);
      if (locked.status !== 'DRAFT') throw new ConflictException('La cotización ya no está vigente');
      await this.closeDiscountRequest(tx, request.id, decision, decision === 'REJECTED' ? resolution || null : null, user);
      if (decision === 'APPROVED') await this.reapplyGlobalDiscount(tx, quoteId, request.requestedPercent);
      await enqueue(tx, [{ userId: request.requestedById, kind: 'discount-resolved', dedupeKey: `discount-resolved:${request.id}` }]);
    });
    return this.getQuote(quoteId, user);
  }

  // The seller (or an administrator) withdraws an open request.
  async cancelDiscountRequest(quoteId: string, requestId: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockQuote(tx, quoteId, user);
      const request = await tx.quoteDiscountRequest.findFirst({ where: { id: requestId, quoteId } });
      if (!request) throw new NotFoundException('La solicitud de descuento no existe');
      if (request.status === 'CANCELLED') return;
      if (request.status !== 'PENDING') throw new ConflictException(`La solicitud ya está ${DISCOUNT_STATUS[request.status]}`);
      await this.closeDiscountRequest(tx, request.id, 'CANCELLED', null, user);
    });
    return this.getQuote(quoteId, user);
  }

  // Closes a PENDING request (the quote is locked by the caller) and its task:
  // answered → task completed; cancelled → task cancelled.
  private async closeDiscountRequest(
    tx: Tx,
    requestId: string,
    status: 'APPROVED' | 'REJECTED' | 'CANCELLED',
    resolution: string | null,
    user: SafeUser,
  ) {
    const now = new Date();
    const request = await tx.quoteDiscountRequest.update({ where: { id: requestId }, data: { status, resolvedAt: now, resolution } });
    await tx.task.updateMany({
      where: { discountRequestId: requestId, completedAt: null, cancelledAt: null },
      data: status === 'CANCELLED' ? { cancelledAt: now } : { completedAt: now },
    });
    await audit(tx, {
      entity: 'Quote',
      entityId: request.quoteId,
      action: `DISCOUNT_${status}`,
      userId: user.id,
      reason: resolution ?? undefined,
      data: { requestId, percent: request.requestedPercent.toString() },
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
        // The order must carry the discount the administrator decides on.
        if (await tx.quoteDiscountRequest.findFirst({ where: { quoteId: id, status: 'PENDING' }, select: { id: true } })) {
          throw new ConflictException('Hay una solicitud de descuento global pendiente: espera la respuesta del administrador o cancélala antes de convertir');
        }
        const quote = await tx.quote.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
        // Quotes saved before the payment method existed must choose one first.
        if (!quote.paymentMethod) throw new ConflictException('Indica la forma de pago y guarda la cotización antes de convertirla en orden');
        const order = await tx.salesOrder.create({
          data: {
            number: await nextNumber(tx, 'sales_order_number_seq', 'OV'),
            quoteId: quote.id,
            customerId: quote.customerId,
            customerName: quote.customerName,
            currency: quote.currency,
            subtotal: quote.subtotal,
            discountTotal: quote.discountTotal,
            globalDiscountPercent: quote.globalDiscountPercent,
            globalDiscountAmount: quote.globalDiscountAmount,
            taxTotal: quote.taxTotal,
            total: quote.total,
            notes: quote.notes,
            paymentMethod: quote.paymentMethod,
            paymentTerms: quote.paymentTerms,
            // Abono / credit: pending until someone records the payment.
            paymentStatus: COLLECTED_LATER.includes(quote.paymentMethod) ? 'PENDING' : null,
            convertOperationKey: dto.operationKey,
            // The seller of the quote keeps owning the order; who converted it is recorded.
            createdById: quote.createdById,
            convertedById: user.id,
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
                globalDiscountAmount: line.globalDiscountAmount,
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
        include: { ...(user.role === 'ADMIN' ? { createdBy: authorSelect, convertedBy: authorSelect } : {}), _count: { select: { lines: true, dispatches: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  async getOrder(id: string, user: SafeUser) {
    return forViewer(await this.loadOrder(id, user), user);
  }

  // Full order (with its authors) for internal use, e.g. the printable copy.
  private async loadOrder(id: string, user: SafeUser) {
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
            const plan = await this.reservations.plan(tx, line, dto.inventoryLocationId, required, taken, candidates);
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

  // Abono / credit orders: the owner (SALES) or ADMIN records whether the
  // customer already paid. Reversible; every change is audited with its author.
  async setPaymentStatus(id: string, status: PaymentStatus, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (!order.paymentMethod || !COLLECTED_LATER.includes(order.paymentMethod)) {
        throw new ConflictException('Solo las órdenes con abono o a crédito (cartera) registran si ya están pagadas');
      }
      if (order.paymentStatus === status) return;
      await tx.salesOrder.update({ where: { id }, data: { paymentStatus: status, paymentStatusAt: new Date(), paymentStatusById: user.id } });
      await audit(tx, { entity: 'SalesOrder', entityId: id, action: 'PAYMENT_STATUS_CHANGED', userId: user.id, data: { from: order.paymentStatus, to: status } });
    });
    return this.getOrder(id, user);
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

  // --- Printable documents ------------------------------------------------------

  // Same access as reading the document (SALES: own documents only; others
  // get 404). Prints customer-facing values only, never costs.
  async quotePdf(id: string, user: SafeUser) {
    const quote = await this.loadQuote(id, user);
    const pdf = await renderSalesPdf({
      title: 'COTIZACIÓN',
      number: quote.number,
      issuedAt: quote.createdAt,
      validUntil: quote.validUntil,
      status: QUOTE_STATUS[quote.status],
      related: quote.order ? `Orden de venta ${quote.order.number}` : null,
      seller: quote.createdBy.name,
      payment: this.paymentLabel(quote),
      customer: { ...this.customerContact(quote.customer), name: quote.customerName },
      lines: quote.lines,
      subtotal: quote.subtotal,
      discountTotal: quote.discountTotal,
      globalDiscountPercent: quote.globalDiscountPercent,
      globalDiscountAmount: quote.globalDiscountAmount,
      taxTotal: quote.taxTotal,
      total: quote.total,
      notes: quote.notes,
    });
    return { number: quote.number, pdf };
  }

  async orderPdf(id: string, user: SafeUser) {
    const order = await this.loadOrder(id, user);
    const customer = await this.prisma.customer.findUnique({ where: { id: order.customerId } });
    const pdf = await renderSalesPdf({
      title: 'ORDEN DE VENTA',
      number: order.number,
      issuedAt: order.createdAt,
      status: ORDER_STATUS[order.status],
      related: order.quote ? `Cotización ${order.quote.number}` : null,
      seller: order.createdBy.name,
      payment: this.paymentLabel(order),
      customer: { ...this.customerContact(customer), name: order.customerName },
      lines: order.lines,
      subtotal: order.subtotal,
      discountTotal: order.discountTotal,
      globalDiscountPercent: order.globalDiscountPercent,
      globalDiscountAmount: order.globalDiscountAmount,
      taxTotal: order.taxTotal,
      total: order.total,
      notes: order.notes,
    });
    return { number: order.number, pdf };
  }

  private paymentLabel(document: { paymentMethod: PaymentMethod | null; paymentTerms: string | null }) {
    if (!document.paymentMethod) return null;
    return `${PAYMENT_METHOD_LABEL[document.paymentMethod]}${document.paymentTerms ? ` · ${document.paymentTerms}` : ''}`;
  }

  private customerContact(customer: { taxId: string | null; address: string | null; phone: string | null; email: string | null } | null) {
    return { taxId: customer?.taxId ?? null, address: customer?.address ?? null, phone: customer?.phone ?? null, email: customer?.email ?? null };
  }

  // SALES may act only on its own orders (BOLA). ADMIN on any.
  assertOwner(order: { createdById: string }, user: SafeUser) {
    if (user.role !== 'ADMIN' && order.createdById !== user.id) throw new ForbiddenException('No tienes permisos sobre esta orden');
  }
}

