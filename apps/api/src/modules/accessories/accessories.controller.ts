import { Body, Controller, Get, Param, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { AccessoriesService } from './accessories.service.js';
import {
  BasketQueryDto,
  CreateEntryDto,
  CreateExitDto,
  RegisterBasketDto,
  VoucherQueryDto,
} from './dto/accessories.dto.js';

// Accessories warehouse (docs/accesorios-fase-1.md): baskets, their history
// and the entry / no-sale exit vouchers. Only the accessories role and the
// administrator; the responsible user always comes from the session.
@Controller('accessories')
export class AccessoriesController {
  constructor(private readonly accessories: AccessoriesService) {}

  @Roles('ADMIN', 'ACCESSORIES')
  @Get('catalog')
  catalog(@Req() request: AuthenticatedRequest) {
    return this.accessories.catalog(sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Get('baskets')
  baskets(@Query() query: BasketQueryDto, @Req() request: AuthenticatedRequest) {
    return this.accessories.baskets(query, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Get('baskets/epc/:epc')
  basketByEpc(@Param('epc') epc: string, @Req() request: AuthenticatedRequest) {
    return this.accessories.basketByEpc(epc, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Get('baskets/:id')
  basket(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.accessories.basket(id, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Post('baskets')
  registerBasket(@Body() dto: RegisterBasketDto, @Req() request: AuthenticatedRequest) {
    return this.accessories.registerBasket(dto, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Get('vouchers')
  vouchers(@Query() query: VoucherQueryDto, @Req() request: AuthenticatedRequest) {
    return this.accessories.vouchers(query, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Get('vouchers/:id')
  voucher(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.accessories.voucher(id, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Post('vouchers/entries')
  createEntry(@Body() dto: CreateEntryDto, @Req() request: AuthenticatedRequest) {
    return this.accessories.createEntry(dto, sessionUser(request));
  }

  @Roles('ADMIN', 'ACCESSORIES')
  @Post('vouchers/exits')
  createExit(@Body() dto: CreateExitDto, @Req() request: AuthenticatedRequest) {
    return this.accessories.createExit(dto, sessionUser(request));
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}
