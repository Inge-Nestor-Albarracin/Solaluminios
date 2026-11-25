import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PaymentMedium, PaymentMethod } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/database/prisma.service.js';
import { RetryableException } from '../../infrastructure/http/retryable.js';
import { audit, isCheckViolation, isLockTimeout, isUniqueViolation, type Tx } from '../../shared/db.js';
import { ZERO, dec, money, sum, type Decimal } from '../../shared/money.js';
import type { SafeUser } from '../auth/auth.types.js';
import type { AddOrderPaymentDto, EditOrderPaymentDto } from './dto/sales.dto.js';
import { orderMoney } from '../returns/returns.js';
import {
  COLLECTED_LATER,
  ENTITY_REQUIRED,
  customerCredit,
  day,
  lockCustomer,
  orderReturns,
  parsePaymentDay,
  pesos,
  requireTransferEntity,
  snapshot,
  type PaymentRow,
} from './order-payments.js';
import { SalesService } from './sales.service.js';

// Money received for sales orders (one SalesOrderPayment per payment).
//
// - Contado (CASH, TRANSFER, CASH_TRANSFER): recorded with the conversion of
//   the quote, split in one or two media; it must add up exactly to the order
//   total (see contadoSplit). Its amounts are then fixed.
// - Abono / cartera (PARTIAL, CREDIT): each abono is recorded from the order
//   (only what was just received); the payment status follows the balance.
// - Orders converted before payments existed have no records: nothing is
//   invented; their status keeps being changed by hand until they get one.
//
// Consistency: every write locks the order row first (SalesService.lockOrder,
// which also applies the role scope), then reads the balance; a trigger
// refuses payments above the total. Retries: an abono carries the client's
// operationKey (same key + same data returns the saved order; other data 409).

