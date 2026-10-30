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
import { MaterialOrigin } from '../../../generated/prisma/client.js';
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

// Sale price of one line of one purchase: profit on that line's cost.
export class CreateSalePriceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  purchaseId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  purchaseLineId!: string;

  @Matches(DECIMAL_PATTERN, { message: `markupPercent ${DECIMAL_MESSAGE}` })
  markupPercent!: string;

  // true: becomes THE price sales receive for its reference, finish and
  // origin (the previously enabled one is disabled, never deleted).
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class SalePriceQueryDto {
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
  @IsString()
  @MaxLength(50)
  purchaseId?: string;
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

  // Optional: the server uses the open shipment of the Chinese supplier and
  // opens one automatically when there is none. When sent (older clients) it
  // must still be the open shipment, never re-routed.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  shipmentId?: string;

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

// One purchased profile (reference + finish + origin) of the supplier's
// document. grossAmount is the value BEFORE the discount and WITH purchase VAT.
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

  // Profiles bought.
  @IsInt({ message: 'La cantidad debe ser un número entero de perfiles' })
  @Min(1, { message: 'La cantidad debe ser mayor que cero' })
  @Max(1000000)
  quantity!: number;

  // Gross value WITHOUT purchase VAT, as on the invoice.
  @Matches(DECIMAL_PATTERN, { message: `grossAmount ${DECIMAL_MESSAGE}` })
  grossAmount!: string;

  // Applied to the gross value, before VAT.
  @Matches(DECIMAL_PATTERN, { message: `discountPercent ${DECIMAL_MESSAGE}` })
  discountPercent!: string;

  // Purchase VAT on the discounted base. Explicit (may be 0); no default rate.
  @Matches(DECIMAL_PATTERN, { message: `taxRatePercent ${DECIMAL_MESSAGE}` })
  taxRatePercent!: string;

  // Lots whose acquisition cost this line documents (optional).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  lotIds?: string[];
}

// Filters of the purchase list; any combination, or none.
export class PurchaseQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supplierId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  familyId?: string;

  // Purchases with at least one line of this reference.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  referenceId?: string;

  // Document date range, both ends included.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateFrom debe tener el formato AAAA-MM-DD' })
  dateFrom?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'dateTo debe tener el formato AAAA-MM-DD' })
  dateTo?: string;
}

// Purchases are recorded in COP in the order of the invoice: gross value
// without VAT, discount, VAT. No currency conversion, recoverable-VAT choice
// or charges are asked for.
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
