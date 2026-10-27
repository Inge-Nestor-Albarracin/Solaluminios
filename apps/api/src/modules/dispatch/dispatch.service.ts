import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Dispatch, IncidentKind, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, isLockTimeout, isUniqueViolation, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import type { SafeUser } from '../auth/auth.types.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import { enqueue } from '../notifications/outbox.js';
import { ReservationsService, eligibleWhere } from '../sales/reservations.service.js';
import { SalesService } from '../sales/sales.service.js';
import { SETTING_KEYS, SettingsService } from '../supply/settings.service.js';
import { cancelOpenDispatches } from './dispatch-cancel.js';
import type { CreateDispatchDto, DispatchQueryDto, ReassignDispatchDto } from './dto/dispatch.dto.js';
import { matchBundle, type DispatchLineRequirement, type ScannedBundle } from './validation.js';

const MAX_DUE_DAYS = 366;

export type CaptureSource = 'HANDHELD' | 'FIXED_READER' | 'SIMULATOR';

export interface CaptureContext {
  source: CaptureSource;
  // Handheld: the user; reader: the device and its session.
  userId?: string;
  deviceId?: string;
  sessionId?: string;
  // Handheld reads prepare the bundle; fixed readers only monitor (phase 2
  // default: no autonomous picking or stock movement).
  prepare: boolean;
  observedAt?: Date;
  // Radio detections of this chip grouped in one call (fixed readers).
  detections?: number;
  antenna?: number | null;
  rssi?: number | null;
}

const finishLabel = (finish: { code: string; description: string | null }) =>
  (finish.description ?? finish.code).toLowerCase();

