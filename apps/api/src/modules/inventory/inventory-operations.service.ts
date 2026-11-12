import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  type Bundle,
  type InventoryMovement,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import type { SafeUser } from '../auth/auth.types.js';
import type {
  BundleAdjustmentDto,
  BundleExitDto,
  BundleOpenDto,
  BundleTransferBatchDto,
  BundleTransferDto,
} from './dto/bundle-operation.dto.js';
import {
  bundleDetailInclude,
  bundleListInclude,
  movementInclude,
  requirePlace,
  reservedQuantity,
  storeOpeningReason,
  type Place,
  type Tx,
} from './inventory.shared.js';

// Fixed server-side value (never user input), used in SET LOCAL lock_timeout.
const LOCK_TIMEOUT = '5s';
// Business ceiling for one bundle; also keeps the balance inside int4.
const MAX_BUNDLE_QUANTITY = 1_000_000;

// PostgreSQL 55P03 lock_not_available, raised when lock_timeout expires.
function isLockTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = (error as { meta?: Record<string, unknown> }).meta;
  return meta?.code === '55P03' || /55P03|lock timeout/i.test(`${error.message} ${JSON.stringify(meta ?? {})}`);
}

type MovementData = Pick<
  Prisma.InventoryMovementUncheckedCreateInput,
  | 'type'
  | 'quantity'
  | 'quantityBefore'
  | 'quantityAfter'
  | 'sourceLocationId'
  | 'sourceRackId'
  | 'destinationLocationId'
  | 'destinationRackId'
  | 'reason'
>;

interface Operation {
  operationKey: string;
  // Decides whether a stored movement with the same key is the same request.
  matches: (movement: InventoryMovement) => boolean;
  // Runs with the bundle row locked; updates the bundle and describes the
  // movement to record (and the opening that follows it, if any).
  apply: (tx: Tx, bundle: Bundle) => Promise<MovementData & { opening?: MovementData }>;
}

// Key prefix of the movements of one multiple transfer.
const batchTransferPrefix = (operationKey: string) => `bundle-transfer:${operationKey}:`;

// Exits, transfers, adjustments and openings.
//
// Consistency: every operation runs in one interactive transaction that first
// locks the bundle row with SELECT ... FOR UPDATE. Concurrent operations on
// the same bundle are serialized by PostgreSQL; each one reads the balance
// only after acquiring the lock, so two exits can never both consume the same
// profiles. The CHECK constraints on bundles/inventory_movements remain the
// last line of defence against negative balances.
//
// Retries: operationKey is unique in inventory_movements. The key is checked
// after the lock; a concurrent duplicate on another bundle is caught by the
// unique index (P2002). An equivalent request returns the original result
// with replayed = true and changes nothing; different data with the same key
// is rejected with 409.
@Injectable()
export class InventoryOperationsService {
  constructor(private readonly prisma: PrismaService) {}

  exit(bundleId: string, dto: BundleExitDto, user: SafeUser) {
    const reason = dto.reason || null;
    return this.execute(bundleId, user, {
      operationKey: dto.operationKey,
      matches: (m) =>
        m.type === 'EXIT' && m.quantity === dto.quantity && m.reason === reason,
      apply: async (tx, bundle) => {
        this.requireBalance(bundle, dto.quantity);
        await this.requireUnreserved(tx, bundle, dto.quantity, 'La salida');
        const quantityAfter = bundle.quantity - dto.quantity;
        await tx.bundle.update({
          where: { id: bundle.id },
          data: { quantity: quantityAfter },
        });
        return {
          type: 'EXIT',
          quantity: dto.quantity,
          quantityBefore: bundle.quantity,
          quantityAfter,
          sourceLocationId: bundle.inventoryLocationId,
          sourceRackId: bundle.rackId,
          reason,
        };
      },
    });
  }

  // Opens a closed bundle: its profiles become LOOSE profiles in the same
  // location and rack. Not an exit: the total stays the same, the bundle row
  // (EPC, history, lot) remains as antecedent and no new chip is needed. Its
  // reservations stay on the same row, so they follow the profiles without
  // ever being released. A bundle is opened only once (also a DB trigger).
  open(bundleId: string, dto: BundleOpenDto, user: SafeUser) {
    const reason = dto.reason || null;
    return this.execute(bundleId, user, {
      operationKey: dto.operationKey,
      matches: (m) => m.type === 'OPENING' && m.reason === reason,
      apply: async (tx, bundle) => {
        if (bundle.openedAt) {
          throw new ConflictException(
            `El paquete ya fue abierto el ${bundle.openedAt.toISOString().slice(0, 10)}; sus perfiles ya son sueltos`,
          );
        }
        if (bundle.quantity === 0) {
          throw new ConflictException('El paquete está agotado: no tiene perfiles para abrir');
        }
        await tx.bundle.update({
          where: { id: bundle.id },
          data: { openedAt: new Date(), openedById: user.id },
        });
        return {
          type: 'OPENING',
          quantity: bundle.quantity,
          quantityBefore: bundle.quantity,
          quantityAfter: bundle.quantity,
          sourceLocationId: bundle.inventoryLocationId,
          sourceRackId: bundle.rackId,
          reason,
        };
      },
    });
  }

