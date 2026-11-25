-- Payments of sales orders (additive): the money actually received, one record
-- per payment, with its own amount, day and medium (cash or transfer), and the
-- payment method «Contado – efectivo y transferencia» (CASH_TRANSFER).
--
-- Historical records: no payment is created for orders converted before this
-- migration (nothing is invented: amounts, days or media were never
-- recorded).
-- - A contado order (CASH / TRANSFER) without records keeps meaning «paid at
--   the sale», with no detail of media.
-- - An abono / cartera order (PARTIAL / CREDIT) keeps its paymentStatus
--   (PENDING / PAID) as marked by hand. While it has no records it is still
--   changed by hand; once it has records, they decide it (PAID when the
--   balance is zero).
-- Orders, quotes, totals, taxes, discounts, reservations and dispatches do
-- not change.
-- CreateEnum
CREATE TYPE "PaymentMedium" AS ENUM ('CASH', 'TRANSFER');

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'CASH_TRANSFER';

-- CreateTable
CREATE TABLE "sales_order_payments" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "medium" "PaymentMedium" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "atSale" BOOLEAN NOT NULL DEFAULT false,
    "operationKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_order_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_payments_operationKey_key" ON "sales_order_payments"("operationKey");

-- CreateIndex
CREATE INDEX "sales_order_payments_salesOrderId_paidOn_idx" ON "sales_order_payments"("salesOrderId", "paidOn");

-- CreateIndex
CREATE INDEX "sales_order_payments_createdById_idx" ON "sales_order_payments"("createdById");

-- CreateIndex
CREATE INDEX "sales_order_payments_updatedById_idx" ON "sales_order_payments"("updatedById");

-- AddForeignKey
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Business rules enforced by the database (custom SQL, keep when editing) ----

-- A payment always brings money.
ALTER TABLE public.sales_order_payments
ADD CONSTRAINT sales_order_payments_amount_positive
CHECK (amount > 0);

-- The payments of an order never add up to more than its total. The order row
-- is locked first, so concurrent payments of the same order are checked one
-- after the other (the API locks it too, before reading the balance).
CREATE FUNCTION sales_order_payments_within_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_total NUMERIC;
  paid NUMERIC;
BEGIN
  SELECT total INTO order_total FROM public.sales_orders WHERE id = NEW."salesOrderId" FOR UPDATE;
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM public.sales_order_payments WHERE "salesOrderId" = NEW."salesOrderId";
  IF paid > order_total THEN
    RAISE EXCEPTION 'Los pagos de la orden (%) superan su total (%)', paid, order_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_payments_within_total
AFTER INSERT OR UPDATE OF amount, "salesOrderId" ON public.sales_order_payments
FOR EACH ROW EXECUTE FUNCTION sales_order_payments_within_total();

-- A payment never moves to another order.
CREATE FUNCTION sales_order_payments_order_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."salesOrderId" IS DISTINCT FROM OLD."salesOrderId" THEN
    RAISE EXCEPTION 'Un pago no cambia de orden' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_payments_order_is_final
BEFORE UPDATE OF "salesOrderId" ON public.sales_order_payments
FOR EACH ROW EXECUTE FUNCTION sales_order_payments_order_is_final();