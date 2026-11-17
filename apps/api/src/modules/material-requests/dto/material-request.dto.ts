import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
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
import { MaterialOrigin } from '../../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';
import { EPC_PATTERN, normalizeEpc } from '../../inventory/dto/register-bundle.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Most lines of one request (one transaction).
export const MAX_REQUEST_LINES = 50;

export class MaterialRequestLineDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige la referencia' })
  @MaxLength(50)
  referenceId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige el color' })
  @MaxLength(50)
  finishId!: string;

  @IsEnum(MaterialOrigin, { message: 'El origen es China (CHINA) o Nacional (NATIONAL)' })
  origin!: MaterialOrigin;

  // Only when the material must come from one supplier.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supplierId?: string;

  // Profiles asked (not bundles).
  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1, { message: 'La cantidad debe ser mayor que cero' })
  @Max(1000000, { message: 'La cantidad máxima por renglón es 1.000.000 perfiles' })
  quantity!: number;
}

export class CreateMaterialRequestDto {
  // One UUID per request sent: a retry (double click, lost answer) returns it.
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID('all', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige la bodega que abastece' })
  @MaxLength(50)
  sourceLocationId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige el almacén destino' })
  @MaxLength(50)
  destinationLocationId!: string;

  // When Bodega should have it ready; omitted: 24 hours from now.
  @IsOptional()
  @Matches(/T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, { message: 'dueAt debe incluir hora y zona horaria' })
  @IsISO8601({ strict: true, strictSeparator: true })
  dueAt?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  // Omitted: the warehouse worker whose turn it is.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  assigneeId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Agrega al menos un renglón' })
  @ArrayMaxSize(MAX_REQUEST_LINES, { message: `Máximo ${MAX_REQUEST_LINES} renglones por solicitud` })
  @ValidateNested({ each: true })
  @Type(() => MaterialRequestLineDto)
  lines!: MaterialRequestLineDto[];
}

export const REQUEST_STATUSES = ['SENT', 'PREPARING', 'SHIPPED', 'RECEIVED', 'CANCELLED', 'OPEN'] as const;

export class MaterialRequestQueryDto extends PaginationQueryDto {
  // OPEN: sent or being prepared.
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: (typeof REQUEST_STATUSES)[number];
}

export class WorkersQueryDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  sourceLocationId!: string;
}

// A bundle prepared by reading its chip; loose profiles (opened bundle) can
// also be taken by its id, without a chip.
export class PickDto {
  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @ValidateIf((dto: PickDto) => dto.bundleId === undefined)
  @IsString()
  @IsNotEmpty({ message: 'Lee el chip del paquete' })
  @MaxLength(128)
  @Matches(EPC_PATTERN, { message: 'El chip solo puede contener letras y números, sin espacios' })
  epc?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  bundleId?: string;
}

export class ShipDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsUUID('all', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;
}

export class ReceiveDto {
  // Anything different from what was shipped (missing, damaged…).
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AssigneeDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Elige el bodeguero' })
  @MaxLength(50)
  assigneeId!: string;
}

export class CancelRequestDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el motivo de la cancelación' })
  @MaxLength(300)
  reason!: string;
}
