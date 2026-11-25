import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MaterialOrigin, PaymentMedium, PaymentMethod, SaleType, PaymentStatus } from '../../../generated/prisma/client.js';
import { DECIMAL_PATTERN } from '../../../shared/money.js';

// Assembly / installation: pesos with up to 2 decimals (no VAT, no discount).
const SERVICE_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
// Money received for an order: pesos with up to 2 decimals, as text.
const PAYMENT_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
// A calendar day (business day in Colombia).
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DECIMAL_MESSAGE = 'debe ser un número decimal escrito como texto';
const GLOBAL_DISCOUNT_PATTERN = /^\d{1,3}(\.\d{1,2})?$/;
const GLOBAL_DISCOUNT_MESSAGE = 'El descuento global es un porcentaje con hasta 2 decimales, p. ej. "2.5"';

export class SaveCustomerDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'El nombre del cliente es obligatorio' })
  @MaxLength(150)
  name!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxId?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @Transform(trim)
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;
}

export class CustomerQueryDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AvailabilityQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  referenceId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  finishId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  inventoryLocationId?: string;
}

// Sale price for a material and origin, from the rule set by ADMIN.
export class SalePriceQueryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  referenceId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  finishId!: string;

  @IsEnum(MaterialOrigin)
  origin!: MaterialOrigin;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  supplierId?: string;
}

export class QuoteLineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  referenceId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  finishId!: string;

  // Required and explicit: China and National are different restrictions.
  @IsEnum(MaterialOrigin, { message: 'Indica el origen del material (China o Nacional)' })
  origin!: MaterialOrigin;

  // Only when the customer requires a specific supplier.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supplierId?: string;

  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1)
  @Max(1000000)
  quantity!: number;

  // No cost or profit fields: the line takes the sale price enabled by ADMIN
  // for its reference, finish and origin, unless the seller sets a manual
  // price, which needs an administrator's authorisation (any extra field is
  // rejected).

  // Manual sale price per profile before VAT (always allowed, with or without
  // an enabled price or stock).
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: `manualUnitPrice ${DECIMAL_MESSAGE}` })
  manualUnitPrice?: string;

  // Manual price only: why (required with a manual price).
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  priceReason?: string;

  // Manual price only: estimated purchase cost per profile (optional).
  @IsOptional()
  @Matches(DECIMAL_PATTERN, { message: `estimatedUnitCost ${DECIMAL_MESSAGE}` })
  estimatedUnitCost?: string;

  @Matches(DECIMAL_PATTERN, { message: `discountPercent ${DECIMAL_MESSAGE}` })
  discountPercent!: string;

  // Sales VAT of the line (the screen preloads 19 %; editable, may be 0).
  @Matches(DECIMAL_PATTERN, { message: `taxRatePercent ${DECIMAL_MESSAGE}` })
  taxRatePercent!: string;
}

