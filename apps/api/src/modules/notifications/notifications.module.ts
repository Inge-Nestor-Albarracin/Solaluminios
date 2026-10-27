import { Controller, Get, Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { Roles } from '../auth/auth.metadata.js';
import { PushModule } from '../push/push.module.js';
import { SupplyModule } from '../supply/supply.module.js';
import { OutboxService } from './outbox.service.js';

@Controller('notifications')
class NotificationsController {
  constructor(private readonly outbox: OutboxService) {}

  @Roles('ADMIN')
  @Get('outbox')
  status() {
    return this.outbox.status();
  }
}

@Module({
  imports: [DatabaseModule, PushModule, SupplyModule],
  controllers: [NotificationsController],
  providers: [OutboxService],
  exports: [OutboxService],
})
export class NotificationsModule {}
