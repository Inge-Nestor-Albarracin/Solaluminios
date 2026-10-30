import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsEnum,
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
import { MaterialOrigin, PaymentMethod, PaymentStatus } from '../../../generated/prisma/client.js';
import { DECIMAL_PATTERN } from '../../../shared/money.js';
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DECIMAL_MESSAGE = 'debe ser un número decimal escrito como texto';

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

  // No price, cost or profit fields: the line takes the sale price enabled by
  // ADMIN for its reference, finish and origin (any extra field is rejected).

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

  // Contado (efectivo / transferencia), abono or cartera (crédito).
  @IsEnum(PaymentMethod, { message: 'Indica la forma de pago: contado en efectivo, contado por transferencia, abono o cartera (crédito)' })
  paymentMethod!: PaymentMethod;

  // Details agreed with the customer, e.g. advance amount or credit days.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  paymentTerms?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'La cotización necesita al menos un renglón' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  lines!: QuoteLineDto[];
}

export class ListQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(30)
  status?: string;
}

export class ConvertQuoteDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;
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
