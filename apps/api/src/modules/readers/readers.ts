import { randomBytes } from 'node:crypto';
import {
  Body,
  CanActivate,
  ConflictException,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ReaderDevice } from '../../generated/prisma/client.js';
import { DatabaseModule } from '../../infrastructure/database/database.module.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { hashPassword, verifyPassword } from '../../infrastructure/security/password.js';
import { isUniqueViolation } from '../../shared/db.js';
import { Public, Roles } from '../auth/auth.metadata.js';
import type { AuthenticatedRequest, SafeUser } from '../auth/auth.types.js';
import { DispatchModule } from '../dispatch/dispatch.module.js';
import { DispatchService } from '../dispatch/dispatch.service.js';
import { EPC_PATTERN, normalizeEpc } from '../inventory/dto/register-bundle.dto.js';

// PHASE 2 — fixed RFID readers / portal.
//
// A reader (or the adapter running next to it, on a PC or gateway, NOT a
// browser tab) authenticates with its own id and secret (never a user JWT)
// and posts observations for an explicit session bound to one authorised
// dispatch. Observations go through the SAME validation as the handheld
// (DispatchService.scan) in monitoring mode: they record detections and
// incidents, never picks, reservations or stock movements. Determining the
// physical passage (direction, sensors, antenna sequence) is not inferred
// from radio detections; autonomous exits are out of scope until validated.
//
// Disabled unless READER_CAPTURE_ENABLED=true.

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const MAX_EVENTS = 500;
const CLOCK_SKEW_MS = 5 * 60_000;

export class CreateReaderDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9._-]{1,40}$/, { message: 'El código del lector admite letras, números, punto, guion y guion bajo' })
  code!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  inventoryLocationId!: string;

  // Simulators are labelled as such in every observation.
  @IsOptional()
  @IsBoolean()
  simulator?: boolean;
}

export class UpdateReaderDto {
  @IsBoolean()
  active!: boolean;
}

export class OpenSessionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  dispatchId!: string;
}

export class ReaderEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  eventId!: string;

  @Transform(({ value }: { value: unknown }) => normalizeEpc(value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  @Matches(EPC_PATTERN)
  epc!: string;

  @IsISO8601({ strict: true })
  observedAt!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(64)
  antenna?: number;

  @IsOptional()
  @IsInt()
  @Min(-150)
  @Max(50)
  rssi?: number;
}

export class ObservationBatchDto {
  // Optional: without it, the device's open session is used (at most one per
  // device), so the adapter does not need to learn ids from the screen.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  sessionId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_EVENTS)
  @ValidateNested({ each: true })
  @Type(() => ReaderEventDto)
  events!: ReaderEventDto[];
}

interface ReaderRequest {
  headers: Record<string, string | string[] | undefined>;
  reader?: ReaderDevice;
}

export const readerCaptureEnabled = () => process.env.READER_CAPTURE_ENABLED === 'true';

// Device authentication: X-Reader-Id + "Authorization: Reader <secret>".
@Injectable()
export class ReaderAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!readerCaptureEnabled()) {
      throw new ServiceUnavailableException('La captura de lectores fijos está deshabilitada (READER_CAPTURE_ENABLED)');
    }
    const request = context.switchToHttp().getRequest<ReaderRequest>();
    const code = String(request.headers['x-reader-id'] ?? '').trim().toUpperCase();
    const auth = String(request.headers.authorization ?? '');
    const secret = auth.startsWith('Reader ') ? auth.slice(7).trim() : '';
    if (!code || !secret) throw new UnauthorizedException('Lector no autenticado');
    const device = await this.prisma.readerDevice.findUnique({ where: { code } });
    // Same answer for unknown, inactive or wrong secret.
    if (!device || !device.active || !(await verifyPassword(secret, device.secretHash))) {
      throw new UnauthorizedException('Lector no autenticado');
    }
    request.reader = device;
    return true;
  }
}