// Dispatches: authorised deliveries of a sales order from one location,
// executed by an assigned warehouse worker through a linked DISPATCH task.
//
// States: OPEN → CONFIRMED (physical exit confirmed) or CANCELLED. Progress
// (prepared/pending) is derived from picks and lines; the task completes
// only through confirm(). Prices and costs are never part of dispatch
// responses. Concurrency: every dispatch operation locks the dispatch row
// first and then the bundle rows in id order.
@Injectable()
export class DispatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly reservations: ReservationsService,
    private readonly settings: SettingsService,
  ) {}

  // --- Access ---------------------------------------------------------------

  private scope(user: SafeUser): Prisma.DispatchWhereInput {
    if (user.role === 'ADMIN') return {};
    if (user.role === 'SALES') return { salesOrder: { createdById: user.id } };
    if (user.role === 'WAREHOUSE') {
      return {
        OR: [
          { assigneeId: user.id },
          ...(user.defaultInventoryLocationId ? [{ inventoryLocationId: user.defaultInventoryLocationId }] : []),
        ],
      };
    }
    return { id: '__none__' };
  }

  // Execution (scan, prepare, confirm): the assignee, warehouse staff of
  // the dispatch location, or ADMIN.
  private assertExecutor(dispatch: Dispatch, user: SafeUser) {
    const allowed =
      user.role === 'ADMIN' ||
      (user.role === 'WAREHOUSE' && (dispatch.assigneeId === user.id || dispatch.inventoryLocationId === user.defaultInventoryLocationId));
    if (!allowed) throw new ForbiddenException('No puedes ejecutar este despacho');
  }

  private async lockDispatch(tx: Tx, id: string, user: SafeUser) {
    await setLockTimeout(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "dispatches" WHERE id = ${id} FOR UPDATE`;
    const dispatch = rows.length ? await tx.dispatch.findFirst({ where: { id, ...this.scope(user) } }) : null;
    // Same answer for "does not exist" and "not yours".
    if (!dispatch) throw new NotFoundException('El despacho no existe');
    return dispatch;
  }

  async eligibleAssignees(inventoryLocationId: string) {
    return this.prisma.user.findMany({
      where: { active: true, role: 'WAREHOUSE', defaultInventoryLocationId: inventoryLocationId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  private async requireAssignee(tx: Tx, assigneeId: string, inventoryLocationId: string) {
    const assignee = await tx.user.findUnique({ where: { id: assigneeId } });
    if (!assignee?.active || assignee.role !== 'WAREHOUSE' || assignee.defaultInventoryLocationId !== inventoryLocationId) {
      throw new BadRequestException(
        'El responsable debe ser un usuario activo de bodega asignado a la ubicación del despacho (Administración → Usuarios → ubicación predeterminada)',
      );
    }
    return assignee;
  }

  // --- Creation ---------------------------------------------------------------

  async create(orderId: string, dto: CreateDispatchDto, user: SafeUser) {
    const dueAt = new Date(dto.dueAt);
    const now = Date.now();
    if (dueAt.getTime() <= now + 60_000) throw new BadRequestException('El plazo debe ser al menos un minuto en el futuro');
    if (dueAt.getTime() > now + MAX_DUE_DAYS * 86_400_000) throw new BadRequestException(`El plazo no puede superar ${MAX_DUE_DAYS} días`);
    try {
      const id = await this.prisma.$transaction(
        async (tx) => {
          const replay = await tx.dispatch.findUnique({ where: { createOperationKey: dto.operationKey } });
          if (replay) {
            if (replay.salesOrderId !== orderId) throw new ConflictException('La clave de operación ya se usó con otra orden');
            return replay.id;
          }
          const order = await this.sales.lockOrder(tx, orderId, user);
          if (order.status === 'CANCELLED' || order.status === 'COMPLETED') throw new ConflictException('La orden no admite nuevos despachos');
          const partial = order.status !== 'CONFIRMED';
          if (partial && !dto.partial) {
            throw new ConflictException('La orden no tiene todo su material reservado: confírmala o autoriza explícitamente un despacho parcial');
          }
          const locationId = order.inventoryLocationId ?? dto.inventoryLocationId;
          if (!locationId) throw new BadRequestException('Indica la ubicación de salida del despacho');
          if (dto.inventoryLocationId && order.inventoryLocationId && dto.inventoryLocationId !== order.inventoryLocationId) {
            throw new BadRequestException('El despacho sale de la ubicación en la que se reservó la orden');
          }
          const location = await tx.inventoryLocation.findUnique({ where: { id: locationId } });
          if (!location?.active) throw new BadRequestException('La ubicación no existe o está inactiva');
          await this.requireAssignee(tx, dto.assigneeId, locationId);

          const lines = await tx.salesOrderLine.findMany({
            where: { salesOrderId: orderId },
            include: { dispatchLines: { include: { dispatch: { select: { status: true } } } } },
          });
          const byId = new Map(lines.map((line) => [line.id, line]));
          const seen = new Set<string>();
          for (const input of dto.lines) {
            const line = byId.get(input.salesOrderLineId);
            if (!line) throw new BadRequestException('Un renglón no pertenece a la orden');
            if (seen.has(line.id)) throw new BadRequestException(`El renglón ${line.lineNo} está repetido`);
            seen.add(line.id);
            const authorised = line.dispatchLines.filter((dl) => dl.dispatch.status !== 'CANCELLED').reduce((total, dl) => total + dl.quantity, 0);
            if (input.quantity > line.quantity - authorised) {
              throw new BadRequestException(`Renglón ${line.lineNo}: quedan ${line.quantity - authorised} perfiles por autorizar`);
            }
          }

          // Material for each line: from the order's reservations (confirmed
          // order) or newly reserved for exactly the authorised quantities.
          const plans: { lineId: string; quantity: number; allocations: { bundleId: string; quantity: number }[] }[] = [];
          if (partial) {
            const candidates = new Set<string>();
            for (const input of dto.lines) {
              for (const bundleId of await this.reservations.candidateIds(tx, byId.get(input.salesOrderLineId)!, locationId)) candidates.add(bundleId);
            }
            await this.reservations.lockBundles(tx, [...candidates]);
            const taken = new Map<string, number>();
            const shortages: string[] = [];
            for (const input of dto.lines) {
              const line = byId.get(input.salesOrderLineId)!;
              const plan = await this.reservations.plan(tx, line, locationId, input.quantity, taken);
              if (plan.shortage > 0) shortages.push(`Renglón ${line.lineNo} (${line.referenceCode} ${line.finishCode}): faltan ${plan.shortage} perfiles`);
              for (const a of plan.allocations) taken.set(a.bundleId, (taken.get(a.bundleId) ?? 0) + a.quantity);
              plans.push({ lineId: line.id, quantity: input.quantity, allocations: plan.allocations });
            }
            if (shortages.length > 0) {
              throw new ConflictException({ statusCode: 409, message: `No hay existencias disponibles para el despacho parcial. ${shortages.join('; ')}`, shortages });
            }
          } else {
            for (const input of dto.lines) plans.push({ lineId: input.salesOrderLineId, quantity: input.quantity, allocations: [] });
          }

          const dispatch = await tx.dispatch.create({
            data: {
              number: await nextNumber(tx, 'dispatch_number_seq', 'DES'),
              salesOrderId: orderId,
              inventoryLocationId: locationId,
              assigneeId: dto.assigneeId,
              dueAt,
              partial,
              createOperationKey: dto.operationKey,
              createdById: user.id,
            },
          });
          for (const plan of plans) {
            const dispatchLine = await tx.dispatchLine.create({ data: { dispatchId: dispatch.id, salesOrderLineId: plan.lineId, quantity: plan.quantity } });
            if (partial) {
              for (const a of plan.allocations) {
                await tx.stockReservation.create({
                  data: { bundleId: a.bundleId, salesOrderLineId: plan.lineId, dispatchLineId: dispatchLine.id, quantity: a.quantity, createdById: user.id },
                });
              }
            } else {
              await this.assignOrderReservations(tx, plan.lineId, dispatchLine.id, plan.quantity);
            }
          }
          const summary = dto.lines
            .map((input) => {
              const line = byId.get(input.salesOrderLineId)!;
              return `${input.quantity} perfiles ${line.referenceCode} ${line.finishCode} (${line.origin === 'CHINA' ? 'China' : 'Nacional'})`;
            })
            .join('; ');
          await tx.task.create({
            data: {
              title: `Despacho ${dispatch.number} · orden ${order.number}`,
              description: `Preparar y confirmar la salida: ${summary}.`,
              dueAt,
              assigneeId: dto.assigneeId,
              createdById: user.id,
              kind: 'DISPATCH',
              dispatchId: dispatch.id,
            },
          });
          // Notice after the data exists, in the same transaction (outbox).
          await enqueue(tx, [{ userId: dto.assigneeId, kind: 'dispatch-assigned', dedupeKey: `dispatch-assigned:${dispatch.id}`, dispatchId: dispatch.id }]);
          await audit(tx, { entity: 'Dispatch', entityId: dispatch.id, action: partial ? 'CREATED_PARTIAL' : 'CREATED', userId: user.id, data: { orderId } });
          return dispatch.id;
        },
        { maxWait: 10000, timeout: 30000 },
      );
      return this.get(id, user);
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('Hay paquetes ocupados por otra operación; reintenta con la misma solicitud.');
      if (isUniqueViolation(error)) {
        const replay = await this.prisma.dispatch.findUnique({ where: { createOperationKey: dto.operationKey } });
        if (replay?.salesOrderId === orderId) return this.get(replay.id, user);
      }
      throw error;
    }
  }

  // Moves `quantity` of the order line's unassigned reservations to the
  // dispatch line (splitting rows when needed).
  private async assignOrderReservations(tx: Tx, salesOrderLineId: string, dispatchLineId: string, quantity: number) {
    const rows = await tx.stockReservation.findMany({
      where: { salesOrderLineId, dispatchLineId: null, status: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    let need = quantity;
    for (const row of rows) {
      if (need === 0) break;
      if (row.quantity <= need) {
        await tx.stockReservation.update({ where: { id: row.id }, data: { dispatchLineId } });
        need -= row.quantity;
      } else {
        await tx.stockReservation.update({ where: { id: row.id }, data: { quantity: row.quantity - need } });
        await tx.stockReservation.create({
          data: { bundleId: row.bundleId, salesOrderLineId, dispatchLineId, quantity: need, createdById: row.createdById },
        });
        need = 0;
      }
    }
    if (need > 0) throw new ConflictException('La orden ya no tiene reservado el material de este renglón; revisa la orden');
  }

  // --- Queries ----------------------------------------------------------------

  async list(query: DispatchQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.DispatchWhereInput = { ...this.scope(user), ...(query.status ? { status: query.status } : {}) };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.dispatch.count({ where }),
      this.prisma.dispatch.findMany({
        where,
        include: {
          salesOrder: { select: { id: true, number: true, customerName: true } },
          inventoryLocation: { select: { id: true, code: true, name: true } },
          assignee: { select: { id: true, name: true } },
          _count: { select: { incidents: { where: { status: 'OPEN' } } } },
        },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
  }

  // Requirements, progress, suggested bundles, picks and incidents. Built
  // from the order lines (never from free task text). No prices.
  async get(id: string, user: SafeUser) {
    const dispatch = await this.prisma.dispatch.findFirst({
      where: { id, ...this.scope(user) },
      include: {
        salesOrder: { select: { id: true, number: true, customerName: true, status: true, createdById: true } },
        inventoryLocation: { select: { id: true, code: true, name: true } },
        assignee: { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        confirmedBy: { select: { id: true, name: true } },
        task: { select: { id: true, dueAt: true, completedAt: true, cancelledAt: true } },
        lines: {
          include: {
            salesOrderLine: {
              select: {
                id: true,
                lineNo: true,
                referenceCode: true,
                referenceDescription: true,
                finishCode: true,
                finishDescription: true,
                origin: true,
                supplierName: true,
                quantity: true,
              },
            },
            reservations: {
              where: { status: 'ACTIVE' },
              select: {
                quantity: true,
                bundle: {
                  select: {
                    id: true,
                    epc: true,
                    quantity: true,
                    rack: { select: { number: true, aisle: { select: { number: true } } } },
                  },
                },
              },
            },
            picks: {
              select: {
                quantity: true,
                bundle: {
                  select: {
                    id: true,
                    epc: true,
                    quantity: true,
                    lot: { select: { code: true, origin: true, supplier: { select: { name: true } } } },
                    rack: { select: { number: true, aisle: { select: { number: true } } } },
                  },
                },
              },
            },
          },
        },
        incidents: { orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }], take: 50, include: { resolvedBy: { select: { id: true, name: true } } } },
        movements: { select: { id: true, quantity: true, quantityBefore: true, quantityAfter: true, occurredAt: true, bundle: { select: { epc: true, lot: { select: { code: true, origin: true, supplier: { select: { name: true } } } } } } } },
      },
    });
    if (!dispatch) throw new NotFoundException('El despacho no existe');
    const lines = dispatch.lines
      .sort((a, b) => a.salesOrderLine.lineNo - b.salesOrderLine.lineNo)
      .map((line) => {
        const prepared = line.picks.reduce((total, pick) => total + pick.quantity, 0);
        return {
          id: line.id,
          lineNo: line.salesOrderLine.lineNo,
          referenceCode: line.salesOrderLine.referenceCode,
          referenceDescription: line.salesOrderLine.referenceDescription,
          finishCode: line.salesOrderLine.finishCode,
          finishDescription: line.salesOrderLine.finishDescription,
          origin: line.salesOrderLine.origin,
          supplierRequired: line.salesOrderLine.supplierName,
          authorised: line.quantity,
          prepared,
          pending: line.quantity - prepared,
          dispatched: line.dispatchedQuantity,
          suggested: line.reservations
            .filter((r) => !line.picks.some((pick) => pick.bundle.id === r.bundle.id))
            .map((r) => ({ bundleId: r.bundle.id, epc: r.bundle.epc, quantity: r.quantity, aisle: r.bundle.rack?.aisle.number ?? null, rack: r.bundle.rack?.number ?? null })),
          picks: line.picks.map((pick) => ({
            bundleId: pick.bundle.id,
            epc: pick.bundle.epc,
            quantity: pick.quantity,
            bundleQuantity: pick.bundle.quantity,
            lot: pick.bundle.lot?.code ?? null,
            origin: pick.bundle.lot?.origin ?? null,
            supplier: pick.bundle.lot?.supplier?.name ?? null,
            aisle: pick.bundle.rack?.aisle.number ?? null,
            rack: pick.bundle.rack?.number ?? null,
          })),
        };
      });
    const { lines: _lines, salesOrder, ...rest } = dispatch;
    const openIncidents = dispatch.incidents.filter((incident) => incident.status === 'OPEN').length;
    return {
      ...rest,
      salesOrder: { id: salesOrder.id, number: salesOrder.number, customerName: salesOrder.customerName, status: salesOrder.status },
      lines,
      progress: {
        authorised: lines.reduce((t, l) => t + l.authorised, 0),
        prepared: lines.reduce((t, l) => t + l.prepared, 0),
        dispatched: lines.reduce((t, l) => t + l.dispatched, 0),
        openIncidents,
        overdue: dispatch.status === 'OPEN' && dispatch.dueAt.getTime() < Date.now(),
        readyToConfirm: dispatch.status === 'OPEN' && openIncidents === 0 && lines.every((l) => l.pending === 0),
      },
    };
  }

  // --- Scan / observe -----------------------------------------------------------

  // Validates one chip against the dispatch with the same rules for every
  // source. Records the observation (one row per chip and context, with a
  // counter) and, on mismatch, one OPEN incident per chip and kind (repeats
  // only increase its counter; one notification per incident). Handheld
  // reads prepare the bundle; fixed readers only monitor.
  async scan(id: string, epc: string, user: SafeUser | null, context: CaptureContext) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const dispatch = user
            ? await this.lockDispatch(tx, id, user)
            : await this.lockDispatchForDevice(tx, id);
          if (user) this.assertExecutor(dispatch, user);
          if (dispatch.status !== 'OPEN') throw new ConflictException('El despacho no está abierto');
          return this.scanLocked(tx, dispatch, epc, user, context);
        },
        { maxWait: 10000, timeout: 30000 },
      );
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('El despacho está ocupado por otra lectura; reintenta.');
      throw error;
    }
  }

  async lockDispatchForDevice(tx: Tx, id: string) {
    await setLockTimeout(tx);
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "dispatches" WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundException('El despacho no existe');
    return tx.dispatch.findUniqueOrThrow({ where: { id } });
  }

  async scanLocked(tx: Tx, dispatch: Dispatch, epc: string, user: SafeUser | null, context: CaptureContext) {
    const now = context.observedAt ?? new Date();
    const detections = Math.max(1, context.detections ?? 1);
    const contextKey = context.sessionId ? `session:${context.sessionId}` : `user:${context.userId ?? user?.id ?? 'unknown'}`;
    const bundle = await tx.bundle.findUnique({
      where: { epc },
      include: {
        reference: { select: { code: true } },
        finish: { select: { code: true, description: true } },
        inventoryLocation: { select: { code: true, name: true } },
        lot: { select: { origin: true, supplierId: true, supplier: { select: { name: true } } } },
      },
    });

    const record = async (result: string) => {
      const existing = await tx.readerObservation.findUnique({ where: { dispatchId_contextKey_epc: { dispatchId: dispatch.id, contextKey, epc } } });
      if (existing) {
        await tx.readerObservation.update({ where: { id: existing.id }, data: { count: { increment: detections }, lastSeenAt: now, result } });
      } else {
        await tx.readerObservation.create({
          data: {
            dispatchId: dispatch.id,
            contextKey,
            source: context.source,
            deviceId: context.deviceId ?? null,
            sessionId: context.sessionId ?? null,
            userId: context.userId ?? user?.id ?? null,
            epc,
            result,
            count: detections,
            firstSeenAt: now,
            lastSeenAt: now,
            antenna: context.antenna ?? null,
            rssi: context.rssi ?? null,
          },
        });
      }
    };

    const incident = async (kind: IncidentKind, message: string, bundleId: string | null) => {
      const open = await tx.dispatchIncident.findFirst({ where: { dispatchId: dispatch.id, epc, kind, status: 'OPEN' } });
      if (open) {
        await tx.dispatchIncident.update({ where: { id: open.id }, data: { occurrences: { increment: detections }, lastSeenAt: now } });
        return { ...open, occurrences: open.occurrences + detections, repeated: true };
      }
      const created = await tx.dispatchIncident.create({
        data: { dispatchId: dispatch.id, kind, epc, bundleId, message, source: context.source, occurrences: detections, firstSeenAt: now, lastSeenAt: now },
      });
      const supervisorId = await this.settings.get(SETTING_KEYS.dispatchSupervisorId, tx);
      await enqueue(tx, [
        { userId: dispatch.assigneeId, kind: 'dispatch-incident', dedupeKey: `dispatch-incident:${created.id}`, dispatchId: dispatch.id },
        ...(supervisorId ? [{ userId: supervisorId, kind: 'dispatch-incident' as const, dedupeKey: `dispatch-incident:${created.id}`, dispatchId: dispatch.id }] : []),
      ]);
      return { ...created, repeated: false };
    };

    if (!bundle) {
      await record('UNKNOWN_EPC');
      const created = await incident('UNKNOWN_EPC', `Chip desconocido (${epc}): no corresponde a ningún paquete registrado.`, null);
      return { result: 'INCIDENT' as const, epc, message: created.message, incident: created };
    }

    const confirmedExit = await tx.inventoryMovement.findFirst({ where: { bundleId: bundle.id, dispatchId: { not: null }, dispatch: { salesOrderId: dispatch.salesOrderId } } });
    if (confirmedExit && bundle.quantity === 0) {
      await record('ALREADY_DISPATCHED');
      const created = await incident('ALREADY_DISPATCHED', `El paquete ${epc} ya salió en un despacho confirmado de esta orden.`, bundle.id);
      return { result: 'INCIDENT' as const, epc, message: created.message, incident: created };
    }

    const existingPick = await tx.dispatchPick.findUnique({ where: { dispatchId_bundleId: { dispatchId: dispatch.id, bundleId: bundle.id } } });
    if (existingPick) {
      await record('ALREADY_PREPARED');
      return { result: 'ALREADY_PREPARED' as const, epc, message: `Paquete ya preparado (${existingPick.quantity} perfiles); la lectura repetida no suma de nuevo.`, quantity: existingPick.quantity };
    }

    const lines = await this.requirements(tx, dispatch.id);
    const location = await tx.inventoryLocation.findUniqueOrThrow({ where: { id: dispatch.inventoryLocationId }, select: { code: true, name: true } });
    const scanned: ScannedBundle = {
      id: bundle.id,
      epc: bundle.epc,
      referenceId: bundle.referenceId,
      finishId: bundle.finishId,
      referenceCode: bundle.reference.code,
      finishLabel: finishLabel(bundle.finish),
      quantity: bundle.quantity,
      inventoryLocationId: bundle.inventoryLocationId,
      locationLabel: `${bundle.inventoryLocation.code} ${bundle.inventoryLocation.name}`,
      origin: bundle.lot?.origin ?? null,
      supplierId: bundle.lot?.supplierId ?? null,
      supplierName: bundle.lot?.supplier?.name ?? null,
    };
    const match = matchBundle(scanned, lines, dispatch.inventoryLocationId, `${location.code} ${location.name}`);
    if (!match.ok) {
      if (match.kind === 'OTHER') {
        await record('LINE_COMPLETE');
        return { result: 'LINE_COMPLETE' as const, epc, message: match.message };
      }
      await record(match.kind);
      const created = await incident(match.kind, match.message, bundle.id);
      return { result: 'INCIDENT' as const, epc, message: created.message, incident: created };
    }

    // Free profiles of this bundle for this dispatch line.
    await this.reservations.lockBundles(tx, [bundle.id]);
    const free = await this.freeFor(tx, bundle.id, bundle.quantity, match.line.dispatchLineId);
    if (free <= 0) {
      await record('NOT_AVAILABLE');
      const created = await incident('NOT_AVAILABLE', `El paquete ${epc} está reservado para otra orden; no se puede usar en este despacho.`, bundle.id);
      return { result: 'INCIDENT' as const, epc, message: created.message, incident: created };
    }
    const suggested = Math.min(free, match.line.pending);
    await record('MATCH');
    if (!context.prepare) {
      return { result: 'MATCH' as const, epc, lineNo: match.line.lineNo, suggestedQuantity: suggested, message: 'Coincide con el despacho (solo monitoreo: no se prepara automáticamente).' };
    }
    await tx.dispatchPick.create({
      data: { dispatchId: dispatch.id, dispatchLineId: match.line.dispatchLineId, bundleId: bundle.id, quantity: suggested, createdById: user!.id },
    });
    await this.rebalance(tx, dispatch, match.line.dispatchLineId, user!.id);
    const partialOfBundle = suggested < bundle.quantity;
    return {
      result: 'PREPARED' as const,
      epc,
      lineNo: match.line.lineNo,
      quantity: suggested,
      message: partialOfBundle
        ? `Preparado: ${suggested} de ${bundle.quantity} perfiles del paquete (salida parcial; el resto queda en el paquete). Ajusta la cantidad si es necesario.`
        : `Preparado: paquete completo de ${suggested} perfiles.`,
    };
  }

  // Lines of the dispatch with what is still pending (authorised − picked).
  private async requirements(tx: Tx, dispatchId: string): Promise<DispatchLineRequirement[]> {
    const lines = await tx.dispatchLine.findMany({
      where: { dispatchId },
      include: {
        salesOrderLine: { include: { finish: { select: { code: true, description: true } }, supplier: { select: { name: true } } } },
        picks: { select: { quantity: true } },
      },
    });
    return lines.map((line) => ({
      dispatchLineId: line.id,
      lineNo: line.salesOrderLine.lineNo,
      referenceId: line.salesOrderLine.referenceId,
      finishId: line.salesOrderLine.finishId,
      referenceCode: line.salesOrderLine.referenceCode,
      finishLabel: finishLabel(line.salesOrderLine.finish),
      origin: line.salesOrderLine.origin,
      supplierId: line.salesOrderLine.supplierId,
      supplierName: line.salesOrderLine.supplier?.name ?? line.salesOrderLine.supplierName,
      pending: line.quantity - line.picks.reduce((total, pick) => total + pick.quantity, 0),
    }));
  }

  // Profiles of a (locked) bundle usable by a dispatch line: its quantity
  // minus ACTIVE reservations of anything else.
  private async freeFor(tx: Tx, bundleId: string, quantity: number, dispatchLineId: string) {
    const others = await tx.stockReservation.aggregate({
      where: { bundleId, status: 'ACTIVE', NOT: { dispatchLineId } },
      _sum: { quantity: true },
    });
    return quantity - (others._sum.quantity ?? 0);
  }

  // --- Preparation ------------------------------------------------------------

  // Sets the prepared quantity of a bundle (0 removes it). Explicit
  // quantities allow partial exits of a bundle.
  async setPick(id: string, bundleId: string, quantity: number, user: SafeUser) {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const dispatch = await this.lockDispatch(tx, id, user);
          this.assertExecutor(dispatch, user);
          if (dispatch.status !== 'OPEN') throw new ConflictException('El despacho no está abierto');
          const pick = await tx.dispatchPick.findUnique({ where: { dispatchId_bundleId: { dispatchId: id, bundleId } } });
          if (!pick) throw new NotFoundException('El paquete no está preparado en este despacho; léelo primero');
          if (quantity === 0) {
            await tx.dispatchPick.delete({ where: { id: pick.id } });
          } else {
            await this.reservations.lockBundles(tx, [bundleId]);
            const bundle = await tx.bundle.findUniqueOrThrow({ where: { id: bundleId } });
            if (quantity > bundle.quantity) throw new BadRequestException(`El paquete solo tiene ${bundle.quantity} perfiles`);
            const line = await tx.dispatchLine.findUniqueOrThrow({ where: { id: pick.dispatchLineId }, include: { picks: true } });
            const others = line.picks.filter((p) => p.bundleId !== bundleId).reduce((total, p) => total + p.quantity, 0);
            if (others + quantity > line.quantity) {
              throw new BadRequestException(`Supera lo autorizado para el renglón (${line.quantity} perfiles; ya preparados ${others})`);
            }
            const free = await this.freeFor(tx, bundleId, bundle.quantity, line.id);
            if (quantity > free) throw new ConflictException(`Solo ${free} perfiles de este paquete están libres para este despacho`);
            await tx.dispatchPick.update({ where: { id: pick.id }, data: { quantity } });
          }
          await this.rebalance(tx, dispatch, pick.dispatchLineId, user.id);
        },
        { maxWait: 10000, timeout: 30000 },
      );
      return this.get(id, user);
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('El despacho está ocupado; reintenta.');
      throw error;
    }
  }

  // Keeps the ACTIVE reservations of a dispatch line equal to its authorised
  // quantity and aligned with the picks: picked bundles hold exactly their
  // picked profiles, the remainder stays on previously reserved bundles or is
  // taken FIFO from free eligible stock. This is the atomic substitution of
  // bundles: no profile is ever reserved twice (locks + deferred trigger).
  private async rebalance(tx: Tx, dispatch: Dispatch, dispatchLineId: string, userId: string) {
    const line = await tx.dispatchLine.findUniqueOrThrow({ where: { id: dispatchLineId }, include: { picks: true, salesOrderLine: true } });
    const current = await tx.stockReservation.findMany({ where: { dispatchLineId, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const picks = new Map(line.picks.map((pick) => [pick.bundleId, pick.quantity]));
    const touched = new Set<string>([...picks.keys(), ...current.map((row) => row.bundleId)]);
    await this.reservations.lockBundles(tx, [...touched]);

    const target = new Map(picks);
    let remainder = line.quantity - [...picks.values()].reduce((total, q) => total + q, 0);
    const currentByBundle = new Map<string, number>();
    for (const row of current) currentByBundle.set(row.bundleId, (currentByBundle.get(row.bundleId) ?? 0) + row.quantity);
    // 1) keep previous reservations of bundles not picked
    for (const [bundleId, quantity] of currentByBundle) {
      if (remainder === 0) break;
      if (picks.has(bundleId)) continue;
      const keep = Math.min(quantity, remainder);
      target.set(bundleId, keep);
      remainder -= keep;
    }
    // 2) keep previous extra on picked bundles
    for (const [bundleId, quantity] of currentByBundle) {
      if (remainder === 0) break;
      const picked = picks.get(bundleId);
      if (picked === undefined || quantity <= picked) continue;
      const extra = Math.min(quantity - picked, remainder);
      target.set(bundleId, picked + extra);
      remainder -= extra;
    }
    // 3) take free eligible stock
    if (remainder > 0) {
      const candidates = await tx.bundle.findMany({
        where: { ...eligibleWhere(line.salesOrderLine, dispatch.inventoryLocationId), id: { notIn: [...target.keys()] } },
        select: { id: true, quantity: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      await this.reservations.lockBundles(tx, candidates.map((c) => c.id));
      for (const candidate of candidates) {
        if (remainder === 0) break;
        const free = await this.freeFor(tx, candidate.id, candidate.quantity, dispatchLineId);
        if (free <= 0) continue;
        const take = Math.min(free, remainder);
        target.set(candidate.id, take);
        remainder -= take;
      }
    }
    if (remainder > 0) {
      throw new ConflictException('No hay existencias libres para mantener reservada la cantidad autorizada de este renglón');
    }
    // Apply: rows whose quantity changes are released and replaced (history).
    const now = new Date();
    for (const bundleId of new Set([...target.keys(), ...currentByBundle.keys()])) {
      const want = target.get(bundleId) ?? 0;
      const have = currentByBundle.get(bundleId) ?? 0;
      if (want === have) continue;
      await tx.stockReservation.updateMany({ where: { dispatchLineId, bundleId, status: 'ACTIVE' }, data: { status: 'RELEASED', closedAt: now } });
      if (want > 0) {
        await tx.stockReservation.create({
          data: { bundleId, salesOrderLineId: line.salesOrderLineId, dispatchLineId, quantity: want, createdById: userId },
        });
      }
    }
  }

  // --- Confirmation -------------------------------------------------------------

  // Physical exit confirmed by the operator. In ONE transaction: final
  // validation, EXIT movements, reservations consumed, dispatched quantities,
  // task completion, order completion and persisted notices. Idempotent with
  // the operationKey; a second confirmation with another key is refused.
  async confirm(id: string, operationKey: string, user: SafeUser) {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const dispatch = await this.lockDispatch(tx, id, user);
          this.assertExecutor(dispatch, user);
          if (dispatch.status === 'CONFIRMED') {
            if (dispatch.confirmOperationKey === operationKey) return;
            throw new ConflictException('El despacho ya estaba confirmado; no se registra otra salida');
          }
          if (dispatch.status === 'CANCELLED') throw new ConflictException('El despacho está cancelado');
          const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: dispatch.salesOrderId } });
          if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada');
          const openIncidents = await tx.dispatchIncident.count({ where: { dispatchId: id, status: 'OPEN' } });
          if (openIncidents > 0) throw new ConflictException(`Hay ${openIncidents} incidencia(s) abierta(s): resuélvelas antes de confirmar la salida`);

          const lines = await tx.dispatchLine.findMany({ where: { dispatchId: id }, include: { picks: true, salesOrderLine: { include: { finish: true, supplier: true } } } });
          for (const line of lines) {
            const prepared = line.picks.reduce((total, pick) => total + pick.quantity, 0);
            if (prepared !== line.quantity) {
              throw new ConflictException(`Renglón ${line.salesOrderLine.lineNo}: preparados ${prepared} de ${line.quantity} perfiles; completa la preparación antes de confirmar`);
            }
          }
          const picks = lines.flatMap((line) => line.picks.map((pick) => ({ ...pick, line })));
          await this.reservations.lockBundles(tx, picks.map((pick) => pick.bundleId));
          const location = await tx.inventoryLocation.findUniqueOrThrow({ where: { id: dispatch.inventoryLocationId } });
          const now = new Date();
          for (const pick of picks.sort((a, b) => a.bundleId.localeCompare(b.bundleId))) {
            const bundle = await tx.bundle.findUniqueOrThrow({
              where: { id: pick.bundleId },
              include: { reference: true, finish: true, inventoryLocation: true, lot: { include: { supplier: true } } },
            });
            // Final validation with current data.
            const match = matchBundle(
              {
                id: bundle.id,
                epc: bundle.epc,
                referenceId: bundle.referenceId,
                finishId: bundle.finishId,
                referenceCode: bundle.reference.code,
                finishLabel: finishLabel(bundle.finish),
                quantity: bundle.quantity,
                inventoryLocationId: bundle.inventoryLocationId,
                locationLabel: bundle.inventoryLocation.name,
                origin: bundle.lot?.origin ?? null,
                supplierId: bundle.lot?.supplierId ?? null,
                supplierName: bundle.lot?.supplier?.name ?? null,
              },
              [
                {
                  dispatchLineId: pick.line.id,
                  lineNo: pick.line.salesOrderLine.lineNo,
                  referenceId: pick.line.salesOrderLine.referenceId,
                  finishId: pick.line.salesOrderLine.finishId,
                  referenceCode: pick.line.salesOrderLine.referenceCode,
                  finishLabel: finishLabel(pick.line.salesOrderLine.finish),
                  origin: pick.line.salesOrderLine.origin,
                  supplierId: pick.line.salesOrderLine.supplierId,
                  supplierName: pick.line.salesOrderLine.supplier?.name ?? null,
                  pending: pick.quantity,
                },
              ],
              dispatch.inventoryLocationId,
              location.name,
            );
            if (!match.ok) throw new ConflictException(`Paquete ${bundle.epc}: ${match.message}`);
            if (pick.quantity > bundle.quantity) throw new ConflictException(`El paquete ${bundle.epc} ya no tiene ${pick.quantity} perfiles`);
            const reserved = await tx.stockReservation.aggregate({ where: { dispatchLineId: pick.line.id, bundleId: bundle.id, status: 'ACTIVE' }, _sum: { quantity: true } });
            if ((reserved._sum.quantity ?? 0) !== pick.quantity) {
              throw new ConflictException(`La reserva del paquete ${bundle.epc} no coincide con lo preparado; vuelve a leerlo`);
            }
            const quantityAfter = bundle.quantity - pick.quantity;
            await tx.bundle.update({ where: { id: bundle.id }, data: { quantity: quantityAfter } });
            await tx.inventoryMovement.create({
              data: {
                bundleId: bundle.id,
                type: 'EXIT',
                quantity: pick.quantity,
                quantityBefore: bundle.quantity,
                quantityAfter,
                sourceLocationId: bundle.inventoryLocationId,
                sourceRackId: bundle.rackId,
                occurredAt: now,
                performedById: user.id,
                reason: `Despacho ${dispatch.number} · orden ${order.number}`,
                operationKey: `dispatch:${operationKey}:${bundle.id}`,
                dispatchId: id,
              },
            });
            await tx.stockReservation.updateMany({ where: { dispatchLineId: pick.line.id, bundleId: bundle.id, status: 'ACTIVE' }, data: { status: 'CONSUMED', closedAt: now } });
          }
          for (const line of lines) {
            await tx.dispatchLine.update({ where: { id: line.id }, data: { dispatchedQuantity: line.quantity } });
          }
          await tx.dispatch.update({ where: { id }, data: { status: 'CONFIRMED', confirmedAt: now, confirmedById: user.id, confirmOperationKey: operationKey } });
          await tx.task.updateMany({ where: { dispatchId: id, completedAt: null, cancelledAt: null }, data: { completedAt: now } });
          await tx.readerSession.updateMany({ where: { dispatchId: id, status: 'OPEN' }, data: { status: 'CLOSED', closedAt: now } });

          // Order completed when confirmed dispatches cover every line.
          const orderLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: order.id }, include: { dispatchLines: true } });
          const complete = orderLines.every((ol) => ol.dispatchLines.reduce((total, dl) => total + dl.dispatchedQuantity, 0) >= ol.quantity);
          if (complete) await tx.salesOrder.update({ where: { id: order.id }, data: { status: 'COMPLETED', completedAt: now } });
          await enqueue(tx, [{ userId: order.createdById, kind: 'dispatch-confirmed', dedupeKey: `dispatch-confirmed:${id}`, dispatchId: id }]);
          await audit(tx, { entity: 'Dispatch', entityId: id, action: 'CONFIRMED', userId: user.id, data: { orderCompleted: complete } });
        },
        { maxWait: 10000, timeout: 30000 },
      );
      return this.get(id, user);
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('El despacho está ocupado por otra operación; reintenta con la misma solicitud.');
      if (isUniqueViolation(error)) {
        const current = await this.prisma.dispatch.findUnique({ where: { id } });
        if (current?.confirmOperationKey === operationKey) return this.get(id, user);
      }
      throw error;
    }
  }

  // --- Cancellation, reassignment, incidents ----------------------------------

  async cancel(id: string, reason: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const dispatch = await this.lockDispatch(tx, id, user);
      if (user.role !== 'ADMIN' && user.role !== 'SALES') throw new ForbiddenException('Solo ventas o administración cancelan despachos');
      if (dispatch.status !== 'OPEN') throw new ConflictException('Solo se cancela un despacho abierto; las salidas confirmadas se conservan');
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: dispatch.salesOrderId } });
      // A fully reserved order keeps its material; a partial authorisation
      // releases what it had reserved.
      await cancelOpenDispatches(tx, { dispatchIds: [id], reason, userId: user.id, keepReservations: order.status === 'CONFIRMED' });
    });
    return this.get(id, user);
  }

  async reassign(id: string, dto: ReassignDispatchDto, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const dispatch = await this.lockDispatch(tx, id, user);
      if (user.role !== 'ADMIN' && user.role !== 'SALES') throw new ForbiddenException('Solo ventas o administración reasignan despachos');
      if (dispatch.status !== 'OPEN') throw new ConflictException('Solo se reasigna un despacho abierto');
      if (dispatch.assigneeId === dto.assigneeId) return;
      await this.requireAssignee(tx, dto.assigneeId, dispatch.inventoryLocationId);
      await tx.dispatch.update({ where: { id }, data: { assigneeId: dto.assigneeId } });
      await tx.task.updateMany({ where: { dispatchId: id }, data: { assigneeId: dto.assigneeId } });
      await audit(tx, { entity: 'Dispatch', entityId: id, action: 'REASSIGNED', userId: user.id, reason: dto.reason, data: { from: dispatch.assigneeId, to: dto.assigneeId } });
      const stamp = Date.now();
      await enqueue(tx, [
        { userId: dto.assigneeId, kind: 'dispatch-assigned', dedupeKey: `dispatch-assigned:${id}:${stamp}`, dispatchId: id },
        { userId: dispatch.assigneeId, kind: 'dispatch-reassigned', dedupeKey: `dispatch-reassigned:${id}:${stamp}`, dispatchId: id },
      ]);
    });
    return this.get(id, user);
  }

  // Resolved by ADMIN, the configured supervisor or the executor (with a
  // written resolution; audited). Resolving never counts the material.
  async resolveIncident(id: string, incidentId: string, resolution: string, user: SafeUser) {
    await this.prisma.$transaction(async (tx) => {
      const dispatch = await this.lockDispatch(tx, id, user);
      const supervisorId = await this.settings.get(SETTING_KEYS.dispatchSupervisorId, tx);
      if (user.role !== 'ADMIN' && user.id !== supervisorId) this.assertExecutor(dispatch, user);
      const incident = await tx.dispatchIncident.findFirst({ where: { id: incidentId, dispatchId: id } });
      if (!incident) throw new NotFoundException('La incidencia no existe');
      if (incident.status === 'RESOLVED') return;
      await tx.dispatchIncident.update({ where: { id: incidentId }, data: { status: 'RESOLVED', resolution, resolvedById: user.id, resolvedAt: new Date() } });
      await audit(tx, { entity: 'DispatchIncident', entityId: incidentId, action: 'RESOLVED', userId: user.id, reason: resolution });
    });
    return this.get(id, user);
  }
}
