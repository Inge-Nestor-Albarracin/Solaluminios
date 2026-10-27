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
  BundleTransferDto,
} from './dto/bundle-operation.dto.js';
import {
  bundleDetailInclude,
  movementInclude,
  requireActiveRackInLocation,
  reservedQuantity,
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
  // movement to record.
  apply: (tx: Tx, bundle: Bundle) => Promise<MovementData>;
}

// Exits, transfers and adjustments.
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

  // Moves the whole bundle; quantity is unchanged.
  transfer(bundleId: string, dto: BundleTransferDto, user: SafeUser) {
    const reason = dto.reason || null;
    return this.execute(bundleId, user, {
      operationKey: dto.operationKey,
      matches: (m) =>
        m.type === 'TRANSFER' &&
        m.destinationLocationId === dto.inventoryLocationId &&
        m.destinationRackId === dto.rackId &&
        m.reason === reason,
      apply: async (tx, bundle) => {
        if (bundle.quantity === 0) {
          throw new ConflictException(
            'El paquete está agotado y no se puede trasladar',
          );
        }
        await requireActiveRackInLocation(
          tx,
          dto.rackId,
          dto.inventoryLocationId,
        );
        // Reservations belong to the dispatch location: moving reserved
        // material would invalidate them.
        if ((await reservedQuantity(tx, bundle.id)) > 0) {
          throw new ConflictException(
            'El paquete tiene perfiles reservados para una orden de venta; no se traslada mientras la reserva esté activa',
          );
        }
        if (
          bundle.inventoryLocationId === dto.inventoryLocationId &&
          bundle.rackId === dto.rackId
        ) {
          throw new BadRequestException(
            'El paquete ya está en ese burro de esa ubicación',
          );
        }
        await tx.bundle.update({
          where: { id: bundle.id },
          data: {
            inventoryLocationId: dto.inventoryLocationId,
            rackId: dto.rackId,
          },
        });
        return {
          type: 'TRANSFER',
          quantity: bundle.quantity,
          quantityBefore: bundle.quantity,
          quantityAfter: bundle.quantity,
          sourceLocationId: bundle.inventoryLocationId,
          sourceRackId: bundle.rackId,
          destinationLocationId: dto.inventoryLocationId,
          destinationRackId: dto.rackId,
          reason,
        };
      },
    });
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
          const data = await operation.apply(tx, bundle);
          const movement = await tx.inventoryMovement.create({
            data: {
              ...data,
              bundleId,
              occurredAt: new Date(),
              performedById: user.id,
              operationKey: operation.operationKey,
            },
            include: movementInclude,
          });
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
