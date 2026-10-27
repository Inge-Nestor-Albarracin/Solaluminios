import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { ReasonDto } from '../sales/dto/sales.dto.js';
import { DispatchService } from './dispatch.service.js';
import {
  ConfirmDispatchDto,
  CreateDispatchDto,
  DispatchQueryDto,
  ReassignDispatchDto,
  ResolveIncidentDto,
  ScanDto,
  SetPickDto,
} from './dto/dispatch.dto.js';

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

// SALES generates dispatches of its own orders (without general task
// permissions); WAREHOUSE executes those of its location; ADMIN everything.
// Object-level checks (owner, assignee, location) live in the service.
@Controller()
export class DispatchController {
  constructor(private readonly dispatches: DispatchService) {}

  @Roles('ADMIN', 'SALES')
  @Get('dispatches/eligible-assignees')
  eligibleAssignees(@Query('inventoryLocationId') inventoryLocationId: string) {
    return this.dispatches.eligibleAssignees(String(inventoryLocationId ?? ''));
  }

  @Roles('ADMIN', 'SALES')
  @Post('sales-orders/:id/dispatches')
  create(@Param('id') orderId: string, @Body() dto: CreateDispatchDto, @Req() request: AuthenticatedRequest) {
    return this.dispatches.create(orderId, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get('dispatches')
  list(@Query() query: DispatchQueryDto, @Req() request: AuthenticatedRequest) {
    return this.dispatches.list(query, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get('dispatches/:id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.dispatches.get(id, sessionUser(request));
  }

  // Handheld read (gun in BLE or keyboard mode). Prepares a matching bundle.
  @Roles('ADMIN', 'WAREHOUSE')
  @Throttle({ default: { limit: 600, ttl: 60000 } })
  @Post('dispatches/:id/scan')
  @HttpCode(HttpStatus.OK)
  scan(@Param('id') id: string, @Body() dto: ScanDto, @Req() request: AuthenticatedRequest) {
    const user = sessionUser(request);
    return this.dispatches.scan(id, dto.epc, user, { source: 'HANDHELD', userId: user.id, prepare: true });
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Patch('dispatches/:id/picks/:bundleId')
  setPick(@Param('id') id: string, @Param('bundleId') bundleId: string, @Body() dto: SetPickDto, @Req() request: AuthenticatedRequest) {
    return this.dispatches.setPick(id, bundleId, dto.quantity, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('dispatches/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Param('id') id: string, @Body() dto: ConfirmDispatchDto, @Req() request: AuthenticatedRequest) {
    return this.dispatches.confirm(id, dto.operationKey, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('dispatches/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: AuthenticatedRequest) {
    return this.dispatches.cancel(id, dto.reason, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('dispatches/:id/reassign')
  @HttpCode(HttpStatus.OK)
  reassign(@Param('id') id: string, @Body() dto: ReassignDispatchDto, @Req() request: AuthenticatedRequest) {
    return this.dispatches.reassign(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('dispatches/:id/incidents/:incidentId/resolve')
  @HttpCode(HttpStatus.OK)
  resolveIncident(
    @Param('id') id: string,
    @Param('incidentId') incidentId: string,
    @Body() dto: ResolveIncidentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.dispatches.resolveIncident(id, incidentId, dto.resolution, sessionUser(request));
  }
}
