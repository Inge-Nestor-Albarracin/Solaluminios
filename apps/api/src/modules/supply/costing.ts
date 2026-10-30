import type { DiscountType } from '../../generated/prisma/client.js';
import { Decimal, HUNDRED, ZERO, allocate, dec, money, sum, unitCost } from '../../shared/money.js';

// Purchase costing (pure functions, unit-tested).
//
// CURRENT RULE (computeTaxOnNetLine), in the order of the invoice: the
// administrator enters the gross value WITHOUT purchase VAT; the discount is
// applied before VAT and the VAT on the discounted base:
//   discount  = gross × discount % / 100       (cents)
//   base      = gross − discount
//   VAT       = base × VAT % / 100              (cents; explicit rate, may be 0)
//   total     = base + VAT
//   unit cost = total ÷ profiles               (6 decimals; purchase VAT is
//                                               part of the cost, as before)
//
// PREVIOUS RULE (computeTaxIncludedLine, kept for lines recorded with it):
// gross value WITH purchase VAT; discount = gross × % ; cost = gross −
// discount; unit cost = cost ÷ profiles.
//
// EARLIER DEFINITION (computePurchase, kept for documents recorded with it):
// Per line:   gross     = quantity × unit price
//             base      = gross − line discount
// Document:   the general (commercial) discount is computed on the sum of the
//             bases and allocated to the lines in proportion to their base
//             (largest-remainder rounding, see allocate()). It is applied once.
//             net       = base − allocated general discount
//             tax       = net × explicit tax rate of the line
//             charges   = attributable costs allocated by net amount
//             cost      = net + charges (+ tax only when NOT recoverable)
//             cost COP  = cost × exchange rate (1 for COP)
//             unit cost = cost COP ÷ profiles (quantity × profiles per unit)
// Anything that blocks confirmation is reported in `issues`; drafts can be
// saved with issues, confirmation cannot.

export interface CostingLineInput {
  lineNo: number;
  quantity: Decimal;
  profilesPerUnit: Decimal;
  unitPrice: Decimal;
  lineDiscountType: DiscountType;
  lineDiscountValue: Decimal;
  taxRatePercent: Decimal | null;
  taxRecoverable: boolean | null;
}

export interface CostingInput {
  currency: string;
  exchangeRate: Decimal | null;
  globalDiscountType: DiscountType;
  globalDiscountValue: Decimal;
  charges: Decimal[];
  lines: CostingLineInput[];
}

export interface CostingLineResult {
  lineNo: number;
  grossAmount: Decimal;
  lineDiscountAmount: Decimal;
  globalDiscountAmount: Decimal;
  netAmount: Decimal;
  taxAmount: Decimal;
  chargesAmount: Decimal;
  costAmount: Decimal;
  costAmountCop: Decimal;
  profiles: number;
  unitCostCop: Decimal | null;
}

export interface CostingResult {
  lines: CostingLineResult[];
  grossTotal: Decimal;
  lineDiscountTotal: Decimal;
  globalDiscountTotal: Decimal;
  netTotal: Decimal;
  taxTotal: Decimal;
  chargesTotal: Decimal;
  documentTotal: Decimal;
  issues: string[];
}

function discount(base: Decimal, type: DiscountType, value: Decimal): Decimal {
  if (type === 'PERCENT') return money(base.times(value).dividedBy(HUNDRED));
  if (type === 'AMOUNT') return money(value);
  return ZERO;
}

