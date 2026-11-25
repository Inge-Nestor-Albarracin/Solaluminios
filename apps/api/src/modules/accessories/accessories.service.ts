import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AccessoryExitType, AccessoryVoucherKind, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import {
  audit,
  isLockTimeout,
  isUniqueViolation,
  lockEpc,
  nextNumber,
  setLockTimeout,
  type Tx,
} from '../../shared/db.js';
import type { SafeUser } from '../auth/auth.types.js';
import { isAccessory, withFamilyKind } from '../catalog/catalog-kind.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import { enqueue } from '../notifications/outbox.js';
import {
  MAX_BASKET_QUANTITY,
  type BasketQueryDto,
  type CreateEntryDto,
  type CreateExitDto,
  type RegisterBasketDto,
  type VoucherQueryDto,
} from './dto/accessories.dto.js';

// Accessories warehouse, delivery 1 (docs/accesorios-fase-1.md).
//
// A basket is a Bundle with basket = true: one chip per fixed basket, one
// basket per reference, finish and location (partial unique index), a lot
// that only says its origin. Its units change only through vouchers (entries
// and exits without a sale, whose lines are ENTRY / EXIT movements) and the
// administrator's adjustments; the profile flows refuse it.
//
// Consistency: like the inventory operations, every write locks the basket
// rows (SELECT … FOR UPDATE, in id order) and checks the balance after the
// lock; the CHECKs of bundles / inventory_movements are the last defence.
// Retries: the voucher (or the basket's first movement) keeps the client's
// operationKey; the same request returns the saved result, other data 409.

const refSelect = {
  id: true,
  code: true,
  description: true,
  supplierCode: true,
  brand: true,
  family: { select: { code: true, name: true } },
} as const;
const finishSelect = { id: true, code: true, description: true } as const;
const locationSelect = { id: true, code: true, name: true, branch: { select: { name: true } } } as const;

const basketSelect = {
  id: true,
  epc: true,
  quantity: true,
  basket: true,
  inventoryLocationId: true,
  createdAt: true,
  updatedAt: true,
  reference: { select: refSelect },
  finish: { select: finishSelect },
  inventoryLocation: { select: locationSelect },
  lot: { select: { origin: true } },
} satisfies Prisma.BundleSelect;

type BasketRow = Prisma.BundleGetPayload<{ select: typeof basketSelect }>;

const voucherSelect = {
  id: true,
  number: true,
  kind: true,
  supplierName: true,
  documentNumber: true,
  arrivalDate: true,
  exitType: true,
  detail: true,
  receivedBy: true,
  notes: true,
  operationKey: true,
  createdAt: true,
  createdById: true,
  inventoryLocation: { select: locationSelect },
  createdBy: { select: { id: true, name: true } },
  movements: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      type: true,
      quantity: true,
      quantityBefore: true,
      quantityAfter: true,
      bundle: { select: { id: true, epc: true, reference: { select: refSelect }, finish: { select: finishSelect } } },
    },
  },
  task: { select: { id: true, completedAt: true, assignee: { select: { id: true, name: true } } } },
} satisfies Prisma.AccessoryVoucherSelect;

type VoucherRow = Prisma.AccessoryVoucherGetPayload<{ select: typeof voucherSelect }>;

export const EXIT_TYPE_LABELS: Record<AccessoryExitType, string> = {
  UNREGISTERED_SALE: 'Venta no registrada',
  INTERNAL_USE: 'Consumo interno',
};

// How people name an accessory: the supplier's code (if any) and description.
export function accessoryLabel(reference: { code: string; description: string | null; supplierCode: string | null }) {
  const name = reference.description ?? reference.code;
  return reference.supplierCode ? `${reference.supplierCode} · ${name}` : name;
}

const basketName = (row: { reference: { code: string; description: string | null; supplierCode: string | null }; finish: { code: string } }) =>
  `${accessoryLabel(row.reference)} (${row.finish.code})`;

