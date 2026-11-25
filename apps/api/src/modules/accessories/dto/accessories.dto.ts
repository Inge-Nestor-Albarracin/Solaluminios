import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { AccessoryExitType, MaterialOrigin } from '../../../generated/prisma/client.js';
import { EPC_PATTERN, normalizeEpc } from '../../inventory/dto/register-bundle.dto.js';
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
// Empty text means "not given".
const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  return text === '' ? null : text;
};

// Most units a basket may hold (same bound as a bundle).
export const MAX_BASKET_QUANTITY = 1_000_000;
// Most baskets in one voucher.
export const MAX_VOUCHER_LINES = 200;

class OperationDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID('all', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;
}

// A fixed basket of the accessories warehouse gets its chip once: reference
// (accessory), colour, origin and the units counted today (INITIAL_STOCK).
export class RegisterBasketDto extends OperationDto {
  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @IsString()
  @IsNotEmpty({ message: 'El chip es obligatorio' })
  @MaxLength(128)
  @Matches(EPC_PATTERN, { message: 'El chip solo puede contener letras y números, sin espacios' })
  epc!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige el accesorio' })
  @MaxLength(50)
  referenceId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige el color' })
  @MaxLength(50)
  finishId!: string;

  @IsEnum(MaterialOrigin, { message: 'El origen debe ser CHINA o NATIONAL' })
  origin!: MaterialOrigin;

  @IsInt({ message: 'La cantidad debe ser un número entero de unidades' })
  @Min(0, { message: 'La cantidad no puede ser negativa' })
  @Max(MAX_BASKET_QUANTITY)
  quantity!: number;

  // Administrator only: the accessories warehouse. The accessories user
  // always works in the one assigned to them.
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  inventoryLocationId?: string | null;
}

export class VoucherLineDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  basketId!: string;

  @IsInt({ message: 'La cantidad debe ser un número entero de unidades' })
  @Min(1, { message: 'La cantidad debe ser mayor que cero' })
  @Max(MAX_BASKET_QUANTITY)
  quantity!: number;
}

class VoucherDto extends OperationDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Agrega al menos una canasta' })
  @ArrayMaxSize(MAX_VOUCHER_LINES, { message: `Máximo ${MAX_VOUCHER_LINES} canastas por comprobante` })
  @ValidateNested({ each: true })
  @Type(() => VoucherLineDto)
  lines!: VoucherLineDto[];

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

// Purchased units put in the baskets, with their support.
export class CreateEntryDto extends VoucherDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el proveedor' })
  @MaxLength(150)
  supplierName!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el número de la factura o la remisión' })
  @MaxLength(60)
  documentNumber!: string;

  // Day the goods arrived (YYYY-MM-DD); optional.
  @Transform(trimOrNull)
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La fecha de llegada debe tener el formato AAAA-MM-DD' })
  arrivalDate?: string | null;
}

// Units that leave without a sale registered in the system.
export class CreateExitDto extends VoucherDto {
  @IsEnum(AccessoryExitType, { message: 'El tipo de salida debe ser UNREGISTERED_SALE o INTERNAL_USE' })
  exitType!: AccessoryExitType;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Describe la salida' })
  @MaxLength(500)
  detail!: string;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(150)
  receivedBy?: string | null;
}

export class BasketQueryDto {
  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string | null;

  @Transform(trimOrNull)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  inventoryLocationId?: string | null;
}

export class VoucherQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['ENTRY', 'EXIT'])
  kind?: 'ENTRY' | 'EXIT';
}
