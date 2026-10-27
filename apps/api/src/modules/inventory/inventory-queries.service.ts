import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  DEFAULT_PAGE_SIZE,
  type InventoryFiltersDto,
  type InventorySummaryQueryDto,
  type ListBundlesQueryDto,
  type PaginationQueryDto,
} from './dto/inventory-query.dto.js';
import { bundleListInclude, movementInclude } from './inventory.shared.js';

export interface LocationRow {
  inventoryLocation: {
    id: string;
    code: string;
    name: string;
    type: string;
    branch: { id: string; code: string; name: string };
  };
  aisle: { id: string; number: number; floorNumber: number | null } | null;
  rack: { id: string; number: number } | null;
  profiles: number;
  bundles: number;
}

// Read-only inventory queries. Stock is always computed from the current
// bundles; there is no separate stock table to keep in sync.
@Injectable()
export class InventoryQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  async listBundles(query: ListBundlesQueryDto) {
    await this.requireFilterTargets(query);
    const { page, pageSize, skip } = paginate(query);

    const where: Prisma.BundleWhereInput = {
      ...this.commonWhere(query),
      rackId: query.rackId,
      rack: query.aisleId ? { aisleId: query.aisleId } : undefined,
      lotId: query.unclassified === true || query.origin === 'UNKNOWN' ? null : undefined,
      // A supplier only exists through a lot, so with UNKNOWN nothing matches.
      lot:
        (query.origin && query.origin !== 'UNKNOWN') || query.supplierId
          ? {
              ...(query.origin && query.origin !== 'UNKNOWN' ? { origin: query.origin } : {}),
              ...(query.supplierId ? { supplierId: query.supplierId } : {}),
            }
          : undefined,
      quantity:
        query.available === true
          ? { gt: 0 }
          : query.available === false
            ? 0
            : undefined,
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.bundle.count({ where }),
      this.prisma.bundle.findMany({
        where,
        include: bundleListInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
    ]);

    return { items, page, pageSize, total, totalPages: pages(total, pageSize) };
  }

  // Bulk RFID reading: which of these chips are registered bundles. Chips
  // are returned in the order received; unknown ones go to `missing`.
  async lookupByEpcs(epcs: string[]) {
    const unique = [...new Set(epcs)];
    const rows = await this.prisma.bundle.findMany({
      where: { epc: { in: unique } },
      include: bundleListInclude,
    });
    const byEpc = new Map(rows.map((row) => [row.epc, row]));
    return {
      bundles: unique.flatMap((epc) => byEpc.get(epc) ?? []),
      missing: unique.filter((epc) => !byEpc.has(epc)),
    };
  }

