import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { InboundPreRegistration } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import {
  audit,
  businessToday,
  isLockTimeout,
  isUniqueViolation,
  lockEpc,
  setLockTimeout,
  type Tx,
} from '../../shared/db.js';
import type { SafeUser } from '../auth/auth.types.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import { bundleListInclude, requireActiveRackInLocation } from '../inventory/inventory.shared.js';
import type { CreateShipmentDto, PreRegisterDto, PreRegistrationQueryDto, ReceiveDto } from './dto/supply.dto.js';
import { LotsService } from './lots.service.js';

const preRegistrationInclude = {
  reference: { select: { id: true, code: true, description: true } },
  finish: { select: { id: true, code: true, description: true } },
  shipment: { select: { id: true, code: true, status: true } },
} as const;

// China pre-registration and reception in Colombia.
//
// Pre-registering never creates stock: it records the EPC and the expected
// contents of a bundle of the configured Chinese supplier, in the open
// shipment. Origin and supplier are assigned by the server (any attempt to
// send them is rejected by the DTO whitelist). The Bundle and its ENTRY
// movement exist only after reception.
//
// Every flow that can create a record for an EPC takes the same advisory
// lock (lockEpc), so a pre-registration, a reception and a manual
// registration of the same chip are serialised.
@Injectable()
export class InboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lots: LotsService,
  ) {}

  // --- Shipments (administration) -------------------------------------------

  listShipments() {
    return this.prisma.inboundShipment.findMany({
      include: { supplier: { select: { id: true, code: true, name: true } }, _count: { select: { preRegistrations: true } } },
      orderBy: [{ createdAt: 'desc' }],
      take: 100,
    });
  }

  async openShipment(dto: CreateShipmentDto, user: SafeUser) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const supplier = await this.lots.requireChinaSupplier(tx);
        const open = await tx.inboundShipment.findFirst({ where: { supplierId: supplier.id, status: 'OPEN' } });
        if (open) throw new ConflictException(`Ya hay un envío abierto (${open.code}); ciérralo antes de abrir otro`);
        return tx.inboundShipment.create({
          data: { code: dto.code, supplierId: supplier.id, notes: dto.notes || null, createdById: user.id },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException('Ya existe un envío con ese código o un envío abierto');
      throw error;
    }
  }

  async closeShipment(id: string) {
    const { count } = await this.prisma.inboundShipment.updateMany({
      where: { id, status: 'OPEN' },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('No hay un envío abierto con ese identificador');
    return this.prisma.inboundShipment.findUniqueOrThrow({ where: { id } });
  }

  // --- China operator (English) ---------------------------------------------

  async chinaContext() {
    return this.prisma.$transaction(async (tx) => {
      const supplier = await this.lots.requireChinaSupplier(tx, 'en').catch(() => null);
      const shipment = supplier
        ? await tx.inboundShipment.findFirst({ where: { supplierId: supplier.id, status: 'OPEN' }, select: { id: true, code: true } })
        : null;
      return {
        supplier: supplier ? { code: supplier.code, name: supplier.name } : null,
        shipment,
        problem: !supplier
          ? 'The Chinese supplier is not configured yet. Ask the administrator.'
          : !shipment
            ? 'There is no open shipment. Ask the administrator to open one.'
            : null,
      };
    });
  }

  async chinaCatalog() {
    const [references, finishes] = await Promise.all([
      this.prisma.reference.findMany({ where: { active: true }, select: { id: true, code: true, description: true }, orderBy: { code: 'asc' } }),
      this.prisma.finish.findMany({ where: { active: true }, select: { id: true, code: true, description: true }, orderBy: { code: 'asc' } }),
    ]);
    return { references, finishes };
  }

  async preRegister(dto: PreRegisterDto, user: SafeUser) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await setLockTimeout(tx);
          await lockEpc(tx, dto.epc);
          const replay = await tx.inboundPreRegistration.findUnique({ where: { operationKey: dto.operationKey } });
          if (replay) return this.replayPreRegistration(tx, replay, dto, user);

          const supplier = await this.lots.requireChinaSupplier(tx, 'en');
          const shipment = await tx.inboundShipment.findFirst({ where: { supplierId: supplier.id, status: 'OPEN' } });
          if (!shipment) throw new ConflictException('There is no open shipment. Nothing was saved.');
          if (shipment.id !== dto.shipmentId) {
            throw new ConflictException(`The open shipment changed (now ${shipment.code}). Reload the page; nothing was saved.`);
          }
          const reference = await tx.reference.findUnique({ where: { id: dto.referenceId } });
          if (!reference?.active) throw new BadRequestException('Unknown or inactive reference');
          const finish = await tx.finish.findUnique({ where: { id: dto.finishId } });
          if (!finish?.active) throw new BadRequestException('Unknown or inactive finish / color');

          if (await tx.bundle.findUnique({ where: { epc: dto.epc }, select: { id: true } })) {
            throw new ConflictException('This chip is already registered in Colombia');
          }
          const live = await tx.inboundPreRegistration.findFirst({
            where: { epc: dto.epc, status: { not: 'CANCELLED' } },
            select: { id: true },
          });
          if (live) throw new ConflictException('This chip is already pre-registered');

          const lot = await this.lots.findOrCreateShipmentLot(tx, shipment, dto.referenceId, dto.finishId, user.id);
          const created = await tx.inboundPreRegistration.create({
            data: {
              epc: dto.epc,
              lotId: lot.id,
              shipmentId: shipment.id,
              referenceId: dto.referenceId,
              finishId: dto.finishId,
              expectedQuantity: dto.quantity,
              operationKey: dto.operationKey,
              createdById: user.id,
            },
            include: preRegistrationInclude,
          });
          return { replayed: false, preRegistration: this.forOperator(created) };
        },
        { maxWait: 10000, timeout: 15000 },
      );
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('The chip is being saved by another request. Retry with the same data.');
      if (isUniqueViolation(error)) {
        const replay = await this.prisma.inboundPreRegistration.findUnique({ where: { operationKey: dto.operationKey } });
        if (replay) return this.replayPreRegistration(this.prisma, replay, dto, user);
        throw new ConflictException('This chip is already pre-registered');
      }
      throw error;
    }
  }

  private async replayPreRegistration(client: Tx, existing: InboundPreRegistration, dto: PreRegisterDto, user: SafeUser) {
    const same =
      existing.epc === dto.epc &&
      existing.referenceId === dto.referenceId &&
      existing.finishId === dto.finishId &&
      existing.expectedQuantity === dto.quantity &&
      existing.shipmentId === dto.shipmentId &&
      existing.createdById === user.id;
    if (!same) throw new ConflictException('This operation key was already used with different data');
    const row = await client.inboundPreRegistration.findUniqueOrThrow({ where: { id: existing.id }, include: preRegistrationInclude });
    return { replayed: true, preRegistration: this.forOperator(row) };
  }

  // Operators see only their own records (ADMIN sees all). No costs, stock or
  // Colombian locations are ever included.
  async listPreRegistrations(query: PreRegistrationQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where = user.role === 'ADMIN' ? {} : { createdById: user.id };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.inboundPreRegistration.count({ where }),
      this.prisma.inboundPreRegistration.findMany({
        where,
        include: preRegistrationInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items: items.map((row) => this.forOperator(row)), page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  private forOperator(row: InboundPreRegistration & { reference: unknown; finish: unknown; shipment: unknown }) {
    return {
      id: row.id,
      epc: row.epc,
      reference: row.reference,
      finish: row.finish,
      shipment: row.shipment,
      quantity: row.expectedQuantity,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  // --- Reception in Colombia --------------------------------------------------

  async findForReception(epc: string) {
    const row = await this.prisma.inboundPreRegistration.findFirst({
      where: { epc, status: { not: 'CANCELLED' } },
      include: {
        ...preRegistrationInclude,
        lot: { select: { code: true, origin: true, supplier: { select: { id: true, code: true, name: true } } } },
        createdBy: { select: { id: true, name: true } },
        receivedBundle: { select: { id: true, epc: true, quantity: true } },
      },
    });
    if (!row) throw new NotFoundException('Este chip no tiene prerregistro de China');
    return row;
  }

  async receive(dto: ReceiveDto, user: SafeUser) {
    const movementKey = 'receive:' + dto.operationKey;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await setLockTimeout(tx);
          await lockEpc(tx, dto.epc);
          const replay = await tx.inventoryMovement.findUnique({ where: { operationKey: movementKey }, include: { bundle: true } });
          if (replay) {
            if (replay.bundle.epc !== dto.epc || replay.performedById !== user.id || replay.quantity !== dto.quantity) {
              throw new ConflictException('La clave de operación ya se usó con otros datos');
            }
            return { replayed: true, bundle: await tx.bundle.findUniqueOrThrow({ where: { id: replay.bundleId }, include: bundleListInclude }) };
          }

          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "inbound_pre_registrations"
            WHERE epc = ${dto.epc} AND status <> 'CANCELLED' FOR UPDATE`;
          if (rows.length === 0) throw new NotFoundException('Este chip no tiene prerregistro de China');
          const pre = await tx.inboundPreRegistration.findUniqueOrThrow({ where: { id: rows[0].id } });
          if (pre.status === 'RECEIVED') {
            throw new ConflictException('Este paquete ya fue recibido; no se vuelve a sumar al inventario');
          }
          if (await tx.bundle.findUnique({ where: { epc: dto.epc }, select: { id: true } })) {
            throw new ConflictException('Ya existe un paquete con ese EPC');
          }
          const discrepancy = dto.quantity !== pre.expectedQuantity;
          if (discrepancy && !dto.discrepancyReason) {
            throw new BadRequestException(
              `Se esperaban ${pre.expectedQuantity} perfiles y se reciben ${dto.quantity}: indica el motivo de la diferencia`,
            );
          }
          await requireActiveRackInLocation(tx, dto.rackId, dto.inventoryLocationId);

          const now = new Date();
          const bundle = await tx.bundle.create({
            data: {
              epc: dto.epc,
              referenceId: pre.referenceId,
              finishId: pre.finishId,
              quantity: dto.quantity,
              inventoryLocationId: dto.inventoryLocationId,
              rackId: dto.rackId,
              lotId: pre.lotId,
              arrivalDatePrecision: 'EXACT',
              arrivalDate: new Date(`${businessToday(now)}T00:00:00.000Z`),
            },
          });
          await tx.inventoryMovement.create({
            data: {
              bundleId: bundle.id,
              type: 'ENTRY',
              quantity: dto.quantity,
              quantityBefore: 0,
              quantityAfter: dto.quantity,
              destinationLocationId: dto.inventoryLocationId,
              destinationRackId: dto.rackId,
              occurredAt: now,
              performedById: user.id,
              reason: discrepancy ? `Recepción China con diferencia: ${dto.discrepancyReason}` : 'Recepción de prerregistro de China',
              operationKey: movementKey,
            },
          });
          await tx.inboundPreRegistration.update({
            where: { id: pre.id },
            data: {
              status: 'RECEIVED',
              receivedBundleId: bundle.id,
              receivedQuantity: dto.quantity,
              receivedAt: now,
              receivedById: user.id,
              discrepancyReason: discrepancy ? dto.discrepancyReason : null,
            },
          });
          if (discrepancy) {
            await audit(tx, {
              entity: 'InboundPreRegistration',
              entityId: pre.id,
              action: 'RECEIVED_WITH_DIFFERENCE',
              userId: user.id,
              reason: dto.discrepancyReason,
              data: { expected: pre.expectedQuantity, received: dto.quantity },
            });
          }
          return { replayed: false, bundle: await tx.bundle.findUniqueOrThrow({ where: { id: bundle.id }, include: bundleListInclude }) };
        },
        { maxWait: 10000, timeout: 15000 },
      );
    } catch (error) {
      if (isLockTimeout(error)) {
        throw new RetryableException('El chip se está procesando en otra operación. Reintenta con la misma solicitud.');
      }
      if (isUniqueViolation(error)) {
        const replay = await this.prisma.inventoryMovement.findUnique({ where: { operationKey: movementKey } });
        if (replay?.performedById === user.id) {
          return { replayed: true, bundle: await this.prisma.bundle.findUniqueOrThrow({ where: { id: replay.bundleId }, include: bundleListInclude }) };
        }
        throw new ConflictException('Este paquete ya fue recibido; no se vuelve a sumar al inventario');
      }
      throw error;
    }
  }
}
