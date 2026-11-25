import { BadRequestException } from '@nestjs/common';
import type { PaymentMedium, PaymentMethod, Prisma } from '../../generated/prisma/client.js';
import { businessToday, type Tx } from '../../shared/db.js';
import { ZERO, dec, money, type Decimal } from '../../shared/money.js';

// Pure rules of the payments of sales orders (shared by the conversion of a
// quote and OrderPaymentsService).

export const CONTADO: readonly PaymentMethod[] = ['CASH', 'TRANSFER', 'CASH_TRANSFER'];
export const COLLECTED_LATER: readonly PaymentMethod[] = ['PARTIAL', 'CREDIT'];

export const MEDIUM_LABEL: Record<PaymentMedium, string> = { CASH: 'Efectivo', TRANSFER: 'Transferencia', CREDIT_BALANCE: 'Saldo a favor' };

export const pesos = (value: Decimal) => `$${Number(value.toFixed(2)).toLocaleString('es-CO', { maximumFractionDigits: 2 })}`;

export const ENTITY_REQUIRED = 'Indica dónde se recibió la transferencia (la entidad de Solaluminios que recibió el dinero)';

// How the money received with a new order is split. Throws when it does not
// add up.
// - Saldo a favor (`creditAmount`, from the customer's returns) may pay part
//   or all of any order; the caller checks the customer has it.
// - Contado: the rest (total − saldo a favor) in cash, transfer or both,
//   adding up exactly. The transferred part carries the entity where it was
//   received (checked against the list by requireTransferEntity).
// - Abono / cartera: only the saldo a favor is recorded now; the rest, as
//   abonos from the order.
export function contadoSplit(
  method: PaymentMethod,
  total: Decimal,
  amounts: { cashAmount?: string; transferAmount?: string; transferEntityId?: string; creditAmount?: string },
): { medium: PaymentMedium; amount: Decimal; transferEntityId: string | null }[] {
  const credit = amounts.creditAmount !== undefined ? money(dec(amounts.creditAmount)) : ZERO;
  if (credit.gt(total)) {
    throw new BadRequestException(`El saldo a favor usado (${pesos(credit)}) supera el total de la orden (${pesos(total)})`);
  }
  const creditPart = credit.gt(ZERO) ? [{ medium: 'CREDIT_BALANCE' as const, amount: credit, transferEntityId: null }] : [];
  if (!CONTADO.includes(method)) {
    if (amounts.cashAmount !== undefined || amounts.transferAmount !== undefined || amounts.transferEntityId !== undefined) {
      throw new BadRequestException('El reparto en efectivo y transferencia solo aplica al contado; los abonos se registran desde la orden');
    }
    return creditPart;
  }
  const entity = amounts.transferEntityId || null;
  const cash = amounts.cashAmount !== undefined ? money(dec(amounts.cashAmount)) : null;
  const transfer = amounts.transferAmount !== undefined ? money(dec(amounts.transferAmount)) : null;
  if (total.lte(ZERO)) return [];
  const rest = total.minus(credit);
  if (rest.lte(ZERO)) {
    if ((cash && cash.gt(ZERO)) || (transfer && transfer.gt(ZERO)) || entity) {
      throw new BadRequestException('El saldo a favor cubre todo el total: no se registra efectivo ni transferencia');
    }
    return creditPart;
  }
  if (method === 'CASH' && entity) throw new BadRequestException('Un pago en efectivo no lleva entidad de transferencia');
  if (method !== 'CASH' && !entity) throw new BadRequestException(ENTITY_REQUIRED);
  const target = credit.gt(ZERO) ? `lo que queda después del saldo a favor (${pesos(rest)})` : `el total de la orden (${pesos(rest)})`;
  if (method === 'CASH' || method === 'TRANSFER') {
    const own = method === 'CASH' ? cash : transfer;
    const other = method === 'CASH' ? transfer : cash;
    if (other && other.gt(ZERO)) {
      throw new BadRequestException('Si el cliente paga con efectivo y transferencia, elige «Contado – efectivo y transferencia»');
    }
    if (own && !own.equals(rest)) {
      throw new BadRequestException(`El contado debe cubrir ${target}. Si solo recibió una parte, elige «Abono» y registra lo recibido desde la orden`);
    }
    return [...creditPart, { medium: method, amount: rest, transferEntityId: method === 'TRANSFER' ? entity : null }];
  }
  if (!cash || !transfer || cash.lte(ZERO) || transfer.lte(ZERO)) {
    throw new BadRequestException(
      'Indica cuánto se pagó en efectivo y cuánto por transferencia (ambos mayores que cero). Si fue un solo medio, elige contado en efectivo o por transferencia',
    );
  }
  const given = cash.plus(transfer);
  if (!given.equals(rest)) {
    const gap = rest.minus(given);
    throw new BadRequestException(
      gap.gt(ZERO)
        ? `Efectivo y transferencia suman ${pesos(given)}: faltan ${pesos(gap)} para ${target}. Si solo recibió una parte, elige «Abono»`
        : `Efectivo y transferencia suman ${pesos(given)}: sobran ${pesos(gap.negated())} sobre ${target}`,
    );
  }
  return [
    ...creditPart,
    { medium: 'CASH', amount: cash, transferEntityId: null },
    { medium: 'TRANSFER', amount: transfer, transferEntityId: entity },
  ];
}

