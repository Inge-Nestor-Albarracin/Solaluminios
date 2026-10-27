import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { SupplyModule } from '../supply/supply.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryOperationsService } from './inventory-operations.service.js';
import { InventoryQueriesService } from './inventory-queries.service.js';
import { InventoryService } from './inventory.service.js';

@Module({
  imports: [DatabaseModule, SupplyModule],
  controllers: [InventoryController],
  providers: [InventoryService, InventoryQueriesService, InventoryOperationsService],
})
export class InventoryModule {}
