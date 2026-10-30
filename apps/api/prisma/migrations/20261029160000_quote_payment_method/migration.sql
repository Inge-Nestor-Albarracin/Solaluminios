-- Payment method agreed in a quote (copied to its sales order) and who
-- converted each quote into an order. Existing quotes and orders keep NULL:
-- nothing is assumed about how they were agreed or who converted them.

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'PARTIAL', 'CREDIT');

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "paymentTerms" TEXT;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "convertedById" TEXT,
ADD COLUMN     "paymentMethod" "PaymentMethod",
ADD COLUMN     "paymentTerms" TEXT;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_convertedById_fkey" FOREIGN KEY ("convertedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Free-text terms stay short (same limit as the API).
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_payment_terms_length" CHECK ("paymentTerms" IS NULL OR char_length("paymentTerms") <= 300);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_payment_terms_length" CHECK ("paymentTerms" IS NULL OR char_length("paymentTerms") <= 300);
