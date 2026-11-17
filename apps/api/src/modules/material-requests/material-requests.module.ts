import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { MaterialRequestsController } from './material-requests.controller.js';
import { MaterialRequestsService } from './material-requests.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [MaterialRequestsController],
  providers: [MaterialRequestsService],
})
export class MaterialRequestsModule {}
