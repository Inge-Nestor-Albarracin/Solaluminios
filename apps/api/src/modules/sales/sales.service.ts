import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MaterialOrigin,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  QuoteDiscountRequest,
  QuoteLine,
  QuoteRequestKind,
  QuoteStatus,
  SalesOrder,
  SalesOrderStatus,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, businessToday, isLockTimeout, isUniqueViolation, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import { Decimal, ZERO, dec } from '../../shared/money.js';
import { ACCENT_FOLD_FROM, ACCENT_FOLD_TO, escapeLike, foldAccents } from '../../shared/search.js';
import type { SafeUser } from '../auth/auth.types.js';
import { cancelOpenDispatches } from '../dispatch/dispatch-cancel.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import { ACCESSORY_CATALOG_ONLY, isAccessory, withFamilyKind } from '../catalog/catalog-kind.js';
import { enqueue } from '../notifications/outbox.js';
import type {
  ConfirmOrderDto,
  ApprovePriceDto,
  ConvertQuoteDto,
  CustomerBillingDataDto,
  CustomerQueryDto,
  DiscountRequestDto,
  ListQueryDto,
  OrderListQueryDto,
  PriceRequestDto,
  QuoteLineDto,
  SalePriceQueryDto,
  SaveCustomerDto,
  SaveQuoteDto,
  UpdateOrderLineDto,
} from './dto/sales.dto.js';
import {
  GLOBAL_DISCOUNT_MIN,
  NO_SERVICES,
  SELLER_GLOBAL_DISCOUNT_LIMIT,
  SELLER_LINE_DISCOUNT_LIMIT,
  documentTotals,
  lineAmounts,
  withGlobalDiscount,
  type LineAmounts,
} from './pricing.js';
import { renderSalesExport } from './sales-export.js';
import { renderSalesPdf } from './sales-pdf.js';
import { ReservationsService, type Allocation } from './reservations.service.js';
// Payment methods whose collection is followed (paid / pending), and how the
// contado of a new order is split.
import { COLLECTED_LATER, CONTADO, contadoSplit, customerCredit, lockCustomer, pesos, requireTransferEntity } from './order-payments.js';
import { REASON_LABEL, SETTLEMENT_LABEL, orderMoney } from '../returns/returns.js';

const orderInclude = {
  customer: { select: { id: true, name: true, taxId: true, email: true } },
  inventoryLocation: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  convertedBy: { select: { id: true, name: true } },
  paymentStatusBy: { select: { id: true, name: true } },
  billedBy: { select: { id: true, name: true } },
  quote: { select: { id: true, number: true } },
  payments: {
    orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      medium: true,
      // Transfers: where the money was received (null: «Sin especificar»).
      transferEntity: { select: { id: true, name: true } },
      amount: true,
      paidOn: true,
      note: true,
      atSale: true,
      createdAt: true,
      updatedAt: true,
      createdBy: { select: { id: true, name: true } },
      updatedBy: { select: { id: true, name: true } },
    },
  },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: {
      supplier: { select: { id: true, code: true, name: true } },
      manualApprovedBy: { select: { id: true, name: true } },
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
  // Sales returns of the order (documento DV): header only.
  returns: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      number: true,
      status: true,
      reason: true,
      settlement: true,
      amount: true,
      baseAmount: true,
      settledAmount: true,
      createdAt: true,
      receivedAt: true,
      refundedAt: true,
      creditNoteNumber: true,
      _count: { select: { lines: true } },
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
  CASH_TRANSFER: 'Contado – efectivo y transferencia',
};

// Who created a quote or an order (and who changed its payment state) is
// shown to ADMIN only: other roles get the documents without `createdBy`,
// `convertedBy` and `paymentStatusBy` (SALES only sees its own documents
// anyway). Printable documents keep the seller's name.
function forViewer<T extends object>(document: T, user: SafeUser): T {
  // Billing sees who sold the orders it invoices.
  if (user.role === 'ADMIN' || user.role === 'BILLING') return document;
  const { createdBy: _createdBy, convertedBy: _convertedBy, paymentStatusBy: _paymentStatusBy, ...rest } = document as T & {
    createdBy?: unknown;
    convertedBy?: unknown;
    paymentStatusBy?: unknown;
  };
  return rest as T;
}


const authorSelect = { select: { id: true, name: true } } as const;

// Time the chosen administrator has to answer a discount request. After it the
// task stays pending, flagged as overdue (it is never lost).
const DISCOUNT_ANSWER_HOURS = 24;
const DISCOUNT_STATUS = { PENDING: 'pendiente', APPROVED: 'aprobada', REJECTED: 'rechazada', CANCELLED: 'cancelada' } as const;
// Audit action prefix of each request kind (DISCOUNT_APPROVED, MANUAL_PRICE_REJECTED…).
const REQUEST_AUDIT: Record<QuoteRequestKind, string> = { GLOBAL_DISCOUNT: 'DISCOUNT', MANUAL_PRICE: 'MANUAL_PRICE' };
// A manual price must be explained (who, why, supplier, expected margin…).
const PRICE_REASON_MIN = 10;
const PRICE_REQUEST_REPLACE =
  'Ya hay una solicitud de precio manual en curso. Si continúas, la anterior se cancela y se pierde su avance; confirma para continuar.';

// What an administrator authorises on a manual line: if any of it changes,
// the authorisation is lost and must be requested again.
function manualKey(line: {
  referenceId: string;
  finishId: string;
  origin: MaterialOrigin;
  supplierId: string | null;
  quantity: number;
  unitPrice: Decimal;
  discountPercent: Decimal;
  priceReason: string | null;
  estimatedUnitCost: Decimal | null;
}) {
  return JSON.stringify([
    line.referenceId,
    line.finishId,
    line.origin,
    line.supplierId ?? null,
    line.quantity,
    dec(line.unitPrice).toFixed(2),
    dec(line.discountPercent).toFixed(4),
    line.priceReason ?? '',
    line.estimatedUnitCost ? dec(line.estimatedUnitCost).toFixed(6) : '',
  ]);
}

// Identity of a set of manual lines waiting for authorisation (by line number).
const manualSignature = (lines: QuoteLine[]) => lines.map((line) => `${line.lineNo}:${manualKey(line)}`).join('|');

// Snapshot kept in a MANUAL_PRICE request (and its audit events).
type ManualPriceItem = {
  lineNo: number;
  referenceCode: string;
  referenceDescription: string | null;
  finishCode: string;
  finishDescription: string | null;
  origin: MaterialOrigin;
  supplierName: string | null;
  quantity: number;
  discountPercent: string;
  proposedUnitPrice: string;
  enabledUnitPrice: string | null;
  estimatedUnitCost: string | null;
  priceReason: string;
  approvedUnitPrice?: string;
};
interface ManualPriceDetails {
  signature: string;
  lines: ManualPriceItem[];
}

const describeManual = (line: QuoteLine) => ({
  lineNo: line.lineNo,
  referenceCode: line.referenceCode,
  finishCode: line.finishCode,
  quantity: line.quantity,
  unitPrice: line.unitPrice.toFixed(2),
  priceReason: line.priceReason,
  approvedById: line.manualApprovedById,
});
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

