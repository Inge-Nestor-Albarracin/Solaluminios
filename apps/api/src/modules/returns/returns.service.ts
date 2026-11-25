import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, SalesReturnStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, isLockTimeout, isUniqueViolation, nextNumber, setLockTimeout, type Tx } from '../../shared/db.js';
import { ZERO, dec, sum, type Decimal } from '../../shared/money.js';
import type { SafeUser } from '../auth/auth.types.js';
import { DEFAULT_PAGE_SIZE } from '../inventory/dto/inventory-query.dto.js';
import { enqueue } from '../notifications/outbox.js';
import { COLLECTED_LATER, CONTADO, customerCredit, day, parsePaymentDay, pesos, requireTransferEntity } from '../sales/order-payments.js';
import { ReservationsService } from '../sales/reservations.service.js';
import { SalesService } from '../sales/sales.service.js';
import type { ApproveReturnDto, CreateReturnDto, CreditNoteDto, ReasonDto, ReceiveReturnDto, RefundDto, ReturnQueryDto } from './dto/returns.dto.js';
import { REASON_LABEL, SETTLEMENT_LABEL, allocateReturn, lineShare, orderMoney, returnExcess, type ReturnSource } from './returns.js';

// Sales returns (documento DV): see SalesReturn in the schema.
//
// Who does what:
// - ADMIN: everything, on every order. Its own requests are approved at once.
// - SALES: requests, cancels and records the refund of returns of its own
//   orders; an administrator it chooses authorises them (task).
// - WAREHOUSE: receives the returns of its place (or assigned to it).
// - BILLING: records the credit note of invoiced orders.
//
// Consistency: every write locks the order row, then the return row (same
// order as payments and dispatches), then the bundles. Retries carry the
// client's operationKey (request and reception).

const APPROVAL_HOURS = 24;
const RECEPTION_HOURS = 48;
const CREDIT_NOTE_HOURS = 24;

const STATUS_TEXT: Record<SalesReturnStatus, string> = {
  REQUESTED: 'pendiente de autorización',
  APPROVED: 'autorizada y por recibir',
  RECEIVED: 'recibida',
  REJECTED: 'rechazada',
  CANCELLED: 'cancelada',
};

// Returns that hold profiles of their order lines (rejected and cancelled
// ones free them).
const ACTIVE: SalesReturnStatus[] = ['REQUESTED', 'APPROVED', 'RECEIVED'];

const person = { select: { id: true, name: true } } as const;

const hours = (count: number) => new Date(Date.now() + count * 3_600_000);
const lineBase = (line: { lineSubtotal: Decimal; discountAmount: Decimal; globalDiscountAmount: Decimal }) =>
  line.lineSubtotal.minus(line.discountAmount).minus(line.globalDiscountAmount);
const profiles = (count: number) => `${count} ${count === 1 ? 'perfil' : 'perfiles'}`;

