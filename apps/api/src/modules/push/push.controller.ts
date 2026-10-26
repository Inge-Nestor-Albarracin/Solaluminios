import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { PushEndpointDto, PushSubscriptionDto } from './dto/push-subscription.dto.js';
import { PushService } from './push.service.js';

// Every role can receive notifications on its own devices. All routes act
// only on the session user; no route takes a userId.
const ALL_ROLES = ['ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY'] as const;

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('config')
  config() {
    return this.push.config();
  }

  @Roles(...ALL_ROLES)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('subscriptions')
  @HttpCode(HttpStatus.OK)
  subscribe(@Body() dto: PushSubscriptionDto, @Req() request: AuthenticatedRequest) {
    const agent = request.headers['user-agent'];
    return this.push.subscribe(dto, sessionUser(request), typeof agent === 'string' ? agent : undefined);
  }

  @Roles(...ALL_ROLES)
  @Post('subscriptions/check')
  @HttpCode(HttpStatus.OK)
  check(@Body() dto: PushEndpointDto, @Req() request: AuthenticatedRequest) {
    return this.push.isLinked(dto.endpoint, sessionUser(request));
  }

  @Roles(...ALL_ROLES)
  @Post('subscriptions/remove')
  @HttpCode(HttpStatus.OK)
  remove(@Body() dto: PushEndpointDto, @Req() request: AuthenticatedRequest) {
    return this.push.unsubscribe(dto.endpoint, sessionUser(request));
  }

  // Test message to the session user's own devices (cooldown per user in the
  // service, plus this limit per client).
  @Roles(...ALL_ROLES)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(@Req() request: AuthenticatedRequest) {
    return this.push.sendTest(sessionUser(request));
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}
