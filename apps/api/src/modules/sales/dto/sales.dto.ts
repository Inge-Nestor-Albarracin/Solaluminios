import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { MaterialOrigin, PricingMethod } from '../../../generated/prisma/client.js';
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

export class PriceSuggestionQueryDto {
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

  @IsIn(['MARKUP_ON_COST', 'GROSS_MARGIN'])
  method!: 'MARKUP_ON_COST' | 'GROSS_MARGIN';

  @Matches(DECIMAL_PATTERN, { message: `percent ${DECIMAL_MESSAGE}` })
  percent!: string;
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

  @IsEnum(PricingMethod)
  pricingMethod!: PricingMethod;

  // MARKUP_ON_COST / GROSS_MARGIN.
  @ValidateIf((line: QuoteLineDto) => line.pricingMethod !== 'MANUAL')
  @Matches(DECIMAL_PATTERN, { message: `pricingPercent ${DECIMAL_MESSAGE}` })
  pricingPercent?: string;

  // MANUAL: authorised commercial price before tax, with a reason.
  @ValidateIf((line: QuoteLineDto) => line.pricingMethod === 'MANUAL')
  @Matches(DECIMAL_PATTERN, { message: `unitPrice ${DECIMAL_MESSAGE}` })
  unitPrice?: string;

  @Transform(trim)
  @ValidateIf((line: QuoteLineDto) => line.pricingMethod === 'MANUAL')
  @IsString()
  @IsNotEmpty({ message: 'El precio manual requiere un motivo' })
  @MaxLength(300)
  priceReason?: string;

  @Matches(DECIMAL_PATTERN, { message: `discountPercent ${DECIMAL_MESSAGE}` })
  discountPercent!: string;

  // Explicit sales tax rate for the line (no universal default).
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

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el motivo' })
  @MaxLength(500)
  reason!: string;
}
