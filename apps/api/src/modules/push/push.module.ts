import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { PushController } from './push.controller.js';
import { PushSender, WebPushSender, loadVapidConfig } from './push.sender.js';
import { PushService } from './push.service.js';
import { PUSH_RETRY_DELAYS_MS, VAPID_CONFIG } from './push.tokens.js';

@Module({
  imports: [DatabaseModule],
  controllers: [PushController],
  providers: [
    PushService,
    { provide: VAPID_CONFIG, useFactory: () => loadVapidConfig() },
    { provide: PushSender, useClass: WebPushSender },
    // Waits before the 2nd and 3rd attempt of a temporary failure.
    { provide: PUSH_RETRY_DELAYS_MS, useValue: [1000, 3000] },
  ],
  exports: [PushService],
})
export class PushModule {}
