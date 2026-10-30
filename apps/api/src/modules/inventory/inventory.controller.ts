import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import {
  BundleAdjustmentDto,
  BundleExitDto,
  BundleOpenDto,
  BundleTransferDto,
} from './dto/bundle-operation.dto.js';
import {
  InventorySummaryQueryDto,
  ListBundlesQueryDto,
  PaginationQueryDto,
} from './dto/inventory-query.dto.js';
import { LookupBundlesDto } from './dto/lookup-bundles.dto.js';
import {
  RegisterBundleBatchDto,
  RegisterBundleDto,
} from './dto/register-bundle.dto.js';
import { InventoryOperationsService } from './inventory-operations.service.js';
import { InventoryQueriesService } from './inventory-queries.service.js';
import { InventoryService } from './inventory.service.js';

@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly queries: InventoryQueriesService,
    private readonly operations: InventoryOperationsService,
  ) {}

  // The responsible user always comes from the session, never from the body.
  @Roles('ADMIN', 'WAREHOUSE')
  @Post('bundles')
  registerBundle(
    @Body() dto: RegisterBundleDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inventory.registerBundle(dto, sessionUser(request));
  }

  // Final save of the registration queue: all bundles or none. 201 when
  // saved now, 200 when a retry with the same key replays the saved result.
  @Roles('ADMIN', 'WAREHOUSE')
  @Post('bundles/batch')
  async registerBundles(
    @Body() dto: RegisterBundleBatchDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return withStatus(
      response,
      await this.inventory.registerBundles(dto.bundles, dto.operationKey, sessionUser(request)),
    );
  }

  @Get('bundles')
  listBundles(@Query() query: ListBundlesQueryDto) {
    return this.queries.listBundles(query);
  }

  @Get('summary')
  summary(@Query() query: InventorySummaryQueryDto) {
    return this.queries.summary(query);
  }

  // Bulk RFID reading: read-only, so 200 and available to every role, like
  // the single-chip lookup below (POST only because of the list size; an
  // undecorated POST would be treated as an admin write by RolesGuard).
  @Roles('ADMIN', 'WAREHOUSE', 'SALES', 'READ_ONLY')
  @Post('bundles/lookup')
  @HttpCode(HttpStatus.OK)
  lookupBundles(@Body() dto: LookupBundlesDto) {
    return this.queries.lookupByEpcs(dto.epcs);
  }

  @Get('bundles/epc/:epc')
  getBundleByEpc(@Param('epc') epc: string) {
    return this.inventory.getBundleByEpc(epc);
  }

  @Get('bundles/:id')
  getBundle(@Param('id') id: string) {
    return this.inventory.getBundle(id);
  }

  @Get('bundles/:id/movements')
  listMovements(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.queries.listMovements(id, query);
  }

  // Operations answer 201 when applied and 200 when an equivalent retry
  // (same operationKey) is replayed without changing stock.
  @Roles('ADMIN', 'WAREHOUSE')
  @Post('bundles/:id/exit')
  async exit(
    @Param('id') id: string,
    @Body() dto: BundleExitDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return withStatus(
      response,
      await this.operations.exit(id, dto, sessionUser(request)),
    );
  }

  // «Abrir paquete»: same roles as exits and transfers.
  @Roles('ADMIN', 'WAREHOUSE')
  @Post('bundles/:id/open')
  async open(
    @Param('id') id: string,
    @Body() dto: BundleOpenDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return withStatus(
      response,
      await this.operations.open(id, dto, sessionUser(request)),
    );
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('bundles/:id/transfer')
  async transfer(
    @Param('id') id: string,
    @Body() dto: BundleTransferDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return withStatus(
      response,
      await this.operations.transfer(id, dto, sessionUser(request)),
    );
  }

  @Roles('ADMIN')
  @Post('bundles/:id/adjustments')
  async adjust(
    @Param('id') id: string,
    @Body() dto: BundleAdjustmentDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return withStatus(
      response,
      await this.operations.adjust(id, dto, sessionUser(request)),
    );
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

function withStatus<T extends { replayed: boolean }>(response: Response, result: T) {
  response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);
  return result;
}
