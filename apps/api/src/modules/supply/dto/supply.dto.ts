import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
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
import { DiscountType, MaterialOrigin } from '../../../generated/prisma/client.js';
import { DECIMAL_PATTERN } from '../../../shared/money.js';
import { PaginationQueryDto } from '../../inventory/dto/inventory-query.dto.js';
import { EPC_PATTERN, normalizeEpc } from '../../inventory/dto/register-bundle.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const DECIMAL_MESSAGE = 'debe ser un número decimal escrito como texto (por ejemplo "1250.50")';

// --- Suppliers and settings -------------------------------------------------

export class CreateSupplierDto {
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z0-9._-]{1,30}$/, { message: 'El código del proveedor admite letras, números, punto, guion y guion bajo (máx. 30)' })
  code!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxId?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Indica al menos un origen que suministra el proveedor' })
  @ArrayUnique()
  @IsEnum(MaterialOrigin, { each: true })
  origins!: MaterialOrigin[];

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class UpdateSupplierDto {
  @Transform(trim)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(30)
  taxId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsEnum(MaterialOrigin, { each: true })
  origins?: MaterialOrigin[];

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class SupplierQueryDto {
  @IsOptional()
  @IsEnum(MaterialOrigin)
  origin?: MaterialOrigin;

  @IsOptional()
  @IsIn(['true', 'false'])
  active?: 'true' | 'false';
}

export class UpdateSettingsDto {
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(50)
  chinaSupplierId?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(50)
  dispatchSupervisorId?: string | null;
}

// --- China shipments and pre-registration (English messages) ---------------

export class CreateShipmentDto {
  @Transform(upper)
  @IsString()
  @Matches(/^[A-Z0-9._-]{1,40}$/, { message: 'El código del envío admite letras, números, punto, guion y guion bajo' })
  code!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class PreRegisterDto {
  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @IsString()
  @IsNotEmpty({ message: 'EPC is required' })
  @MaxLength(128)
  @Matches(EPC_PATTERN, { message: 'EPC may only contain letters and digits' })
  epc!: string;

  @IsString()
  @IsNotEmpty({ message: 'Reference is required' })
  @MaxLength(50)
  referenceId!: string;

  @IsString()
  @IsNotEmpty({ message: 'Finish / color is required' })
  @MaxLength(50)
  finishId!: string;

  @IsInt({ message: 'Quantity must be a whole number of profiles' })
  @Min(1, { message: 'Quantity must be at least 1 profile' })
  @Max(1000000)
  quantity!: number;

  // The shipment the operator is working on (shown on screen): if it was
  // closed or replaced meanwhile the request is refused, never re-routed.
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  shipmentId!: string;

  @IsUUID('4', { message: 'operationKey must be a UUID' })
  operationKey!: string;
}

export class PreRegistrationQueryDto extends PaginationQueryDto {}

export class ReceiveDto {
  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(EPC_PATTERN, { message: 'El EPC solo puede contener letras y números' })
  epc!: string;

  // Profiles physically received (may differ from the expected quantity).
  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1)
  @Max(1000000)
  quantity!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inventoryLocationId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  rackId!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discrepancyReason?: string;

  @IsUUID('4')
  operationKey!: string;
}

// --- Lots -------------------------------------------------------------------

export class LotQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  referenceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  finishId?: string;

  @IsOptional()
  @IsEnum(MaterialOrigin)
  origin?: MaterialOrigin;

  @IsOptional()
  @IsIn(['true', 'false'])
  costPending?: 'true' | 'false';
}

export class CreateOpeningLotDto {
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

  // Optional for historical national stock with undocumented supplier.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supplierId?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Describe la evidencia de la procedencia (p. ej. inventario físico, documento)' })
  @MaxLength(500)
  notes!: string;
}

export class AssignBundlesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  bundleIds!: string[];

  // Required when a bundle already belongs to another lot (correction).
  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// --- Purchases --------------------------------------------------------------

export class PurchaseLineDto {
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

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  unitName!: string;

  @Matches(DECIMAL_PATTERN, { message: `profilesPerUnit ${DECIMAL_MESSAGE}` })
  profilesPerUnit!: string;

  @Matches(DECIMAL_PATTERN, { message: `quantity ${DECIMAL_MESSAGE}` })
  quantity!: string;

  @Matches(DECIMAL_PATTERN, { message: `unitPrice ${DECIMAL_MESSAGE}` })
  unitPrice!: string;

  @IsEnum(DiscountType)
  lineDiscountType!: DiscountType;

  @Matches(DECIMAL_PATTERN, { message: `lineDiscountValue ${DECIMAL_MESSAGE}` })
  lineDiscountValue!: string;

  // Explicit rate (no default); null keeps the draft incomplete.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DECIMAL_PATTERN, { message: `taxRatePercent ${DECIMAL_MESSAGE}` })
  taxRatePercent?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  taxRecoverable?: boolean | null;

  // Lots whose acquisition cost this line documents.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  lotIds?: string[];
}

export class PurchaseChargeDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  description!: string;

  @Matches(DECIMAL_PATTERN, { message: `amount ${DECIMAL_MESSAGE}` })
  amount!: string;
}

export class SavePurchaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  supplierId!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  documentNumber!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'documentDate debe tener el formato AAAA-MM-DD' })
  documentDate!: string;

  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'currency debe ser un código ISO de 3 letras' })
  currency!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(DECIMAL_PATTERN, { message: `exchangeRate ${DECIMAL_MESSAGE}` })
  exchangeRate?: string | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  exchangeRateDate?: string | null;

  @Transform(trim)
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(150)
  exchangeRateSource?: string | null;

  @IsEnum(DiscountType)
  globalDiscountType!: DiscountType;

  @Matches(DECIMAL_PATTERN, { message: `globalDiscountValue ${DECIMAL_MESSAGE}` })
  globalDiscountValue!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  conditionalDiscountNote?: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineDto)
  lines!: PurchaseLineDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PurchaseChargeDto)
  charges!: PurchaseChargeDto[];
}

export class LinkLotsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  lineId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  lotIds!: string[];

  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Indica el motivo de la asociación posterior' })
  @MaxLength(500)
  reason!: string;
}
