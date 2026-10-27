import { Transform } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsEnum, IsNotEmpty, IsString,
  MaxLength, MinLength, ValidateIf,
} from 'class-validator';
import { UserRole } from '../../../generated/prisma/client.js';

export class CreateUserDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(UserRole)
  role?: UserRole;
}

export class UpdateUserActiveDto {
  @IsBoolean()
  active!: boolean;
}

// Location where a warehouse user works (dispatch assignment). null clears it.
export class UpdateUserLocationDto {
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  @MaxLength(50)
  inventoryLocationId!: string | null;
}

export class UpdateUserRoleDto {
  @IsEnum(UserRole, { message: 'role debe ser ADMIN, WAREHOUSE, SALES, READ_ONLY o CHINA_OPERATOR' })
  role!: UserRole;
}
