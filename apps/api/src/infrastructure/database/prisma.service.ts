import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;

    if (!connectionString) {
      throw new Error('Falta configurar DATABASE_URL');
    }

    const adapter = new PrismaPg({
      connectionString,
      // DATABASE_POOL_MAX overrides the pool size; invalid values fall back to 10.
      max: Math.min(50, Math.max(1, Number(process.env.DATABASE_POOL_MAX) || 10)),
      connectionTimeoutMillis: 5000,
    });

    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}