// The customer's saldo a favor: credited by received returns (CREDIT) minus
// what was already paid with it. Lock the customer row first when it is
// about to be used (a trigger checks it too).
export async function customerCredit(client: Pick<Tx, 'salesReturn' | 'salesOrderPayment'>, customerId: string): Promise<Decimal> {
  const credited = await client.salesReturn.aggregate({ where: { customerId, status: 'RECEIVED', settlement: 'CREDIT' }, _sum: { settledAmount: true } });
  const used = await client.salesOrderPayment.aggregate({ where: { medium: 'CREDIT_BALANCE', salesOrder: { customerId } }, _sum: { amount: true } });
  return dec(credited._sum.settledAmount).minus(dec(used._sum.amount));
}

export async function lockCustomer(tx: Tx, customerId: string) {
  await tx.$queryRaw`SELECT id FROM "customers" WHERE id = ${customerId} FOR UPDATE`;
}

// Order money with received returns (see returns.ts orderMoney).
export async function orderReturns(client: Pick<Tx, 'salesReturn'>, orderId: string) {
  const totals = await client.salesReturn.aggregate({ where: { salesOrderId: orderId, status: 'RECEIVED' }, _sum: { amount: true, settledAmount: true } });
  return { returned: dec(totals._sum.amount), settled: dec(totals._sum.settledAmount) };
}

// The entity must be one of the list and active (inactive ones stay only for
// the history of payments already recorded).
export async function requireTransferEntity(tx: Tx, id: string) {
  const entity = await tx.transferEntity.findUnique({ where: { id } });
  if (!entity?.active) throw new BadRequestException('La entidad de la transferencia no existe o ya no se usa: elige una de la lista');
  return entity;
}

// A business day as a Date at UTC midnight (the column is a DATE). Never in
// the future.
export function parsePaymentDay(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value || value < '2020-01-01') {
    throw new BadRequestException('La fecha del pago no es válida');
  }
  if (value > businessToday()) throw new BadRequestException('La fecha del pago no puede ser posterior a hoy');
  return date;
}

export const day = (date: Date) => date.toISOString().slice(0, 10);

export type PaymentRow = Prisma.SalesOrderPaymentGetPayload<object>;
export const snapshot = (p: Pick<PaymentRow, 'amount' | 'medium' | 'paidOn' | 'note' | 'transferEntityId'>) => ({
  amount: p.amount.toFixed(2),
  medium: p.medium,
  transferEntityId: p.transferEntityId ?? null,
  paidOn: day(p.paidOn),
  note: p.note ?? null,
});
