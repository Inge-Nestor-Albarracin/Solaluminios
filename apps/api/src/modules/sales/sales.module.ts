import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { OrderPaymentsService } from './order-payments.service.js';
import { ReservationsService } from './reservations.service.js';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';

@Module({
  imports: [DatabaseModule],
  controllers: [SalesController],
  providers: [SalesService, ReservationsService, OrderPaymentsService],
  exports: [SalesService, ReservationsService],
})
export class SalesModule {}
