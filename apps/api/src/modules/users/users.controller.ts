import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  CreateUserDto,
  LoginEventQueryDto,
  ResetPasswordDto,
  UpdateUserActiveDto,
  UpdateUserLocationDto,
  UpdateUserRoleDto,
  UpdateUsernameDto,
} from './dto/user.dto.js';
import { UsersService } from './users.service.js';

@Roles('ADMIN')
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list() {
    return this.usersService.list();
  }

  // Logins, failed attempts and password changes (newest first).
  @Get('login-events')
  loginEvents(@Query() query: LoginEventQueryDto) {
    return this.usersService.loginEvents(query);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto, @Req() request: AuthenticatedRequest) {
    if (!request.user) throw new UnauthorizedException();
    return this.usersService.resetPassword(id, dto.idNumber, request.user.id);
  }

  @Patch(':id/username')
  setUsername(@Param('id') id: string, @Body() dto: UpdateUsernameDto) {
    return this.usersService.setUsername(id, dto.username);
  }

  @Patch(':id/active')
  setActive(
    @Param('id') id: string,
    @Body() dto: UpdateUserActiveDto,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!request.user) throw new UnauthorizedException();
    return this.usersService.setActive(id, dto.active, request.user.id);
  }

  @Patch(':id/location')
  setLocation(@Param('id') id: string, @Body() dto: UpdateUserLocationDto) {
    return this.usersService.setLocation(id, dto.inventoryLocationId);
  }

  @Patch(':id/role')
  setRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    if (!request.user) throw new UnauthorizedException();
    return this.usersService.setRole(id, dto.role, request.user.id);
  }
}