export function computePurchase(input: CostingInput): CostingResult {
  const issues: string[] = [];
  if (input.lines.length === 0) issues.push('La compra no tiene renglones');

  const gross = input.lines.map((line) => money(line.quantity.times(line.unitPrice)));
  const lineDiscount = input.lines.map((line, i) => {
    const amount = discount(gross[i], line.lineDiscountType, line.lineDiscountValue);
    if (amount.greaterThan(gross[i])) issues.push(`Renglón ${line.lineNo}: el descuento supera el valor del renglón`);
    return amount;
  });
  const base = gross.map((value, i) => value.minus(lineDiscount[i]));
  const baseTotal = sum(base);

  const globalTotal = discount(baseTotal, input.globalDiscountType, input.globalDiscountValue);
  if (globalTotal.greaterThan(baseTotal)) issues.push('El descuento general supera la base de la compra');
  const globalShares = allocate(globalTotal.greaterThan(baseTotal) ? ZERO : globalTotal, base);
  const net = base.map((value, i) => value.minus(globalShares[i]));

  const chargesTotal = money(sum(input.charges));
  const chargeShares = allocate(chargesTotal, net);

  const rate = input.currency === 'COP' ? dec(1) : input.exchangeRate;
  if (!rate) issues.push(`Moneda ${input.currency}: falta la tasa de cambio aplicada`);

  const lines = input.lines.map((line, i): CostingLineResult => {
    let taxAmount = ZERO;
    if (line.taxRatePercent === null) {
      issues.push(`Renglón ${line.lineNo}: falta la tarifa de impuesto (puede ser 0)`);
    } else {
      taxAmount = money(net[i].times(line.taxRatePercent).dividedBy(HUNDRED));
    }
    if (line.taxRecoverable === null) {
      issues.push(`Renglón ${line.lineNo}: indica si el impuesto es descontable o no`);
    }
    const costAmount = net[i].plus(chargeShares[i]).plus(line.taxRecoverable === false ? taxAmount : ZERO);
    const costAmountCop = rate ? money(costAmount.times(rate)) : ZERO;
    const profilesExact = line.quantity.times(line.profilesPerUnit);
    if (!profilesExact.isInteger()) {
      issues.push(`Renglón ${line.lineNo}: la cantidad equivale a ${profilesExact.toString()} perfiles; debe ser un número entero`);
    }
    const profiles = profilesExact.isInteger() ? profilesExact.toNumber() : 0;
    let unitCostCop: Decimal | null = null;
    if (profiles > 0 && rate && costAmountCop.greaterThan(0)) {
      unitCostCop = unitCost(costAmountCop.dividedBy(profiles));
    } else if (rate && profiles > 0) {
      issues.push(`Renglón ${line.lineNo}: el costo resultante es cero`);
    }
    return {
      lineNo: line.lineNo,
      grossAmount: gross[i],
      lineDiscountAmount: lineDiscount[i],
      globalDiscountAmount: globalShares[i],
      netAmount: net[i],
      taxAmount,
      chargesAmount: chargeShares[i],
      costAmount,
      costAmountCop,
      profiles,
      unitCostCop,
    };
  });

  const netTotal = sum(net);
  const taxTotal = sum(lines.map((line) => line.taxAmount));
  return {
    lines,
    grossTotal: sum(gross),
    lineDiscountTotal: sum(lineDiscount),
    globalDiscountTotal: sum(globalShares),
    netTotal,
    taxTotal,
    chargesTotal,
    documentTotal: netTotal.plus(taxTotal).plus(chargesTotal),
    issues,
  };
}

export interface TaxIncludedLine {
  discountAmount: Decimal;
  costAmount: Decimal;
  unitCost: Decimal | null;
}

// Current rule: gross value with purchase VAT, percentage discount, profiles.
export function computeTaxIncludedLine(grossAmount: Decimal, discountPercent: Decimal, profiles: number): TaxIncludedLine {
  const gross = money(grossAmount);
  const discountAmount = money(gross.times(discountPercent).dividedBy(HUNDRED));
  const costAmount = gross.minus(discountAmount);
  const valid = profiles > 0 && Number.isInteger(profiles) && costAmount.greaterThan(0);
  return { discountAmount, costAmount, unitCost: valid ? unitCost(costAmount.dividedBy(profiles)) : null };
}

export interface TaxOnNetLine {
  discountAmount: Decimal;
  netAmount: Decimal;
  taxAmount: Decimal;
  costAmount: Decimal;
  unitCost: Decimal | null;
}

// Current rule: gross WITHOUT VAT → discount → VAT on the discounted base.
export function computeTaxOnNetLine(grossAmount: Decimal, discountPercent: Decimal, taxRatePercent: Decimal, profiles: number): TaxOnNetLine {
  const gross = money(grossAmount);
  const discountAmount = money(gross.times(discountPercent).dividedBy(HUNDRED));
  const netAmount = gross.minus(discountAmount);
  const taxAmount = money(netAmount.times(taxRatePercent).dividedBy(HUNDRED));
  const costAmount = netAmount.plus(taxAmount);
  const valid = profiles > 0 && Number.isInteger(profiles) && costAmount.greaterThan(0);
  return { discountAmount, netAmount, taxAmount, costAmount, unitCost: valid ? unitCost(costAmount.dividedBy(profiles)) : null };
}