export class SaveQuoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  customerId!: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'validUntil debe tener el formato AAAA-MM-DD' })
  validUntil?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  // Contado (efectivo / transferencia), abono or cartera (crédito). Optional
  // in a quote (it may be just an inquiry); required when it becomes an
  // order (ConvertQuoteDto).
  @IsOptional()
  @IsEnum(PaymentMethod, { message: 'Indica la forma de pago: contado en efectivo, contado por transferencia, contado en efectivo y transferencia, abono o cartera (crédito)' })
  paymentMethod?: PaymentMethod;

  // Details agreed with the customer, e.g. advance amount or credit days.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  paymentTerms?: string;

  // «Detal» (RETAIL, default) or «Ventanería» (WINDOWS).
  @IsOptional()
  @IsEnum(SaleType, { message: 'La modalidad es Detal (RETAIL) o Ventanería (WINDOWS)' })
  saleType?: SaleType;

  // Ventanería only: assembly in the workshop and installation, whole
  // amounts typed by the seller (pesos, up to 2 decimals), without VAT nor
  // discounts. Omitted = 0.
  @IsOptional()
  @Matches(SERVICE_AMOUNT_PATTERN, { message: 'El valor del ensamble debe ser un monto en pesos, con máximo 2 decimales' })
  assemblyAmount?: string;

  @IsOptional()
  @Matches(SERVICE_AMOUNT_PATTERN, { message: 'El valor de la instalación debe ser un monto en pesos, con máximo 2 decimales' })
  installationAmount?: string;

  // Discount on the whole quote, after line discounts and before VAT: 0 or
  // 0.1–100 % with up to 2 decimals. SALES: up to 3 % (or what an
  // administrator approved for this quote). Omitted = 0.
  @IsOptional()
  @Matches(GLOBAL_DISCOUNT_PATTERN, { message: GLOBAL_DISCOUNT_MESSAGE })
  globalDiscountPercent?: string;

  // Consent to cancel an open manual-price request that this save makes out
  // of date (its progress is lost). Without it such a save is refused (409).
  @IsOptional()
  @IsBoolean()
  replacePendingPriceRequest?: boolean;

  @IsArray()
  @ArrayMinSize(1, { message: 'La cotización necesita al menos un renglón' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines!: QuoteLineDto[];
}

// A seller asks the administrator they choose to authorise a global
// discount above their own limit.
export class DiscountRequestDto {
  @Matches(GLOBAL_DISCOUNT_PATTERN, { message: GLOBAL_DISCOUNT_MESSAGE })
  percent!: string;

  @IsString()
  @IsNotEmpty({ message: 'Elige el administrador que autorizará el descuento' })
  @MaxLength(50)
  approverId!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// A seller asks the administrator they choose to authorise the manual prices
// of the quote. `replace` cancels an open request (its progress is lost).
export class PriceRequestDto {
  @IsString()
  @IsNotEmpty({ message: 'Elige el administrador que autorizará el precio manual' })
  @MaxLength(50)
  approverId!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class ApprovedPriceLineDto {
  @IsInt()
  @Min(1)
  @Max(1000)
  lineNo!: number;

  @Matches(DECIMAL_PATTERN, { message: `unitPrice ${DECIMAL_MESSAGE}` })
  unitPrice!: string;
}

// The administrator may correct any requested price when approving.
export class ApprovePriceDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ApprovedPriceLineDto)
  lines?: ApprovedPriceLineDto[];
}

export class ResolveDiscountDto {
  // Optional explanation when the administrator rejects the request.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  resolution?: string;
}

export class ListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;
}

// Orders by seller (the owner of the order), creation day (Bogotá, both ends
// included) and payment state, for commissions. Filters combine freely.
// payment: PAID / PENDING (abono and credit orders) or NONE (cash and
// transfer orders, whose payment is not followed).
export class OrderListQueryDto extends ListQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  sellerId?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateFrom debe tener el formato AAAA-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateTo debe tener el formato AAAA-MM-DD' })
  dateTo?: string;

  @IsOptional()
  @IsIn(['PAID', 'PENDING', 'NONE'], { message: 'payment debe ser PAID, PENDING o NONE' })
  payment?: 'PAID' | 'PENDING' | 'NONE';

  // Electronic invoice: PENDING (to invoice, not cancelled) or BILLED.
  @IsOptional()
  @IsIn(['PENDING', 'BILLED'], { message: 'billing debe ser PENDING o BILLED' })
  billing?: 'PENDING' | 'BILLED';
}

export class ConvertQuoteDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;

  // Chosen when the customer confirms the purchase. Omitted: the one saved in
  // the quote; a quote without one cannot become an order.
  @IsOptional()
  @IsEnum(PaymentMethod, { message: 'Indica la forma de pago: contado en efectivo, contado por transferencia, contado en efectivo y transferencia, abono o cartera (crédito)' })
  paymentMethod?: PaymentMethod;

  // Omitted: the terms saved in the quote; empty clears them.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  paymentTerms?: string;

  // The order needs an electronic invoice (made in another software): a task
  // goes to the billing user. The customer needs NIT / ID and e-mail.
  @IsOptional()
  @IsBoolean({ message: 'requiresBilling debe ser verdadero o falso' })
  requiresBilling?: boolean;

  // Contado only: how the money received at the sale is split. With
  // CASH_TRANSFER both are required (free split) and must add up to the
  // order total; with CASH or TRANSFER the whole total is in that medium
  // (omitted: the total). Pesos with up to 2 decimals.
  @IsOptional()
  @Matches(PAYMENT_AMOUNT_PATTERN, { message: 'cashAmount debe ser un valor en pesos, con hasta 2 decimales' })
  cashAmount?: string;

  @IsOptional()
  @Matches(PAYMENT_AMOUNT_PATTERN, { message: 'transferAmount debe ser un valor en pesos, con hasta 2 decimales' })
  transferAmount?: string;

  // Part paid with the customer's saldo a favor (from returns), any method.
  @IsOptional()
  @Matches(PAYMENT_AMOUNT_PATTERN, { message: 'creditAmount debe ser un valor en pesos, con hasta 2 decimales' })
  creditAmount?: string;

  // Contado with a transfer (TRANSFER or the transferred part of
  // CASH_TRANSFER): where Solaluminios received it (id of transfer_entities).
  // Required then; never with cash.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  transferEntityId?: string;
}

