import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Bundle, Prisma } from '../../generated/prisma/client.js';

export type Tx = Prisma.TransactionClient;

// Only non-sensitive user fields are ever exposed with movements.
export const performedBySelect = {
  select: { id: true, name: true, role: true },
} as const;

const locationSelect = {
  select: { id: true, code: true, name: true },
} as const;

const rackSelect = {
  select: {
    id: true,
    number: true,
    aisle: { select: { id: true, number: true, floorNumber: true } },
  },
} as const;

export const bundleListInclude = {
  reference: {
    include: {
      family: { select: { id: true, code: true, name: true, active: true } },
    },
  },
  finish: true,
  inventoryLocation: {
    include: {
      branch: { select: { id: true, code: true, name: true, active: true } },
    },
  },
  rack: {
    include: {
      aisle: {
        select: { id: true, number: true, floorNumber: true, active: true },
      },
    },
  },
  // Provenance only (never the cost): null lot = origin unknown.
  lot: {
    select: {
      id: true,
      code: true,
      origin: true,
      supplier: { select: { id: true, code: true, name: true } },
    },
  },
} satisfies Prisma.BundleInclude;

// Profiles of a bundle committed to sales orders (ACTIVE reservations).
export async function reservedQuantity(tx: Tx, bundleId: string): Promise<number> {
  const result = await tx.stockReservation.aggregate({
    where: { bundleId, status: 'ACTIVE' },
    _sum: { quantity: true },
  });
  return result._sum.quantity ?? 0;
}

export const bundleDetailInclude = {
  ...bundleListInclude,
  openedBy: { select: { id: true, name: true } },
  // Latest movements only, newest first; the full history is paginated at
  // GET /inventory/bundles/:id/movements. Keeps responses bounded.
  movements: {
    orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: 20,
    include: { performedBy: performedBySelect },
  },
} satisfies Prisma.BundleInclude;

export const movementInclude = {
  performedBy: performedBySelect,
  sourceLocation: locationSelect,
  destinationLocation: locationSelect,
  sourceRack: rackSelect,
  destinationRack: rackSelect,
} satisfies Prisma.InventoryMovementInclude;

// Where a bundle is placed. Warehouses (bodegas) organise bundles by aisle
// and rack. Retail stores (almacenes) have neither: what arrives there is
// sold loose, so every bundle placed in one is opened (loose = true).
export interface Place {
  location: { id: string; code: string; name: string; type: 'WAREHOUSE' | 'RETAIL_STORE' | 'ACCESSORY_WAREHOUSE' };
  rackId: string | null;
  loose: boolean;
}

// Location and branch must exist and be active. A warehouse requires an
// active rack of that location; a retail store refuses any rack.
export async function requirePlace(
  tx: Tx,
  inventoryLocationId: string,
  rackId: string | null | undefined,
): Promise<Place> {
  const location = await tx.inventoryLocation.findUnique({
    where: { id: inventoryLocationId },
    include: { branch: { select: { active: true } } },
  });
  if (!location) throw new NotFoundException('La ubicación no existe');
  if (!location.active || !location.branch.active) {
    throw new BadRequestException('La ubicación o su sucursal está inactiva');
  }
  const place = { id: location.id, code: location.code, name: location.name, type: location.type };
  // Profile flows never place a bundle there: baskets are registered and
  // moved only by the accessories flows.
  if (location.type === 'ACCESSORY_WAREHOUSE') {
    throw new BadRequestException(
      `${location.name} es una bodega de accesorios: allí solo hay canastas, que se manejan desde Accesorios`,
    );
  }
  if (location.type === 'RETAIL_STORE') {
    if (rackId) {
      throw new BadRequestException(
        `${location.name} es un almacén: no maneja pasillo ni burro. Envía solo la ubicación.`,
      );
    }
    return { location: place, rackId: null, loose: true };
  }
  if (!rackId) {
    throw new BadRequestException(`Elige el pasillo y el burro de la bodega ${location.name}`);
  }
  await requireActiveRackInLocation(tx, rackId, inventoryLocationId);
  return { location: place, rackId, loose: false };
}

// Reason of the automatic opening of a bundle placed in a retail store.
export function storeOpeningReason(storeName: string, how: 'registro' | 'recepción' | 'traslado'): string {
  const when = { registro: 'al registrarse', recepción: 'al recibirse', traslado: 'al llegar por traslado' }[how];
  return `Abierto ${when}: ${storeName} es un almacén y allí los perfiles quedan sueltos`;
}

// The rack and its aisle must exist and be active, and the rack must belong
// to the selected location (already validated by requirePlace).
async function requireActiveRackInLocation(
  tx: Tx,
  rackId: string,
  inventoryLocationId: string,
) {
  const rack = await tx.rack.findUnique({
    where: { id: rackId },
    include: {
      aisle: {
        select: { active: true, inventoryLocationId: true },
      },
    },
  });
  if (!rack) throw new NotFoundException('El burro no existe');
  if (rack.aisle.inventoryLocationId !== inventoryLocationId) {
    throw new BadRequestException(
      'El burro no pertenece a la ubicación seleccionada',
    );
  }
  if (!rack.active || !rack.aisle.active) {
    throw new BadRequestException('El burro o su pasillo está inactivo');
  }
}

// What one movement of a bundle records (the caller adds bundle, time, user
// and operation key).
export type BundleMovementData = Pick<
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

// Moves a locked, validated bundle (whole) to a place and describes its
// TRANSFER movement and, when it arrives closed at a retail store, the
// OPENING that follows (its profiles become loose there). Shared by the
// manual transfers and the shipment of material requests.
export async function moveBundle(
  tx: Tx,
  bundle: Bundle,
  place: Place,
  reason: string | null,
  userId: string,
  now: Date,
): Promise<BundleMovementData & { opening?: BundleMovementData }> {
  const opens = place.loose && !bundle.openedAt;
  await tx.bundle.update({
    where: { id: bundle.id },
    data: {
      inventoryLocationId: place.location.id,
      rackId: place.rackId,
      ...(opens ? { openedAt: now, openedById: userId } : {}),
    },
  });
  const transfer: BundleMovementData = {
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
  const opening: BundleMovementData = {
    type: 'OPENING',
    quantity: bundle.quantity,
    quantityBefore: bundle.quantity,
    quantityAfter: bundle.quantity,
    sourceLocationId: place.location.id,
    reason: storeOpeningReason(place.location.name, 'traslado'),
  };
  return { ...transfer, opening };
}
