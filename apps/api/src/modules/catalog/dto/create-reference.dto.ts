import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { REFERENCE_CODE_PATTERN, normalizeReferenceCode } from '../catalog-codes.js';

export class CreateReferenceDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normalizeReferenceCode(value) : value,
  )
  @IsString()
  @MaxLength(50)
  @Matches(REFERENCE_CODE_PATTERN, {
    message:
      'El código debe contener letras, números, los símbolos . _ / - o un espacio entre partes (p. ej. «703 CURVO»)',
  })
  code!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string | null;

  // Omitted or null: reference without family.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'familyId no puede estar vacío' })
  @MaxLength(50)
  familyId?: string | null;

  // Other families where it is also known (a hint on screen only).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(200)
  familyHint?: string | null;
}
