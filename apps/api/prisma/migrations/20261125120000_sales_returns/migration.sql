-- Sales returns (documento DV): the customer gives back delivered material.
-- Additive: new tables, enum values and links; nothing existing changes.
-- Design and rules: docs/devoluciones.md.


-- CreateEnum
CREATE TYPE "SalesReturnStatus" AS ENUM ('REQUESTED', 'APPROVED', 'RECEIVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesReturnReason" AS ENUM ('SELLER_ERROR', 'CUSTOMER_ERROR', 'WAREHOUSE_ERROR', 'DEFECTIVE');

-- CreateEnum
CREATE TYPE "SalesReturnSettlement" AS ENUM ('CREDIT', 'REFUND');

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'RETURN';

-- AlterEnum
ALTER TYPE "PaymentMedium" ADD VALUE 'CREDIT_BALANCE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TaskKind" ADD VALUE 'RETURN_APPROVAL';
ALTER TYPE "TaskKind" ADD VALUE 'RETURN_RECEPTION';
ALTER TYPE "TaskKind" ADD VALUE 'CREDIT_NOTE';

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "salesReturnLineId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "salesReturnId" TEXT;

-- CreateTable
CREATE TABLE "sales_returns" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "inventoryLocationId" TEXT NOT NULL,
    "status" "SalesReturnStatus" NOT NULL,
    "reason" "SalesReturnReason" NOT NULL,
    "notes" TEXT,
    "settlement" "SalesReturnSettlement" NOT NULL,
    "createOperationKey" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approverId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    "receiverId" TEXT,
    "receivedById" TEXT,
    "receivedAt" TIMESTAMPTZ(3),
    "receiveOperationKey" TEXT,
    "receptionNote" TEXT,
    "amount" DECIMAL(18,2),
    "baseAmount" DECIMAL(18,2),
    "settledAmount" DECIMAL(18,2),
    "refundMedium" "PaymentMedium",
    "refundTransferEntityId" TEXT,
    "refundedOn" DATE,
    "refundNote" TEXT,
    "refundedAt" TIMESTAMPTZ(3),
    "refundedById" TEXT,
    "creditNoteNumber" TEXT,
    "creditNoteAt" TIMESTAMPTZ(3),
    "creditNoteById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_returns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_return_lines" (
    "id" TEXT NOT NULL,
    "salesReturnId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "goodQuantity" INTEGER,
    "damagedQuantity" INTEGER,
    "amount" DECIMAL(18,2),
    "baseAmount" DECIMAL(18,2),

    CONSTRAINT "sales_return_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_number_key" ON "sales_returns"("number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_createOperationKey_key" ON "sales_returns"("createOperationKey");

-- CreateIndex
CREATE UNIQUE INDEX "sales_returns_receiveOperationKey_key" ON "sales_returns"("receiveOperationKey");

-- CreateIndex
CREATE INDEX "sales_returns_salesOrderId_idx" ON "sales_returns"("salesOrderId");

-- CreateIndex
CREATE INDEX "sales_returns_customerId_status_idx" ON "sales_returns"("customerId", "status");

-- CreateIndex
CREATE INDEX "sales_returns_inventoryLocationId_status_idx" ON "sales_returns"("inventoryLocationId", "status");

-- CreateIndex
CREATE INDEX "sales_returns_status_createdAt_idx" ON "sales_returns"("status", "createdAt");

-- CreateIndex
CREATE INDEX "sales_return_lines_salesOrderLineId_idx" ON "sales_return_lines"("salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_return_lines_salesReturnId_salesOrderLineId_key" ON "sales_return_lines"("salesReturnId", "salesOrderLineId");

-- CreateIndex
CREATE INDEX "inventory_movements_salesReturnLineId_idx" ON "inventory_movements"("salesReturnLineId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_salesReturnId_kind_key" ON "tasks"("salesReturnId", "kind");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_salesReturnLineId_fkey" FOREIGN KEY ("salesReturnLineId") REFERENCES "sales_return_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_salesReturnId_fkey" FOREIGN KEY ("salesReturnId") REFERENCES "sales_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_inventoryLocationId_fkey" FOREIGN KEY ("inventoryLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_refundedById_fkey" FOREIGN KEY ("refundedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_creditNoteById_fkey" FOREIGN KEY ("creditNoteById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_refundTransferEntityId_fkey" FOREIGN KEY ("refundTransferEntityId") REFERENCES "transfer_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_salesReturnId_fkey" FOREIGN KEY ("salesReturnId") REFERENCES "sales_returns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "sales_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business rules enforced by the database (custom SQL, keep when editing) ----
-- The enum values added above cannot be used as enum literals in the same
-- transaction: they are compared as text.

-- Numbers DV-000001…
CREATE SEQUENCE IF NOT EXISTS sales_return_number_seq;

-- A return movement adds the profiles back to the bundle they left from.
ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_balance_consistent;
ALTER TABLE public.inventory_movements
ADD CONSTRAINT inventory_movements_balance_consistent
CHECK (
    CASE type::text
        WHEN 'INITIAL_STOCK' THEN
            "quantityBefore" = 0
            AND "quantityAfter" = quantity
        WHEN 'ENTRY' THEN
            "quantityAfter" = "quantityBefore" + quantity
        WHEN 'ADJUSTMENT_IN' THEN
            "quantityAfter" = "quantityBefore" + quantity
        WHEN 'RETURN' THEN
            "quantityAfter" = "quantityBefore" + quantity
        WHEN 'EXIT' THEN
            "quantityAfter" = "quantityBefore" - quantity
        WHEN 'ADJUSTMENT_OUT' THEN
            "quantityAfter" = "quantityBefore" - quantity
        WHEN 'TRANSFER' THEN
            "quantityAfter" = "quantityBefore"
            AND quantity = "quantityBefore"
        WHEN 'OPENING' THEN
            "quantityAfter" = "quantityBefore"
            AND quantity = "quantityBefore"
        ELSE false
    END
);

-- Every RETURN movement belongs to a line of a sales return, and only they do.
ALTER TABLE public.inventory_movements
ADD CONSTRAINT inventory_movements_sales_return_link
CHECK ((type::text = 'RETURN') = ("salesReturnLineId" IS NOT NULL));

-- Return tasks point to their return, and only they do.
ALTER TABLE public.tasks
ADD CONSTRAINT tasks_sales_return_link
CHECK ((kind::text IN ('RETURN_APPROVAL', 'RETURN_RECEPTION', 'CREDIT_NOTE')) = ("salesReturnId" IS NOT NULL));

-- A line asks for at least one profile; at reception, good + damaged never
-- exceed it, and the value is recorded with the counts.
ALTER TABLE public.sales_return_lines
ADD CONSTRAINT sales_return_lines_valid
CHECK (
    quantity > 0
    AND ("goodQuantity" IS NULL) = ("damagedQuantity" IS NULL)
    AND ("goodQuantity" IS NULL) = (amount IS NULL)
    AND (amount IS NULL) = ("baseAmount" IS NULL)
    AND (
        "goodQuantity" IS NULL
        OR (
            "goodQuantity" >= 0
            AND "damagedQuantity" >= 0
            AND "goodQuantity" + "damagedQuantity" <= quantity
            AND amount >= 0
            AND "baseAmount" >= 0
        )
    )
);

-- Header of a return by state: each step keeps who and when, together.
ALTER TABLE public.sales_returns
ADD CONSTRAINT sales_returns_valid
CHECK (
    -- Requested by a seller: waits for the administrator it chose.
    (status::text <> 'REQUESTED' OR ("approverId" IS NOT NULL AND "decidedAt" IS NULL))
    -- Decision (approve or reject), with author and date.
    AND (("decidedAt" IS NULL) = ("decidedById" IS NULL))
    AND (status::text NOT IN ('APPROVED', 'RECEIVED', 'REJECTED') OR "decidedAt" IS NOT NULL)
    AND (status::text <> 'REJECTED' OR length(btrim(coalesce("decisionNote", ''))) > 0)
    -- Approved: someone has the reception task.
    AND (status::text <> 'APPROVED' OR "receiverId" IS NOT NULL)
    -- Reception: only a received return has it, complete with its value.
    AND ((status::text = 'RECEIVED') = ("receivedAt" IS NOT NULL))
    AND (("receivedAt" IS NULL) = ("receivedById" IS NULL))
    AND (("receivedAt" IS NULL) = ("receiveOperationKey" IS NULL))
    AND (("receivedAt" IS NULL) = (amount IS NULL))
    AND ((amount IS NULL) = ("baseAmount" IS NULL))
    AND ((amount IS NULL) = ("settledAmount" IS NULL))
    AND (amount IS NULL OR (amount >= 0 AND "baseAmount" >= 0 AND "settledAmount" >= 0 AND "settledAmount" <= amount))
    -- Cancellation: only when cancelled, with author and reason.
    AND ((status::text = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
    AND (("cancelledAt" IS NULL) = ("cancelledById" IS NULL))
    AND (status::text <> 'CANCELLED' OR length(btrim(coalesce("cancelReason", ''))) > 0)
    -- Refund: only of a REFUND return with money to give back, recorded
    -- complete; cash or transfer (a transfer says from which entity).
    AND (("refundedAt" IS NULL) = ("refundedById" IS NULL))
    AND (("refundedAt" IS NULL) = ("refundMedium" IS NULL))
    AND (("refundedAt" IS NULL) = ("refundedOn" IS NULL))
    AND ("refundedAt" IS NULL OR (settlement::text = 'REFUND' AND "settledAmount" > 0))
    AND ("refundMedium" IS NULL OR "refundMedium"::text IN ('CASH', 'TRANSFER'))
    AND ((coalesce("refundMedium"::text, '') = 'TRANSFER') = ("refundTransferEntityId" IS NOT NULL))
    -- Credit note (made in the billing software): number, date and author.
    AND (("creditNoteAt" IS NULL) = ("creditNoteNumber" IS NULL))
    AND (("creditNoteAt" IS NULL) = ("creditNoteById" IS NULL))
    AND ("creditNoteAt" IS NULL OR (status::text = 'RECEIVED' AND length(btrim("creditNoteNumber")) > 0))
);

-- A received return is final: its value, settlement and reception never
-- change; only the refund and the credit note are added, once.
CREATE FUNCTION sales_returns_received_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text = 'RECEIVED' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW."baseAmount" IS DISTINCT FROM OLD."baseAmount"
    OR NEW."settledAmount" IS DISTINCT FROM OLD."settledAmount"
    OR NEW.settlement IS DISTINCT FROM OLD.settlement
    OR NEW."salesOrderId" IS DISTINCT FROM OLD."salesOrderId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."receivedAt" IS DISTINCT FROM OLD."receivedAt"
    OR (OLD."refundedAt" IS NOT NULL AND (NEW."refundedAt", NEW."refundMedium", NEW."refundTransferEntityId", NEW."refundedOn")
        IS DISTINCT FROM (OLD."refundedAt", OLD."refundMedium", OLD."refundTransferEntityId", OLD."refundedOn"))
    OR (OLD."creditNoteAt" IS NOT NULL AND (NEW."creditNoteNumber", NEW."creditNoteAt") IS DISTINCT FROM (OLD."creditNoteNumber", OLD."creditNoteAt"))
  ) THEN
    RAISE EXCEPTION 'La devolución % ya fue recibida: no se modifica', OLD.number USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_returns_received_is_final
BEFORE UPDATE ON public.sales_returns
FOR EACH ROW EXECUTE FUNCTION sales_returns_received_is_final();

-- The counts and value of a line, once received, never change.
CREATE FUNCTION sales_return_lines_received_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."goodQuantity" IS NOT NULL AND (
    (NEW."salesReturnId", NEW."salesOrderLineId", NEW.quantity, NEW."goodQuantity", NEW."damagedQuantity", NEW.amount, NEW."baseAmount")
    IS DISTINCT FROM
    (OLD."salesReturnId", OLD."salesOrderLineId", OLD.quantity, OLD."goodQuantity", OLD."damagedQuantity", OLD.amount, OLD."baseAmount")
  ) THEN
    RAISE EXCEPTION 'El renglón de una devolución recibida no se modifica' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_return_lines_received_is_final
BEFORE UPDATE ON public.sales_return_lines
FOR EACH ROW EXECUTE FUNCTION sales_return_lines_received_is_final();

-- Payments of an order, now with its received returns: what the customer
-- keeps paid (payments − what was given back as saldo a favor or reintegro)
-- never exceeds the net total (total − value returned). Replaces the rule of
-- 20261124140000_order_payments; same trigger, same lock of the order row.
CREATE OR REPLACE FUNCTION sales_order_payments_within_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_total NUMERIC;
  paid NUMERIC;
  returned NUMERIC;
  settled NUMERIC;
BEGIN
  SELECT total INTO order_total FROM public.sales_orders WHERE id = NEW."salesOrderId" FOR UPDATE;
  SELECT COALESCE(SUM(amount), 0) INTO paid FROM public.sales_order_payments WHERE "salesOrderId" = NEW."salesOrderId";
  SELECT COALESCE(SUM(amount), 0), COALESCE(SUM("settledAmount"), 0) INTO returned, settled
  FROM public.sales_returns WHERE "salesOrderId" = NEW."salesOrderId" AND status::text = 'RECEIVED';
  IF paid - settled > order_total - returned THEN
    RAISE EXCEPTION 'Los pagos de la orden (% menos % devueltos al cliente) superan su total neto (% menos % devuelto)',
      paid, settled, order_total, returned
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Saldo a favor: the payments made with it never exceed what the customer
-- was credited by received returns. Derived (no stored balance); the
-- customer row is locked so two payments of the same customer are checked
-- one after the other (the API locks it too before reading the balance).
CREATE FUNCTION sales_order_payments_customer_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  customer TEXT;
  credited NUMERIC;
  used NUMERIC;
BEGIN
  IF NEW.medium::text <> 'CREDIT_BALANCE' THEN
    RETURN NEW;
  END IF;
  SELECT "customerId" INTO customer FROM public.sales_orders WHERE id = NEW."salesOrderId";
  PERFORM 1 FROM public.customers WHERE id = customer FOR UPDATE;
  SELECT COALESCE(SUM("settledAmount"), 0) INTO credited FROM public.sales_returns
  WHERE "customerId" = customer AND status::text = 'RECEIVED' AND settlement::text = 'CREDIT';
  SELECT COALESCE(SUM(p.amount), 0) INTO used
  FROM public.sales_order_payments p JOIN public.sales_orders o ON o.id = p."salesOrderId"
  WHERE o."customerId" = customer AND p.medium::text = 'CREDIT_BALANCE';
  IF used > credited THEN
    RAISE EXCEPTION 'El saldo a favor del cliente (%) no alcanza: los pagos con saldo a favor suman %', credited, used
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_payments_customer_credit
AFTER INSERT OR UPDATE OF amount, medium ON public.sales_order_payments
FOR EACH ROW EXECUTE FUNCTION sales_order_payments_customer_credit();
