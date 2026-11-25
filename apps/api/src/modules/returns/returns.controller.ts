import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  ApproveReturnDto,
  CreateReturnDto,
  CreditNoteDto,
  ReasonDto,
  ReceiveReturnDto,
  RefundDto,
  ReturnQueryDto,
} from './dto/returns.dto.js';
import { ReturnsService } from './returns.service.js';

// Sales returns (documento DV). The responsible user always comes from the
// session; each role reaches only its steps (see ReturnsService).
@Controller()
export class ReturnsController {
  constructor(private readonly returns: ReturnsService) {}

  @Roles('ADMIN', 'SALES')
  @Get('sales-orders/:id/returnable')
  returnable(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.returns.returnable(id, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('sales-orders/:id/returns')
  create(@Param('id') id: string, @Body() dto: CreateReturnDto, @Req() request: AuthenticatedRequest) {
    return this.returns.create(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE', 'BILLING')
  @Get('sales-returns')
  list(@Query() query: ReturnQueryDto, @Req() request: AuthenticatedRequest) {
    return this.returns.list(query, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE', 'BILLING')
  @Get('sales-returns/:id')
  get(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.returns.get(id, sessionUser(request));
  }

  @Roles('ADMIN')
  @Post('sales-returns/:id/approve')
  @HttpCode(HttpStatus.OK)
  approve(@Param('id') id: string, @Body() dto: ApproveReturnDto, @Req() request: AuthenticatedRequest) {
    return this.returns.approve(id, dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Post('sales-returns/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: AuthenticatedRequest) {
    return this.returns.reject(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('sales-returns/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: AuthenticatedRequest) {
    return this.returns.cancel(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('sales-returns/:id/receive')
  @HttpCode(HttpStatus.OK)
  receive(@Param('id') id: string, @Body() dto: ReceiveReturnDto, @Req() request: AuthenticatedRequest) {
    return this.returns.receive(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('sales-returns/:id/refund')
  @HttpCode(HttpStatus.OK)
  refund(@Param('id') id: string, @Body() dto: RefundDto, @Req() request: AuthenticatedRequest) {
    return this.returns.refund(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'BILLING')
  @Post('sales-returns/:id/credit-note')
  @HttpCode(HttpStatus.OK)
  creditNote(@Param('id') id: string, @Body() dto: CreditNoteDto, @Req() request: AuthenticatedRequest) {
    return this.returns.creditNote(id, dto, sessionUser(request));
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}