// Days the administrator's notice stays "on time" (it never expires: it
// stays pending, flagged overdue, until marked as seen).
const NOTICE_DAYS = 3;

@Injectable()
export class AccessoriesService {
  constructor(private readonly prisma: PrismaService) {}

  // Accessories, colours and accessories warehouses for the selectors (the
  // ACCESSORIES role does not read /catalog nor /locations).
  async catalog(user: SafeUser) {
    const scope = await this.scope(this.prisma, user);
    const [references, finishes, locations] = await Promise.all([
      this.prisma.reference.findMany({
        where: { active: true, family: { kind: 'ACCESSORY' } },
        select: refSelect,
        orderBy: [{ family: { code: 'asc' } }, { description: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.finish.findMany({ where: { active: true }, select: finishSelect, orderBy: { code: 'asc' } }),
      this.prisma.inventoryLocation.findMany({
        where: { type: 'ACCESSORY_WAREHOUSE', active: true, branch: { active: true }, ...(scope ? { id: scope } : {}) },
        select: locationSelect,
        orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
      }),
    ]);
    return { references, finishes, locations };
  }

  async baskets(query: BasketQueryDto, user: SafeUser) {
    const scope = await this.scope(this.prisma, user);
    const text = query.q ?? null;
    const where: Prisma.BundleWhereInput = {
      basket: true,
      inventoryLocationId: scope ?? query.inventoryLocationId ?? undefined,
      ...(text
        ? {
            OR: [
              { epc: text.toUpperCase() },
              { reference: { code: { contains: text, mode: 'insensitive' } } },
              { reference: { description: { contains: text, mode: 'insensitive' } } },
              { reference: { supplierCode: { contains: text, mode: 'insensitive' } } },
              { reference: { brand: { contains: text, mode: 'insensitive' } } },
              { finish: { code: { equals: text, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.bundle.findMany({
      where,
      select: basketSelect,
      orderBy: [{ reference: { description: 'asc' } }, { reference: { code: 'asc' } }, { finish: { code: 'asc' } }],
      take: 500,
    });
    const reserved = await this.reservedByBundle(this.prisma, rows.map((r) => r.id));
    return {
      items: rows.map((row) => presentBasket(row, reserved.get(row.id) ?? 0)),
      totals: { baskets: rows.length, units: rows.reduce((sum, row) => sum + row.quantity, 0) },
    };
  }

  async basketByEpc(epc: string, user: SafeUser) {
    const value = epc.trim().toUpperCase();
    const bundle = await this.prisma.bundle.findUnique({ where: { epc: value }, select: { id: true, basket: true } });
    if (!bundle) throw new NotFoundException(`No hay una canasta con el chip ${value}`);
    if (!bundle.basket) throw new ConflictException(`El chip ${value} es de un paquete de perfiles, no de una canasta de accesorios`);
    return this.basket(bundle.id, user);
  }

  // A basket and its history (kárdex), newest first.
  async basket(id: string, user: SafeUser) {
    const scope = await this.scope(this.prisma, user);
    const row = await this.prisma.bundle.findFirst({ where: { id, basket: true }, select: basketSelect });
    if (!row || (scope && row.inventoryLocationId !== scope)) throw new NotFoundException('La canasta no existe');
    const [reserved, movements] = await Promise.all([
      this.reservedByBundle(this.prisma, [row.id]),
      this.prisma.inventoryMovement.findMany({
        where: { bundleId: row.id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 200,
        select: {
          id: true,
          type: true,
          quantity: true,
          quantityBefore: true,
          quantityAfter: true,
          occurredAt: true,
          reason: true,
          performedBy: { select: { id: true, name: true } },
          accessoryVoucher: { select: { id: true, number: true, kind: true } },
        },
      }),
    ]);
    return { ...presentBasket(row, reserved.get(row.id) ?? 0), movements };
  }

  async registerBasket(dto: RegisterBasketDto, user: SafeUser) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await setLockTimeout(tx);
          const replayed = await this.replayBasket(tx, dto, user);
          if (replayed) return replayed;

          const locationId = await this.registrationLocation(tx, user, dto.inventoryLocationId ?? null);
          await lockEpc(tx, dto.epc);
          const used = await tx.bundle.findUnique({ where: { epc: dto.epc }, select: { basket: true, reference: { select: refSelect }, finish: { select: finishSelect } } });
          if (used) {
            throw new ConflictException(
              used.basket
                ? `Ese chip ya es de la canasta ${basketName(used)}`
                : 'Ese chip ya es de un paquete de perfiles; usa otro chip para la canasta',
            );
          }
          const announced = await tx.inboundPreRegistration.findFirst({ where: { epc: dto.epc, status: 'PENDING' }, select: { id: true } });
          if (announced) throw new ConflictException('Ese chip tiene un prerregistro de China; usa otro chip para la canasta');

          const reference = await tx.reference.findUnique({ where: { id: dto.referenceId }, include: withFamilyKind });
          if (!reference || !isAccessory(reference)) throw new BadRequestException('Elige un accesorio del catálogo');
          if (!reference.active) throw new BadRequestException('Ese accesorio está inactivo en el catálogo');
          const finish = await tx.finish.findUnique({ where: { id: dto.finishId } });
          if (!finish?.active) throw new BadRequestException('Elige un color activo');

          const twin = await tx.bundle.findFirst({
            where: { basket: true, referenceId: dto.referenceId, finishId: dto.finishId, inventoryLocationId: locationId },
            select: { epc: true },
          });
          if (twin) {
            throw new ConflictException(
              `Ya hay una canasta de ${accessoryLabel(reference)} en color ${finish.code} (chip ${twin.epc}): las compras se le suman con un ingreso`,
            );
          }

          const lot = await tx.stockLot.create({
            data: {
              code: await nextNumber(tx, 'stock_lot_code_seq', 'LOT'),
              kind: 'ACCESSORY_BASKET',
              referenceId: dto.referenceId,
              finishId: dto.finishId,
              origin: dto.origin,
              createdById: user.id,
            },
          });
          const now = new Date();
          const basket = await tx.bundle.create({
            data: {
              epc: dto.epc,
              referenceId: dto.referenceId,
              finishId: dto.finishId,
              quantity: dto.quantity,
              inventoryLocationId: locationId,
              lotId: lot.id,
              basket: true,
            },
            select: { id: true },
          });
          // A movement always moves something (CHECK quantity > 0): an empty
          // basket has no movement yet, and its history starts with its
          // first entry (from 0).
          if (dto.quantity > 0) {
            await tx.inventoryMovement.create({
              data: {
                bundleId: basket.id,
                type: 'INITIAL_STOCK',
                quantity: dto.quantity,
                quantityBefore: 0,
                quantityAfter: dto.quantity,
                destinationLocationId: locationId,
                occurredAt: now,
                performedById: user.id,
                reason: 'Canasta registrada con el conteo de hoy',
                operationKey: dto.operationKey,
              },
            });
          }
          await audit(tx, {
            entity: 'Bundle',
            entityId: basket.id,
            action: 'BASKET_REGISTERED',
            userId: user.id,
            data: { operationKey: dto.operationKey, epc: dto.epc, referenceId: dto.referenceId, finishId: dto.finishId, origin: dto.origin, quantity: dto.quantity },
          });
          return this.basketIn(tx, basket.id);
        },
        { timeout: 20000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replayed = await this.replayBasket(this.prisma, dto, user);
        if (replayed) return replayed;
        throw new ConflictException('Otra persona acaba de registrar ese chip o esa canasta; revisa la lista de canastas');
      }
      if (isLockTimeout(error)) throw busy();
      throw error;
    }
  }

  async vouchers(query: VoucherQueryDto, user: SafeUser) {
    const scope = await this.scope(this.prisma, user);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.AccessoryVoucherWhereInput = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(scope ? { inventoryLocationId: scope } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.accessoryVoucher.count({ where }),
      this.prisma.accessoryVoucher.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: voucherSelect,
      }),
    ]);
    return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)), items: rows.map(presentVoucher) };
  }

  async voucher(id: string, user: SafeUser) {
    const scope = await this.scope(this.prisma, user);
    const row = await this.prisma.accessoryVoucher.findUnique({ where: { id }, select: voucherSelect });
    if (!row || (scope && row.inventoryLocation.id !== scope)) throw new NotFoundException('El comprobante no existe');
    return presentVoucher(row);
  }

  createEntry(dto: CreateEntryDto, user: SafeUser) {
    return this.createVoucher('ENTRY', dto, user);
  }

  createExit(dto: CreateExitDto, user: SafeUser) {
    return this.createVoucher('EXIT', dto, user);
  }

  // One voucher: every basket changes or none does.
  private async createVoucher(kind: AccessoryVoucherKind, dto: CreateEntryDto | CreateExitDto, user: SafeUser) {
    const header = voucherHeader(kind, dto);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await setLockTimeout(tx);
          const existing = await tx.accessoryVoucher.findUnique({ where: { operationKey: dto.operationKey }, select: voucherSelect });
          if (existing) return replayVoucher(existing, kind, header, dto, user);

          const ids = dto.lines.map((line) => line.basketId);
          const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
          if (repeated) throw new BadRequestException('Una canasta está repetida en el comprobante: deja una sola línea por canasta');
          const sorted = [...ids].sort();
          await tx.$queryRaw`SELECT id FROM "bundles" WHERE id = ANY(${sorted}::text[]) ORDER BY id FOR UPDATE`;
          const rows = await tx.bundle.findMany({ where: { id: { in: ids } }, select: basketSelect });
          if (rows.length !== ids.length) throw new NotFoundException('Una canasta del comprobante no existe');
          const byId = new Map(rows.map((row) => [row.id, row]));
          const notBasket = rows.find((row) => !row.basket);
          if (notBasket) throw new BadRequestException(`El chip ${notBasket.epc} es de un paquete de perfiles, no de una canasta`);
          const locationId = rows[0].inventoryLocationId;
          if (rows.some((row) => row.inventoryLocationId !== locationId)) {
            throw new BadRequestException('Todas las canastas de un comprobante deben ser de la misma bodega de accesorios');
          }
          const scope = await this.scope(tx, user);
          if (scope && scope !== locationId) throw new ForbiddenException('Esas canastas no son de tu bodega de accesorios');
          await this.requireAccessoryWarehouse(tx, locationId);

          const reserved = await this.reservedByBundle(tx, ids);
          const problems: string[] = [];
          for (const line of dto.lines) {
            const row = byId.get(line.basketId)!;
            if (kind === 'EXIT') {
              const free = row.quantity - (reserved.get(row.id) ?? 0);
              if (line.quantity > free) {
                problems.push(
                  `${basketName(row)}: pides ${line.quantity} y hay ${free}${reserved.get(row.id) ? ` disponibles (${reserved.get(row.id)} reservadas)` : ''}`,
                );
              }
            } else if (row.quantity + line.quantity > MAX_BASKET_QUANTITY) {
              problems.push(`${basketName(row)}: la canasta quedaría con más de ${MAX_BASKET_QUANTITY} unidades`);
            }
          }
          if (problems.length > 0) {
            throw new ConflictException(`No se guardó nada. ${problems.join('; ')}`);
          }

          const number = await nextNumber(tx, kind === 'ENTRY' ? 'accessory_entry_number_seq' : 'accessory_exit_number_seq', kind === 'ENTRY' ? 'IA' : 'SS');
          const voucher = await tx.accessoryVoucher.create({
            data: { number, kind, inventoryLocationId: locationId, ...header, operationKey: dto.operationKey, createdById: user.id },
            select: { id: true },
          });
          const now = new Date();
          const reason = kind === 'ENTRY' ? `Ingreso ${number}` : `Salida sin venta ${number}`;
          for (const line of dto.lines) {
            const row = byId.get(line.basketId)!;
            const after = kind === 'ENTRY' ? row.quantity + line.quantity : row.quantity - line.quantity;
            await tx.bundle.update({ where: { id: row.id }, data: { quantity: after } });
            await tx.inventoryMovement.create({
              data: {
                bundleId: row.id,
                type: kind,
                quantity: line.quantity,
                quantityBefore: row.quantity,
                quantityAfter: after,
                ...(kind === 'ENTRY' ? { destinationLocationId: locationId } : { sourceLocationId: locationId }),
                occurredAt: now,
                performedById: user.id,
                reason,
                operationKey: `accessory-voucher:${dto.operationKey}:${row.id}`,
                accessoryVoucherId: voucher.id,
              },
            });
          }
          const units = dto.lines.reduce((sum, line) => sum + line.quantity, 0);
          await audit(tx, {
            entity: 'AccessoryVoucher',
            entityId: voucher.id,
            action: kind === 'ENTRY' ? 'ACCESSORY_ENTRY_CREATED' : 'ACCESSORY_EXIT_CREATED',
            userId: user.id,
            data: { number, baskets: dto.lines.length, units },
          });
          await this.notifyAdministrator(tx, { id: voucher.id, number, kind, header, lines: dto.lines, byId, units, user, now });
          const saved = await tx.accessoryVoucher.findUniqueOrThrow({ where: { id: voucher.id }, select: voucherSelect });
          return presentVoucher(saved);
        },
        { timeout: 20000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.prisma.accessoryVoucher.findUnique({ where: { operationKey: dto.operationKey }, select: voucherSelect });
        if (existing) return replayVoucher(existing, kind, header, dto, user);
      }
      if (isLockTimeout(error)) throw busy();
      throw error;
    }
  }

  // The administrator is told (task + notice), never asked to authorise.
  // Vouchers made by an administrator need no notice.
  private async notifyAdministrator(
    tx: Tx,
    input: {
      id: string;
      number: string;
      kind: AccessoryVoucherKind;
      header: ReturnType<typeof voucherHeader>;
      lines: { basketId: string; quantity: number }[];
      byId: Map<string, BasketRow>;
      units: number;
      user: SafeUser;
      now: Date;
    },
  ) {
    if (input.user.role === 'ADMIN') return;
    const admin = await tx.user.findFirst({
      where: { role: 'ADMIN', active: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (!admin) return;
    const entry = input.kind === 'ENTRY';
    const baskets = `${input.lines.length} ${input.lines.length === 1 ? 'canasta' : 'canastas'}`;
    const title = entry
      ? `Ingreso ${input.number} · ${baskets}, +${input.units} unid.`
      : `Salida sin venta ${input.number} · ${EXIT_TYPE_LABELS[input.header.exitType!]} · ${baskets}, −${input.units} unid.`;
    const lines = input.lines.map((line) => {
      const row = input.byId.get(line.basketId)!;
      return `- ${basketName(row)}: ${entry ? '+' : '−'}${line.quantity} (de ${row.quantity} a ${entry ? row.quantity + line.quantity : row.quantity - line.quantity})`;
    });
    const support = entry
      ? `Proveedor: ${input.header.supplierName} · Factura o remisión: ${input.header.documentNumber}${input.header.arrivalDate ? ` · Llegó el ${input.header.arrivalDate.toISOString().slice(0, 10)}` : ''}`
      : `${EXIT_TYPE_LABELS[input.header.exitType!]}: ${input.header.detail}${input.header.receivedBy ? ` · Recibió: ${input.header.receivedBy}` : ''}`;
    const description = [`Registrado por ${input.user.name}. Solo para tu información: no hay que autorizar nada.`, support, ...lines]
      .concat(input.header.notes ? [`Notas: ${input.header.notes}`] : [])
      .join('\n');
    await tx.task.create({
      data: {
        kind: 'ACCESSORY_NOTICE',
        title,
        description,
        dueAt: new Date(input.now.getTime() + NOTICE_DAYS * 24 * 3600 * 1000),
        assigneeId: admin.id,
        createdById: input.user.id,
        accessoryVoucherId: input.id,
      },
    });
    await enqueue(tx, [{ userId: admin.id, kind: entry ? 'accessory-entry' : 'accessory-exit', dedupeKey: `accessory-voucher:${input.id}` }]);
  }

  // ADMIN: every accessories warehouse (null). ACCESSORIES: the one assigned
  // to them, which must be an active accessories warehouse.
  private async scope(client: Tx | PrismaService, user: SafeUser): Promise<string | null> {
    if (user.role === 'ADMIN') return null;
    if (!user.defaultInventoryLocationId) throw noWarehouse();
    const location = await client.inventoryLocation.findUnique({
      where: { id: user.defaultInventoryLocationId },
      select: { type: true, active: true, branch: { select: { active: true } } },
    });
    if (!location || location.type !== 'ACCESSORY_WAREHOUSE' || !location.active || !location.branch.active) throw noWarehouse();
    return user.defaultInventoryLocationId;
  }

  private async registrationLocation(tx: Tx, user: SafeUser, requested: string | null) {
    const scope = await this.scope(tx, user);
    if (scope) {
      if (requested && requested !== scope) throw new ForbiddenException('Solo registras canastas en tu bodega de accesorios');
      return scope;
    }
    if (requested) {
      await this.requireAccessoryWarehouse(tx, requested);
      return requested;
    }
    const all = await tx.inventoryLocation.findMany({
      where: { type: 'ACCESSORY_WAREHOUSE', active: true, branch: { active: true } },
      select: { id: true },
      take: 2,
    });
    if (all.length === 1) return all[0].id;
    throw new BadRequestException(all.length === 0 ? 'No hay ninguna bodega de accesorios activa' : 'Elige la bodega de accesorios');
  }

  private async requireAccessoryWarehouse(tx: Tx, id: string) {
    const location = await tx.inventoryLocation.findUnique({ where: { id }, select: { name: true, type: true, active: true, branch: { select: { active: true } } } });
    if (!location) throw new NotFoundException('La ubicación no existe');
    if (location.type !== 'ACCESSORY_WAREHOUSE') throw new BadRequestException(`${location.name} no es una bodega de accesorios`);
    if (!location.active || !location.branch.active) throw new BadRequestException('La bodega de accesorios o su sucursal está inactiva');
  }

  private async reservedByBundle(client: Tx | PrismaService, ids: string[]) {
    if (ids.length === 0) return new Map<string, number>();
    const rows = await client.stockReservation.groupBy({
      by: ['bundleId'],
      where: { bundleId: { in: ids }, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    return new Map(rows.map((row) => [row.bundleId, row._sum.quantity ?? 0]));
  }

  private async basketIn(client: Tx | PrismaService, id: string) {
    const row = await client.bundle.findUniqueOrThrow({ where: { id }, select: basketSelect });
    const reserved = await this.reservedByBundle(client, [id]);
    return presentBasket(row, reserved.get(id) ?? 0);
  }

  // Same key: the same basket by the same person returns it; anything else is
  // a reused key. The registration's audit event keeps the key (an empty
  // basket has no movement to hold it).
  private async replayBasket(client: Tx | PrismaService, dto: RegisterBasketDto, user: SafeUser) {
    const event = await client.auditEvent.findFirst({
      where: { entity: 'Bundle', action: 'BASKET_REGISTERED', data: { path: ['operationKey'], equals: dto.operationKey } },
      select: { entityId: true, userId: true, data: true },
    });
    if (!event) {
      // A key already used by any other inventory operation.
      const used = await client.inventoryMovement.findUnique({ where: { operationKey: dto.operationKey }, select: { id: true } });
      if (used) throw new ConflictException('La clave de guardado ya se usó con otros datos');
      return null;
    }
    const saved = (event.data ?? {}) as { quantity?: number };
    const bundle = await client.bundle.findUnique({
      where: { id: event.entityId },
      select: { id: true, epc: true, basket: true, referenceId: true, finishId: true, lot: { select: { origin: true } } },
    });
    const same =
      !!bundle &&
      event.userId === user.id &&
      saved.quantity === dto.quantity &&
      bundle.basket &&
      bundle.epc === dto.epc &&
      bundle.referenceId === dto.referenceId &&
      bundle.finishId === dto.finishId &&
      bundle.lot?.origin === dto.origin;
    if (!same) throw new ConflictException('La clave de guardado ya se usó con otros datos');
    return { replayed: true, ...(await this.basketIn(client, bundle.id)) };
  }
}

function voucherHeader(kind: AccessoryVoucherKind, dto: CreateEntryDto | CreateExitDto) {
  if (kind === 'ENTRY') {
    const entry = dto as CreateEntryDto;
    return {
      supplierName: entry.supplierName,
      documentNumber: entry.documentNumber,
      arrivalDate: entry.arrivalDate ? parseDay(entry.arrivalDate) : null,
      exitType: null,
      detail: null,
      receivedBy: null,
      notes: dto.notes ?? null,
    };
  }
  const exit = dto as CreateExitDto;
  return {
    supplierName: null,
    documentNumber: null,
    arrivalDate: null,
    exitType: exit.exitType,
    detail: exit.detail,
    receivedBy: exit.receivedBy ?? null,
    notes: dto.notes ?? null,
  };
}

function parseDay(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new BadRequestException('La fecha de llegada no es válida');
  }
  if (date.getTime() > Date.now() + 24 * 3600 * 1000) throw new BadRequestException('La fecha de llegada no puede ser futura');
  return date;
}

function replayVoucher(
  saved: VoucherRow,
  kind: AccessoryVoucherKind,
  header: ReturnType<typeof voucherHeader>,
  dto: CreateEntryDto | CreateExitDto,
  user: SafeUser,
) {
  const lines = new Map(saved.movements.map((m) => [m.bundle.id, m.quantity]));
  const same =
    saved.kind === kind &&
    saved.createdById === user.id &&
    saved.supplierName === header.supplierName &&
    saved.documentNumber === header.documentNumber &&
    (saved.arrivalDate?.getTime() ?? null) === (header.arrivalDate?.getTime() ?? null) &&
    saved.exitType === header.exitType &&
    saved.detail === header.detail &&
    saved.receivedBy === header.receivedBy &&
    saved.notes === header.notes &&
    lines.size === dto.lines.length &&
    dto.lines.every((line) => lines.get(line.basketId) === line.quantity);
  if (!same) throw new ConflictException('La clave de guardado ya se usó con otro comprobante');
  return { replayed: true, ...presentVoucher(saved) };
}

function presentBasket(row: BasketRow, reserved: number) {
  const { lot, basket: _basket, ...rest } = row;
  return { ...rest, origin: lot?.origin ?? null, reserved, available: Math.max(0, row.quantity - reserved) };
}

function presentVoucher(row: VoucherRow) {
  const { operationKey: _key, createdById: _creator, ...rest } = row;
  return {
    ...rest,
    arrivalDate: row.arrivalDate ? row.arrivalDate.toISOString().slice(0, 10) : null,
    exitTypeLabel: row.exitType ? EXIT_TYPE_LABELS[row.exitType] : null,
    totals: { baskets: row.movements.length, units: row.movements.reduce((sum, m) => sum + m.quantity, 0) },
  };
}

function noWarehouse() {
  return new BadRequestException('No tienes asignada una bodega de accesorios activa: pídele al administrador que te la asigne en Usuarios');
}

function busy() {
  return new ConflictException('Una de las canastas está ocupada con otra operación; intenta de nuevo en unos segundos');
}
