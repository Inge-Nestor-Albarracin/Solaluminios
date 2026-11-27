import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { PASSWORD_CHANGE_KEY, PUBLIC_KEY } from './auth.metadata.js';
import type { AuthenticatedRequest } from './auth.types.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ])) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string'
      ? /^Bearer\s+(\S+)$/i.exec(authorization)
      : null;
    const token = match?.[1];
    if (!token) throw new UnauthorizedException('Debes iniciar sesión');

    let claims: { sub?: unknown; exp?: unknown; iat?: unknown };
    try {
      claims = await this.jwt.verifyAsync<{ sub?: unknown; exp?: unknown; iat?: unknown }>(token);
    } catch {
      throw new UnauthorizedException('Sesión inválida o vencida');
    }
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') {
      throw new UnauthorizedException('Sesión inválida');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: {
        id: true, name: true, username: true, email: true, role: true,
        active: true, defaultInventoryLocationId: true,
        mustChangePassword: true, passwordChangedAt: true,
      },
    });
    if (!user?.active) throw new UnauthorizedException('La sesión ya no está habilitada');
    // A password change or reset ends the sessions issued before it.
    if (user.passwordChangedAt && claims.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) {
      throw new UnauthorizedException('Tu contraseña cambió: inicia sesión de nuevo');
    }
    // With the initial password (ID number), nothing but changing it.
    if (
      user.mustChangePassword &&
      !this.reflector.getAllAndOverride<boolean>(PASSWORD_CHANGE_KEY, [context.getHandler(), context.getClass()])
    ) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'Debes cambiar tu contraseña inicial antes de continuar',
      });
    }
    const { passwordChangedAt: _changedAt, ...safe } = user;
    request.user = safe;
    return true;
  }
}