@Injectable()
export class ReadersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatches: DispatchService,
  ) {}

  list() {
    return this.prisma.readerDevice.findMany({
      select: {
        id: true,
        code: true,
        name: true,
        active: true,
        simulator: true,
        lastSeenAt: true,
        inventoryLocation: { select: { id: true, code: true, name: true } },
        sessions: { where: { status: 'OPEN' }, select: { id: true, dispatch: { select: { id: true, number: true } } } },
      },
      orderBy: { code: 'asc' },
    });
  }

  // The secret is returned ONCE; only its scrypt hash is stored.
  async create(dto: CreateReaderDto, user: SafeUser) {
    const location = await this.prisma.inventoryLocation.findUnique({ where: { id: dto.inventoryLocationId } });
    if (!location?.active) throw new NotFoundException('La ubicación no existe o está inactiva');
    const secret = randomBytes(24).toString('base64url');
    try {
      const device = await this.prisma.readerDevice.create({
        data: {
          code: dto.code,
          name: dto.name,
          inventoryLocationId: dto.inventoryLocationId,
          simulator: dto.simulator ?? false,
          secretHash: await hashPassword(secret),
          createdById: user.id,
        },
        select: { id: true, code: true, name: true, simulator: true, inventoryLocationId: true },
      });
      return { device, secret, notice: 'Guarda este secreto en el adaptador del lector; no se volverá a mostrar.' };
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe un lector con ese código');
      throw error;
    }
  }

  async setActive(id: string, active: boolean) {
    const { count } = await this.prisma.readerDevice.updateMany({ where: { id }, data: { active } });
    if (count === 0) throw new NotFoundException('El lector no existe');
    if (!active) await this.prisma.readerSession.updateMany({ where: { deviceId: id, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } });
    return { id, active };
  }

  // Active readers of the dispatch location, for the dispatch screen. Same
  // location rule as opening a session; another location reads as not found.
  async forDispatch(dispatchId: string, user: SafeUser) {
    const dispatch = await this.prisma.dispatch.findUnique({ where: { id: dispatchId }, select: { inventoryLocationId: true } });
    if (!dispatch || (user.role === 'WAREHOUSE' && user.defaultInventoryLocationId !== dispatch.inventoryLocationId)) {
      throw new NotFoundException('El despacho no existe');
    }
    const readers = await this.prisma.readerDevice.findMany({
      where: { active: true, inventoryLocationId: dispatch.inventoryLocationId },
      select: {
        id: true,
        code: true,
        name: true,
        simulator: true,
        lastSeenAt: true,
        sessions: { where: { status: 'OPEN' }, select: { id: true, dispatch: { select: { id: true, number: true } } } },
      },
      orderBy: { code: 'asc' },
    });
    return { captureEnabled: readerCaptureEnabled(), readers };
  }

  // Explicit association reader ↔ authorised dispatch of the same location.
  async openSession(deviceId: string, dto: OpenSessionDto, user: SafeUser) {
    const device = await this.prisma.readerDevice.findUnique({ where: { id: deviceId } });
    if (!device?.active) throw new NotFoundException('El lector no existe o está inactivo');
    if (user.role === 'WAREHOUSE' && user.defaultInventoryLocationId !== device.inventoryLocationId) {
      throw new ForbiddenException('El lector pertenece a otra ubicación');
    }
    const dispatch = await this.prisma.dispatch.findUnique({ where: { id: dto.dispatchId } });
    if (!dispatch || dispatch.status !== 'OPEN') throw new ConflictException('El despacho no existe o no está abierto');
    if (dispatch.inventoryLocationId !== device.inventoryLocationId) {
      throw new ConflictException('El lector y el despacho están en ubicaciones distintas');
    }
    try {
      return await this.prisma.readerSession.create({ data: { deviceId, dispatchId: dto.dispatchId, openedById: user.id } });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('El lector ya tiene una sesión abierta; ciérrala primero');
      throw error;
    }
  }

  async closeSession(id: string, user: SafeUser) {
    const session = await this.prisma.readerSession.findUnique({ where: { id }, include: { device: true } });
    if (!session) throw new NotFoundException('La sesión no existe');
    if (user.role === 'WAREHOUSE' && user.defaultInventoryLocationId !== session.device.inventoryLocationId) {
      throw new ForbiddenException('El lector pertenece a otra ubicación');
    }
    await this.prisma.readerSession.updateMany({ where: { id, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: new Date() } });
    return { id, status: 'CLOSED' };
  }

  async observe(device: ReaderDevice, dto: ObservationBatchDto) {
    const session = dto.sessionId
      ? await this.prisma.readerSession.findUnique({ where: { id: dto.sessionId }, include: { dispatch: true } })
      : await this.prisma.readerSession.findFirst({ where: { deviceId: device.id, status: 'OPEN' }, include: { dispatch: true } });
    if (!session || session.deviceId !== device.id || session.status !== 'OPEN') {
      throw new ConflictException('Sesión de lectura inexistente o cerrada: no se registró nada');
    }
    if (session.dispatch.status !== 'OPEN' || session.dispatch.inventoryLocationId !== device.inventoryLocationId) {
      throw new ConflictException('El despacho de la sesión no está abierto en la ubicación del lector');
    }
    await this.prisma.readerDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

    const limit = Date.now() + CLOCK_SKEW_MS;
    const accepted = new Map<string, { count: number; last: ReaderEventDto }>();
    let duplicates = 0;
    let rejected = 0;
    for (const event of dto.events) {
      if (new Date(event.observedAt).getTime() > limit) {
        rejected += 1;
        continue;
      }
      try {
        await this.prisma.readerEvent.create({ data: { deviceId: device.id, eventId: event.eventId } });
      } catch (error) {
        if (isUniqueViolation(error)) {
          duplicates += 1;
          continue;
        }
        throw error;
      }
      const entry = accepted.get(event.epc) ?? { count: 0, last: event };
      entry.count += 1;
      if (event.observedAt > entry.last.observedAt) entry.last = event;
      accepted.set(event.epc, entry);
    }
    const results = [];
    for (const [epc, { count, last }] of accepted) {
      const outcome = await this.dispatches.scan(session.dispatchId, epc, null, {
        source: device.simulator ? 'SIMULATOR' : 'FIXED_READER',
        deviceId: device.id,
        sessionId: session.id,
        prepare: false,
        detections: count,
        observedAt: new Date(last.observedAt),
        antenna: last.antenna ?? null,
        rssi: last.rssi ?? null,
      });
      results.push({ epc, detections: count, result: outcome.result, message: outcome.message });
    }
    return {
      mode: 'MONITOR',
      simulator: device.simulator,
      sessionId: session.id,
      dispatch: session.dispatch.number,
      accepted: dto.events.length - duplicates - rejected,
      duplicates,
      rejected,
      results,
    };
  }
}