// «$ 1.234.567,89» (Colombian format) for task texts.
const formatPesos = (value: Decimal) => {
  const amount = Number(value.toString());
  const decimals = Number.isInteger(amount) ? 0 : 2;
  return `$ ${amount.toLocaleString('es-CO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

// Excel export of orders: above this, the admin narrows the dates.
export const MAX_EXPORT_ORDERS = 10_000;
const EXPORT_PAYMENT_FILTER = { PAID: 'Pagadas', PENDING: 'Pago pendiente', NONE: 'De contado' } as const;
// Day in Bogotá (UTC-05:00, no daylight saving time) as AAAA-MM-DD.
const bogotaDay = (date: Date) => new Date(date.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
// ASCII file-name fragment: «José Pérez» → «jose_perez».
const slug = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'vendedor';

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
// Kind of sale and services of a quote being saved. «Detal» never carries
// labour: amounts sent with it are refused, not silently dropped, so nothing
// is charged that the screen does not show.
function saleOf(dto: SaveQuoteDto) {
  const saleType = dto.saleType ?? 'RETAIL';
  const assemblyAmount = new Decimal(dto.assemblyAmount ?? '0');
  const installationAmount = new Decimal(dto.installationAmount ?? '0');
  if (saleType === 'RETAIL' && (assemblyAmount.greaterThan(0) || installationAmount.greaterThan(0))) {
    throw new BadRequestException('En Detal no se cobran ensamble ni instalación: cambia la modalidad a Ventanería o deja esos valores en 0');
  }
  return { saleType, assemblyAmount, installationAmount };
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservations: ReservationsService,
  ) {}

  // --- Customers ------------------------------------------------------------

  // Active customers by name or NIT. The name ignores case and accents
  // («pena» finds «Peña») and the NIT ignores dots, dashes and spaces
  // («900123456» finds «900.123.456-7»).
  async listCustomers(query: CustomerQueryDto) {
    const term = query.search?.trim() ?? '';
    if (!term) return this.prisma.customer.findMany({ where: { active: true }, orderBy: { name: 'asc' }, take: 100 });
    const text = foldAccents(term);
    const code = term.replace(/[^0-9a-z]/gi, '').toLowerCase();
    const matches = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "customers"
      WHERE active
        AND (
          translate(lower(name), ${ACCENT_FOLD_FROM}, ${ACCENT_FOLD_TO}) LIKE ${`%${escapeLike(text)}%`}
          OR (${code} <> '' AND lower(regexp_replace(coalesce("taxId", ''), '[^0-9A-Za-z]', '', 'g')) LIKE ${`%${escapeLike(code)}%`})
        )
      ORDER BY name, id
      LIMIT 50`;
    return this.prisma.customer.findMany({ where: { id: { in: matches.map((m) => m.id) } }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  async createCustomer(dto: SaveCustomerDto, user: SafeUser) {
    await this.requireNewTaxId(dto.taxId, null);
    return this.prisma.customer.create({ data: { ...this.customerData(dto), createdById: user.id } });
  }

  // One customer per NIT, whatever its format: «900.123.456-7»,
  // «900123456-7» and «900123456» are the same NIT (the check digit after
  // the dash is ignored). Customers without NIT are not compared.
  private async requireNewTaxId(taxId: string | null | undefined, exceptId: string | null) {
    const base = (taxId ?? '').split('-')[0].replace(/[^0-9a-z]/gi, '').toLowerCase();
    if (!base) return;
    const [found] = await this.prisma.$queryRaw<{ name: string; taxId: string; active: boolean }[]>`
      SELECT name, "taxId", active FROM "customers"
      WHERE lower(regexp_replace(split_part(coalesce("taxId", ''), '-', 1), '[^0-9A-Za-z]', '', 'g')) = ${base}
        AND (${exceptId}::text IS NULL OR id <> ${exceptId})
      ORDER BY active DESC, name
      LIMIT 1`;
    if (found) {
      throw new ConflictException(
        `Ya existe el cliente «${found.name}» con el NIT ${found.taxId}${found.active ? '' : ' (inactivo)'}. Búscalo por su NIT en vez de crearlo de nuevo.`,
      );
    }
  }

  async updateCustomer(id: string, dto: SaveCustomerDto) {
    if (!(await this.prisma.customer.findUnique({ where: { id } }))) throw new NotFoundException('El cliente no existe');
    await this.requireNewTaxId(dto.taxId, id);
    return this.prisma.customer.update({ where: { id }, data: this.customerData(dto) });
  }

  async customerCreditOf(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) throw new NotFoundException('El cliente no existe');
    return { customerId: id, available: (await customerCredit(this.prisma, id)).toFixed(2) };
  }

  // Only what an invoice needs (NIT / ID and e-mail); the rest is kept.
  async updateCustomerBillingData(id: string, dto: CustomerBillingDataDto) {
    if (!(await this.prisma.customer.findUnique({ where: { id } }))) throw new NotFoundException('El cliente no existe');
    await this.requireNewTaxId(dto.taxId, id);
    return this.prisma.customer.update({ where: { id }, data: { taxId: dto.taxId, email: dto.email } });
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
        lines: { orderBy: { lineNo: 'asc' }, include: { manualApprovedBy: authorSelect } },
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
      projected:
        request.status === 'PENDING' && request.requestedPercent ? documentTotals(withGlobalDiscount(quote.lines, request.requestedPercent), quote) : null,
    }));
    // Manual lines (and whether their price is authorised) for every role.
    const lines = quote.lines.map((line) => ({ ...line, manualPrice: line.pricingMethod === 'MANUAL' }));
    const withRequests = { ...quote, lines, discountRequests, globalDiscountLimit: limit.toString() };
    if (user.role === 'ADMIN') return withRequests;
    // SALES: no pricing rule nor cost (its own manual reason and estimate stay).
    return {
      ...withRequests,
      lines: lines.map(({ pricingMethod: _method, pricingPercent: _percent, costBasis: _cost, costLotId: _lot, ...line }) => line),
    };
  }

  // Highest global discount SALES may apply to this quote by itself: its own
  // limit, or the largest one an administrator approved for it.
  private async sellerLimit(client: Tx | PrismaService, quoteId: string | null) {
    if (!quoteId) return SELLER_GLOBAL_DISCOUNT_LIMIT;
    const approved = await client.quoteDiscountRequest.aggregate({
      where: { quoteId, kind: 'GLOBAL_DISCOUNT', status: 'APPROVED' },
      _max: { requestedPercent: true },
    });
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
          paymentMethod: dto.paymentMethod ?? null,
          paymentTerms: dto.paymentTerms || null,
          ...saleOf(dto),
          createdById: user.id,
        },
      });
      await this.writeQuoteLines(tx, quote.id, dto.lines, await this.globalDiscount(tx, null, dto.globalDiscountPercent, user), user, []);
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
      // Authorised manual prices survive only on lines that did not change.
      const previous = await tx.quoteLine.findMany({ where: { quoteId: id }, orderBy: { lineNo: 'asc' } });
      await tx.quoteLine.deleteMany({ where: { quoteId: id } });
      await tx.quote.update({
        where: { id },
        data: {
          customerId: customer.id,
          customerName: customer.name,
          validUntil: dto.validUntil ? new Date(`${dto.validUntil}T00:00:00.000Z`) : null,
          notes: dto.notes || null,
          paymentMethod: dto.paymentMethod ?? null,
          paymentTerms: dto.paymentTerms || null,
          ...saleOf(dto),
        },
      });
      const lost = await this.writeQuoteLines(tx, id, dto.lines, globalDiscount, user, previous);
      if (lost.length > 0) {
        await audit(tx, {
          entity: 'Quote',
          entityId: id,
          action: 'MANUAL_PRICE_APPROVAL_LOST',
          userId: user.id,
          reason: 'Se editaron renglones con precio manual autorizado',
          data: { before: lost.map(describeManual), after: (await this.unauthorisedManual(tx, id)).map(describeManual) },
        });
      }
      // An open manual-price request no longer describes what is waiting:
      // cancelled only with the user's explicit consent.
      const pending = await tx.quoteDiscountRequest.findFirst({ where: { quoteId: id, kind: 'MANUAL_PRICE', status: 'PENDING' } });
      if (pending && (pending.details as unknown as ManualPriceDetails).signature !== manualSignature(await this.unauthorisedManual(tx, id))) {
        if (!dto.replacePendingPriceRequest) {
          throw new ConflictException(
            'La cotización tiene una solicitud de precio manual en curso. Si guardas estos cambios, la solicitud se cancela y se pierde su avance; confirma para continuar.',
          );
        }
        await this.closeRequest(tx, pending, 'CANCELLED', null, user, 'Se editó la cotización y la solicitud quedó desactualizada');
      }
    });
    return this.getQuote(id, user);
  }

  // Also withdraws its open requests (and their administrators' tasks).
  async cancelQuote(id: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockQuote(tx, id, user);
      if (locked.status !== 'DRAFT') throw new ConflictException('La cotización no existe o ya no está en borrador');
      await tx.quote.update({ where: { id }, data: { status: 'CANCELLED' } });
      for (const pending of await tx.quoteDiscountRequest.findMany({ where: { quoteId: id, status: 'PENDING' } })) {
        await this.closeRequest(tx, pending, 'CANCELLED', null, user, 'Se canceló la cotización');
      }
    });
    return this.getQuote(id, user);
  }

  private async requireCustomer(tx: Tx, id: string) {
    const customer = await tx.customer.findUnique({ where: { id } });
    if (!customer) throw new NotFoundException('El cliente no existe');
    if (!customer.active) throw new BadRequestException('El cliente está inactivo');
    return customer;
  }

  // Writes the lines with their amounts. A manual price is authorised when
  // ADMIN saves it, or when it is unchanged from an authorised line of
  // `previous`; returns the authorised manual lines that lost it.
  private async writeQuoteLines(tx: Tx, quoteId: string, lines: QuoteLineDto[], globalDiscountPercent: Decimal, user: SafeUser, previous: QuoteLine[]) {
    const rows: Omit<Prisma.QuoteLineUncheckedCreateInput, keyof LineAmounts>[] = [];
    const bases: (LineAmounts & { taxRatePercent: Decimal })[] = [];
    // Authorised manual lines that may be kept, by what was authorised.
    const authorised = new Map<string, QuoteLine[]>();
    for (const line of previous) {
      if (line.pricingMethod !== 'MANUAL' || !line.manualApprovedById) continue;
      const key = manualKey(line);
      authorised.set(key, [...(authorised.get(key) ?? []), line]);
    }
    const appliedByAdmin: number[] = [];
    for (const [index, line] of lines.entries()) {
      const reference = await tx.reference.findUnique({ where: { id: line.referenceId }, include: withFamilyKind });
      if (!reference?.active) throw new BadRequestException(`Renglón ${index + 1}: la referencia no existe o está inactiva`);
      if (isAccessory(reference)) throw new BadRequestException(`Renglón ${index + 1}: la referencia ${ACCESSORY_CATALOG_ONLY}`);
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
      // A seller gives up to 3 % per line. More only on a manual-price line
      // (the administrator authorises it with its discount) or when the line
      // keeps, unchanged, a discount saved before (e.g. by an administrator).
      if (user.role !== 'ADMIN' && line.manualUnitPrice === undefined && discountPercent.greaterThan(SELLER_LINE_DISCOUNT_LIMIT)) {
        const kept = previous.some(
          (saved) =>
            saved.referenceId === line.referenceId &&
            saved.finishId === line.finishId &&
            saved.origin === line.origin &&
            (saved.supplierId ?? null) === (line.supplierId ?? null) &&
            dec(saved.discountPercent).equals(discountPercent),
        );
        if (!kept) {
          throw new BadRequestException(
            `Renglón ${index + 1}: puedes dar hasta ${SELLER_LINE_DISCOUNT_LIMIT.toString()} % de descuento por renglón. Para más, usa precio manual (lo autoriza un administrador) o pide un descuento global.`,
          );
        }
      }
      const identity = {
        quoteId,
        lineNo: index + 1,
        referenceId: line.referenceId,
        finishId: line.finishId,
        origin: line.origin,
        supplierId: line.supplierId ?? null,
        quantity: line.quantity,
      };
      let pricing: Pick<
        Prisma.QuoteLineUncheckedCreateInput,
        'pricingMethod' | 'pricingPercent' | 'costBasis' | 'salePriceId' | 'unitPrice' | 'priceReason' | 'estimatedUnitCost' | 'manualApprovedById' | 'manualApprovedAt'
      >;
      let unitPrice: Decimal;
      if (line.manualUnitPrice !== undefined) {
        // Manual price: always possible, explained, and authorised by an administrator.
        unitPrice = dec(line.manualUnitPrice);
        if (!unitPrice.greaterThan(0) || unitPrice.decimalPlaces() > 2) {
          throw new BadRequestException(`Renglón ${index + 1}: el precio manual debe ser mayor que cero y tener máximo 2 decimales`);
        }
        const priceReason = line.priceReason ?? '';
        if (priceReason.length < PRICE_REASON_MIN) {
          throw new BadRequestException(
            `Renglón ${index + 1}: explica por qué el precio es manual (mínimo ${PRICE_REASON_MIN} caracteres), p. ej. proveedor, costo y ganancia esperada`,
          );
        }
        const estimatedUnitCost = line.estimatedUnitCost === undefined ? null : dec(line.estimatedUnitCost);
        if (estimatedUnitCost && !estimatedUnitCost.greaterThan(0)) {
          throw new BadRequestException(`Renglón ${index + 1}: el costo estimado debe ser mayor que cero`);
        }
        const key = manualKey({ ...identity, unitPrice, discountPercent, priceReason, estimatedUnitCost });
        const kept = authorised.get(key)?.shift();
        if (!kept && user.role === 'ADMIN') appliedByAdmin.push(index + 1);
        pricing = {
          pricingMethod: 'MANUAL',
          pricingPercent: null,
          costBasis: null,
          salePriceId: null,
          unitPrice,
          priceReason,
          estimatedUnitCost,
          ...(kept
            ? { manualApprovedById: kept.manualApprovedById, manualApprovedAt: kept.manualApprovedAt }
            : user.role === 'ADMIN'
              ? { manualApprovedById: user.id, manualApprovedAt: new Date() }
              : { manualApprovedById: null, manualApprovedAt: null }),
        };
      } else {
        if (line.priceReason || line.estimatedUnitCost !== undefined) {
          throw new BadRequestException(`Renglón ${index + 1}: la justificación y el costo estimado solo aplican con precio manual`);
        }
        // Values copied from the enabled price: later changes never touch it.
        const price = await this.enabledPrice(tx, line);
        if (!price) {
          throw new BadRequestException(
            `Renglón ${index + 1}: no hay precio de venta habilitado para ${reference.code} ${finish.code} (${line.origin === 'CHINA' ? 'China' : 'Nacional'}). Usa precio manual o pide a administración que lo habilite.`,
          );
        }
        unitPrice = price.unitPrice;
        pricing = {
          pricingMethod: 'MARKUP_ON_COST',
          pricingPercent: price.markupPercent,
          costBasis: price.unitCost,
          salePriceId: price.id,
          unitPrice,
          priceReason: null,
          estimatedUnitCost: null,
          manualApprovedById: null,
          manualApprovedAt: null,
        };
      }
      bases.push({ ...lineAmounts(line.quantity, unitPrice, discountPercent, taxRatePercent), taxRatePercent });
      rows.push({
        ...identity,
        ...pricing,
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
    await tx.quote.update({ where: { id: quoteId }, data: { ...documentTotals(amounts, await this.servicesOf(tx, quoteId)), globalDiscountPercent } });
    if (appliedByAdmin.length > 0) {
      const applied = await tx.quoteLine.findMany({ where: { quoteId, lineNo: { in: appliedByAdmin } }, orderBy: { lineNo: 'asc' } });
      await audit(tx, { entity: 'Quote', entityId: quoteId, action: 'MANUAL_PRICE_APPLIED', userId: user.id, data: { lines: applied.map(describeManual) } });
    }
    return [...authorised.values()].flat();
  }

  // Manual lines whose price is not authorised (what a request covers).
  private unauthorisedManual(tx: Tx, quoteId: string) {
    return tx.quoteLine.findMany({ where: { quoteId, pricingMethod: 'MANUAL', manualApprovedById: null }, orderBy: { lineNo: 'asc' } });
  }

  // Recomputes every line and the totals from the stored prices (after an
  // administrator corrects manual prices).
  private async recomputeQuote(tx: Tx, quoteId: string) {
    const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { globalDiscountPercent: true } });
    const lines = await tx.quoteLine.findMany({ where: { quoteId }, orderBy: { lineNo: 'asc' } });
    const amounts = withGlobalDiscount(
      lines.map((line) => ({ ...lineAmounts(line.quantity, line.unitPrice, line.discountPercent, line.taxRatePercent), taxRatePercent: line.taxRatePercent })),
      quote.globalDiscountPercent,
    );
    for (const [index, line] of lines.entries()) await tx.quoteLine.update({ where: { id: line.id }, data: amounts[index] });
    await tx.quote.update({ where: { id: quoteId }, data: documentTotals(amounts, await this.servicesOf(tx, quoteId)) });
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
    await tx.quote.update({ where: { id: quoteId }, data: { ...documentTotals(amounts, await this.servicesOf(tx, quoteId)), globalDiscountPercent } });
  }

  // Assembly and installation saved in the quote (added to its total).
  private async servicesOf(tx: Tx, quoteId: string) {
    return (await tx.quote.findUnique({ where: { id: quoteId }, select: { assemblyAmount: true, installationAmount: true } })) ?? NO_SERVICES;
  }

  // --- Global discount requests -------------------------------------------------

  // Administrators a seller may ask (active ADMIN users).
  discountApprovers() {
    return this.prisma.user.findMany({ where: { role: 'ADMIN', active: true }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  }

  // In-app notice of the sales menu: the answers to the session user's own
  // requests (approved or rejected) it has not seen yet, newest first. It
  // works without push notifications enabled on the device.
  async requestUpdates(user: SafeUser) {
    const where: Prisma.QuoteDiscountRequestWhereInput = {
      requestedById: user.id,
      status: { in: ['APPROVED', 'REJECTED'] },
      requesterSeenAt: null,
    };
    const [count, items] = await Promise.all([
      this.prisma.quoteDiscountRequest.count({ where }),
      this.prisma.quoteDiscountRequest.findMany({
        where,
        orderBy: [{ resolvedAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          kind: true,
          status: true,
          requestedPercent: true,
          resolution: true,
          resolvedAt: true,
          approver: { select: { id: true, name: true } },
          quote: { select: { id: true, number: true, customerName: true } },
        },
      }),
    ]);
    return { count, items };
  }

  // The seller opened the quote: its answered requests are seen. Only its
  // own requests; repeating it changes nothing.
  async markRequestUpdatesSeen(quoteId: string, user: SafeUser) {
    const { count } = await this.prisma.quoteDiscountRequest.updateMany({
      where: { quoteId, requestedById: user.id, status: { in: ['APPROVED', 'REJECTED'] }, requesterSeenAt: null },
      data: { requesterSeenAt: new Date() },
    });
    return { seen: count };
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
        const pending = await tx.quoteDiscountRequest.findFirst({ where: { quoteId, kind: 'GLOBAL_DISCOUNT', status: 'PENDING' } });
        if (pending) {
          if (pending.requestedPercent?.equals(percent) && pending.approverId === dto.approverId) return;
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
      const request = await this.answerable(tx, quoteId, requestId, 'GLOBAL_DISCOUNT', user);
      if (request.status === decision) return;
      if (request.status !== 'PENDING') throw new ConflictException(`La solicitud ya está ${DISCOUNT_STATUS[request.status]}`);
      if (locked.status !== 'DRAFT') throw new ConflictException('La cotización ya no está vigente');
      await this.closeRequest(tx, request, decision, decision === 'REJECTED' ? resolution || null : null, user);
      if (decision === 'APPROVED') await this.reapplyGlobalDiscount(tx, quoteId, request.requestedPercent!);
      const kind = decision === 'APPROVED' ? 'discount-approved' : 'discount-rejected';
      await enqueue(tx, [{ userId: request.requestedById, kind, dedupeKey: `${kind}:${request.id}` }]);
    });
    return this.getQuote(quoteId, user);
  }

  // The request of that kind on that quote, which only the administrator the
  // seller chose may answer.
  private async answerable(tx: Tx, quoteId: string, requestId: string, kind: QuoteRequestKind, user: SafeUser) {
    const request = await tx.quoteDiscountRequest.findFirst({ where: { id: requestId, quoteId, kind } });
    if (!request) throw new NotFoundException(kind === 'GLOBAL_DISCOUNT' ? 'La solicitud de descuento no existe' : 'La solicitud de precio manual no existe');
    if (request.approverId !== user.id) {
      throw new ForbiddenException('Solo el administrador elegido por el vendedor responde esta solicitud');
    }
    return request;
  }

  // The seller (or an administrator) withdraws an open request.
  async cancelDiscountRequest(quoteId: string, requestId: string, user: SafeUser, kind: QuoteRequestKind = 'GLOBAL_DISCOUNT') {
    await this.prisma.$transaction(async (tx) => {
      await this.lockQuote(tx, quoteId, user);
      const request = await tx.quoteDiscountRequest.findFirst({ where: { id: requestId, quoteId, kind } });
      if (!request) throw new NotFoundException(kind === 'GLOBAL_DISCOUNT' ? 'La solicitud de descuento no existe' : 'La solicitud de precio manual no existe');
      if (request.status === 'CANCELLED') return;
      if (request.status !== 'PENDING') throw new ConflictException(`La solicitud ya está ${DISCOUNT_STATUS[request.status]}`);
      await this.closeRequest(tx, request, 'CANCELLED', null, user, 'Retirada por quien la pidió o por un administrador');
    });
    return this.getQuote(quoteId, user);
  }

  // Closes a PENDING request (the quote is locked by the caller) and its task:
  // answered → task completed; cancelled → task cancelled. `note` explains a
  // cancellation in the audit trail; `data` adds to it.
  private async closeRequest(
    tx: Tx,
    request: Pick<QuoteDiscountRequest, 'id' | 'kind'>,
    status: 'APPROVED' | 'REJECTED' | 'CANCELLED',
    resolution: string | null,
    user: SafeUser,
    note?: string,
    data: Record<string, unknown> = {},
  ) {
    const now = new Date();
    const closed = await tx.quoteDiscountRequest.update({ where: { id: request.id }, data: { status, resolvedAt: now, resolution } });
    await tx.task.updateMany({
      where: { discountRequestId: request.id, completedAt: null, cancelledAt: null },
      data: status === 'CANCELLED' ? { cancelledAt: now } : { completedAt: now },
    });
    await audit(tx, {
      entity: 'Quote',
      entityId: closed.quoteId,
      action: `${REQUEST_AUDIT[closed.kind]}_${status}`,
      userId: user.id,
      reason: resolution ?? note,
      data: { requestId: closed.id, ...(closed.requestedPercent ? { percent: closed.requestedPercent.toString() } : {}), ...data },
    });
  }

  // --- Manual price requests ----------------------------------------------------

  // SALES asks the administrator it chooses to authorise every manual price of
  // the quote that is not authorised yet. It becomes a task of that
  // administrator; the quote can be neither printed for the customer nor
  // converted until then. Repeating the same request is a no-op; another one
  // while one is open needs `replace` (the open one is cancelled).
  async requestPrice(quoteId: string, dto: PriceRequestDto, user: SafeUser) {
    if (user.role === 'ADMIN') {
      throw new BadRequestException('Como administrador, tus precios manuales quedan autorizados al guardar la cotización');
    }
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await this.lockQuote(tx, quoteId, user);
        if (locked.status !== 'DRAFT') throw new ConflictException('Solo se pide autorización para una cotización vigente (borrador)');
        const lines = await this.unauthorisedManual(tx, quoteId);
        if (lines.length === 0) throw new BadRequestException('La cotización no tiene precios manuales por autorizar');
        const signature = manualSignature(lines);
        const pending = await tx.quoteDiscountRequest.findFirst({ where: { quoteId, kind: 'MANUAL_PRICE', status: 'PENDING' } });
        if (pending) {
          // Retry of the same request (double click, lost answer): nothing new.
          if ((pending.details as unknown as ManualPriceDetails).signature === signature && pending.approverId === dto.approverId) return;
          if (!dto.replace) throw new ConflictException(PRICE_REQUEST_REPLACE);
        }
        const approver = await tx.user.findUnique({ where: { id: dto.approverId }, select: { role: true, active: true } });
        if (!approver || approver.role !== 'ADMIN' || !approver.active) {
          throw new BadRequestException('Elige un administrador activo para autorizar el precio manual');
        }
        const items: ManualPriceItem[] = [];
        for (const line of lines) {
          const enabled = await this.enabledPrice(tx, line);
          items.push({
            lineNo: line.lineNo,
            referenceCode: line.referenceCode,
            referenceDescription: line.referenceDescription,
            finishCode: line.finishCode,
            finishDescription: line.finishDescription,
            origin: line.origin,
            supplierName: line.supplierName,
            quantity: line.quantity,
            discountPercent: line.discountPercent.toString(),
            proposedUnitPrice: line.unitPrice.toFixed(2),
            enabledUnitPrice: enabled ? enabled.unitPrice.toFixed(2) : null,
            estimatedUnitCost: line.estimatedUnitCost ? line.estimatedUnitCost.toString() : null,
            priceReason: line.priceReason ?? '',
          });
        }
        const details: ManualPriceDetails = { signature, lines: items };
        if (pending) await this.closeRequest(tx, pending, 'CANCELLED', null, user, 'Reemplazada por una solicitud nueva');
        const request = await tx.quoteDiscountRequest.create({
          data: {
            quoteId,
            kind: 'MANUAL_PRICE',
            details: details as unknown as Prisma.InputJsonValue,
            reason: dto.reason || null,
            requestedById: user.id,
            approverId: dto.approverId,
          },
        });
        if (pending) await tx.quoteDiscountRequest.update({ where: { id: pending.id }, data: { replacedById: request.id } });
        const quote = await tx.quote.findUniqueOrThrow({ where: { id: quoteId }, select: { number: true, customerName: true } });
        const summary = items
          .map((item) => `${item.quantity} × ${item.referenceCode} ${item.finishDescription ?? item.finishCode} a ${moneyText(dec(item.proposedUnitPrice))}`)
          .join('; ');
        const now = new Date();
        await tx.task.create({
          data: {
            title: `Autorizar precio manual · ${quote.number}`,
            description: `${user.name} pide autorizar precios manuales en la cotización ${quote.number} para ${quote.customerName}: ${summary}.${dto.reason ? ` Nota: ${dto.reason}` : ''}`,
            dueAt: new Date(now.getTime() + DISCOUNT_ANSWER_HOURS * 3_600_000),
            createdAt: now,
            assigneeId: dto.approverId,
            createdById: user.id,
            kind: 'DISCOUNT_APPROVAL',
            discountRequestId: request.id,
          },
        });
        await enqueue(tx, [{ userId: dto.approverId, kind: 'price-requested', dedupeKey: `price-requested:${request.id}` }]);
        await audit(tx, {
          entity: 'Quote',
          entityId: quoteId,
          action: 'MANUAL_PRICE_REQUESTED',
          userId: user.id,
          reason: dto.reason || undefined,
          data: { requestId: request.id, approverId: dto.approverId, replaces: pending?.id ?? null, lines: items },
        });
      });
    } catch (error) {
      // Only one open request per quote and kind (unique index), even if two arrive at once.
      if (isUniqueViolation(error)) throw new ConflictException(PRICE_REQUEST_REPLACE);
      throw error;
    }
    return this.getQuote(quoteId, user);
  }

  // Only the administrator the seller chose answers. Approving may correct
  // any requested price; the quote is recomputed and becomes printable and
  // convertible (if nothing else is pending). Repeating the same answer is a
  // no-op.
  async resolvePrice(quoteId: string, requestId: string, decision: 'APPROVED' | 'REJECTED', dto: ApprovePriceDto & { resolution?: string }, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockQuote(tx, quoteId, user);
      const request = await this.answerable(tx, quoteId, requestId, 'MANUAL_PRICE', user);
      if (request.status === decision) return;
      if (request.status !== 'PENDING') throw new ConflictException(`La solicitud ya está ${DISCOUNT_STATUS[request.status]}`);
      if (locked.status !== 'DRAFT') throw new ConflictException('La cotización ya no está vigente');
      const details = request.details as unknown as ManualPriceDetails;
      if (decision === 'REJECTED') {
        await this.closeRequest(tx, request, 'REJECTED', dto.resolution || null, user, undefined, { lines: details.lines });
      } else {
        const lines = await this.unauthorisedManual(tx, quoteId);
        // Edits cancel the request, so this only guards against the impossible.
        if (manualSignature(lines) !== details.signature) {
          throw new ConflictException('La cotización cambió después de la solicitud; pide a ventas que la envíe de nuevo');
        }
        const corrections = new Map<number, Decimal>();
        for (const correction of dto.lines ?? []) {
          if (!lines.some((line) => line.lineNo === correction.lineNo)) {
            throw new BadRequestException(`El renglón ${correction.lineNo} no está en esta solicitud de precio manual`);
          }
          const price = dec(correction.unitPrice);
          if (!price.greaterThan(0) || price.decimalPlaces() > 2) {
            throw new BadRequestException(`Renglón ${correction.lineNo}: el precio debe ser mayor que cero y tener máximo 2 decimales`);
          }
          corrections.set(correction.lineNo, price);
        }
        const now = new Date();
        for (const line of lines) {
          await tx.quoteLine.update({
            where: { id: line.id },
            data: { unitPrice: corrections.get(line.lineNo) ?? line.unitPrice, manualApprovedById: user.id, manualApprovedAt: now },
          });
        }
        await this.recomputeQuote(tx, quoteId);
        const approved = details.lines.map((item) => ({
          ...item,
          approvedUnitPrice: (corrections.get(item.lineNo) ?? dec(item.proposedUnitPrice)).toFixed(2),
        }));
        await tx.quoteDiscountRequest.update({
          where: { id: request.id },
          data: { details: { ...details, lines: approved } as unknown as Prisma.InputJsonValue },
        });
        await this.closeRequest(tx, request, 'APPROVED', null, user, undefined, {
          lines: approved.map((item) => ({ lineNo: item.lineNo, referenceCode: item.referenceCode, proposedUnitPrice: item.proposedUnitPrice, approvedUnitPrice: item.approvedUnitPrice })),
          corrected: corrections.size > 0,
        });
      }
      const kind = decision === 'APPROVED' ? 'price-approved' : 'price-rejected';
      await enqueue(tx, [{ userId: request.requestedById, kind, dedupeKey: `${kind}:${request.id}` }]);
    });
    return this.getQuote(quoteId, user);
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
        // The order must carry what the administrator decides on.
        const pending = await tx.quoteDiscountRequest.findFirst({ where: { quoteId: id, status: 'PENDING' }, select: { kind: true } });
        if (pending) {
          throw new ConflictException(
            pending.kind === 'GLOBAL_DISCOUNT'
              ? 'Hay una solicitud de descuento global pendiente: espera la respuesta del administrador o cancélala antes de convertir'
              : 'El precio manual está en solicitud: espera la autorización del administrador antes de convertir',
          );
        }
        const quote = await tx.quote.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
        if (quote.lines.some((line) => line.pricingMethod === 'MANUAL' && !line.manualApprovedById)) {
          throw new ConflictException('La cotización tiene precios manuales sin autorizar: envía la solicitud a un administrador antes de convertir');
        }
        // The payment method is agreed when the customer buys: sent with the
        // conversion, or the one saved in the quote. It stays in the quote too.
        const paymentMethod = dto.paymentMethod ?? quote.paymentMethod;
        if (!paymentMethod) {
          throw new BadRequestException('Elige la forma de pago para convertir la cotización en orden de venta');
        }
        const paymentTerms = dto.paymentTerms !== undefined ? dto.paymentTerms || null : quote.paymentTerms;
        if (dto.requiresBilling) await this.requireBillingData(tx, quote.customerId);
        // Contado: the money received at the sale, in one or two media, adding
        // up exactly to the total (abono / cartera: recorded later, per abono).
        const contado = contadoSplit(paymentMethod, quote.total, dto);
        for (const part of contado) if (part.transferEntityId) await requireTransferEntity(tx, part.transferEntityId);
        // Saldo a favor (from the customer's returns): the customer must have it.
        const credit = contado.find((part) => part.medium === 'CREDIT_BALANCE');
        if (credit) {
          await lockCustomer(tx, quote.customerId);
          const available = await customerCredit(tx, quote.customerId);
          if (credit.amount.gt(available)) {
            throw new BadRequestException(
              available.gt(ZERO) ? `El cliente tiene ${pesos(available)} de saldo a favor: no alcanza para ${pesos(credit.amount)}` : 'El cliente no tiene saldo a favor',
            );
          }
        }
        const prepaid = contado.reduce((total, part) => total.plus(part.amount), ZERO);
        if (paymentMethod !== quote.paymentMethod || paymentTerms !== quote.paymentTerms) {
          await tx.quote.update({ where: { id }, data: { paymentMethod, paymentTerms } });
        }
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
            // Services travel with the order; they are not lines, so they
            // are never reserved nor dispatched.
            saleType: quote.saleType,
            assemblyAmount: quote.assemblyAmount,
            installationAmount: quote.installationAmount,
            total: quote.total,
            notes: quote.notes,
            paymentMethod,
            paymentTerms,
            // Abono / credit: pending until someone records the payment.
            paymentStatus: COLLECTED_LATER.includes(paymentMethod) ? (prepaid.gte(quote.total) && quote.total.gt(ZERO) ? 'PAID' : 'PENDING') : null,
            convertOperationKey: dto.operationKey,
            ...(dto.requiresBilling ? { requiresBilling: true, billingRequestedAt: new Date() } : {}),
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
                manualPrice: line.pricingMethod === 'MANUAL',
                priceReason: line.pricingMethod === 'MANUAL' ? line.priceReason : null,
                manualApprovedById: line.pricingMethod === 'MANUAL' ? line.manualApprovedById : null,
              })),
            },
          },
        });
        await tx.quote.update({ where: { id }, data: { status: 'CONVERTED' } });
        const paidOn = new Date(`${businessToday()}T00:00:00.000Z`);
        for (const part of contado) {
          const payment = await tx.salesOrderPayment.create({
            data: {
              salesOrderId: order.id,
              medium: part.medium,
              transferEntityId: part.transferEntityId,
              amount: part.amount,
              paidOn,
              // Contado is fixed at the sale; saldo a favor of an abono /
              // cartera order is an abono like the others.
              atSale: CONTADO.includes(paymentMethod),
              operationKey: `${dto.operationKey}:contado:${part.medium}`,
              createdById: user.id,
            },
          });
          await audit(tx, {
            entity: 'SalesOrderPayment',
            entityId: payment.id,
            action: 'PAYMENT_RECORDED',
            userId: user.id,
            data: {
              orderId: order.id,
              amount: part.amount.toFixed(2),
              medium: part.medium,
              transferEntityId: part.transferEntityId,
              paidOn: businessToday(),
              note: null,
              atSale: CONTADO.includes(paymentMethod),
            },
          });
        }
        if (dto.requiresBilling) await this.openBillingTask(tx, order, user);
        const manual = quote.lines.filter((line) => line.pricingMethod === 'MANUAL');
        await audit(tx, {
          entity: 'Quote',
          entityId: id,
          action: 'CONVERTED',
          userId: user.id,
          data: {
            orderId: order.id,
            orderNumber: order.number,
            paymentMethod,
            requiresBilling: Boolean(dto.requiresBilling),
            ...(manual.length > 0 ? { manualPrices: manual.map(describeManual) } : {}),
          },
        });
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

  // ADMIN: every order. BILLING: the orders sent to billing. SALES: its own.
  orderScope(user: SafeUser): Prisma.SalesOrderWhereInput {
    if (user.role === 'ADMIN') return {};
    if (user.role === 'BILLING') return { requiresBilling: true };
    return { createdById: user.id };
  }

  // Filters of the order list and the seller summary (combined with AND).
  private orderFilters(query: OrderListQueryDto): Prisma.SalesOrderWhereInput {
    // Days in Bogotá (UTC-05:00, no daylight saving time); `to` included.
    const day = (value: string, field: string) => {
      const date = new Date(`${value}T00:00:00.000-05:00`);
      if (Number.isNaN(date.getTime()) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
        throw new BadRequestException(`${field}: la fecha no existe`);
      }
      return date;
    };
    const from = query.dateFrom ? day(query.dateFrom, 'Desde') : undefined;
    const to = query.dateTo ? new Date(day(query.dateTo, 'Hasta').getTime() + 86_400_000) : undefined;
    if (from && to && from >= to) throw new BadRequestException('La fecha «desde» es posterior a la fecha «hasta»');
    const billing: Prisma.SalesOrderWhereInput =
      query.billing === 'PENDING'
        ? { requiresBilling: true, billedAt: null, NOT: { status: 'CANCELLED' } }
        : query.billing === 'BILLED'
          ? { billedAt: { not: null } }
          : {};
    return {
      ...(query.status ? { status: query.status as SalesOrderStatus } : {}),
      ...(query.sellerId ? { createdById: query.sellerId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}),
      ...(query.payment ? { paymentStatus: query.payment === 'NONE' ? null : query.payment } : {}),
      ...(query.billing ? { AND: [billing] } : {}),
    };
  }

  // Per seller (owner of the order): orders and amounts, split by payment
  // state, for commissions. Cancelled orders are left out. Base = value
  // before VAT after line and global discounts.
  async ordersSummary(query: OrderListQueryDto) {
    // Without a status filter, cancelled orders are not sales.
    const where: Prisma.SalesOrderWhereInput = { ...this.orderFilters(query), ...(query.status ? {} : { status: { not: 'CANCELLED' } }) };
    const groups = await this.prisma.salesOrder.groupBy({
      by: ['createdById', 'paymentStatus'],
      where,
      _count: { _all: true },
      _sum: { subtotal: true, discountTotal: true, globalDiscountAmount: true, total: true },
    });
    const sellers = await this.prisma.user.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.createdById))] } }, select: { id: true, name: true } });
    const empty = () => ({ orders: 0, base: ZERO, total: ZERO });
    const rows = new Map<string, { seller: { id: string; name: string }; all: ReturnType<typeof empty>; paid: ReturnType<typeof empty>; pending: ReturnType<typeof empty>; cash: ReturnType<typeof empty> }>();
    for (const group of groups) {
      const seller = sellers.find((s) => s.id === group.createdById) ?? { id: group.createdById, name: 'Usuario eliminado' };
      const row = rows.get(seller.id) ?? { seller, all: empty(), paid: empty(), pending: empty(), cash: empty() };
      const base = dec(group._sum.subtotal).minus(dec(group._sum.discountTotal)).minus(dec(group._sum.globalDiscountAmount));
      const total = dec(group._sum.total);
      const bucket = group.paymentStatus === 'PAID' ? row.paid : group.paymentStatus === 'PENDING' ? row.pending : row.cash;
      for (const target of [row.all, bucket]) {
        target.orders += group._count._all;
        target.base = target.base.plus(base);
        target.total = target.total.plus(total);
      }
      rows.set(seller.id, row);
    }
    // Received returns of those orders, by their seller: sold and came back.
    const returns = await this.prisma.salesReturn.findMany({
      where: { status: 'RECEIVED', salesOrder: where },
      select: { amount: true, baseAmount: true, salesOrder: { select: { createdById: true } } },
    });
    const back = new Map<string, { returns: number; base: Decimal; total: Decimal }>();
    for (const item of returns) {
      const row = back.get(item.salesOrder.createdById) ?? { returns: 0, base: ZERO, total: ZERO };
      row.returns += 1;
      row.base = row.base.plus(dec(item.baseAmount));
      row.total = row.total.plus(dec(item.amount));
      back.set(item.salesOrder.createdById, row);
    }
    const returned = (sellerId: string) => {
      const row = back.get(sellerId) ?? { returns: 0, base: ZERO, total: ZERO };
      return { returns: row.returns, base: row.base.toFixed(2), total: row.total.toFixed(2) };
    };
    const text = (bucket: ReturnType<typeof empty>) => ({ orders: bucket.orders, base: bucket.base.toFixed(2), total: bucket.total.toFixed(2) });
    return [...rows.values()]
      .sort((a, b) => b.all.total.comparedTo(a.all.total) || a.seller.name.localeCompare(b.seller.name))
      .map((row) => ({
        seller: row.seller,
        all: text(row.all),
        paid: text(row.paid),
        pending: text(row.pending),
        cash: text(row.cash),
        returned: returned(row.seller.id),
      }));
  }

  // Excel of the filtered orders (same filters as the list), for commissions.
  // Cancelled orders are included and marked; the summary sheet is the same
  // as on screen (without cancelled orders unless filtered by them).
  async exportOrders(query: OrderListQueryDto, user: SafeUser) {
    const where = this.orderFilters(query);
    const count = await this.prisma.salesOrder.count({ where });
    if (count > MAX_EXPORT_ORDERS) {
      throw new BadRequestException(
        `Hay ${count.toLocaleString('es-CO')} órdenes con estos filtros; el máximo por archivo es ${MAX_EXPORT_ORDERS.toLocaleString('es-CO')}. Acota el rango de fechas.`,
      );
    }
    const [orders, summary, seller] = await Promise.all([
      this.prisma.salesOrder.findMany({
        where,
        include: {
          customer: { select: { taxId: true } },
          createdBy: authorSelect,
          convertedBy: authorSelect,
          quote: { select: { number: true } },
          lines: { orderBy: { lineNo: 'asc' } },
          returns: {
            where: { status: 'RECEIVED' },
            orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
            include: { lines: { orderBy: { salesOrderLine: { lineNo: 'asc' } }, include: { salesOrderLine: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.ordersSummary(query),
      query.sellerId ? this.prisma.user.findUnique({ where: { id: query.sellerId }, select: { name: true } }) : null,
    ]);
    const now = new Date();
    const filters: [string, string][] = [
      ['Vendedor', query.sellerId ? (seller?.name ?? 'Usuario no encontrado') : 'Todos'],
      ['Desde', query.dateFrom ?? 'Sin límite'],
      ['Hasta', query.dateTo ?? 'Sin límite'],
      ['Estado de la orden', query.status ? (ORDER_STATUS[query.status as keyof typeof ORDER_STATUS] ?? query.status) : 'Todos (canceladas en rojo)'],
      ['Estado de pago', query.payment ? EXPORT_PAYMENT_FILTER[query.payment] : 'Todos'],
      ['Órdenes', String(orders.length)],
    ];
    const file = await renderSalesExport({
      generatedAt: now,
      generatedBy: user.name,
      filters,
      summary,
      orders: orders.map((order) => ({
        number: order.number,
        createdAt: order.createdAt,
        seller: order.createdBy.name,
        convertedBy: order.convertedBy?.name ?? null,
        customerName: order.customerName,
        customerTaxId: order.customer.taxId,
        saleType: order.saleType === 'WINDOWS' ? 'Ventanería' : 'Detal',
        paymentMethod: order.paymentMethod ? PAYMENT_METHOD_LABEL[order.paymentMethod] : null,
        paymentTerms: order.paymentTerms,
        status: ORDER_STATUS[order.status],
        cancelled: order.status === 'CANCELLED',
        paymentStatus: order.paymentStatus === 'PAID' ? 'Pagada' : order.paymentStatus === 'PENDING' ? 'Pago pendiente' : 'De contado',
        quoteNumber: order.quote?.number ?? null,
        subtotal: order.subtotal,
        discountTotal: order.discountTotal,
        globalDiscountAmount: order.globalDiscountAmount,
        taxTotal: order.taxTotal,
        assemblyAmount: order.assemblyAmount,
        installationAmount: order.installationAmount,
        total: order.total,
        cancelReason: order.cancelReason,
        requiresBilling: order.requiresBilling,
        invoiceNumber: order.invoiceNumber,
        billedAt: order.billedAt,
        lines: order.lines.map((line) => ({ ...line, origin: line.origin === 'CHINA' ? 'China' : 'Nacional' })),
        returns: order.returns.map((item) => ({
          number: item.number,
          receivedAt: item.receivedAt!,
          reason: REASON_LABEL[item.reason],
          // What happened with the money beyond lowering the balance.
          settlement: dec(item.settledAmount).gt(ZERO) ? SETTLEMENT_LABEL[item.settlement] : 'Descontado del saldo',
          settledAmount: dec(item.settledAmount),
          creditNoteNumber: item.creditNoteNumber,
          lines: item.lines.map((line) => ({
            lineNo: line.salesOrderLine.lineNo,
            referenceCode: line.salesOrderLine.referenceCode,
            referenceDescription: line.salesOrderLine.referenceDescription,
            finishCode: line.salesOrderLine.finishCode,
            origin: line.salesOrderLine.origin === 'CHINA' ? 'China' : 'Nacional',
            good: line.goodQuantity ?? 0,
            damaged: line.damagedQuantity ?? 0,
            amount: dec(line.amount),
            baseAmount: dec(line.baseAmount),
          })),
        })),
      })),
    });
    const who = seller ? `_${slug(seller.name)}` : '';
    const range = `${query.dateFrom ?? 'inicio'}_a_${query.dateTo ?? bogotaDay(now)}`;
    return { filename: `ventas${who}_${range}.xlsx`, file };
  }

  async listOrders(query: OrderListQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    // SALES: always within its own orders (whatever seller it asks for).
    const where: Prisma.SalesOrderWhereInput = { AND: [this.orderFilters(query), this.orderScope(user)] };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.salesOrder.count({ where }),
      this.prisma.salesOrder.findMany({
        where,
        include: {
          ...(user.role === 'ADMIN' || user.role === 'BILLING' ? { createdBy: authorSelect, convertedBy: authorSelect } : {}),
          billedBy: authorSelect,
          _count: { select: { lines: true, dispatches: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  // Entities where Solaluminios receives transfers (the only list; inactive
  // ones are not offered).
  transferEntities() {
    return this.prisma.transferEntity.findMany({ where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, name: true } });
  }

  async getOrder(id: string, user: SafeUser) {
    return forViewer(await this.withPayments(await this.loadOrder(id, user), user), user);
  }

  // Payments of the order, with total paid and balance computed here (never
  // typed by anyone), and the corrections of each one from the audit. Only
  // who records payments sees them (ADMIN and the owner seller): billing
  // reads the order without them. Authors of payments and corrections: ADMIN.
  //
  // Returns (documento DV) are shown to everyone who sees the order (billing
  // makes their credit notes). The balance counts them: net total = total −
  // value returned; paid = payments − what was given back to the customer.
  private async withPayments<T extends { total: Decimal; customerId: string; payments: OrderWithLines['payments']; returns: OrderWithLines['returns'] }>(
    order: T,
    user: SafeUser,
  ) {
    const { payments, returns, ...rest } = order;
    const received = returns.filter((r) => r.status === 'RECEIVED');
    const returned = received.reduce((total, r) => total.plus(dec(r.amount)), ZERO);
    const settled = received.reduce((total, r) => total.plus(dec(r.settledAmount)), ZERO);
    const returnList = returns.map(({ _count, amount, baseAmount, settledAmount, ...r }) => ({
      ...r,
      reasonLabel: REASON_LABEL[r.reason],
      settlementLabel: SETTLEMENT_LABEL[r.settlement],
      lines: _count.lines,
      amount: amount?.toFixed(2) ?? null,
      baseAmount: baseAmount?.toFixed(2) ?? null,
      settledAmount: settledAmount?.toFixed(2) ?? null,
      refundPending: r.status === 'RECEIVED' && r.settlement === 'REFUND' && dec(settledAmount).gt(ZERO) && !r.refundedAt,
    }));
    const returnSummary = { returned: returned.toFixed(2), net: order.total.minus(returned).toFixed(2) };
    if (user.role !== 'ADMIN' && user.role !== 'SALES') return { ...rest, returns: returnList, returnSummary };
    const admin = user.role === 'ADMIN';
    const edits = payments.length
      ? await this.prisma.auditEvent.findMany({
          where: { entity: 'SalesOrderPayment', action: 'PAYMENT_EDITED', entityId: { in: payments.map((p) => p.id) } },
          orderBy: { at: 'asc' },
          select: { entityId: true, at: true, data: true, user: { select: { id: true, name: true } } },
        })
      : [];
    const paid = payments.reduce((total, p) => total.plus(p.amount), ZERO);
    const { net, balance } = orderMoney({ total: order.total, paid, returned, settled });
    return {
      ...rest,
      returns: returnList,
      returnSummary,
      // Saldo a favor of the customer (from returns), usable as a payment.
      customerCredit: (await customerCredit(this.prisma, order.customerId)).toFixed(2),
      payments: payments.map(({ createdBy, updatedBy, ...payment }) => ({
        ...payment,
        paidOn: payment.paidOn.toISOString().slice(0, 10),
        edited: updatedBy !== null,
        ...(admin ? { createdBy, updatedBy } : {}),
        changes: edits
          .filter((e) => e.entityId === payment.id)
          .map((e) => ({ at: e.at, changed: (e.data as { changed?: unknown } | null)?.changed ?? {}, ...(admin ? { by: e.user } : {}) })),
      })),
      paymentSummary: {
        // No records: an order converted before payments existed (nothing is
        // invented) or an abono / cartera order still without abonos.
        recorded: payments.length > 0,
        total: order.total.toFixed(2),
        // Value of the received returns and what of it went back to the
        // customer (saldo a favor or reintegro); the rest lowered the balance.
        returned: returned.toFixed(2),
        settled: settled.toFixed(2),
        net: net.toFixed(2),
        paid: paid.toFixed(2),
        balance: balance.toFixed(2),
        complete: payments.length > 0 && balance.lte(ZERO),
      },
    };
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
      // With abonos recorded, they decide the status (paid when the balance is zero).
      if ((await tx.salesOrderPayment.count({ where: { salesOrderId: id } })) > 0) {
        throw new ConflictException('El estado de pago lo calculan los abonos registrados: agrega o corrige un abono');
      }
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
      if (order.requiresBilling) await this.billingAfterCancel(tx, order, reason, user);
    });
    return this.getOrder(id, user);
  }

  // --- Billing (the invoice itself is made in another software) -------------------

  // The customer must have what an electronic invoice needs.
  private async requireBillingData(tx: Tx, customerId: string) {
    const customer = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { name: true, taxId: true, email: true } });
    const missing = [!customer.taxId?.trim() ? 'NIT o cédula' : null, !customer.email?.trim() ? 'correo electrónico' : null].filter(Boolean);
    if (missing.length > 0) {
      throw new BadRequestException(`Para enviarla a facturación, el cliente «${customer.name}» necesita ${missing.join(' y ')}. Complétalos y vuelve a intentarlo.`);
    }
  }

  // Active BILLING user (in turn if there are several). Without one, the
  // oldest active administrator, so the request is never lost.
  async billingAssignee(tx: Tx): Promise<{ id: string; fallback: boolean }> {
    const users = await tx.user.findMany({ where: { active: true, role: 'BILLING' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (users.length === 1) return { id: users[0].id, fallback: false };
    if (users.length > 1) {
      const last = await tx.task.findFirst({ where: { kind: 'BILLING' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { assigneeId: true } });
      const index = last ? users.findIndex((u) => u.id === last.assigneeId) : -1;
      return { id: users[(index + 1) % users.length].id, fallback: false };
    }
    const admin = await tx.user.findFirst({ where: { active: true, role: 'ADMIN' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!admin) throw new ConflictException('No hay un usuario de facturación ni un administrador activo para recibir la orden');
    return { id: admin.id, fallback: true };
  }

  // Creates the BILLING task of the order, or reopens it (requested again
  // after being unmarked), and notifies the billing user.
  private async openBillingTask(tx: Tx, order: { id: string; number: string; customerName: string; total: Decimal }, user: SafeUser) {
    const assignee = await this.billingAssignee(tx);
    const now = new Date();
    const data = {
      title: `Facturar ${order.number}`,
      description:
        `${order.customerName} · total ${formatPesos(order.total)}. Descarga el PDF de la orden, genera la factura en el software de facturación y registra aquí su número.` +
        (assignee.fallback ? ' (No hay un usuario de Facturación activo: la recibe un administrador.)' : ''),
      dueAt: new Date(now.getTime() + 24 * 3_600_000),
      assigneeId: assignee.id,
      createdById: user.id,
    };
    const existing = await tx.task.findUnique({ where: { salesOrderId_kind: { salesOrderId: order.id, kind: 'BILLING' } }, select: { id: true } });
    if (existing) await tx.task.update({ where: { id: existing.id }, data: { ...data, completedAt: null, cancelledAt: null } });
    else await tx.task.create({ data: { ...data, kind: 'BILLING', salesOrderId: order.id } });
    await enqueue(tx, [{ userId: assignee.id, kind: 'billing-requested', dedupeKey: `billing-requested:${order.id}:${now.getTime()}` }]);
  }

  // The seller (own orders) or ADMIN marks whether the order needs an
  // invoice. Unmarking is possible until it is invoiced.
  async setBilling(id: string, required: boolean, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.requiresBilling === required) return;
      if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada');
      if (!required && order.billedAt) {
        throw new ConflictException(`La orden ya está facturada (factura ${order.invoiceNumber}): ya no se puede desmarcar`);
      }
      if (required) {
        await this.requireBillingData(tx, order.customerId);
        await tx.salesOrder.update({ where: { id }, data: { requiresBilling: true, billingRequestedAt: new Date() } });
        await this.openBillingTask(tx, order, user);
      } else {
        await tx.salesOrder.update({ where: { id }, data: { requiresBilling: false, billingRequestedAt: null } });
        const task = await tx.task.findUnique({ where: { salesOrderId_kind: { salesOrderId: id, kind: 'BILLING' } } });
        if (task && !task.completedAt && !task.cancelledAt) {
          await tx.task.update({ where: { id: task.id }, data: { cancelledAt: new Date() } });
          await enqueue(tx, [{ userId: task.assigneeId, kind: 'billing-cancelled', dedupeKey: `billing-cancelled:${id}:${Date.now()}` }]);
        }
      }
      await audit(tx, { entity: 'SalesOrder', entityId: id, action: required ? 'BILLING_REQUESTED' : 'BILLING_UNREQUESTED', userId: user.id });
    });
    return this.getOrder(id, user);
  }

  // The billing user (or ADMIN) records the number of the invoice made in
  // the billing software. Repeating the same number changes nothing.
  async recordInvoice(id: string, invoiceNumber: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockOrder(tx, id, user);
      if (order.billedAt) {
        if (order.invoiceNumber === invoiceNumber) return;
        throw new ConflictException(`La orden ya está facturada con la factura ${order.invoiceNumber}`);
      }
      if (!order.requiresBilling) throw new ConflictException('La orden no está marcada para facturación');
      if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada: no se factura');
      const now = new Date();
      await tx.salesOrder.update({ where: { id }, data: { invoiceNumber, billedAt: now, billedById: user.id } });
      await tx.task.updateMany({ where: { salesOrderId: id, kind: 'BILLING', completedAt: null }, data: { completedAt: now, cancelledAt: null } });
      await enqueue(tx, [{ userId: order.createdById, kind: 'order-billed', dedupeKey: `order-billed:${id}` }]);
      await audit(tx, { entity: 'SalesOrder', entityId: id, action: 'INVOICED', userId: user.id, data: { invoiceNumber } });
    });
    return this.getOrder(id, user);
  }

  // Cancelling an order sent to billing: the pending task is cancelled; if
  // it was already invoiced, billing gets a task to void the invoice.
  private async billingAfterCancel(tx: Tx, order: SalesOrder, reason: string, user: SafeUser) {
    const task = await tx.task.findUnique({ where: { salesOrderId_kind: { salesOrderId: order.id, kind: 'BILLING' } } });
    if (!order.billedAt) {
      if (task && !task.completedAt && !task.cancelledAt) {
        await tx.task.update({ where: { id: task.id }, data: { cancelledAt: new Date() } });
        await enqueue(tx, [{ userId: task.assigneeId, kind: 'billing-cancelled', dedupeKey: `billing-cancelled:${order.id}:${Date.now()}` }]);
      }
      return;
    }
    const assigneeId = order.billedById ?? task?.assigneeId ?? (await this.billingAssignee(tx)).id;
    await tx.task.create({
      data: {
        title: `Anular factura ${order.invoiceNumber} (${order.number} cancelada)`,
        description: `La orden ${order.number} de ${order.customerName} se canceló después de facturarse. Motivo: ${reason}. Haz la anulación o nota crédito en el software de facturación y marca esta tarea como completada.`,
        dueAt: new Date(Date.now() + 3 * 24 * 3_600_000),
        assigneeId,
        createdById: user.id,
      },
    });
    await enqueue(tx, [{ userId: assigneeId, kind: 'billing-void-needed', dedupeKey: `billing-void-needed:${order.id}` }]);
  }

  // --- Printable documents ------------------------------------------------------

  // Same access as reading the document (SALES: own documents only; others
  // get 404). Prints customer-facing values only, never costs.
  async quotePdf(id: string, user: SafeUser) {
    const quote = await this.loadQuote(id, user);
    // The customer never sees a price nobody authorised (ADMIN may preview).
    if (user.role !== 'ADMIN' && quote.lines.some((line) => line.manualPrice && !line.manualApprovedById)) {
      throw new ConflictException('La cotización tiene precios manuales sin autorizar: el PDF se habilita cuando un administrador los apruebe');
    }
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
      services: { assembly: quote.assemblyAmount, installation: quote.installationAmount },
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
      services: { assembly: order.assemblyAmount, installation: order.installationAmount },
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

