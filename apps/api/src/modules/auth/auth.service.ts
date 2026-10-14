import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password.js';
import type { LoginDto } from './dto/login.dto.js';
import { LoginAttempts } from './login-attempts.js';

@Injectable()
export class AuthService {
  // Apply the same password work when the account does not exist.
  private readonly dummyHash = hashPassword('Dummy-account-never-used-for-login');
  // Per-account lockout after repeated failures (the throttler is per IP).
  private readonly attempts = new LoginAttempts();

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    this.attempts.assertAllowed(dto.email);
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const valid = await verifyPassword(dto.password, user?.passwordHash ?? await this.dummyHash);
    if (!user || !user.active || !valid) {
      this.attempts.recordFailure(dto.email);
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    this.attempts.recordSuccess(dto.email);
    const token = await this.jwt.signAsync({ sub: user.id });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        active: user.active,
        defaultInventoryLocationId: user.defaultInventoryLocationId,
      },
    };
  }
}
