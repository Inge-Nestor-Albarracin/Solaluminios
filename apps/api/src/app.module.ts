import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { DatabaseModule } from './infrastructure/database/database.module.js';
import { CatalogModule } from './modules/catalog/catalog.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { TasksModule } from './modules/tasks/tasks.module.js';
import { PushModule } from './modules/push/push.module.js';
import { SupplyModule } from './modules/supply/supply.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { DispatchModule } from './modules/dispatch/dispatch.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { ReadersModule } from './modules/readers/readers.js';

@Module({
  imports: [DatabaseModule,AuthModule,CatalogModule,LocationsModule,UsersModule,InventoryModule,TasksModule,PushModule,SupplyModule,SalesModule,DispatchModule,NotificationsModule,ReadersModule,],
  controllers: [AppController],
  providers: [AppService],
  
  
})
export class AppModule {}