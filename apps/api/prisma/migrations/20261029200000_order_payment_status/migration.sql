-- Collection state of orders sold by abono (PARTIAL) or on credit (CREDIT):
-- PENDING until the owner or ADMIN marks it PAID. Cash and transfer orders
-- (and orders without payment method) keep NULL.

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID');

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "paymentStatus" "PaymentStatus",
ADD COLUMN     "paymentStatusAt" TIMESTAMPTZ(3),
ADD COLUMN     "paymentStatusById" TEXT;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_paymentStatusById_fkey" FOREIGN KEY ("paymentStatusById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Orders already converted with abono or credit: nothing says they were paid,
-- so they start as pending (no author or date: nobody marked them).
UPDATE "sales_orders" SET "paymentStatus" = 'PENDING' WHERE "paymentMethod" IN ('PARTIAL', 'CREDIT');

-- A state exists exactly for abono / credit orders.
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_payment_status_by_method" CHECK (
  CASE WHEN "paymentMethod" IN ('PARTIAL', 'CREDIT') THEN "paymentStatus" IS NOT NULL ELSE "paymentStatus" IS NULL END
);
