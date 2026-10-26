import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { PushModule } from '../push/push.module.js';
import { TasksController } from './tasks.controller.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [DatabaseModule, PushModule],
  controllers: [TasksController],
  providers: [TasksService],
})
export class TasksModule {}
