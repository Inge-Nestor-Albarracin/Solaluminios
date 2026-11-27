import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { LoginEventType, User } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password.js';
import type { ChangePasswordDto, LoginDto } from './dto/login.dto.js';
import { LoginAttempts } from './login-attempts.js';
import { passwordProblem } from './password-policy.js';

// Where an access attempt came from (kept in the login log, trimmed).
export interface AccessMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const WRONG = 'Usuario o contraseña incorrectos';

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

  // By user name; an e-mail (with @) is still accepted. Wrong user, wrong
  // password and deactivated user all answer the same, and unknown names are
  // locked like real ones (nothing tells which names exist). Every attempt
  // goes to the login log.
  async login(dto: LoginDto, meta: AccessMeta = {}) {
    const identifier = (dto.username ?? dto.email ?? '').trim().toLowerCase();
    const user = identifier.includes('@')
      ? await this.prisma.user.findUnique({ where: { email: identifier } })
      : await this.prisma.user.findUnique({ where: { username: identifier } });
    // One counter per account, whichever name was typed.
    const key = user ? `user:${user.id}` : `name:${identifier}`;
    try {
      this.attempts.assertAllowed(key);
    } catch (error) {
      await this.log('LOGIN_LOCKED', identifier, user?.id ?? null, meta);
      throw error;
    }
    const valid = await verifyPassword(dto.password, user?.passwordHash ?? (await this.dummyHash));
    if (!user || !valid || !user.active) {
      this.attempts.recordFailure(key);
      await this.log(user && valid ? 'LOGIN_INACTIVE' : 'LOGIN_FAILED', identifier, user?.id ?? null, meta);
      throw new UnauthorizedException(WRONG);
    }
    this.attempts.recordSuccess(key);
    await this.log('LOGIN_OK', identifier, user.id, meta);
    return this.session(user);
  }

  // The user replaces their password (mandatory after the initial one). The
  // current one is checked again; a wrong one counts as a failed attempt.
  // Sessions issued before stop working; a new one is returned.
  async changePassword(userId: string, dto: ChangePasswordDto, meta: AccessMeta = {}) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.active) throw new UnauthorizedException('La sesión ya no está habilitada');
    const key = `user:${user.id}`;
    this.attempts.assertAllowed(key);
    if (!(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      this.attempts.recordFailure(key);
      // 400, not 401: the session itself is valid.
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    const problem = passwordProblem(dto.newPassword, user.username);
    if (problem) throw new BadRequestException(problem);
    if (await verifyPassword(dto.newPassword, user.passwordHash)) {
      throw new BadRequestException('La nueva contraseña debe ser distinta de la actual');
    }
    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(dto.newPassword), mustChangePassword: false, passwordChangedAt: new Date() },
    });
    this.attempts.recordSuccess(key);
    await this.log('PASSWORD_CHANGED', user.username, user.id, meta);
    return this.session(updated);
  }

  private async session(user: User) {
    const token = await this.jwt.signAsync({ sub: user.id });
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        email: user.email,
        role: user.role,
        active: user.active,
        defaultInventoryLocationId: user.defaultInventoryLocationId,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }

  private log(type: LoginEventType, identifier: string, userId: string | null, meta: AccessMeta) {
    return this.prisma.loginEvent.create({
      data: {
        type,
        identifier: identifier.slice(0, 254),
        userId,
        ip: meta.ip ? meta.ip.slice(0, 64) : null,
        userAgent: meta.userAgent ? meta.userAgent.slice(0, 300) : null,
      },
    });
  }
}
