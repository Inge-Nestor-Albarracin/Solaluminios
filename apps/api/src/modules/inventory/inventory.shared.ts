import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

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
} satisfies Prisma.BundleInclude;

export const bundleDetailInclude = {
  ...bundleListInclude,
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

// Location, its branch, the rack and its aisle must exist and be active, and
// the rack must belong to the selected location.
export async function requireActiveRackInLocation(
  tx: Tx,
  rackId: string,
  inventoryLocationId: string,
) {
  const location = await tx.inventoryLocation.findUnique({
    where: { id: inventoryLocationId },
    include: { branch: { select: { active: true } } },
  });
  if (!location) throw new NotFoundException('La ubicación no existe');
  if (!location.active || !location.branch.active) {
    throw new BadRequestException('La ubicación o su sucursal está inactiva');
  }

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
