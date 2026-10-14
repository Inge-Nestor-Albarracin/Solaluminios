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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ArrivalDatePrecision } from '../../../generated/prisma/client.js';

export const BUNDLE_REGISTRATION_TYPES = ['INITIAL_STOCK', 'ENTRY'] as const;
export type BundleRegistrationType = (typeof BUNDLE_REGISTRATION_TYPES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Factory EPC as read by the UHF reader: kept as text so leading zeros are
// preserved. No fixed length is imposed yet.
export const normalizeEpc = (value: unknown) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

export const EPC_PATTERN = /^[A-Z0-9]+$/;

export class RegisterBundleDto {
  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @IsString()
  @IsNotEmpty({ message: 'El EPC es obligatorio' })
  @MaxLength(128)
  @Matches(EPC_PATTERN, {
    message: 'El EPC solo puede contener letras y números, sin espacios',
  })
  epc!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  referenceId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  finishId!: string;

  // Whole profiles physically in the bundle.
  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1, { message: 'La cantidad debe ser mayor que cero' })
  @Max(1000000)
  quantity!: number;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inventoryLocationId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  rackId!: string;

  @IsIn(BUNDLE_REGISTRATION_TYPES, {
    message: 'registrationType debe ser INITIAL_STOCK o ENTRY',
  })
  registrationType!: BundleRegistrationType;

  @IsEnum(ArrivalDatePrecision, {
    message: 'arrivalDatePrecision debe ser EXACT, MONTH o UNKNOWN',
  })
  arrivalDatePrecision!: ArrivalDatePrecision;

  // EXACT only. Calendar date YYYY-MM-DD of the physical arrival.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'arrivalDate debe tener el formato AAAA-MM-DD',
  })
  arrivalDate?: string;

  // MONTH only.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1900)
  @Max(9999)
  arrivalYear?: number;

  // MONTH only.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(12)
  arrivalMonth?: number;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}

// Upper bound of bundles saved in one batch (one transaction).
export const MAX_BATCH_SIZE = 50;

// Final save of the registration queue.
export class RegisterBundleBatchDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'La lista de paquetes está vacía' })
  @ArrayMaxSize(MAX_BATCH_SIZE, {
    message: `Máximo ${MAX_BATCH_SIZE} paquetes por guardado`,
  })
  @ValidateNested({ each: true })
  @Type(() => RegisterBundleDto)
  bundles!: RegisterBundleDto[];
}
