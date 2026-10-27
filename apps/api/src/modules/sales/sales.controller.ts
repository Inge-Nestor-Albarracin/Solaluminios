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
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  AvailabilityQueryDto,
  ConfirmOrderDto,
  ConvertQuoteDto,
  CustomerQueryDto,
  ListQueryDto,
  PriceSuggestionQueryDto,
  ReasonDto,
  SaveCustomerDto,
  SaveQuoteDto,
  UpdateOrderLineDto,
} from './dto/sales.dto.js';
import { SalesService } from './sales.service.js';

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

// Commercial documents: ADMIN and SALES only (SALES limited to its own
// documents inside the service). Availability by provenance is also open to
// the warehouse (no prices).
@Controller()
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Roles('ADMIN', 'SALES')
  @Get('customers')
  listCustomers(@Query() query: CustomerQueryDto) {
    return this.sales.listCustomers(query);
  }

  @Roles('ADMIN', 'SALES')
  @Post('customers')
  createCustomer(@Body() dto: SaveCustomerDto, @Req() request: AuthenticatedRequest) {
    return this.sales.createCustomer(dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Patch('customers/:id')
  updateCustomer(@Param('id') id: string, @Body() dto: SaveCustomerDto) {
    return this.sales.updateCustomer(id, dto);
  }

  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get('sales/availability')
  availability(@Query() query: AvailabilityQueryDto) {
    return this.sales.availability(query.referenceId, query.finishId, query.inventoryLocationId);
  }

  @Roles('ADMIN', 'SALES')
  @Get('sales/price-suggestion')
  suggestPrice(@Query() query: PriceSuggestionQueryDto) {
    return this.sales.suggestPrice(query);
  }

  @Roles('ADMIN', 'SALES')
  @Get('quotes')
  listQuotes(@Query() query: ListQueryDto, @Req() request: AuthenticatedRequest) {
    return this.sales.listQuotes(query, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Get('quotes/:id')
  getQuote(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.getQuote(id, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('quotes')
  createQuote(@Body() dto: SaveQuoteDto, @Req() request: AuthenticatedRequest) {
    return this.sales.createQuote(dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Patch('quotes/:id')
  updateQuote(@Param('id') id: string, @Body() dto: SaveQuoteDto, @Req() request: AuthenticatedRequest) {
    return this.sales.updateQuote(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('quotes/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelQuote(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.cancelQuote(id, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('quotes/:id/convert')
  @HttpCode(HttpStatus.OK)
  convertQuote(@Param('id') id: string, @Body() dto: ConvertQuoteDto, @Req() request: AuthenticatedRequest) {
    return this.sales.convertQuote(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Get('sales-orders')
  listOrders(@Query() query: ListQueryDto, @Req() request: AuthenticatedRequest) {
    return this.sales.listOrders(query, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Get('sales-orders/:id')
  getOrder(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.sales.getOrder(id, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Patch('sales-orders/:id/lines/:lineId')
  updateOrderLine(
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateOrderLineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.sales.updateOrderLine(id, lineId, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('sales-orders/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirmOrder(@Param('id') id: string, @Body() dto: ConfirmOrderDto, @Req() request: AuthenticatedRequest) {
    return this.sales.confirmOrder(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'SALES')
  @Post('sales-orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancelOrder(@Param('id') id: string, @Body() dto: ReasonDto, @Req() request: AuthenticatedRequest) {
    return this.sales.cancelOrder(id, dto.reason, sessionUser(request));
  }
}
