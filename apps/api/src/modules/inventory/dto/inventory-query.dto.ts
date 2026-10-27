import { applyDecorators } from '@nestjs/common';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// Query strings arrive as text; only plain digit strings become integers.
const toInt = ({ value }: { value: unknown }) =>
  typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

const optional = (_object: unknown, value: unknown) => value !== undefined;

export class PaginationQueryDto {
  @Transform(toInt)
  @ValidateIf(optional)
  @IsInt({ message: 'page debe ser un entero' })
  @Min(1)
  @Max(100000)
  page?: number;

  @Transform(toInt)
  @ValidateIf(optional)
  @IsInt({ message: 'pageSize debe ser un entero' })
  @Min(1)
  @Max(MAX_PAGE_SIZE, {
    message: `pageSize no puede ser mayor que ${MAX_PAGE_SIZE}`,
  })
  pageSize?: number;
}

// Optional entity ID used as a filter.
const IdField = () =>
  applyDecorators(
    Transform(trim),
    ValidateIf(optional),
    IsString(),
    IsNotEmpty(),
    MaxLength(50),
  );

export class InventoryFiltersDto extends PaginationQueryDto {
  @IdField() familyId?: string;
  @IdField() referenceId?: string;
  @IdField() finishId?: string;
  @IdField() branchId?: string;
  @IdField() inventoryLocationId?: string;
}

export class ListBundlesQueryDto extends InventoryFiltersDto {
  @IdField() aisleId?: string;
  @IdField() rackId?: string;

  // true: only bundles with profiles; false: only empty bundles.
  @Transform(toBoolean)
  @ValidateIf(optional)
  @IsBoolean({ message: 'available debe ser true o false' })
  available?: boolean;

  // true: only bundles without provenance (origin unknown), for
  // administrative classification.
  @Transform(toBoolean)
  @ValidateIf(optional)
  @IsBoolean({ message: 'unclassified debe ser true o false' })
  unclassified?: boolean;
}

export class InventorySummaryQueryDto extends InventoryFiltersDto {}
