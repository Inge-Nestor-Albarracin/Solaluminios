import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { MAX_PASSWORD_LENGTH, normalizeLogin } from '../password-policy.js';

// Login by user name («pedro.alvarez»). During the change from e-mails, an
// e-mail is still accepted, in `username` (with an @) or in the old `email`.
export class LoginDto {
  @ValidateIf((dto: LoginDto) => dto.email === undefined)
  @Transform(normalizeLogin)
  @IsString()
  @IsNotEmpty({ message: 'Escribe tu usuario' })
  @MaxLength(254)
  username?: string;

  @ValidateIf((dto: LoginDto) => dto.username === undefined)
  @Transform(normalizeLogin)
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  email?: string;

  @IsString()
  @IsNotEmpty({ message: 'Escribe tu contraseña' })
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}

export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Escribe tu contraseña actual' })
  @MaxLength(MAX_PASSWORD_LENGTH)
  currentPassword!: string;

  // Rules in password-policy.ts (checked by the service with the user name).
  @IsString()
  @IsNotEmpty({ message: 'Escribe la nueva contraseña' })
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}
