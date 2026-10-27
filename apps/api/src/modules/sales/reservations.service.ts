import { Injectable } from '@nestjs/common';
import type { MaterialOrigin, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import type { Tx } from '../../shared/db.js';

// What an order line requires from a bundle. The supplier is a restriction
// only when the line names one.
export interface MaterialRequirement {
  referenceId: string;
  finishId: string;
  origin: MaterialOrigin;
  supplierId: string | null;
}

export interface Allocation {
  bundleId: string;
  quantity: number;
}

// Eligible stock: same reference and finish, a lot with the required origin
// (and supplier when required), in the given location, with profiles.
// Bundles without a lot (origin unknown) are never eligible.
export function eligibleWhere(requirement: MaterialRequirement, inventoryLocationId: string): Prisma.BundleWhereInput {
  return {
    referenceId: requirement.referenceId,
    finishId: requirement.finishId,
    inventoryLocationId,
    quantity: { gt: 0 },
    lot: {
      origin: requirement.origin,
      ...(requirement.supplierId ? { supplierId: requirement.supplierId } : {}),
    },
  };
}

// Reservations of bundles for sales order lines.
//
// Physical stock and commitments are kept apart: a reservation never changes
// the bundle quantity. available(bundle) = quantity − ACTIVE reservations.
// Callers lock the bundle rows (lockBundles) in id order inside their
// transaction before reading availability, so two orders can never commit
// the same profiles; a deferred trigger re-checks it at commit time.
@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  async lockBundles(tx: Tx, ids: string[]) {
    const sorted = [...new Set(ids)].sort();
    if (sorted.length === 0) return;
    await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
  }

  async candidateIds(tx: Tx, requirement: MaterialRequirement, inventoryLocationId: string): Promise<string[]> {
    const rows = await tx.bundle.findMany({ where: eligibleWhere(requirement, inventoryLocationId), select: { id: true } });
    return rows.map((row) => row.id);
  }

  // Active reservations per bundle (call after locking).
  async reservedByBundle(tx: Tx, bundleIds: string[]): Promise<Map<string, number>> {
    if (bundleIds.length === 0) return new Map();
    const groups = await tx.stockReservation.groupBy({
      by: ['bundleId'],
      where: { bundleId: { in: bundleIds }, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    return new Map(groups.map((group) => [group.bundleId, group._sum.quantity ?? 0]));
  }

  // FIFO plan over locked candidates (oldest bundle first). `taken` holds
  // quantities planned in the same transaction for other lines. `locked`
  // limits the plan to the bundles the caller locked: one that became
  // eligible after the lock (new entry, transfer, classification) is not
  // locked, so it is left for the next confirmation instead of being used.
  async plan(
    tx: Tx,
    requirement: MaterialRequirement,
    inventoryLocationId: string,
    quantity: number,
    taken: Map<string, number> = new Map(),
    locked?: ReadonlySet<string>,
  ): Promise<{ allocations: Allocation[]; shortage: number; available: number }> {
    const bundles = await tx.bundle.findMany({
      where: { ...eligibleWhere(requirement, inventoryLocationId), ...(locked ? { id: { in: [...locked] } } : {}) },
      select: { id: true, quantity: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const reserved = await this.reservedByBundle(tx, bundles.map((bundle) => bundle.id));
    const allocations: Allocation[] = [];
    let remaining = quantity;
    let available = 0;
    for (const bundle of bundles) {
      const free = bundle.quantity - (reserved.get(bundle.id) ?? 0) - (taken.get(bundle.id) ?? 0);
      if (free <= 0) continue;
      available += free;
      if (remaining === 0) continue;
      const use = Math.min(free, remaining);
      allocations.push({ bundleId: bundle.id, quantity: use });
      remaining -= use;
    }
    return { allocations, shortage: remaining, available };
  }

  // Availability summary by provenance for quoting and order screens
  // (no costs). Unknown-origin stock is shown separately and never counts
  // as China or National.
  async availability(referenceId: string, finishId: string, inventoryLocationId?: string) {
    const bundles = await this.prisma.bundle.findMany({
      where: { referenceId, finishId, quantity: { gt: 0 }, ...(inventoryLocationId ? { inventoryLocationId } : {}) },
      select: {
        id: true,
        quantity: true,
        inventoryLocationId: true,
        lot: { select: { origin: true, supplier: { select: { id: true, code: true, name: true } } } },
      },
    });
    const reserved = await this.reservedByBundle(this.prisma, bundles.map((bundle) => bundle.id));
    const groups = new Map<string, { origin: MaterialOrigin | 'UNKNOWN'; supplier: { id: string; code: string; name: string } | null; bundles: number; physical: number; reserved: number; available: number }>();
    for (const bundle of bundles) {
      const origin = bundle.lot?.origin ?? 'UNKNOWN';
      const supplier = bundle.lot?.supplier ?? null;
      const key = `${origin}|${supplier?.id ?? ''}`;
      const group = groups.get(key) ?? { origin, supplier, bundles: 0, physical: 0, reserved: 0, available: 0 };
      const held = reserved.get(bundle.id) ?? 0;
      group.bundles += 1;
      group.physical += bundle.quantity;
      group.reserved += held;
      group.available += bundle.quantity - held;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => a.origin.localeCompare(b.origin) || (a.supplier?.name ?? '').localeCompare(b.supplier?.name ?? ''));
  }
}