  // Groups by reference + finish. Empty bundles (quantity 0) are excluded
  // from both profile and bundle counts.
  async summary(query: InventorySummaryQueryDto) {
    await this.requireFilterTargets(query);
    const { page, pageSize, skip } = paginate(query);

    const rows = await this.prisma.bundle.groupBy({
      by: ['referenceId', 'finishId', 'inventoryLocationId', 'rackId'],
      where: { ...this.commonWhere(query), quantity: { gt: 0 } },
      _sum: { quantity: true },
      _count: { _all: true },
    });

    const unique = <T>(values: (T | null)[]) =>
      [...new Set(values.filter((v): v is T => v !== null))];

    const [references, finishes, locations, racks] = await Promise.all([
      this.prisma.reference.findMany({
        where: { id: { in: unique(rows.map((r) => r.referenceId)) } },
        select: {
          id: true,
          code: true,
          description: true,
          active: true,
          family: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.finish.findMany({
        where: { id: { in: unique(rows.map((r) => r.finishId)) } },
        select: { id: true, code: true, description: true, active: true },
      }),
      this.prisma.inventoryLocation.findMany({
        where: { id: { in: unique(rows.map((r) => r.inventoryLocationId)) } },
        select: {
          id: true,
          code: true,
          name: true,
          type: true,
          branch: { select: { id: true, code: true, name: true } },
        },
      }),
      this.prisma.rack.findMany({
        where: { id: { in: unique(rows.map((r) => r.rackId)) } },
        select: {
          id: true,
          number: true,
          aisle: { select: { id: true, number: true, floorNumber: true } },
        },
      }),
    ]);

    const byId = <T extends { id: string }>(list: T[]) =>
      new Map(list.map((item) => [item.id, item]));
    const referenceMap = byId(references);
    const finishMap = byId(finishes);
    const locationMap = byId(locations);
    const rackMap = byId(racks);

    const groups = new Map<
      string,
      {
        reference: (typeof references)[number];
        finish: (typeof finishes)[number];
        profiles: number;
        bundles: number;
        locations: LocationRow[];
      }
    >();

    for (const row of rows) {
      const key = `${row.referenceId}|${row.finishId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          reference: referenceMap.get(row.referenceId)!,
          finish: finishMap.get(row.finishId)!,
          profiles: 0,
          bundles: 0,
          locations: [],
        };
        groups.set(key, group);
      }
      const profiles = row._sum.quantity ?? 0;
      const bundles = row._count._all;
      const rack = row.rackId ? rackMap.get(row.rackId) : undefined;
      group.profiles += profiles;
      group.bundles += bundles;
      group.locations.push({
        inventoryLocation: locationMap.get(row.inventoryLocationId)!,
        aisle: rack?.aisle ?? null,
        rack: rack ? { id: rack.id, number: rack.number } : null,
        profiles,
        bundles,
      });
    }

    const sorted = [...groups.values()].sort(
      (a, b) =>
        compare(a.reference.code, b.reference.code) ||
        compare(a.finish.code, b.finish.code) ||
        compare(a.reference.id, b.reference.id) ||
        compare(a.finish.id, b.finish.id),
    );
    for (const group of sorted) {
      group.locations.sort(
        (a, b) =>
          compare(a.inventoryLocation.branch.code, b.inventoryLocation.branch.code) ||
          compare(a.inventoryLocation.code, b.inventoryLocation.code) ||
          (a.aisle?.number ?? Infinity) - (b.aisle?.number ?? Infinity) ||
          (a.rack?.number ?? Infinity) - (b.rack?.number ?? Infinity) ||
          compare(a.rack?.id ?? '', b.rack?.id ?? ''),
      );
    }

    const total = sorted.length;
    return {
      items: sorted.slice(skip, skip + pageSize),
      page,
      pageSize,
      total,
      totalPages: pages(total, pageSize),
      totals: {
        profiles: sorted.reduce((sum, g) => sum + g.profiles, 0),
        bundles: sorted.reduce((sum, g) => sum + g.bundles, 0),
      },
    };
  }

  async listMovements(bundleId: string, query: PaginationQueryDto) {
    const bundle = await this.prisma.bundle.findUnique({
      where: { id: bundleId },
      select: { id: true },
    });
    if (!bundle) throw new NotFoundException('El paquete no existe');

    const { page, pageSize, skip } = paginate(query);
    const where = { bundleId };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.count({ where }),
      this.prisma.inventoryMovement.findMany({
        where,
        include: movementInclude,
        orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip,
        take: pageSize,
      }),
    ]);

    return { items, page, pageSize, total, totalPages: pages(total, pageSize) };
  }

  private commonWhere(query: InventoryFiltersDto): Prisma.BundleWhereInput {
    return {
      referenceId: query.referenceId,
      finishId: query.finishId,
      inventoryLocationId: query.inventoryLocationId,
      reference: query.familyId ? { familyId: query.familyId } : undefined,
      inventoryLocation: query.branchId
        ? { branchId: query.branchId }
        : undefined,
    };
  }

  // A filter pointing to a record that does not exist is a client error
  // (404), not an empty inventory.
  private async requireFilterTargets(
    query: InventoryFiltersDto & { aisleId?: string; rackId?: string },
  ) {
    const checks: [string | undefined, () => Promise<unknown>, string][] = [
      [query.familyId, () => this.prisma.productFamily.findUnique({ where: { id: query.familyId } }), 'La familia no existe'],
      [query.referenceId, () => this.prisma.reference.findUnique({ where: { id: query.referenceId } }), 'La referencia no existe'],
      [query.finishId, () => this.prisma.finish.findUnique({ where: { id: query.finishId } }), 'El color no existe'],
      [query.branchId, () => this.prisma.branch.findUnique({ where: { id: query.branchId } }), 'La sucursal no existe'],
      [query.inventoryLocationId, () => this.prisma.inventoryLocation.findUnique({ where: { id: query.inventoryLocationId } }), 'La ubicación no existe'],
      [query.aisleId, () => this.prisma.aisle.findUnique({ where: { id: query.aisleId } }), 'El pasillo no existe'],
      [query.rackId, () => this.prisma.rack.findUnique({ where: { id: query.rackId } }), 'El burro no existe'],
    ];

    for (const [value, find, message] of checks) {
      if (value !== undefined && !(await find())) {
        throw new NotFoundException(message);
      }
    }
  }
}

function paginate(query: PaginationQueryDto) {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function pages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
