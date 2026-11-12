import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Retry contract: the client generates one UUID per intended operation and
// resends the same key on retries. Same key + equivalent data never changes
// stock twice; same key with different data is rejected (409).
class OperationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsUUID('all', { message: 'operationKey debe ser un UUID generado por el cliente' })
  operationKey!: string;
}

// Opening a closed bundle: all its profiles become loose in the same place.
export class BundleOpenDto extends OperationDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class BundleExitDto extends OperationDto {
  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1, { message: 'La cantidad debe ser mayor que cero' })
  @Max(1000000)
  quantity!: number;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

export class BundleTransferDto extends OperationDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inventoryLocationId!: string;

  // Only warehouses (bodegas) use racks; retail stores (almacenes) refuse
  // one. Required or refused by the location type, not here.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  rackId?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

// Most bundles moved in one transfer (one transaction).
export const MAX_TRANSFER_BATCH = 200;

// Several whole bundles to the same destination, all or none.
export class BundleTransferBatchDto extends BundleTransferDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Elige al menos un paquete' })
  @ArrayMaxSize(MAX_TRANSFER_BATCH, { message: `Máximo ${MAX_TRANSFER_BATCH} paquetes por traslado` })
  @ArrayUnique({ message: 'Un paquete está repetido en la lista' })
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(50, { each: true })
  bundleIds!: string[];
}

export const ADJUSTMENT_TYPES = ['ADJUSTMENT_IN', 'ADJUSTMENT_OUT'] as const;

export class BundleAdjustmentDto extends OperationDto {
  @IsIn(ADJUSTMENT_TYPES, {
    message: 'type debe ser ADJUSTMENT_IN o ADJUSTMENT_OUT',
  })
  type!: (typeof ADJUSTMENT_TYPES)[number];

  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1, { message: 'La cantidad debe ser mayor que cero' })
  @Max(1000000)
  quantity!: number;

  @Transform(trim)
  @IsString({ message: 'El motivo del ajuste es obligatorio' })
  @IsNotEmpty({ message: 'El motivo del ajuste es obligatorio' })
  @MaxLength(500)
  reason!: string;
}
