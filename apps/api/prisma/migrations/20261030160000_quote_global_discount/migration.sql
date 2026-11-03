-- Global discount on quotes (and the orders converted from them), and the
-- requests a seller sends to an administrator of their choice when the
-- discount exceeds the seller's own limit. Existing quotes, orders and lines
-- get 0: their totals do not change.
-- CreateEnum
CREATE TYPE "QuoteDiscountRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "TaskKind" ADD VALUE 'DISCOUNT_APPROVAL';

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "globalDiscountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "globalDiscountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "globalDiscountPercent" DECIMAL(9,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "globalDiscountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "globalDiscountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "globalDiscountPercent" DECIMAL(9,4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "discountRequestId" TEXT;

-- CreateTable
CREATE TABLE "quote_discount_requests" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "requestedPercent" DECIMAL(9,4) NOT NULL,
    "reason" TEXT,
    "status" "QuoteDiscountRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quote_discount_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quote_discount_requests_quoteId_createdAt_idx" ON "quote_discount_requests"("quoteId", "createdAt");

-- CreateIndex
CREATE INDEX "quote_discount_requests_approverId_status_idx" ON "quote_discount_requests"("approverId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_discountRequestId_key" ON "tasks"("discountRequestId");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_discountRequestId_fkey" FOREIGN KEY ("discountRequestId") REFERENCES "quote_discount_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_discount_requests" ADD CONSTRAINT "quote_discount_requests_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_discount_requests" ADD CONSTRAINT "quote_discount_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_discount_requests" ADD CONSTRAINT "quote_discount_requests_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business rules enforced by the database (custom SQL, keep when editing) ---

-- 0 (no global discount) or between 0.1 % and 100 %.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_global_discount"
CHECK (
  ("globalDiscountPercent" = 0 OR ("globalDiscountPercent" >= 0.1 AND "globalDiscountPercent" <= 100))
  AND "globalDiscountAmount" >= 0
);

ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_global_discount"
CHECK (
  ("globalDiscountPercent" = 0 OR ("globalDiscountPercent" >= 0.1 AND "globalDiscountPercent" <= 100))
  AND "globalDiscountAmount" >= 0
);

ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_global_discount" CHECK ("globalDiscountAmount" >= 0);
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_global_discount" CHECK ("globalDiscountAmount" >= 0);

-- A request is open (PENDING, not resolved) or resolved with its date; only a
-- rejection carries the administrator's reason. Nobody approves their own.
ALTER TABLE "quote_discount_requests" ADD CONSTRAINT "quote_discount_requests_values"
CHECK (
  "requestedPercent" > 0 AND "requestedPercent" <= 100
  AND ("status" = 'PENDING') = ("resolvedAt" IS NULL)
  AND ("resolution" IS NULL OR "status" = 'REJECTED')
  AND ("reason" IS NULL OR char_length("reason") <= 500)
  AND ("resolution" IS NULL OR char_length("resolution") <= 500)
  AND "approverId" <> "requestedById"
);

-- At most one open request per quote (two clicks or two tabs cannot create two).
CREATE UNIQUE INDEX "quote_discount_requests_one_pending"
ON "quote_discount_requests" ("quoteId") WHERE "status" = 'PENDING';

-- Tasks: a discount approval task is linked to its request and, like dispatch
-- tasks, may be answered after its deadline. Compared as text: the new enum
-- value cannot be used as a literal in the transaction that adds it.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_discount_request_link"
CHECK ((kind::text = 'DISCOUNT_APPROVAL') = ("discountRequestId" IS NOT NULL));

ALTER TABLE "tasks" DROP CONSTRAINT "tasks_completed_before_due";

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_before_due"
CHECK (
  "completedAt" IS NULL
  OR ("completedAt" >= "createdAt" AND (kind::text <> 'GENERAL' OR "completedAt" <= "dueAt"))
);