interface SourceRow extends ReturnSource {
  epc: string;
  closed: boolean;
  here: boolean;
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
    private readonly reservations: ReservationsService,
  ) {}

  // --- Who sees what -------------------------------------------------------------

  private scope(user: SafeUser): Prisma.SalesReturnWhereInput {
    switch (user.role) {
      case 'ADMIN':
        return {};
      case 'SALES':
        return { salesOrder: { createdById: user.id } };
      case 'WAREHOUSE':
        return {
          status: { in: ['APPROVED', 'RECEIVED'] },
          OR: [{ receiverId: user.id }, ...(user.defaultInventoryLocationId ? [{ inventoryLocationId: user.defaultInventoryLocationId }] : [])],
        };
      case 'BILLING':
        return { status: 'RECEIVED', salesOrder: { requiresBilling: true } };
      default:
        return { id: '' };
    }
  }

  // --- Reading -------------------------------------------------------------------

  // What each line of an order can still return: delivered (confirmed
  // dispatches) minus what active returns hold. Also the place it is received
  // and the customer's saldo a favor. For the «Registrar devolución» form.
  async returnable(orderId: string, user: SafeUser) {
    const order = await this.prisma.salesOrder.findFirst({
      where: { id: orderId, ...this.sales.orderScope(user) },
      include: { lines: { orderBy: { lineNo: 'asc' } }, customer: { select: { id: true, name: true } } },
    });
    if (!order) throw new NotFoundException('La orden no existe');
    const ids = order.lines.map((line) => line.id);
    const state = await this.lineState(this.prisma, ids);
    const locations = [...new Set([...state.values()].flatMap((s) => s.locations))];
    const location = locations.length === 1 ? await this.prisma.inventoryLocation.findUnique({ where: { id: locations[0] }, select: { id: true, code: true, name: true } }) : null;
    return {
      order: { id: order.id, number: order.number, status: order.status, customer: order.customer, billed: order.billedAt !== null, invoiceNumber: order.invoiceNumber },
      location,
      problem:
        order.status === 'CANCELLED'
          ? 'La orden está cancelada: no recibe devoluciones.'
          : locations.length > 1
            ? 'El material de esta orden salió de varias ubicaciones: por ahora una devolución se recibe en una sola. Pide ayuda al administrador.'
            : null,
      lines: order.lines.map((line) => {
        const s = state.get(line.id)!;
        return {
          id: line.id,
          lineNo: line.lineNo,
          referenceCode: line.referenceCode,
          referenceDescription: line.referenceDescription,
          finishCode: line.finishCode,
          finishDescription: line.finishDescription,
          origin: line.origin,
          quantity: line.quantity,
          delivered: s.delivered,
          returned: s.received,
          inProcess: s.inProcess,
          returnable: Math.max(0, s.delivered - s.received - s.inProcess),
          // Value of one profile with tax (indicative; the return computes it exactly).
          unitValue: line.quantity > 0 ? line.lineTotal.dividedBy(line.quantity).toFixed(2) : '0.00',
          // To estimate like the return does (see lineShare): the line total
          // and what received returns already took from it.
          lineTotal: line.lineTotal.toFixed(2),
          returnedAmount: s.receivedAmount.toFixed(2),
        };
      }),
      customerCredit: (await customerCredit(this.prisma, order.customerId)).toFixed(2),
    };
  }

  // Delivered and returned profiles of order lines, and the places they left from.
  private async lineState(client: Tx | PrismaService, lineIds: string[]) {
    const [dispatched, held] = [
      await client.dispatchLine.findMany({
        where: { salesOrderLineId: { in: lineIds }, dispatch: { status: 'CONFIRMED' } },
        select: { salesOrderLineId: true, dispatchedQuantity: true, dispatch: { select: { inventoryLocationId: true } } },
      }),
      await client.salesReturnLine.findMany({
        where: { salesOrderLineId: { in: lineIds }, salesReturn: { status: { in: ACTIVE } } },
        select: {
          salesOrderLineId: true,
          quantity: true,
          goodQuantity: true,
          damagedQuantity: true,
          amount: true,
          baseAmount: true,
          salesReturn: { select: { status: true } },
        },
      }),
    ];
    const state = new Map(
      lineIds.map((id) => [id, { delivered: 0, received: 0, inProcess: 0, locations: [] as string[], receivedAmount: ZERO, receivedBase: ZERO }]),
    );
    for (const row of dispatched) {
      const s = state.get(row.salesOrderLineId)!;
      s.delivered += row.dispatchedQuantity;
      if (row.dispatchedQuantity > 0 && !s.locations.includes(row.dispatch.inventoryLocationId)) s.locations.push(row.dispatch.inventoryLocationId);
    }
    for (const row of held) {
      const s = state.get(row.salesOrderLineId)!;
      if (row.salesReturn.status === 'RECEIVED') {
        s.received += (row.goodQuantity ?? 0) + (row.damagedQuantity ?? 0);
        s.receivedAmount = s.receivedAmount.plus(dec(row.amount));
        s.receivedBase = s.receivedBase.plus(dec(row.baseAmount));
      } else {
        s.inProcess += row.quantity;
      }
    }
    return state;
  }

  // Bundles each order line left from (confirmed dispatches), with what
  // already came back into each from received returns.
  private async sources(client: Tx | PrismaService, orderLineIds: string[], locationId: string) {
    const picks = await client.dispatchPick.findMany({
      where: { dispatch: { status: 'CONFIRMED', inventoryLocationId: locationId }, dispatchLine: { salesOrderLineId: { in: orderLineIds } } },
      select: {
        quantity: true,
        bundle: { select: { id: true, epc: true, openedAt: true, inventoryLocationId: true } },
        dispatchLine: { select: { salesOrderLineId: true } },
        dispatch: { select: { confirmedAt: true } },
      },
    });
    const back = await client.inventoryMovement.findMany({
      where: { type: 'RETURN', salesReturnLine: { salesOrderLineId: { in: orderLineIds } } },
      select: { bundleId: true, quantity: true, salesReturnLine: { select: { salesOrderLineId: true } } },
    });
    const byLine = new Map<string, Map<string, SourceRow>>(orderLineIds.map((id) => [id, new Map()]));
    for (const pick of picks) {
      const rows = byLine.get(pick.dispatchLine.salesOrderLineId)!;
      const leftAt = pick.dispatch.confirmedAt ?? new Date(0);
      const row = rows.get(pick.bundle.id) ?? {
        bundleId: pick.bundle.id,
        epc: pick.bundle.epc,
        closed: pick.bundle.openedAt === null,
        here: pick.bundle.inventoryLocationId === locationId,
        picked: 0,
        returned: 0,
        leftAt,
      };
      row.picked += pick.quantity;
      if (leftAt > row.leftAt) row.leftAt = leftAt;
      rows.set(pick.bundle.id, row);
    }
    for (const movement of back) {
      const row = byLine.get(movement.salesReturnLine!.salesOrderLineId)?.get(movement.bundleId);
      if (row) row.returned += movement.quantity;
    }
    return byLine;
  }

  async list(query: ReturnQueryDto, user: SafeUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const where: Prisma.SalesReturnWhereInput = { AND: [this.scope(user), query.status ? { status: query.status } : {}] };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.salesReturn.count({ where }),
      this.prisma.salesReturn.findMany({
        where,
        include: {
          salesOrder: { select: { id: true, number: true, customerName: true } },
          inventoryLocation: { select: { id: true, name: true } },
          requestedBy: person,
          _count: { select: { lines: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const money = user.role !== 'WAREHOUSE';
    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: items.map((item) => ({
        id: item.id,
        number: item.number,
        status: item.status,
        reason: item.reason,
        settlement: item.settlement,
        createdAt: item.createdAt,
        receivedAt: item.receivedAt,
        order: item.salesOrder,
        location: item.inventoryLocation,
        requestedBy: item.requestedBy,
        lines: item._count.lines,
        amount: money ? (item.amount?.toFixed(2) ?? null) : null,
        refundPending: item.status === 'RECEIVED' && item.settlement === 'REFUND' && dec(item.settledAmount).gt(ZERO) && !item.refundedAt,
      })),
    };
  }

  async get(id: string, user: SafeUser) {
    const item = await this.prisma.salesReturn.findFirst({
      where: { id, ...this.scope(user) },
      include: {
        salesOrder: {
          select: {
            id: true,
            number: true,
            status: true,
            total: true,
            customerName: true,
            customerId: true,
            createdById: true,
            paymentMethod: true,
            requiresBilling: true,
            billedAt: true,
            invoiceNumber: true,
          },
        },
        inventoryLocation: { select: { id: true, code: true, name: true } },
        requestedBy: person,
        approver: person,
        decidedBy: person,
        receiver: person,
        receivedBy: person,
        refundedBy: person,
        creditNoteBy: person,
        cancelledBy: person,
        refundTransferEntity: { select: { id: true, name: true } },
        lines: {
          orderBy: { salesOrderLine: { lineNo: 'asc' } },
          include: {
            salesOrderLine: true,
            movements: { orderBy: { occurredAt: 'asc' }, select: { id: true, quantity: true, reason: true, bundle: { select: { id: true, epc: true } } } },
          },
        },
      },
    });
    if (!item) throw new NotFoundException('La devolución no existe');
    const money = user.role !== 'WAREHOUSE';
    const orderLineIds = item.lines.map((line) => line.salesOrderLineId);
    // Before reception: what it would be worth, and the bundles it left from
    // (to read the chip of those that come back closed).
    const state = item.status === 'RECEIVED' ? null : await this.lineState(this.prisma, orderLineIds);
    const sources = item.status === 'APPROVED' && user.role !== 'BILLING' ? await this.sources(this.prisma, orderLineIds, item.inventoryLocationId) : null;
    const lines = item.lines.map((line) => {
      const ol = line.salesOrderLine;
      const s = state?.get(ol.id);
      const estimate = s
        ? lineShare({ quantity: ol.quantity, lineTotal: ol.lineTotal, base: lineBase(ol) }, line.quantity, { count: s.received, amount: s.receivedAmount, base: s.receivedBase })
        : null;
      return {
        id: line.id,
        salesOrderLineId: ol.id,
        lineNo: ol.lineNo,
        referenceCode: ol.referenceCode,
        referenceDescription: ol.referenceDescription,
        finishCode: ol.finishCode,
        finishDescription: ol.finishDescription,
        origin: ol.origin,
        orderedQuantity: ol.quantity,
        quantity: line.quantity,
        goodQuantity: line.goodQuantity,
        damagedQuantity: line.damagedQuantity,
        ...(money
          ? {
              amount: line.amount?.toFixed(2) ?? null,
              baseAmount: line.baseAmount?.toFixed(2) ?? null,
              estimatedAmount: estimate?.amount.toFixed(2) ?? null,
            }
          : {}),
        movements: line.movements.map((m) => ({ id: m.id, quantity: m.quantity, epc: m.bundle.epc, bundleId: m.bundle.id, closed: m.reason?.includes('cerrado') ?? false })),
        sources: sources
          ? [...(sources.get(ol.id)?.values() ?? [])]
              .filter((row) => row.here)
              .map((row) => ({ bundleId: row.bundleId, epc: row.epc, picked: row.picked, returned: row.returned, closed: row.closed }))
          : undefined,
      };
    });
    const { salesOrder: order } = item;
    return {
      id: item.id,
      number: item.number,
      status: item.status,
      reason: item.reason,
      reasonLabel: REASON_LABEL[item.reason],
      settlement: item.settlement,
      settlementLabel: SETTLEMENT_LABEL[item.settlement],
      notes: item.notes,
      createdAt: item.createdAt,
      order: {
        id: order.id,
        number: order.number,
        status: order.status,
        customerName: order.customerName,
        customerId: order.customerId,
        billed: order.billedAt !== null,
        invoiceNumber: order.invoiceNumber,
        ...(money ? { total: order.total.toFixed(2) } : {}),
      },
      location: item.inventoryLocation,
      requestedBy: item.requestedBy,
      approver: item.approver,
      decidedBy: item.decidedBy,
      decidedAt: item.decidedAt,
      decisionNote: item.decisionNote,
      receiver: item.receiver,
      receivedBy: item.receivedBy,
      receivedAt: item.receivedAt,
      receptionNote: item.receptionNote,
      cancelledBy: item.cancelledBy,
      cancelledAt: item.cancelledAt,
      cancelReason: item.cancelReason,
      ...(money
        ? {
            amount: item.amount?.toFixed(2) ?? null,
            baseAmount: item.baseAmount?.toFixed(2) ?? null,
            settledAmount: item.settledAmount?.toFixed(2) ?? null,
            estimatedAmount: state ? sum(lines.map((l) => dec(l.estimatedAmount))).toFixed(2) : null,
            refund: item.refundedAt
              ? {
                  medium: item.refundMedium,
                  transferEntity: item.refundTransferEntity,
                  refundedOn: item.refundedOn ? day(item.refundedOn) : null,
                  note: item.refundNote,
                  at: item.refundedAt,
                  by: item.refundedBy,
                }
              : null,
            refundPending: item.status === 'RECEIVED' && item.settlement === 'REFUND' && dec(item.settledAmount).gt(ZERO) && !item.refundedAt,
          }
        : {}),
      creditNote: item.creditNoteAt ? { number: item.creditNoteNumber, at: item.creditNoteAt, by: item.creditNoteBy } : null,
      creditNotePending: item.status === 'RECEIVED' && order.billedAt !== null && !item.creditNoteAt,
      lines,
    };
  }

  // --- Request ---------------------------------------------------------------------

  async create(orderId: string, dto: CreateReturnDto, user: SafeUser) {
    let id: string;
    try {
      id = await this.prisma.$transaction(
        async (tx) => {
          const order = await this.sales.lockOrder(tx, orderId, user);
          const replay = await tx.salesReturn.findUnique({ where: { createOperationKey: dto.operationKey } });
          if (replay) {
            if (replay.salesOrderId !== orderId) throw new ConflictException('La clave de operación ya se usó con otra orden');
            return replay.id;
          }
          if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada: no recibe devoluciones');
          const ids = dto.lines.map((line) => line.salesOrderLineId);
          if (new Set(ids).size !== ids.length) throw new BadRequestException('Un renglón está repetido en la devolución');
          const orderLines = await tx.salesOrderLine.findMany({ where: { salesOrderId: orderId, id: { in: ids } } });
          if (orderLines.length !== ids.length) throw new BadRequestException('Un renglón no pertenece a la orden');
          const state = await this.lineState(tx, ids);
          const locations = new Set<string>();
          let estimate = ZERO;
          for (const requested of dto.lines) {
            const line = orderLines.find((l) => l.id === requested.salesOrderLineId)!;
            const s = state.get(line.id)!;
            const available = s.delivered - s.received - s.inProcess;
            if (requested.quantity > available) {
              throw new BadRequestException(
                s.delivered === 0
                  ? `Renglón ${line.lineNo} (${line.referenceCode}): no tiene perfiles entregados por devolver`
                  : `Renglón ${line.lineNo} (${line.referenceCode}): se pueden devolver hasta ${profiles(Math.max(0, available))} (entregados ${s.delivered}, ya devueltos ${s.received}, en trámite ${s.inProcess})`,
              );
            }
            for (const location of s.locations) locations.add(location);
            estimate = estimate.plus(
              lineShare({ quantity: line.quantity, lineTotal: line.lineTotal, base: lineBase(line) }, requested.quantity, { count: s.received, amount: s.receivedAmount, base: s.receivedBase }).amount,
            );
          }
          if (locations.size !== 1) {
            throw new BadRequestException('Estos renglones salieron de varias ubicaciones: registra una devolución por cada ubicación');
          }
          const [inventoryLocationId] = [...locations];
          const admin = user.role === 'ADMIN';
          let approverId: string | null = null;
          if (!admin) {
            if (!dto.approverId) throw new BadRequestException('Elige el administrador que autoriza la devolución');
            const approver = await tx.user.findUnique({ where: { id: dto.approverId }, select: { active: true, role: true } });
            if (!approver?.active || approver.role !== 'ADMIN') throw new BadRequestException('Quien autoriza debe ser un administrador activo');
            approverId = dto.approverId;
          }
          const now = new Date();
          const receiver = admin ? await this.nextReceiver(tx, inventoryLocationId) : null;
          const created = await tx.salesReturn.create({
            data: {
              number: await nextNumber(tx, 'sales_return_number_seq', 'DV'),
              salesOrderId: orderId,
              customerId: order.customerId,
              inventoryLocationId,
              status: admin ? 'APPROVED' : 'REQUESTED',
              reason: dto.reason,
              settlement: dto.settlement,
              notes: dto.notes || null,
              createOperationKey: dto.operationKey,
              requestedById: user.id,
              approverId,
              ...(admin ? { decidedById: user.id, decidedAt: now, receiverId: receiver!.id } : {}),
              lines: { create: dto.lines.map((line) => ({ salesOrderLineId: line.salesOrderLineId, quantity: line.quantity })) },
            },
          });
          const count = dto.lines.reduce((total, line) => total + line.quantity, 0);
          await audit(tx, {
            entity: 'SalesReturn',
            entityId: created.id,
            action: 'REQUESTED',
            userId: user.id,
            data: { orderId, number: created.number, reason: dto.reason, settlement: dto.settlement, lines: dto.lines.map((l) => ({ salesOrderLineId: l.salesOrderLineId, quantity: l.quantity })), estimate: estimate.toFixed(2) },
          });
          if (admin) {
            await audit(tx, { entity: 'SalesReturn', entityId: created.id, action: 'APPROVED', userId: user.id, data: { byRequester: true } });
            await this.openReception(tx, { ...created, receiverId: receiver!.id }, order, count, receiver!.fallback, user);
          } else {
            await tx.task.create({
              data: {
                kind: 'RETURN_APPROVAL',
                salesReturnId: created.id,
                title: `Autorizar devolución ${created.number} · ${order.number}`,
                description:
                  `${user.name} pide devolver ${profiles(count)} de ${order.customerName} (unos ${pesos(estimate)}). ` +
                  `Motivo: ${REASON_LABEL[dto.reason]}. Dinero: ${SETTLEMENT_LABEL[dto.settlement].toLowerCase()}.` +
                  (dto.notes ? ` Nota: ${dto.notes}` : ''),
                dueAt: hours(APPROVAL_HOURS),
                assigneeId: approverId!,
                createdById: user.id,
              },
            });
            await enqueue(tx, [{ userId: approverId!, kind: 'return-requested', dedupeKey: `return-requested:${created.id}` }]);
          }
          return created.id;
        },
        { maxWait: 10000, timeout: 20000 },
      );
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('La orden está ocupada con otra operación; intenta de nuevo en unos segundos.');
      if (isUniqueViolation(error)) {
        // The same key arrived at the same time: the same order returns the
        // saved return; another order is a client error, never a 500.
        const saved = await this.prisma.salesReturn.findUnique({ where: { createOperationKey: dto.operationKey } });
        if (saved?.salesOrderId === orderId) return this.get(saved.id, user);
        if (saved) throw new ConflictException('La clave de operación ya se usó con otra orden');
      }
      throw error;
    }
    return this.get(id, user);
  }

  // Warehouse staff of the place in turn; without staff, the oldest active
  // administrator (with a note in the task).
  private async nextReceiver(tx: Tx, locationId: string): Promise<{ id: string; fallback: boolean }> {
    const staff = await tx.user.findMany({
      where: { active: true, role: 'WAREHOUSE', defaultInventoryLocationId: locationId },
      select: { id: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    if (staff.length > 0) {
      const last = await tx.task.findFirst({
        where: { kind: 'RETURN_RECEPTION', salesReturn: { inventoryLocationId: locationId } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { assigneeId: true },
      });
      const index = last ? staff.findIndex((s) => s.id === last.assigneeId) : -1;
      return { id: staff[(index + 1) % staff.length].id, fallback: false };
    }
    const admin = await tx.user.findFirst({ where: { active: true, role: 'ADMIN' }, select: { id: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    if (!admin) throw new ConflictException('No hay bodegueros de esa ubicación ni un administrador activo para recibir la devolución');
    return { id: admin.id, fallback: true };
  }

  private async openReception(
    tx: Tx,
    item: { id: string; number: string; receiverId: string; requestedById: string },
    order: { number: string; customerName: string },
    count: number,
    fallback: boolean,
    user: SafeUser,
  ) {
    await tx.task.create({
      data: {
        kind: 'RETURN_RECEPTION',
        salesReturnId: item.id,
        title: `Recibir devolución ${item.number} · ${order.number}`,
        description:
          `${order.customerName} devuelve ${profiles(count)}. Cuenta lo que llega (en buen estado o dañado) y lee el chip de los paquetes que vuelvan cerrados.` +
          (fallback ? ' (No hay bodegueros asignados a esa ubicación: la recibe un administrador.)' : ''),
        dueAt: hours(RECEPTION_HOURS),
        assigneeId: item.receiverId,
        createdById: user.id,
      },
    });
    await enqueue(tx, [{ userId: item.receiverId, kind: 'return-to-receive', dedupeKey: `return-to-receive:${item.id}` }]);
  }

  // Order row first, then the return (the same order as every other write on
  // an order). The scope is checked after locking.
  private async lockReturn(tx: Tx, id: string, user: SafeUser) {
    await setLockTimeout(tx);
    const head = await tx.salesReturn.findUnique({ where: { id }, select: { salesOrderId: true } });
    if (!head) throw new NotFoundException('La devolución no existe');
    await tx.$queryRaw`SELECT id FROM "sales_orders" WHERE id = ${head.salesOrderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "sales_returns" WHERE id = ${id} FOR UPDATE`;
    const item = await tx.salesReturn.findFirst({ where: { id, ...this.scope(user) } });
    if (!item) throw new NotFoundException('La devolución no existe');
    return item;
  }

  private async run(work: (tx: Tx) => Promise<void>, timeout = 20000) {
    try {
      await this.prisma.$transaction(work, { maxWait: 10000, timeout });
    } catch (error) {
      if (isLockTimeout(error)) throw new RetryableException('La devolución está ocupada con otra operación; intenta de nuevo en unos segundos.');
      // An operation key already used elsewhere (e.g. by another return):
      // nothing was applied (the transaction rolled back).
      if (isUniqueViolation(error)) throw new ConflictException('La clave de operación ya se usó en otra operación; vuelve a intentarlo desde la pantalla');
      throw error;
    }
  }

  // --- Decision --------------------------------------------------------------------

  async approve(id: string, dto: ApproveReturnDto, user: SafeUser) {
    await this.run(async (tx) => {
      const item = await this.lockReturn(tx, id, user);
      if (item.status === 'APPROVED' || item.status === 'RECEIVED') return;
      if (item.status !== 'REQUESTED') throw new ConflictException(`La devolución está ${STATUS_TEXT[item.status]}`);
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: item.salesOrderId } });
      if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada: cancela la devolución');
      const receiver = await this.nextReceiver(tx, item.inventoryLocationId);
      const now = new Date();
      await tx.salesReturn.update({
        where: { id },
        data: { status: 'APPROVED', decidedById: user.id, decidedAt: now, decisionNote: dto.note || null, receiverId: receiver.id },
      });
      await tx.task.updateMany({ where: { salesReturnId: id, kind: 'RETURN_APPROVAL', completedAt: null }, data: { completedAt: now, cancelledAt: null } });
      const lines = await tx.salesReturnLine.findMany({ where: { salesReturnId: id }, select: { quantity: true } });
      await this.openReception(tx, { ...item, receiverId: receiver.id }, order, lines.reduce((t, l) => t + l.quantity, 0), receiver.fallback, user);
      await enqueue(tx, [{ userId: item.requestedById, kind: 'return-approved', dedupeKey: `return-approved:${id}` }]);
      await audit(tx, { entity: 'SalesReturn', entityId: id, action: 'APPROVED', userId: user.id, reason: dto.note || null });
    });
    return this.get(id, user);
  }

  async reject(id: string, dto: ReasonDto, user: SafeUser) {
    await this.run(async (tx) => {
      const item = await this.lockReturn(tx, id, user);
      if (item.status === 'REJECTED') return;
      if (item.status !== 'REQUESTED') throw new ConflictException(`La devolución está ${STATUS_TEXT[item.status]}: ya no se rechaza`);
      const now = new Date();
      await tx.salesReturn.update({ where: { id }, data: { status: 'REJECTED', decidedById: user.id, decidedAt: now, decisionNote: dto.reason } });
      await tx.task.updateMany({ where: { salesReturnId: id, kind: 'RETURN_APPROVAL', completedAt: null }, data: { completedAt: now, cancelledAt: null } });
      await enqueue(tx, [{ userId: item.requestedById, kind: 'return-rejected', dedupeKey: `return-rejected:${id}` }]);
      await audit(tx, { entity: 'SalesReturn', entityId: id, action: 'REJECTED', userId: user.id, reason: dto.reason });
    });
    return this.get(id, user);
  }

  // Before reception only (a received return is final).
  async cancel(id: string, dto: ReasonDto, user: SafeUser) {
    await this.run(async (tx) => {
      const item = await this.lockReturn(tx, id, user);
      if (item.status === 'CANCELLED') return;
      if (item.status !== 'REQUESTED' && item.status !== 'APPROVED') {
        throw new ConflictException(`La devolución está ${STATUS_TEXT[item.status]}: ya no se cancela`);
      }
      const now = new Date();
      const open = await tx.task.findMany({ where: { salesReturnId: id, completedAt: null, cancelledAt: null }, select: { id: true, assigneeId: true } });
      await tx.task.updateMany({ where: { id: { in: open.map((t) => t.id) } }, data: { cancelledAt: now } });
      await tx.salesReturn.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now, cancelledById: user.id, cancelReason: dto.reason } });
      await enqueue(
        tx,
        [...open.map((t) => t.assigneeId), item.requestedById]
          .filter((userId) => userId !== user.id)
          .map((userId) => ({ userId, kind: 'return-cancelled' as const, dedupeKey: `return-cancelled:${id}` })),
      );
      await audit(tx, { entity: 'SalesReturn', entityId: id, action: 'CANCELLED', userId: user.id, reason: dto.reason });
    });
    return this.get(id, user);
  }

  // --- Reception -------------------------------------------------------------------

  // The warehouse counts what came back. Good profiles go back to the bundles
  // they left from (closed ones read by chip come back closed; the rest as
  // loose profiles). Damaged ones are recorded but never enter the stock.
  // Then the value, the money (balance, saldo a favor or reintegro) and, if
  // the order was invoiced, the credit note task.
  async receive(id: string, dto: ReceiveReturnDto, user: SafeUser) {
    await this.run(async (tx) => {
      const item = await this.lockReturn(tx, id, user);
      if (item.status === 'RECEIVED') {
        if (item.receiveOperationKey === dto.operationKey) return;
        throw new ConflictException('La devolución ya fue recibida');
      }
      if (item.status !== 'APPROVED') throw new ConflictException(`La devolución está ${STATUS_TEXT[item.status]}: no se recibe`);
      const keyUsed = await tx.salesReturn.findFirst({ where: { receiveOperationKey: dto.operationKey, id: { not: id } }, select: { number: true } });
      if (keyUsed) throw new ConflictException(`La clave de operación ya se usó para recibir la devolución ${keyUsed.number}`);
      const lines = await tx.salesReturnLine.findMany({ where: { salesReturnId: id }, include: { salesOrderLine: true } });
      const counts = new Map(dto.lines.map((l) => [l.lineId, l]));
      if (counts.size !== dto.lines.length || counts.size !== lines.length || lines.some((l) => !counts.has(l.id))) {
        throw new BadRequestException('Indica lo recibido en cada renglón de la devolución, una sola vez');
      }
      let received = 0;
      for (const line of lines) {
        const c = counts.get(line.id)!;
        if (c.good + c.damaged > line.quantity) {
          throw new BadRequestException(
            `Renglón ${line.salesOrderLine.lineNo} (${line.salesOrderLine.referenceCode}): llegaron ${c.good + c.damaged} y la devolución es de ${line.quantity}. Si trajeron más, registra otra devolución`,
          );
        }
        received += c.good + c.damaged;
      }
      if (received === 0) throw new BadRequestException('No se recibió nada: si el cliente no trajo el material, cancela la devolución');

      // Where each line goes back to.
      const orderLineIds = lines.map((l) => l.salesOrderLineId);
      const sources = await this.sources(tx, orderLineIds, item.inventoryLocationId);
      const location = await tx.inventoryLocation.findUniqueOrThrow({ where: { id: item.inventoryLocationId } });
      const plan: { lineId: string; bundleId: string; quantity: number; closed: boolean }[] = [];
      const sealed = new Map<string, number>();
      const seen = new Set<string>();
      for (const epc of dto.sealedEpcs ?? []) {
        if (seen.has(epc)) throw new BadRequestException(`El chip ${epc} está repetido`);
        seen.add(epc);
        const line = lines.find((l) => [...(sources.get(l.salesOrderLineId)?.values() ?? [])].some((s) => s.epc === epc));
        const source = line ? [...sources.get(line.salesOrderLineId)!.values()].find((s) => s.epc === epc)! : null;
        if (!line || !source) throw new BadRequestException(`El paquete ${epc} no salió en esta orden desde ${location.name}`);
        if (!source.here) throw new BadRequestException(`El paquete ${epc} ya no figura en ${location.name}: recíbelo como perfiles sueltos`);
        if (!source.closed || source.returned > 0) {
          throw new BadRequestException(`El paquete ${epc} salió abierto o ya volvió una parte: recibe sus perfiles como sueltos, sin leer el chip`);
        }
        plan.push({ lineId: line.id, bundleId: source.bundleId, quantity: source.picked, closed: true });
        sealed.set(line.id, (sealed.get(line.id) ?? 0) + source.picked);
        source.returned = source.picked; // nothing loose goes into it
      }
      for (const line of lines) {
        const good = counts.get(line.id)!.good;
        const closed = sealed.get(line.id) ?? 0;
        if (closed > good) {
          throw new BadRequestException(
            `Renglón ${line.salesOrderLine.lineNo}: los paquetes cerrados leídos suman ${profiles(closed)}, más que los ${good} en buen estado`,
          );
        }
        const loose = good - closed;
        if (loose === 0) continue;
        const candidates = [...(sources.get(line.salesOrderLineId)?.values() ?? [])].filter((s) => s.here);
        const allocation = allocateReturn(candidates, loose);
        if (!allocation) {
          throw new ConflictException(
            `Renglón ${line.salesOrderLine.lineNo}: no se encontró en ${location.name} de qué paquetes salieron ${profiles(loose)}. Pide ayuda al administrador`,
          );
        }
        for (const a of allocation) plan.push({ lineId: line.id, bundleId: a.bundleId, quantity: a.quantity, closed: false });
      }

      // Stock: RETURN movements into those bundles.
      const now = new Date();
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: item.salesOrderId } });
      await this.reservations.lockBundles(tx, [...new Set(plan.map((p) => p.bundleId))]);
      for (const step of [...plan].sort((a, b) => a.bundleId.localeCompare(b.bundleId) || a.lineId.localeCompare(b.lineId))) {
        const bundle = await tx.bundle.findUniqueOrThrow({ where: { id: step.bundleId } });
        if (bundle.inventoryLocationId !== item.inventoryLocationId) {
          throw new ConflictException(`El paquete ${bundle.epc} cambió de ubicación; vuelve a intentarlo`);
        }
        if (step.closed && bundle.openedAt) throw new ConflictException(`El paquete ${bundle.epc} ya está abierto: recibe sus perfiles como sueltos`);
        // Loose profiles back into a closed bundle: from now on it is open.
        if (!step.closed && !bundle.openedAt) {
          await tx.bundle.update({ where: { id: bundle.id }, data: { openedAt: now, openedById: user.id } });
        }
        const quantityAfter = bundle.quantity + step.quantity;
        await tx.bundle.update({ where: { id: bundle.id }, data: { quantity: quantityAfter } });
        await tx.inventoryMovement.create({
          data: {
            bundleId: bundle.id,
            type: 'RETURN',
            quantity: step.quantity,
            quantityBefore: bundle.quantity,
            quantityAfter,
            destinationLocationId: bundle.inventoryLocationId,
            destinationRackId: step.closed ? bundle.rackId : null,
            occurredAt: now,
            performedById: user.id,
            reason: `Devolución ${item.number} · orden ${order.number} (${step.closed ? 'paquete cerrado' : 'perfiles sueltos'})`,
            operationKey: `return:${dto.operationKey}:${step.lineId}:${bundle.id}`,
            salesReturnLineId: step.lineId,
          },
        });
      }

      // Value of what came back, proportional to each order line.
      const state = await this.lineState(tx, orderLineIds);
      let amount = ZERO;
      let base = ZERO;
      for (const line of lines) {
        const c = counts.get(line.id)!;
        const s = state.get(line.salesOrderLineId)!;
        const ol = line.salesOrderLine;
        const share = lineShare({ quantity: ol.quantity, lineTotal: ol.lineTotal, base: lineBase(ol) }, c.good + c.damaged, {
          count: s.received,
          amount: s.receivedAmount,
          base: s.receivedBase,
        });
        await tx.salesReturnLine.update({
          where: { id: line.id },
          data: { goodQuantity: c.good, damagedQuantity: c.damaged, amount: share.amount, baseAmount: share.base },
        });
        amount = amount.plus(share.amount);
        base = base.plus(share.base);
      }

      // Money: first lowers what the customer owed; the excess goes back.
      const payments = await tx.salesOrderPayment.findMany({ where: { salesOrderId: order.id }, select: { amount: true } });
      // Orders from before payments were recorded: contado (or marked paid)
      // was paid in full; otherwise nothing is known to be paid.
      const paid =
        payments.length > 0
          ? sum(payments.map((p) => p.amount))
          : order.paymentMethod && (CONTADO.includes(order.paymentMethod) || order.paymentStatus === 'PAID')
            ? order.total
            : ZERO;
      const before = await tx.salesReturn.aggregate({ where: { salesOrderId: order.id, status: 'RECEIVED' }, _sum: { amount: true, settledAmount: true } });
      const returned = dec(before._sum.amount);
      const settledBefore = dec(before._sum.settledAmount);
      const settled = returnExcess({ total: order.total, paid, returned, settled: settledBefore, value: amount });
      await tx.salesReturn.update({
        where: { id },
        data: {
          status: 'RECEIVED',
          receivedById: user.id,
          receivedAt: now,
          receiveOperationKey: dto.operationKey,
          receptionNote: dto.note || null,
          amount,
          baseAmount: base,
          settledAmount: settled,
        },
      });
      const after = orderMoney({ total: order.total, paid, returned: returned.plus(amount), settled: settledBefore.plus(settled) });
      if (order.paymentMethod && COLLECTED_LATER.includes(order.paymentMethod)) {
        const status = after.balance.lte(ZERO) ? 'PAID' : 'PENDING';
        if (order.paymentStatus !== status) {
          await tx.salesOrder.update({ where: { id: order.id }, data: { paymentStatus: status, paymentStatusAt: now, paymentStatusById: user.id } });
          await audit(tx, {
            entity: 'SalesOrder',
            entityId: order.id,
            action: 'PAYMENT_STATUS_CHANGED',
            userId: user.id,
            data: { from: order.paymentStatus, to: status, byReturn: item.number, balance: after.balance.toFixed(2) },
          });
        }
      }

      await tx.task.updateMany({ where: { salesReturnId: id, kind: 'RETURN_RECEPTION', completedAt: null }, data: { completedAt: now, cancelledAt: null } });
      // Billing: an invoiced order needs a credit note (in the billing
      // software); one still to invoice is invoiced for the net value.
      if (order.billedAt) {
        const assignee = await this.sales.billingAssignee(tx);
        await tx.task.create({
          data: {
            kind: 'CREDIT_NOTE',
            salesReturnId: id,
            title: `Nota crédito ${item.number} · factura ${order.invoiceNumber}`,
            description:
              `${order.customerName} devolvió material de la orden ${order.number} por ${pesos(amount)} (base sin IVA ${pesos(base)}). ` +
              'Haz la nota crédito en el software de facturación y registra aquí su número.' +
              (assignee.fallback ? ' (No hay un usuario de Facturación activo: la recibe un administrador.)' : ''),
            dueAt: hours(CREDIT_NOTE_HOURS),
            assigneeId: assignee.id,
            createdById: user.id,
          },
        });
        await enqueue(tx, [{ userId: assignee.id, kind: 'credit-note-needed', dedupeKey: `credit-note-needed:${id}` }]);
      } else if (order.requiresBilling) {
        const task = await tx.task.findFirst({ where: { salesOrderId: order.id, kind: 'BILLING', completedAt: null, cancelledAt: null } });
        if (task) {
          await tx.task.update({
            where: { id: task.id },
            data: { description: `${task.description ?? ''}\nDevolución ${item.number}: el cliente devolvió ${pesos(amount)}. Factura el valor neto de la orden: ${pesos(after.net)}.` },
          });
        }
      }
      await enqueue(
        tx,
        [...new Set([order.createdById, item.requestedById])]
          .filter((userId) => userId !== user.id)
          .map((userId) => ({ userId, kind: 'return-received' as const, dedupeKey: `return-received:${id}` })),
      );
      await audit(tx, {
        entity: 'SalesReturn',
        entityId: id,
        action: 'RECEIVED',
        userId: user.id,
        data: {
          amount: amount.toFixed(2),
          baseAmount: base.toFixed(2),
          settledAmount: settled.toFixed(2),
          settlement: item.settlement,
          lines: lines.map((l) => ({ lineId: l.id, good: counts.get(l.id)!.good, damaged: counts.get(l.id)!.damaged })),
          sealedEpcs: dto.sealedEpcs ?? [],
          stock: plan,
        },
      });
    }, 30000);
    return this.get(id, user);
  }

  // --- After reception -------------------------------------------------------------

  // The money handed back to the customer (REFUND), by the seller or ADMIN.
  async refund(id: string, dto: RefundDto, user: SafeUser) {
    const refundedOn = parsePaymentDay(dto.refundedOn);
    const entity = dto.transferEntityId || null;
    if (dto.medium === 'CASH' && entity) throw new BadRequestException('Un reintegro en efectivo no lleva entidad de transferencia');
    if (dto.medium === 'TRANSFER' && !entity) throw new BadRequestException('Indica desde qué entidad de Solaluminios salió la transferencia');
    await this.run(async (tx) => {
      const item = await this.lockReturn(tx, id, user);
      if (item.status !== 'RECEIVED' || item.settlement !== 'REFUND' || !dec(item.settledAmount).gt(ZERO)) {
        throw new ConflictException('Esta devolución no tiene dinero por reintegrar');
      }
      if (item.refundedAt) {
        const same =
          item.refundMedium === dto.medium && (item.refundTransferEntityId ?? null) === entity && item.refundedOn && day(item.refundedOn) === dto.refundedOn;
        if (same) return;
        throw new ConflictException('El reintegro ya está registrado');
      }
      if (entity) await requireTransferEntity(tx, entity);
      await tx.salesReturn.update({
        where: { id },
        data: { refundMedium: dto.medium, refundTransferEntityId: entity, refundedOn, refundNote: dto.note || null, refundedAt: new Date(), refundedById: user.id },
      });
      await audit(tx, {
        entity: 'SalesReturn',
        entityId: id,
        action: 'REFUNDED',
        userId: user.id,
        data: { amount: dec(item.settledAmount).toFixed(2), medium: dto.medium, transferEntityId: entity, refundedOn: dto.refundedOn },
      });
    });
    return this.get(id, user);
  }

  // Number of the credit note made in the billing software (billing or ADMIN).
  async creditNote(id: string, dto: CreditNoteDto, user: SafeUser) {
    await this.run(async (tx) => {
      const item = await this.lockReturn(tx, id, user);
      if (item.status !== 'RECEIVED') throw new ConflictException('La devolución todavía no se ha recibido');
      const order = await tx.salesOrder.findUniqueOrThrow({ where: { id: item.salesOrderId }, select: { billedAt: true, createdById: true } });
      if (!order.billedAt) throw new ConflictException('La orden no está facturada: no lleva nota crédito');
      if (item.creditNoteNumber) {
        if (item.creditNoteNumber === dto.number) return;
        throw new ConflictException(`La nota crédito ya está registrada con el número ${item.creditNoteNumber}`);
      }
      const now = new Date();
      await tx.salesReturn.update({ where: { id }, data: { creditNoteNumber: dto.number, creditNoteAt: now, creditNoteById: user.id } });
      await tx.task.updateMany({ where: { salesReturnId: id, kind: 'CREDIT_NOTE', completedAt: null }, data: { completedAt: now, cancelledAt: null } });
      await audit(tx, { entity: 'SalesReturn', entityId: id, action: 'CREDIT_NOTE_RECORDED', userId: user.id, data: { number: dto.number } });
    });
    return this.get(id, user);
  }
}
