-- Billing (additive): role and task kind BILLING; sales orders record whether
-- they need an invoice (made in another software) and its number. Existing
-- orders: requiresBilling = false, nothing else changes.

-- AlterEnum
ALTER TYPE "TaskKind" ADD VALUE 'BILLING';

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'BILLING';

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "billedAt" TIMESTAMPTZ(3),
ADD COLUMN     "billedById" TEXT,
ADD COLUMN     "billingRequestedAt" TIMESTAMPTZ(3),
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "requiresBilling" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "salesOrderId" TEXT;

-- CreateIndex
CREATE INDEX "sales_orders_requiresBilling_billedAt_idx" ON "sales_orders"("requiresBilling", "billedAt");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_salesOrderId_kind_key" ON "tasks"("salesOrderId", "kind");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_billedById_fkey" FOREIGN KEY ("billedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business rules enforced by the database (custom SQL, keep when editing).
-- New enum values cannot be used as literals in the transaction that adds
-- them: compared as text.

-- BILLING tasks are linked to their order; no other task is.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sales_order_link" CHECK (
  (kind::text = 'BILLING') = ("salesOrderId" IS NOT NULL)
);

-- Billing of an order: requested ⇔ request date; billed only if required,
-- and number, date and author always together.
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_billing_valid" CHECK (
  "requiresBilling" = ("billingRequestedAt" IS NOT NULL)
  AND ("billedAt" IS NULL) = ("invoiceNumber" IS NULL)
  AND ("billedAt" IS NULL) = ("billedById" IS NULL)
  AND ("billedAt" IS NULL OR "requiresBilling")
  AND ("invoiceNumber" IS NULL OR length(btrim("invoiceNumber")) > 0)
);
