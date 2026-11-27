import { Transform } from 'class-transformer';
import {
  IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString,
  Matches, Max, MaxLength, Min, MinLength, ValidateIf,
} from 'class-validator';
import { LoginEventType, UserRole } from '../../../generated/prisma/client.js';
import { ID_NUMBER_MESSAGE, ID_NUMBER_PATTERN, USERNAME_MESSAGE, USERNAME_PATTERN, normalizeLogin } from '../../auth/password-policy.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toInt = ({ value }: { value: unknown }) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);

// New user: name, user name («pedro.alvarez») and the ID number as initial
// password (to be changed at the first login). E-mail optional.
export class CreateUserDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Transform(normalizeLogin)
  @IsString()
  @MinLength(3, { message: USERNAME_MESSAGE })
  @MaxLength(50, { message: USERNAME_MESSAGE })
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username!: string;

  @Transform(trim)
  @IsString()
  @Matches(ID_NUMBER_PATTERN, { message: ID_NUMBER_MESSAGE })
  idNumber!: string;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value))
  @IsOptional()
  @IsEmail({}, { message: 'El correo no es válido' })
  @MaxLength(254)
  email?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(UserRole)
  role?: UserRole;
}

// Back to the ID number as password (forgotten password): the user must
// change it again at the next login.
export class ResetPasswordDto {
  @Transform(trim)
  @IsString()
  @Matches(ID_NUMBER_PATTERN, { message: ID_NUMBER_MESSAGE })
  idNumber!: string;
}

export class UpdateUsernameDto {
  @Transform(normalizeLogin)
  @IsString()
  @MinLength(3, { message: USERNAME_MESSAGE })
  @MaxLength(50, { message: USERNAME_MESSAGE })
  @Matches(USERNAME_PATTERN, { message: USERNAME_MESSAGE })
  username!: string;
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
  @IsEnum(UserRole, { message: 'role debe ser ADMIN, WAREHOUSE, SALES, READ_ONLY, CHINA_OPERATOR, BILLING o ACCESSORIES' })
  role!: UserRole;
}

export class LoginEventQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  userId?: string;

  @IsOptional()
  @IsIn(Object.values(LoginEventType))
  type?: LoginEventType;

  @Transform(toInt)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100000)
  page?: number;

  @Transform(toInt)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