function sessionUser(request: AuthenticatedRequest) {
  if (!request.user) throw new UnauthorizedException();
  return request.user;
}

@Controller()
export class ReadersController {
  constructor(private readonly readers: ReadersService) {}

  @Roles('ADMIN')
  @Get('readers')
  list() {
    return this.readers.list();
  }

  @Roles('ADMIN')
  @Post('readers')
  create(@Body() dto: CreateReaderDto, @Req() request: AuthenticatedRequest) {
    return this.readers.create(dto, sessionUser(request));
  }

  @Roles('ADMIN')
  @Patch('readers/:id')
  update(@Param('id') id: string, @Body() dto: UpdateReaderDto) {
    return this.readers.setActive(id, dto.active);
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Get('dispatches/:id/readers')
  forDispatch(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.readers.forDispatch(id, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('readers/:id/sessions')
  openSession(@Param('id') id: string, @Body() dto: OpenSessionDto, @Req() request: AuthenticatedRequest) {
    return this.readers.openSession(id, dto, sessionUser(request));
  }

  @Roles('ADMIN', 'WAREHOUSE')
  @Post('reader-sessions/:id/close')
  @HttpCode(HttpStatus.OK)
  closeSession(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.readers.closeSession(id, sessionUser(request));
  }

  // Device endpoint: no user session; authenticated by ReaderAuthGuard.
  @Public()
  @UseGuards(ReaderAuthGuard)
  @Throttle({ default: { limit: 240, ttl: 60000 } })
  @Post('reader/observations')
  @HttpCode(HttpStatus.OK)
  observe(@Body() dto: ObservationBatchDto, @Req() request: ReaderRequest) {
    return this.readers.observe(request.reader!, dto);
  }
}

@Module({
  imports: [DatabaseModule, DispatchModule],
  controllers: [ReadersController],
  providers: [ReadersService, ReaderAuthGuard],
})
export class ReadersModule {}
