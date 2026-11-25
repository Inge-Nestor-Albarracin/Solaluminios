import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { SalesReturnReason, SalesReturnSettlement, SalesReturnStatus } from '../../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';
import { EPC_PATTERN, normalizeEpc } from '../../inventory/dto/register-bundle.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// Profiles of one order line (whole profiles, like the rest of the system).
const MAX_PROFILES = 100000;

export class ReturnLineDto {
  @IsString()
  @MaxLength(50)
  salesOrderLineId!: string;

  @IsInt({ message: 'La cantidad a devolver es un número entero de perfiles' })
  @Min(1, { message: 'Devuelve al menos un perfil por renglón' })
  @Max(MAX_PROFILES)
  quantity!: number;
}

export class CreateReturnDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;

  @IsEnum(SalesReturnReason, { message: 'Elige el motivo de la devolución' })
  reason!: SalesReturnReason;

  @IsEnum(SalesReturnSettlement, { message: 'Elige qué se hace con el dinero: saldo a favor o reintegro' })
  settlement!: SalesReturnSettlement;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  // A seller chooses the administrator who authorises it (like discounts).
  @IsOptional()
  @IsString()
  @MaxLength(50)
  approverId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Elige al menos un renglón para devolver' })
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  lines!: ReturnLineDto[];
}

export class ApproveReturnDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReasonDto {
  @Transform(trim)
  @IsString()
  @MinLength(3, { message: 'Escribe el motivo (al menos 3 letras)' })
  @MaxLength(500)
  reason!: string;
}

export class ReceiveLineDto {
  @IsString()
  @MaxLength(50)
  lineId!: string;

  @IsInt({ message: 'Los perfiles en buen estado son un número entero' })
  @Min(0)
  @Max(MAX_PROFILES)
  good!: number;

  @IsInt({ message: 'Los perfiles dañados son un número entero' })
  @Min(0)
  @Max(MAX_PROFILES)
  damaged!: number;
}

export class ReceiveReturnDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];

  // Chips of the bundles that came back closed (whole, as they left).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @Transform(({ value }: { value: unknown }) => (Array.isArray(value) ? value.map(normalizeEpc) : value))
  @IsString({ each: true })
  @MaxLength(128, { each: true })
  @Matches(EPC_PATTERN, { each: true, message: 'El chip solo puede contener letras y números, sin espacios' })
  sealedEpcs?: string[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class RefundDto {
  @IsIn(['CASH', 'TRANSFER'], { message: 'El reintegro se entrega en efectivo (CASH) o por transferencia (TRANSFER)' })
  medium!: 'CASH' | 'TRANSFER';

  // Transfer: the Solaluminios entity it was sent from.
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(50)
  transferEntityId?: string;

  @Matches(DAY_PATTERN, { message: 'La fecha del reintegro debe tener el formato AAAA-MM-DD' })
  refundedOn!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class CreditNoteDto {
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'Escribe el número de la nota crédito' })
  @MaxLength(60)
  number!: string;
}

export class ReturnQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(SalesReturnStatus)
  status?: SalesReturnStatus;
}
