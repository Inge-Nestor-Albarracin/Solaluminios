import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService, type AccessMeta } from './auth.service.js';
import { AllowedBeforePasswordChange, Public, Roles } from './auth.metadata.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { ChangePasswordDto, LoginDto } from './dto/login.dto.js';

// Every role reaches its own account (the restricted ones, too).
const EVERY_ROLE = ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY', 'CHINA_OPERATOR', 'BILLING', 'ACCESSORIES'] as const;

const meta = (request: AuthenticatedRequest): AccessMeta => {
  const agent = request.headers['user-agent'];
  return { ip: request.ip ?? null, userAgent: typeof agent === 'string' ? agent : null };
};

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  // Per IP (shared by a whole branch): 30 logins per minute. Each account is
  // also locked after 5 failures (login-attempts.ts).
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() request: AuthenticatedRequest) {
    return this.authService.login(dto, meta(request));
  }

  @Roles(...EVERY_ROLE)
  @AllowedBeforePasswordChange()
  @Get('me')
  me(@Req() request: AuthenticatedRequest) {
    return request.user;
  }

  // The user's own password (mandatory after the initial ID number).
  @Roles(...EVERY_ROLE)
  @AllowedBeforePasswordChange()
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  changePassword(@Body() dto: ChangePasswordDto, @Req() request: AuthenticatedRequest) {
    if (!request.user) throw new UnauthorizedException();
    return this.authService.changePassword(request.user.id, dto, meta(request));
  }
}
