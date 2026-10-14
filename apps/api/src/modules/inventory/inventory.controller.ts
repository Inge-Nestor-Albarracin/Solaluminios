import {
  Body,
  Controller,
  Get,
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
  BundleTransferDto,
} from './dto/bundle-operation.dto.js';
import {
  InventorySummaryQueryDto,
  ListBundlesQueryDto,
  PaginationQueryDto,
} from './dto/inventory-query.dto.js';
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

  // Final save of the registration queue: all bundles or none.
  @Roles('ADMIN', 'WAREHOUSE')
  @Post('bundles/batch')
  registerBundles(
    @Body() dto: RegisterBundleBatchDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.inventory.registerBundles(dto.bundles, sessionUser(request));
  }

  @Get('bundles')
  listBundles(@Query() query: ListBundlesQueryDto) {
    return this.queries.listBundles(query);
  }

  @Get('summary')
  summary(@Query() query: InventorySummaryQueryDto) {
    return this.queries.summary(query);
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
