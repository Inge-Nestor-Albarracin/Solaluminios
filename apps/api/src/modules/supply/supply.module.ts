import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { InboundService } from './inbound.service.js';
import { LotsService } from './lots.service.js';
import { PurchasesService } from './purchases.service.js';
import { SettingsService } from './settings.service.js';
import { ChinaController, InboundController, SupplyController } from './supply.controller.js';
import { SuppliersService } from './suppliers.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [SupplyController, ChinaController, InboundController],
  providers: [SettingsService, SuppliersService, LotsService, InboundService, PurchasesService],
  exports: [SettingsService, LotsService],
})
export class SupplyModule {}