// One payment (abono) received for an abono / cartera order: only what was
// just received; the system adds it up. The day is chosen (today by default).
export class AddOrderPaymentDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;

  @Matches(PAYMENT_AMOUNT_PATTERN, { message: 'El valor debe estar en pesos, con hasta 2 decimales' })
  amount!: string;

  @IsEnum(PaymentMedium, { message: 'El medio de pago es CASH (efectivo), TRANSFER (transferencia) o CREDIT_BALANCE (saldo a favor)' })
  medium!: PaymentMedium;

  // Transfer: where Solaluminios received it (required). Cash: not sent.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  transferEntityId?: string;

  @Matches(DAY_PATTERN, { message: 'La fecha del pago debe tener el formato AAAA-MM-DD' })
  paidOn!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

// Correction of a payment already recorded: only the fields sent change.
// `note` empty or null clears it.
export class EditOrderPaymentDto {
  @IsOptional()
  @Matches(PAYMENT_AMOUNT_PATTERN, { message: 'El valor debe estar en pesos, con hasta 2 decimales' })
  amount?: string;

  @IsOptional()
  @IsEnum(PaymentMedium, { message: 'El medio de pago es CASH (efectivo) o TRANSFER (transferencia)' })
  medium?: PaymentMedium;

  // Entity of a transfer. Required when a cash payment becomes a transfer;
  // a change to cash removes it.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  transferEntityId?: string;

  @IsOptional()
  @Matches(DAY_PATTERN, { message: 'La fecha del pago debe tener el formato AAAA-MM-DD' })
  paidOn?: string;

  @Transform(trim)
  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MaxLength(300)
  note?: string | null;
}

// Marks or unmarks an existing order as needing an invoice.
export class SetBillingDto {
  @IsBoolean({ message: 'required debe ser verdadero o falso' })
  required!: boolean;
}

// Number of the invoice made in the billing software.
export class InvoiceDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Escribe el número de la factura' })
  @MaxLength(40, { message: 'El número de factura tiene como máximo 40 caracteres' })
  @Matches(/^[\p{L}\p{N}][\p{L}\p{N} ._/-]*$/u, { message: 'El número de factura solo admite letras, números, espacios y . _ / -' })
  invoiceNumber!: string;
}

// What an invoice needs from the customer (completed from the order or the
// conversion when it is missing).
export class CustomerBillingDataDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'El NIT o la cédula es obligatorio para facturar' })
  @MaxLength(30)
  taxId!: string;

  @Transform(trim)
  @IsEmail({}, { message: 'Escribe un correo electrónico válido para la factura' })
  @MaxLength(150)
  email!: string;
}

export class ConfirmOrderDto {
  // Location from which the order will be reserved and dispatched.
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inventoryLocationId!: string;
}

export class UpdateOrderLineDto {
  @IsEnum(MaterialOrigin)
  origin!: MaterialOrigin;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(50)
  supplierId?: string | null;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el motivo del cambio' })
  @MaxLength(300)
  reason!: string;
}

// Abono / credit orders: whether the customer already paid.
export class UpdatePaymentStatusDto {
  @IsEnum(PaymentStatus, { message: 'El estado de pago es PENDING (pendiente) o PAID (pagada)' })
  status!: PaymentStatus;
}

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el motivo' })
  @MaxLength(500)
  reason!: string;
}
