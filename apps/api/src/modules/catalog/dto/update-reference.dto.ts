import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateReferenceDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  active?: boolean;

  // Omitted: keeps the family. null: removes it. ID: sets it.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'familyId no puede estar vacío' })
  @MaxLength(50)
  familyId?: string | null;

  // Omitted: keeps it. Empty or null: removes it. A hint on screen only.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(200)
  familyHint?: string | null;

  // Supplier's / maker's code (shown for accessories; may repeat). Omitted:
  // kept; empty or null: removed.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(50)
  supplierCode?: string | null;

  // Supplier or brand (YALE, PACKLINE…). Omitted: kept; empty or null: removed.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  brand?: string | null;

  // Version the client edited (updatedAt it received). Optional: when sent,
  // a newer change by someone else makes the API answer 409.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true }, { message: 'expectedUpdatedAt debe ser la fecha updatedAt recibida' })
  expectedUpdatedAt?: string;
}
