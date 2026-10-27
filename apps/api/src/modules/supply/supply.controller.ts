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
  AssignBundlesDto,
  CreateOpeningLotDto,
  CreateShipmentDto,
  CreateSupplierDto,
  LinkLotsDto,
  LotQueryDto,
  PreRegisterDto,
  PreRegistrationQueryDto,
  ReceiveDto,
  SavePurchaseDto,
  SupplierQueryDto,
  UpdateSettingsDto,
  UpdateSupplierDto,
} from './dto/supply.dto.js';
import { InboundService } from './inbound.service.js';
import { LotsService } from './lots.service.js';
import { PurchasesService } from './purchases.service.js';
import { SettingsService } from './settings.service.js';
import { SuppliersService } from './suppliers.service.js';

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

// Suppliers are visible to the roles that choose them in forms; managing
// them, settings, lots, costs and purchases is ADMIN only.
@Controller()
export class SupplyController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly settings: SettingsService,
    private readonly lots: LotsService,
    private readonly purchases: PurchasesService,
  ) {}

  @Roles('ADMIN', 'SALES', 'WAREHOUSE')
  @Get('suppliers')
  listSuppliers(@Query() query: SupplierQueryDto) {
    return this.suppliers.list(query);
  }

  @Roles('ADMIN')
  @Post('suppliers')
  createSupplier(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @Roles('ADMIN')
  @Patch('suppliers/:id')
  updateSupplier(@Param('id') id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto);
  }

  @Roles('ADMIN')
  @Get('supply/settings')
  getSettings() {
    return this.settings.view();
  }

  @Roles('ADMIN')
  @Patch('supply/settings')
  updateSettings(@Body() dto: UpdateSettingsDto, @Req() request: AuthenticatedRequest) {
    return this.settings.update(dto, sessionUser(request).id);
  }

  @Roles('ADMIN')
  @Get('lots')
  listLots(@Query() query: LotQueryDto) {
    return this.lots.list(query);
  }

  @Roles('ADMIN')
  @Get('lots/unclassified')
  unclassified() {
    return this.lots.unclassified();
  }

  @Roles('ADMIN')
  @Post('lots/opening')
  createOpeningLot(@Body() dto: CreateOpeningLotDto, @Req() request: AuthenticatedRequest) {
    return this.lots.createOpening(dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Post('lots/:id/bundles')
  @HttpCode(HttpStatus.OK)
  assignBundles(@Param('id') id: string, @Body() dto: AssignBundlesDto, @Req() request: AuthenticatedRequest) {
    return this.lots.assignBundles(id, dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Get('purchases')
  listPurchases() {
    return this.purchases.list();
  }

  @Roles('ADMIN')
  @Get('purchases/:id')
  getPurchase(@Param('id') id: string) {
    return this.purchases.get(id);
  }

  @Roles('ADMIN')
  @Post('purchases')
  createPurchase(@Body() dto: SavePurchaseDto, @Req() request: AuthenticatedRequest) {
    return this.purchases.create(dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Patch('purchases/:id')
  updatePurchase(@Param('id') id: string, @Body() dto: SavePurchaseDto, @Req() request: AuthenticatedRequest) {
    return this.purchases.update(id, dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Post('purchases/:id/confirm')
  @HttpCode(HttpStatus.OK)
  confirmPurchase(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.purchases.confirm(id, sessionUser(request));
  }

  @Roles('ADMIN')
  @Post('purchases/:id/link-lots')
  @HttpCode(HttpStatus.OK)
  linkLots(@Param('id') id: string, @Body() dto: LinkLotsDto, @Req() request: AuthenticatedRequest) {
    return this.purchases.linkAfterConfirmation(id, dto, sessionUser(request));
  }
}

// China operator (English UI) and shipment administration.
@Controller('china')
export class ChinaController {
  constructor(private readonly inbound: InboundService) {}

  @Roles('CHINA_OPERATOR', 'ADMIN')
  @Get('context')
  context() {
    return this.inbound.chinaContext();
  }

  @Roles('CHINA_OPERATOR', 'ADMIN')
  @Get('catalog')
  catalog() {
    return this.inbound.chinaCatalog();
  }

  @Roles('CHINA_OPERATOR')
  @Post('pre-registrations')
  preRegister(@Body() dto: PreRegisterDto, @Req() request: AuthenticatedRequest) {
    return this.inbound.preRegister(dto, sessionUser(request));
  }

  @Roles('CHINA_OPERATOR', 'ADMIN')
  @Get('pre-registrations')
  listPreRegistrations(@Query() query: PreRegistrationQueryDto, @Req() request: AuthenticatedRequest) {
    return this.inbound.listPreRegistrations(query, sessionUser(request));
  }

  @Roles('ADMIN')
  @Get('shipments')
  listShipments() {
    return this.inbound.listShipments();
  }

  @Roles('ADMIN')
  @Post('shipments')
  openShipment(@Body() dto: CreateShipmentDto, @Req() request: AuthenticatedRequest) {
    return this.inbound.openShipment(dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Post('shipments/:id/close')
  @HttpCode(HttpStatus.OK)
  closeShipment(@Param('id') id: string) {
    return this.inbound.closeShipment(id);
  }
}

// Reception in Colombia of pre-registered bundles.
@Controller('inbound')
export class InboundController {
  constructor(private readonly inbound: InboundService) {}

  @Roles('ADMIN', 'WAREHOUSE')
  @Get('pre-registrations/epc/:epc')
  find(@Param('epc') epc: string) {
    return this.inbound.findForReception(epc.trim().toUpperCase());
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('receive')
  receive(@Body() dto: ReceiveDto, @Req() request: AuthenticatedRequest) {
    return this.inbound.receive(dto, sessionUser(request));
  }
}