@Injectable()
export class OrderPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sales: SalesService,
  ) {}

  // Records an abono of an abono / cartera order: amount (> 0, at most the
  // balance), day and medium; the note is optional.
  async add(orderId: string, dto: AddOrderPaymentDto, user: SafeUser) {
    const amount = money(dec(dto.amount));
    const paidOn = parsePaymentDay(dto.paidOn);
    const note = dto.note || null;
    // A transfer says where Solaluminios received it; cash and saldo a favor
    // never do.
    const transferEntityId = dto.transferEntityId || null;
    if (dto.medium !== 'TRANSFER' && transferEntityId) throw new BadRequestException(CASH_HAS_NO_ENTITY);
    if (dto.medium === 'TRANSFER' && !transferEntityId) throw new BadRequestException(ENTITY_REQUIRED);
    const input = { amount, medium: dto.medium, transferEntityId, paidOn, note };
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const order = await this.sales.lockOrder(tx, orderId, user);
          const saved = await tx.salesOrderPayment.findUnique({ where: { operationKey: dto.operationKey } });
          if (saved) return requireSameAbono(saved, orderId, input, user);
          if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada: no recibe abonos');
          if (!order.paymentMethod || !COLLECTED_LATER.includes(order.paymentMethod)) {
            throw new ConflictException(
              'Solo las órdenes con abono o a crédito (cartera) reciben abonos. El contado se registra completo al convertir la cotización',
            );
          }
          if (amount.lte(ZERO)) throw new BadRequestException('El abono debe ser mayor que cero');
          const payments = await tx.salesOrderPayment.findMany({ where: { salesOrderId: orderId } });
          if (payments.length === 0 && order.paymentStatus === 'PAID') {
            throw new ConflictException(
              'La orden ya figura como pagada (se marcó antes de registrar abonos). Para registrar sus abonos, vuélvela primero a «Pago pendiente»',
            );
          }
          const paid = sum(payments.map((p) => p.amount));
          const returns = await orderReturns(tx, orderId);
          const { balance } = orderMoney({ total: order.total, paid, ...returns });
          if (amount.gt(balance)) {
            throw new BadRequestException(`El abono (${pesos(amount)}) supera el saldo pendiente (${pesos(balance)})`);
          }
          if (transferEntityId) await requireTransferEntity(tx, transferEntityId);
          if (dto.medium === 'CREDIT_BALANCE') await this.requireCredit(tx, order.customerId, amount);
          const payment = await tx.salesOrderPayment.create({
            data: { salesOrderId: orderId, medium: dto.medium, transferEntityId, amount, paidOn, note, operationKey: dto.operationKey, createdById: user.id },
          });
          await audit(tx, {
            entity: 'SalesOrderPayment',
            entityId: payment.id,
            action: 'PAYMENT_RECORDED',
            userId: user.id,
            data: { orderId, ...snapshot(payment) },
          });
          await this.followBalance(tx, order, orderMoney({ total: order.total, paid: paid.plus(amount), ...returns }).balance, user);
        },
        { maxWait: 10000, timeout: 20000 },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent retry with the same key won: same data returns it.
        const saved = await this.prisma.salesOrderPayment.findUnique({ where: { operationKey: dto.operationKey } });
        if (saved) requireSameAbono(saved, orderId, input, user);
        else throw error;
      } else if (isCheckViolation(error)) {
        throw new ConflictException('Otro abono se registró al mismo tiempo y este superaría el total de la orden. Revisa el saldo e intenta de nuevo');
      } else if (isLockTimeout(error)) {
        throw new RetryableException('La orden está ocupada con otra operación; intenta de nuevo en unos segundos.');
      } else {
        throw error;
      }
    }
    return this.sales.getOrder(orderId, user);
  }

  // Corrects a payment already recorded (amount, day, medium or note). The
  // balance is computed replacing the old amount, never adding a payment.
  // A contado payment keeps its amount (the contado adds up to the total).
  async edit(orderId: string, paymentId: string, dto: EditOrderPaymentDto, user: SafeUser) {
    try {
      await this.prisma.$transaction(
        async (tx) => {
          const order = await this.sales.lockOrder(tx, orderId, user);
          const payment = await tx.salesOrderPayment.findFirst({ where: { id: paymentId, salesOrderId: orderId } });
          if (!payment) throw new NotFoundException('El pago no existe en esta orden');
          if (order.status === 'CANCELLED') throw new ConflictException('La orden está cancelada: sus pagos ya no se corrigen');
          const medium = dto.medium ?? payment.medium;
          const next = {
            amount: dto.amount !== undefined ? money(dec(dto.amount)) : payment.amount,
            medium,
            transferEntityId: await this.entityAfterEdit(tx, payment, medium, dto.transferEntityId),
            paidOn: dto.paidOn !== undefined ? parsePaymentDay(dto.paidOn) : payment.paidOn,
            note: dto.note === undefined ? payment.note : dto.note || null,
          };
          if (next.amount.lte(ZERO)) throw new BadRequestException('El valor debe ser mayor que cero');
          if (payment.atSale && !next.amount.equals(payment.amount)) {
            throw new ConflictException(
              'El valor de un pago de contado no se cambia: el contado siempre suma el total de la orden. Puedes corregir el medio, la fecha o la observación',
            );
          }
          const before = snapshot(payment);
          const after = snapshot(next);
          if (JSON.stringify(before) === JSON.stringify(after)) return; // retry or no change
          const others = sum(
            (await tx.salesOrderPayment.findMany({ where: { salesOrderId: orderId, id: { not: paymentId } } })).map((p) => p.amount),
          );
          const returns = await orderReturns(tx, orderId);
          // Room = what the order still lacks without this payment.
          const room = orderMoney({ total: order.total, paid: others, ...returns }).balance;
          if (next.amount.gt(room)) {
            throw new BadRequestException(`Con ese valor los pagos superarían el total de la orden: este pago puede ser como máximo ${pesos(room)}`);
          }
          if (next.medium === 'CREDIT_BALANCE') {
            // What this payment already took from the saldo a favor is available again.
            const own = payment.medium === 'CREDIT_BALANCE' ? payment.amount : ZERO;
            await this.requireCredit(tx, order.customerId, next.amount, own);
          }
          await tx.salesOrderPayment.update({
            where: { id: paymentId },
            data: {
              amount: next.amount,
              medium: next.medium,
              transferEntityId: next.transferEntityId,
              paidOn: next.paidOn,
              note: next.note,
              updatedById: user.id,
            },
          });
          const changed = Object.fromEntries(
            (Object.keys(after) as (keyof typeof after)[]).filter((k) => before[k] !== after[k]).map((k) => [k, { from: before[k], to: after[k] }]),
          );
          await audit(tx, {
            entity: 'SalesOrderPayment',
            entityId: paymentId,
            action: 'PAYMENT_EDITED',
            userId: user.id,
            data: { orderId, changed },
          });
          await this.followBalance(tx, order, orderMoney({ total: order.total, paid: others.plus(next.amount), ...returns }).balance, user);
        },
        { maxWait: 10000, timeout: 20000 },
      );
    } catch (error) {
      if (isCheckViolation(error)) {
        throw new ConflictException('Otro pago se registró al mismo tiempo y con este valor se superaría el total. Revisa el saldo e intenta de nuevo');
      }
      if (isLockTimeout(error)) throw new RetryableException('La orden está ocupada con otra operación; intenta de nuevo en unos segundos.');
      throw error;
    }
    return this.sales.getOrder(orderId, user);
  }

  // Entity of a payment after a correction:
  // - cash never has one (a change to cash removes it);
  // - a payment that becomes a transfer must say where it was received;
  // - a transfer keeps its entity unless another one of the list is chosen;
  //   one recorded before entities existed may stay «Sin especificar».
  private async entityAfterEdit(
    tx: Tx,
    payment: { medium: PaymentMedium; transferEntityId: string | null },
    medium: PaymentMedium,
    requested: string | undefined,
  ): Promise<string | null> {
    if (medium !== 'TRANSFER') {
      if (requested) throw new BadRequestException(CASH_HAS_NO_ENTITY);
      return null;
    }
    if (requested !== undefined) {
      if (!requested) throw new BadRequestException(ENTITY_REQUIRED);
      if (requested !== payment.transferEntityId) await requireTransferEntity(tx, requested);
      return requested;
    }
    if (payment.medium === 'TRANSFER') return payment.transferEntityId;
    throw new BadRequestException(ENTITY_REQUIRED);
  }

  // Saldo a favor: the customer must have it (customer row locked first, so
  // two payments of the same customer are checked one after the other).
  private async requireCredit(tx: Tx, customerId: string, amount: Decimal, own: Decimal = ZERO) {
    await lockCustomer(tx, customerId);
    const available = (await customerCredit(tx, customerId)).plus(own);
    if (amount.gt(available)) {
      throw new BadRequestException(
        available.gt(ZERO)
          ? `El cliente tiene ${pesos(available)} de saldo a favor: el pago con saldo a favor puede ser como máximo ese valor`
          : 'El cliente no tiene saldo a favor',
      );
    }
  }

  // Abono / cartera orders with payments: paid when the balance (after
  // returns) is zero, pending otherwise. Each change is audited like a
  // manual one.
  private async followBalance(
    tx: Tx,
    order: { id: string; paymentMethod: PaymentMethod | null; paymentStatus: 'PENDING' | 'PAID' | null },
    balance: Decimal,
    user: SafeUser,
  ) {
    if (!order.paymentMethod || !COLLECTED_LATER.includes(order.paymentMethod)) return;
    const status = balance.lte(ZERO) ? 'PAID' : 'PENDING';
    if (order.paymentStatus === status) return;
    await tx.salesOrder.update({ where: { id: order.id }, data: { paymentStatus: status, paymentStatusAt: new Date(), paymentStatusById: user.id } });
    await audit(tx, {
      entity: 'SalesOrder',
      entityId: order.id,
      action: 'PAYMENT_STATUS_CHANGED',
      userId: user.id,
      data: { from: order.paymentStatus, to: status, byPayments: true, balance: balance.toFixed(2) },
    });
  }
}

const CASH_HAS_NO_ENTITY = 'Solo una transferencia lleva entidad: el efectivo y el saldo a favor no';

function requireSameAbono(
  saved: PaymentRow,
  orderId: string,
  input: { amount: Decimal; medium: PaymentMedium; transferEntityId: string | null; paidOn: Date; note: string | null },
  user: SafeUser,
) {
  const same =
    saved.salesOrderId === orderId &&
    saved.createdById === user.id &&
    saved.amount.equals(input.amount) &&
    saved.medium === input.medium &&
    (saved.transferEntityId ?? null) === input.transferEntityId &&
    day(saved.paidOn) === day(input.paidOn) &&
    (saved.note ?? null) === input.note;
  if (!same) throw new ConflictException('La clave de guardado ya se usó con otro abono');
}
