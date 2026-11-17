import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  AssigneeDto,
  CancelRequestDto,
  CreateMaterialRequestDto,
  MaterialRequestQueryDto,
  PickDto,
  ReceiveDto,
  ShipDto,
  WorkersQueryDto,
} from './dto/material-request.dto.js';
import { MaterialRequestsService } from './material-requests.service.js';

// Material requests (Sales → warehouse → store). The responsible user always
// comes from the session.
@Controller('material-requests')
export class MaterialRequestsController {
  constructor(private readonly requests: MaterialRequestsService) {}

  // Warehouse workers of a warehouse and whose turn it is.
  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get('workers')
  workers(@Query() query: WorkersQueryDto) {
    return this.requests.workers(query.sourceLocationId);
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get()
  list(@Query() query: MaterialRequestQueryDto, @Req() request: AuthenticatedRequest) {
    return this.requests.list(query, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post()
  create(@Body() dto: CreateMaterialRequestDto, @Req() request: AuthenticatedRequest) {
    return this.requests.create(dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get(':id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.requests.get(id, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post(':id/picks')
  @HttpCode(HttpStatus.OK)
  pick(@Param('id') id: string, @Body() dto: PickDto, @Req() request: AuthenticatedRequest) {
    return this.requests.pick(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post(':id/picks/:pickId/remove')
  @HttpCode(HttpStatus.OK)
  unpick(@Param('id') id: string, @Param('pickId') pickId: string, @Req() request: AuthenticatedRequest) {
    return this.requests.unpick(id, pickId, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post(':id/ship')
  @HttpCode(HttpStatus.OK)
  ship(@Param('id') id: string, @Body() dto: ShipDto, @Req() request: AuthenticatedRequest) {
    return this.requests.ship(id, dto, sessionUser(request));
  }

  // The store's staff; without staff at the store, the reception task goes to
  // the requester, so SALES may also receive (the service checks who).
  @Roles('ADMIN', 'WAREHOUSE', 'SALES')
  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  receive(@Param('id') id: string, @Body() dto: ReceiveDto, @Req() request: AuthenticatedRequest) {
    return this.requests.receive(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post(':id/assignee')
  @HttpCode(HttpStatus.OK)
  reassign(@Param('id') id: string, @Body() dto: AssigneeDto, @Req() request: AuthenticatedRequest) {
    return this.requests.reassign(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @Body() dto: CancelRequestDto, @Req() request: AuthenticatedRequest) {
    return this.requests.cancel(id, dto, sessionUser(request));
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}
