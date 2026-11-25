import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { AccessoriesController } from './accessories.controller.js';
import { AccessoriesService } from './accessories.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [AccessoriesController],
  providers: [AccessoriesService],
})
export class AccessoriesModule {}