  // Moves the whole bundle; quantity is unchanged. Arriving at a retail store
  // (almacén) it is opened in the same operation: its profiles are loose.
  transfer(bundleId: string, dto: BundleTransferDto, user: SafeUser) {
    const reason = dto.reason || null;
    return this.execute(bundleId, user, {
      operationKey: dto.operationKey,
      matches: (m) =>
        m.type === 'TRANSFER' &&
        m.destinationLocationId === dto.inventoryLocationId &&
        m.destinationRackId === (dto.rackId ?? null) &&
        m.reason === reason,
      apply: async (tx, bundle) => {
        const place = await requirePlace(tx, dto.inventoryLocationId, dto.rackId);
        const problem = notMovable(bundle, await reservedQuantity(tx, bundle.id), place);
        if (problem) throw problem;
        return this.moveTo(tx, bundle, place, reason, user, new Date());
      },
    });
  }

  // Several whole bundles to one destination in ONE transaction: all of them
  // move or none does, and every problem is reported at once. Each bundle
  // gets its own TRANSFER movement (and OPENING when the destination is a
  // retail store) with the key `bundle-transfer:<key>:<bundleId>`. A retry
  // with the same key returns the saved result.
  async transferMany(dto: BundleTransferBatchDto, user: SafeUser) {
    const reason = dto.reason || null;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          const ids = [...dto.bundleIds].sort();
          await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
          const replayed = await this.replayTransferMany(tx, dto, user);
          if (replayed) return replayed;

          const place = await requirePlace(tx, dto.inventoryLocationId, dto.rackId);
          const bundles = await tx.bundle.findMany({ where: { id: { in: ids } } });
          const missing = dto.bundleIds.length - bundles.length;
          if (missing > 0) {
            throw new NotFoundException(
              missing === 1
                ? 'Un paquete de la lista no existe; no se trasladó ninguno'
                : `${missing} paquetes de la lista no existen; no se trasladó ninguno`,
            );
          }
          const reserved = await tx.stockReservation.groupBy({
            by: ['bundleId'],
            where: { bundleId: { in: ids }, status: 'ACTIVE' },
            _sum: { quantity: true },
          });
          const held = new Map(reserved.map((row) => [row.bundleId, row._sum.quantity ?? 0]));
          const byId = new Map(bundles.map((bundle) => [bundle.id, bundle]));
          const ordered = dto.bundleIds.map((id) => byId.get(id)!);
          const problems = ordered
            .map((bundle) => ({ bundle, error: notMovable(bundle, held.get(bundle.id) ?? 0, place) }))
            .filter((row): row is { bundle: Bundle; error: Error } => row.error !== null)
            .map(({ bundle, error }) => ({ bundleId: bundle.id, epc: bundle.epc, message: error.message }));
          if (problems.length > 0) {
            throw new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              message: `No se trasladó ningún paquete. ${problems.map((p) => `${p.epc}: ${p.message}`).join(' · ')}`,
              problems,
            });
          }

          const now = new Date();
          let opened = 0;
          for (const bundle of ordered) {
            const key = batchTransferPrefix(dto.operationKey) + bundle.id;
            const { opening, ...movement } = await this.moveTo(tx, bundle, place, reason, user, now);
            await tx.inventoryMovement.create({
              data: { ...movement, bundleId: bundle.id, occurredAt: now, performedById: user.id, operationKey: key },
            });
            if (opening) {
              opened += 1;
              await tx.inventoryMovement.create({
                data: { ...opening, bundleId: bundle.id, occurredAt: now, performedById: user.id, operationKey: `${key}:open` },
              });
            }
          }
          return { replayed: false, ...(await this.transferResult(tx, dto.bundleIds, opened)) };
        },
        { maxWait: 10000, timeout: 60000 },
      );
    } catch (error: unknown) {
      if (isLockTimeout(error)) {
        throw new RetryableException(
          'Uno de los paquetes está siendo modificado por otra operación. Reintenta en unos segundos con la misma solicitud.',
        );
      }
      // The same key was committed concurrently by another request.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replayed = await this.replayTransferMany(this.prisma, dto, user);
        if (replayed) return replayed;
      }
      throw error;
    }
  }

  // The saved result of a multiple transfer with this key, if it is the same
  // request; a key already used with other data is rejected.
  private async replayTransferMany(client: Tx, dto: BundleTransferBatchDto, user: SafeUser) {
    const prefix = batchTransferPrefix(dto.operationKey);
    const saved = await client.inventoryMovement.findMany({
      where: { operationKey: { startsWith: prefix } },
    });
    if (saved.length === 0) return null;
    const transfers = saved.filter((m) => m.type === 'TRANSFER');
    const reason = dto.reason || null;
    const same =
      transfers.length === dto.bundleIds.length &&
      dto.bundleIds.every((id) => transfers.some((m) => m.operationKey === prefix + id && m.bundleId === id)) &&
      transfers.every(
        (m) =>
          m.performedById === user.id &&
          m.destinationLocationId === dto.inventoryLocationId &&
          m.destinationRackId === (dto.rackId ?? null) &&
          m.reason === reason,
      );
    if (!same) throw new ConflictException('La clave de operación ya se usó con otros datos');
    const opened = saved.filter((m) => m.type === 'OPENING').length;
    return { replayed: true, ...(await this.transferResult(client, dto.bundleIds, opened)) };
  }

  private async transferResult(client: Tx, ids: string[], opened: number) {
    const bundles = await client.bundle.findMany({ where: { id: { in: ids } }, include: bundleListInclude });
    const order = new Map(ids.map((id, index) => [id, index]));
    bundles.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    return {
      count: bundles.length,
      profiles: bundles.reduce((total, bundle) => total + bundle.quantity, 0),
      opened,
      bundles,
    };
  }

  // Moves a locked, validated bundle and describes its TRANSFER movement and,
  // when it arrives closed at a retail store, the OPENING that follows.
  private async moveTo(
    tx: Tx,
    bundle: Bundle,
    place: Place,
    reason: string | null,
    user: SafeUser,
    now: Date,
  ): Promise<MovementData & { opening?: MovementData }> {
    const opens = place.loose && !bundle.openedAt;
    await tx.bundle.update({
      where: { id: bundle.id },
      data: {
        inventoryLocationId: place.location.id,
        rackId: place.rackId,
        ...(opens ? { openedAt: now, openedById: user.id } : {}),
      },
    });
    const transfer: MovementData = {
      type: 'TRANSFER',
      quantity: bundle.quantity,
      quantityBefore: bundle.quantity,
      quantityAfter: bundle.quantity,
      sourceLocationId: bundle.inventoryLocationId,
      sourceRackId: bundle.rackId,
      destinationLocationId: place.location.id,
      destinationRackId: place.rackId,
      reason,
    };
    if (!opens) return transfer;
    const opening: MovementData = {
      type: 'OPENING',
      quantity: bundle.quantity,
      quantityBefore: bundle.quantity,
      quantityAfter: bundle.quantity,
      sourceLocationId: place.location.id,
      reason: storeOpeningReason(place.location.name, 'traslado'),
    };
    return { ...transfer, opening };
  }

  adjust(bundleId: string, dto: BundleAdjustmentDto, user: SafeUser) {
    return this.execute(bundleId, user, {
      operationKey: dto.operationKey,
      matches: (m) =>
        m.type === dto.type &&
        m.quantity === dto.quantity &&
        m.reason === dto.reason,
      apply: async (tx, bundle) => {
        const incoming = dto.type === 'ADJUSTMENT_IN';
        if (!incoming) {
          this.requireBalance(bundle, dto.quantity);
          await this.requireUnreserved(tx, bundle, dto.quantity, 'El ajuste');
        }
        if (incoming && bundle.quantity + dto.quantity > MAX_BUNDLE_QUANTITY) {
          throw new BadRequestException(
            `El saldo resultante superaría el máximo de ${MAX_BUNDLE_QUANTITY} perfiles por paquete`,
          );
        }
        const quantityAfter = incoming
          ? bundle.quantity + dto.quantity
          : bundle.quantity - dto.quantity;
        await tx.bundle.update({
          where: { id: bundle.id },
          data: { quantity: quantityAfter },
        });
        const here = incoming
          ? {
              destinationLocationId: bundle.inventoryLocationId,
              destinationRackId: bundle.rackId,
            }
          : {
              sourceLocationId: bundle.inventoryLocationId,
              sourceRackId: bundle.rackId,
            };
        return {
          type: dto.type,
          quantity: dto.quantity,
          quantityBefore: bundle.quantity,
          quantityAfter,
          ...here,
          reason: dto.reason,
        };
      },
    });
  }

  private async execute(bundleId: string, user: SafeUser, operation: Operation) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Wait at most LOCK_TIMEOUT for a bundle busy with another operation
          // instead of holding a pool connection until the transaction timeout.
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          const locked = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "bundles" WHERE id = ${bundleId} FOR UPDATE`;

          const existing = await tx.inventoryMovement.findUnique({
            where: { operationKey: operation.operationKey },
          });
          if (existing) {
            return this.replay(tx, existing, bundleId, user, operation);
          }
          if (locked.length === 0) {
            throw new NotFoundException('El paquete no existe');
          }

          const bundle = await tx.bundle.findUniqueOrThrow({
            where: { id: bundleId },
          });
          const { opening, ...data } = await operation.apply(tx, bundle);
          const occurredAt = new Date();
          const movement = await tx.inventoryMovement.create({
            data: {
              ...data,
              bundleId,
              occurredAt,
              performedById: user.id,
              operationKey: operation.operationKey,
            },
            include: movementInclude,
          });
          if (opening) {
            await tx.inventoryMovement.create({
              data: { ...opening, bundleId, occurredAt, performedById: user.id, operationKey: `${operation.operationKey}:open` },
            });
          }
          const updated = await tx.bundle.findUniqueOrThrow({
            where: { id: bundleId },
            include: bundleDetailInclude,
          });
          return { replayed: false, movement, bundle: updated };
        },
        { maxWait: 10000, timeout: 15000 },
      );
    } catch (error: unknown) {
      // Another operation still holds the bundle: nothing was applied. This is
      // temporary, so the client retries with the SAME operationKey (503),
      // never as a definitive conflict that would make it pick a new key.
      if (isLockTimeout(error)) {
        throw new RetryableException(
          'El paquete está siendo modificado por otra operación. Reintenta en unos segundos con la misma solicitud.',
        );
      }
      // The same key was committed concurrently by another transaction.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const existing = await this.prisma.inventoryMovement.findUnique({
          where: { operationKey: operation.operationKey },
        });
        if (existing) {
          return this.replay(this.prisma, existing, bundleId, user, operation);
        }
      }
      throw error;
    }
  }

  private async replay(
    client: Tx,
    existing: InventoryMovement,
    bundleId: string,
    user: SafeUser,
    operation: Operation,
  ) {
    if (
      existing.bundleId !== bundleId ||
      existing.performedById !== user.id ||
      !operation.matches(existing)
    ) {
      throw new ConflictException(
        'La clave de operación ya se usó con otros datos',
      );
    }
    // Sequential: inside a transaction both queries share one connection.
    const movement = await client.inventoryMovement.findUniqueOrThrow({
      where: { id: existing.id },
      include: movementInclude,
    });
    const bundle = await client.bundle.findUniqueOrThrow({
      where: { id: bundleId },
      include: bundleDetailInclude,
    });
    return { replayed: true, movement, bundle };
  }

  // Manual exits and negative adjustments can only use unreserved profiles;
  // reserved ones leave through their dispatch, or the reservation is
  // released first (order/dispatch cancellation).
  private async requireUnreserved(tx: Tx, bundle: Bundle, quantity: number, operation: string) {
    const reserved = await reservedQuantity(tx, bundle.id);
    if (reserved > 0 && quantity > bundle.quantity - reserved) {
      throw new ConflictException(
        `${operation} supera lo disponible: ${reserved} de ${bundle.quantity} perfiles están reservados para órdenes de venta. Libera o reasigna la reserva antes de continuar.`,
      );
    }
  }

  private requireBalance(bundle: Bundle, quantity: number) {
    if (bundle.quantity === 0) {
      throw new ConflictException('El paquete está agotado');
    }
    if (quantity > bundle.quantity) {
      throw new ConflictException(
        `La cantidad supera el saldo del paquete (${bundle.quantity} perfiles)`,
      );
    }
  }
}

// Why a bundle cannot move to this place (null when it can). Reservations
// belong to the dispatch location: moving reserved material would
// invalidate them.
function notMovable(bundle: Bundle, reserved: number, place: Place): Error | null {
  if (bundle.quantity === 0) {
    return new ConflictException('El paquete está agotado y no se puede trasladar');
  }
  if (reserved > 0) {
    return new ConflictException(
      'El paquete tiene perfiles reservados para una orden de venta; no se traslada mientras la reserva esté activa',
    );
  }
  if (bundle.inventoryLocationId === place.location.id && bundle.rackId === place.rackId) {
    return new BadRequestException(
      place.loose ? `El paquete ya está en el almacén ${place.location.name}` : 'El paquete ya está en ese burro de esa ubicación',
    );
  }
  return null;
}
