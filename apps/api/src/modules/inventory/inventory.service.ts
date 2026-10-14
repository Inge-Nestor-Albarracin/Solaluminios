import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { SafeUser } from '../auth/auth.types.js';
import {
  EPC_PATTERN,
  normalizeEpc,
  type RegisterBundleDto,
} from './dto/register-bundle.dto.js';
import {
  bundleDetailInclude,
  bundleListInclude,
  requireActiveRackInLocation,
  type Tx,
} from './inventory.shared.js';

// Calendar used to decide what "today" is for physical arrival dates.
const BUSINESS_TIME_ZONE = 'America/Bogota';

interface ArrivalData {
  arrivalDatePrecision: RegisterBundleDto['arrivalDatePrecision'];
  arrivalDate: Date | null;
  arrivalYear: number | null;
  arrivalMonth: number | null;
}

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  // Creates the bundle and its first movement atomically. The bundle keeps
  // the physical arrival (exact, month or unknown); the movement's
  // occurredAt is the moment it was registered in the system.
  async registerBundle(dto: RegisterBundleDto, user: SafeUser) {
    const arrival = this.parseArrival(dto);

    return this.withUniqueEpc(() =>
      this.prisma.$transaction(async (tx) => {
        const id = await this.createBundle(tx, dto, arrival, user, new Date());
        return tx.bundle.findUniqueOrThrow({
          where: { id },
          include: bundleDetailInclude,
        });
      }),
    );
  }

  // Final save of the registration queue: every bundle and its first
  // movement are created in ONE transaction, so either all of them are
  // saved or none is. Errors name the item (1-based) that failed.
  async registerBundles(dtos: RegisterBundleDto[], user: SafeUser) {
    const seen = new Map<string, number>();
    dtos.forEach((dto, index) => {
      const first = seen.get(dto.epc);
      if (first !== undefined) {
        throw itemError(
          new BadRequestException(
            `El EPC está repetido en la lista (también en el paquete ${first + 1})`,
          ),
          index,
          dto.epc,
        );
      }
      seen.set(dto.epc, index);
    });

    const arrivals = dtos.map((dto, index) => {
      try {
        return this.parseArrival(dto);
      } catch (error) {
        throw itemError(error, index, dto.epc);
      }
    });

    // Report every already-registered EPC at once, before writing anything.
    const existing = await this.prisma.bundle.findMany({
      where: { epc: { in: dtos.map((dto) => dto.epc) } },
      select: { epc: true },
    });
    if (existing.length > 0) {
      throw new ConflictException({
        statusCode: 409,
        message: `Ya existen paquetes con estos EPC: ${existing.map((b) => b.epc).join(', ')}`,
        error: 'Conflict',
        epcs: existing.map((b) => b.epc),
      });
    }

    return this.withUniqueEpc(() =>
      this.prisma.$transaction(
        async (tx) => {
          const registeredAt = new Date();
          const ids: string[] = [];
          for (const [index, dto] of dtos.entries()) {
            try {
              ids.push(
                await this.createBundle(tx, dto, arrivals[index], user, registeredAt),
              );
            } catch (error) {
              throw itemError(error, index, dto.epc);
            }
          }
          const bundles = await tx.bundle.findMany({
            where: { id: { in: ids } },
            include: bundleListInclude,
          });
          const order = new Map(ids.map((id, index) => [id, index]));
          bundles.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
          return { count: bundles.length, bundles };
        },
        { maxWait: 10000, timeout: 60000 },
      ),
    );
  }

  private async createBundle(
    tx: Tx,
    dto: RegisterBundleDto,
    arrival: ArrivalData,
    user: SafeUser,
    registeredAt: Date,
  ): Promise<string> {
    await this.requireNewEpc(tx, dto.epc);
    await this.requireActiveReference(tx, dto.referenceId);
    await this.requireActiveFinish(tx, dto.finishId);
    await requireActiveRackInLocation(tx, dto.rackId, dto.inventoryLocationId);

    const bundle = await tx.bundle.create({
      data: {
        epc: dto.epc,
        referenceId: dto.referenceId,
        finishId: dto.finishId,
        quantity: dto.quantity,
        inventoryLocationId: dto.inventoryLocationId,
        rackId: dto.rackId,
        ...arrival,
        notes: dto.notes || null,
      },
      select: { id: true },
    });

    await tx.inventoryMovement.create({
      data: {
        bundleId: bundle.id,
        type: dto.registrationType,
        quantity: dto.quantity,
        quantityBefore: 0,
        quantityAfter: dto.quantity,
        destinationLocationId: dto.inventoryLocationId,
        destinationRackId: dto.rackId,
        occurredAt: registeredAt,
        performedById: user.id,
        operationKey: `bundle-registration:${randomUUID()}`,
      },
    });

    return bundle.id;
  }

  // A concurrent request with the same EPC committed first.
  private async withUniqueEpc<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un paquete con ese EPC');
      }
      throw error;
    }
  }

  async getBundle(id: string) {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id },
      include: bundleDetailInclude,
    });

    if (!bundle) {
      throw new NotFoundException('El paquete no existe');
    }

    return bundle;
  }

  // Exact lookup. Reading an EPC never creates or changes inventory.
  async getBundleByEpc(rawEpc: string) {
    const epc = normalizeEpc(rawEpc) as string;

    if (!EPC_PATTERN.test(epc) || epc.length > 128) {
      throw new BadRequestException(
        'El EPC solo puede contener letras y números, sin espacios',
      );
    }

    const bundle = await this.prisma.bundle.findUnique({
      where: { epc },
      include: bundleDetailInclude,
    });

    if (!bundle) {
      throw new NotFoundException('No hay un paquete registrado con ese EPC');
    }

    return bundle;
  }

  private parseArrival(dto: RegisterBundleDto): ArrivalData {
    const today = todayIn(BUSINESS_TIME_ZONE);
    const hasDate = dto.arrivalDate !== undefined;
    const hasMonth =
      dto.arrivalYear !== undefined || dto.arrivalMonth !== undefined;

    switch (dto.arrivalDatePrecision) {
      case 'EXACT': {
        if (!hasDate || hasMonth) {
          throw new BadRequestException(
            'Con llegada exacta envía solo arrivalDate (AAAA-MM-DD)',
          );
        }
        const date = new Date(`${dto.arrivalDate}T00:00:00.000Z`);
        if (
          Number.isNaN(date.getTime()) ||
          date.toISOString().slice(0, 10) !== dto.arrivalDate
        ) {
          throw new BadRequestException('arrivalDate no es una fecha válida');
        }
        if (dto.arrivalDate! > today) {
          throw new BadRequestException(
            'La fecha de llegada no puede ser futura',
          );
        }
        return {
          arrivalDatePrecision: 'EXACT',
          arrivalDate: date,
          arrivalYear: null,
          arrivalMonth: null,
        };
      }
      case 'MONTH': {
        if (
          hasDate ||
          dto.arrivalYear === undefined ||
          dto.arrivalMonth === undefined
        ) {
          throw new BadRequestException(
            'Con llegada mensual envía solo arrivalYear y arrivalMonth',
          );
        }
        const month = `${dto.arrivalYear}-${String(dto.arrivalMonth).padStart(2, '0')}`;
        if (month > today.slice(0, 7)) {
          throw new BadRequestException(
            'El mes de llegada no puede ser futuro',
          );
        }
        return {
          arrivalDatePrecision: 'MONTH',
          arrivalDate: null,
          arrivalYear: dto.arrivalYear,
          arrivalMonth: dto.arrivalMonth,
        };
      }
      case 'UNKNOWN': {
        if (hasDate || hasMonth) {
          throw new BadRequestException(
            'Con llegada desconocida no envíes fecha, año ni mes',
          );
        }
        return {
          arrivalDatePrecision: 'UNKNOWN',
          arrivalDate: null,
          arrivalYear: null,
          arrivalMonth: null,
        };
      }
    }
  }

  private async requireNewEpc(tx: Tx, epc: string) {
    const existing = await tx.bundle.findUnique({
      where: { epc },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Ya existe un paquete con ese EPC');
    }
  }

  private async requireActiveReference(tx: Tx, id: string) {
    const reference = await tx.reference.findUnique({ where: { id } });
    if (!reference) throw new NotFoundException('La referencia no existe');
    if (!reference.active) {
      throw new BadRequestException('La referencia está inactiva');
    }
  }

  private async requireActiveFinish(tx: Tx, id: string) {
    const finish = await tx.finish.findUnique({ where: { id } });
    if (!finish) throw new NotFoundException('El color no existe');
    if (!finish.active) throw new BadRequestException('El color está inactivo');
  }
}

// Prefixes an HTTP error with the queue position of the failing bundle.
function itemError(error: unknown, index: number, epc: string): unknown {
  if (!(error instanceof HttpException)) return error;
  const status = error.getStatus();
  return new HttpException(
    {
      statusCode: status,
      message: `Paquete ${index + 1} (EPC ${epc}): ${error.message}`,
      itemIndex: index,
    },
    status,
  );
}

function todayIn(timeZone: string): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
