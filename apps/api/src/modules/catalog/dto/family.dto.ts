import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' ? true : value === 'false' ? false : value;

export class CreateFamilyDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(50)
  @Matches(/^[A-Z0-9][A-Z0-9._/-]*$/, {
    message:
      'El código debe contener letras, números o los símbolos . _ / -',
  })
  code!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la familia es obligatorio' })
  @MaxLength(100)
  name!: string;

  // What the family groups; fixed once created. Default PROFILE. ACCESSORY
  // families are catalog only for now.
  @IsOptional()
  @IsIn(['PROFILE', 'ACCESSORY'], { message: 'kind debe ser PROFILE (perfiles) o ACCESSORY (accesorios)' })
  kind?: 'PROFILE' | 'ACCESSORY';
}

export class UpdateFamilyDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'El nombre de la familia es obligatorio' })
  @MaxLength(100)
  name?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  active?: boolean;

  // Version the client edited (updatedAt it received). Optional: when sent,
  // a newer change by someone else makes the API answer 409.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsISO8601({ strict: true }, { message: 'expectedUpdatedAt debe ser la fecha updatedAt recibida' })
  expectedUpdatedAt?: string;

}

export class ListFamiliesQueryDto {
  // Omitted: all families. true/false: only active or inactive ones.
  @Transform(toBoolean)
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean({ message: 'active debe ser true o false' })
  active?: boolean;
}

export class ListReferencesQueryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @IsNotEmpty({ message: 'familyId no puede estar vacío' })
  @MaxLength(50)
  familyId?: string;

  // Part of the code or the description (case and accents ignored).
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
