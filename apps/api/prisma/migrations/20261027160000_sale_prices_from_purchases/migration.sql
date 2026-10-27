-- Sale prices linked to a specific purchase line (purchase -> line -> price).
-- Additive: no existing row is changed or deleted. Existing purchase lines
-- keep grossIncludesTax = false (earlier cost definition, kept as recorded);
-- existing quote/order lines keep salePriceId = NULL (no link is invented).

-- AlterTable
ALTER TABLE "purchase_lines" ADD COLUMN     "grossIncludesTax" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "salePriceId" TEXT;

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "salePriceId" TEXT;

-- CreateTable
CREATE TABLE "sale_prices" (
    "id" TEXT NOT NULL,
    "purchaseLineId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "origin" "MaterialOrigin" NOT NULL,
    "unitCost" DECIMAL(18,6) NOT NULL,
    "markupPercent" DECIMAL(9,4) NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMPTZ(3),
    "disabledAt" TIMESTAMPTZ(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sale_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_prices_referenceId_finishId_origin_idx" ON "sale_prices"("referenceId", "finishId", "origin");

-- CreateIndex
CREATE INDEX "sale_prices_purchaseLineId_idx" ON "sale_prices"("purchaseLineId");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_lines_id_referenceId_finishId_origin_key" ON "purchase_lines"("id", "referenceId", "finishId", "origin");

-- AddForeignKey
ALTER TABLE "sale_prices" ADD CONSTRAINT "sale_prices_purchaseLineId_referenceId_finishId_origin_fkey" FOREIGN KEY ("purchaseLineId", "referenceId", "finishId", "origin") REFERENCES "purchase_lines"("id", "referenceId", "finishId", "origin") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sale_prices" ADD CONSTRAINT "sale_prices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_salePriceId_fkey" FOREIGN KEY ("salePriceId") REFERENCES "sale_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_salePriceId_fkey" FOREIGN KEY ("salePriceId") REFERENCES "sale_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Values of a sale price.
ALTER TABLE public.sale_prices
ADD CONSTRAINT sale_prices_values
CHECK ("unitCost" > 0 AND "markupPercent" >= 0 AND "markupPercent" <= 1000 AND "unitPrice" > 0);

-- enabledAt is set exactly while the price is enabled.
ALTER TABLE public.sale_prices
ADD CONSTRAINT sale_prices_enabled_consistent
CHECK (NOT enabled OR "enabledAt" IS NOT NULL);

-- At most one price offered to sales per reference, finish and origin: the
-- administrator decides which one; nothing is chosen automatically.
CREATE UNIQUE INDEX sale_prices_one_enabled
ON public.sale_prices ("referenceId", "finishId", origin) WHERE enabled;
