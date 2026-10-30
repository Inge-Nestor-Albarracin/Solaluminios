import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
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
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';
import { EPC_PATTERN, normalizeEpc } from '../../inventory/dto/register-bundle.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class DispatchLineInputDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  salesOrderLineId!: string;

  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}

export class CreateDispatchDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  assigneeId!: string;

  @Matches(/T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/, { message: 'dueAt debe incluir hora y zona horaria' })
  @IsISO8601({ strict: true, strictSeparator: true })
  dueAt!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => DispatchLineInputDto)
  lines!: DispatchLineInputDto[];

  // Explicit authorisation of a partial delivery for an order that is not
  // fully reserved: only the requested quantities are reserved.
  @IsOptional()
  @IsBoolean()
  partial?: boolean;

  // Location of a partial dispatch when the order has none yet.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  inventoryLocationId?: string;
}

export class DispatchQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'CONFIRMED', 'CANCELLED'])
  status?: 'OPEN' | 'CONFIRMED' | 'CANCELLED';
}

export class ScanDto {
  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(EPC_PATTERN, { message: 'El EPC solo puede contener letras y números' })
  epc!: string;
}

export class SetPickDto {
  // 0 removes the bundle from the preparation.
  @IsInt()
  @Min(0)
  @Max(1000000)
  quantity!: number;
}

export class ConfirmDispatchDto {
  @IsUUID('4', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;
}

export class LooseLineDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  dispatchLineId!: string;

  // Loose profiles of the line shown to the worker (assigned to it).
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;
}

// «Ya retiré los sueltos»: the quantities the screen showed, per line.
export class PrepareLooseDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Indica los sueltos que retiraste' })
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => LooseLineDto)
  lines!: LooseLineDto[];
}

export class ReassignDispatchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  assigneeId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

export class ResolveIncidentDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Describe cómo se resolvió la incidencia' })
  @MaxLength(500)
  resolution!: string;
}
