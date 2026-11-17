-- Kind of sale of a quote and its order: «Detal» (materials only, the
-- behaviour until now) or «Ventanería» (materials plus, optionally, the
-- assembly of the window in the workshop and its installation).
-- Existing quotes and orders become RETAIL with no services: their values do
-- not change (their totals were made of material lines only).

-- CreateEnum
CREATE TYPE "SaleType" AS ENUM ('RETAIL', 'WINDOWS');

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "assemblyAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "installationAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "saleType" "SaleType" NOT NULL DEFAULT 'RETAIL';

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "assemblyAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "installationAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "saleType" "SaleType" NOT NULL DEFAULT 'RETAIL';

-- Services are whole amounts typed by the seller (no VAT, no discounts), never
-- negative, and only in «Ventanería»: no hidden labour charge in «Detal».
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_services_valid" CHECK (
  "assemblyAmount" >= 0 AND "installationAmount" >= 0
  AND ("saleType" = 'WINDOWS' OR ("assemblyAmount" = 0 AND "installationAmount" = 0))
);
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_services_valid" CHECK (
  "assemblyAmount" >= 0 AND "installationAmount" >= 0
  AND ("saleType" = 'WINDOWS' OR ("assemblyAmount" = 0 AND "installationAmount" = 0))
);
