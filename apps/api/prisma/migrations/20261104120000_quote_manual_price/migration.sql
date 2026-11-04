-- Manual prices on quote lines, authorised by an administrator the seller
-- chooses (same request/task flow as the global discount, new request kind).
-- Order lines keep the reason and the administrator who authorised the price.
-- CreateEnum
CREATE TYPE "QuoteRequestKind" AS ENUM ('GLOBAL_DISCOUNT', 'MANUAL_PRICE');

-- AlterTable
ALTER TABLE "quote_discount_requests" ADD COLUMN     "details" JSONB,
ADD COLUMN     "kind" "QuoteRequestKind" NOT NULL DEFAULT 'GLOBAL_DISCOUNT',
ADD COLUMN     "replacedById" TEXT,
ALTER COLUMN "requestedPercent" DROP NOT NULL;

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "estimatedUnitCost" DECIMAL(18,6),
ADD COLUMN     "manualApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "manualApprovedById" TEXT;

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "manualApprovedById" TEXT,
ADD COLUMN     "manualPrice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "priceReason" TEXT;

-- AddForeignKey
ALTER TABLE "quote_discount_requests" ADD CONSTRAINT "quote_discount_requests_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "quote_discount_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_manualApprovedById_fkey" FOREIGN KEY ("manualApprovedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_manualApprovedById_fkey" FOREIGN KEY ("manualApprovedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Business rules enforced by the database (custom SQL, keep when editing) ---

-- Manual lines saved before this flow existed were set by an administrator
-- under the previous rules: they stay authorised by the quote's creator.
UPDATE "quote_lines" ql
SET "manualApprovedById" = q."createdById", "manualApprovedAt" = q."createdAt"
FROM "quotes" q
WHERE ql."quoteId" = q.id AND ql."pricingMethod" = 'MANUAL';

-- Authorisation and estimated cost only on manual lines; authorised by
-- someone at some time, or not at all.
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_manual_price"
CHECK (
  ("manualApprovedById" IS NULL) = ("manualApprovedAt" IS NULL)
  AND ("manualApprovedById" IS NULL OR "pricingMethod" = 'MANUAL')
  AND ("estimatedUnitCost" IS NULL OR ("estimatedUnitCost" > 0 AND "pricingMethod" = 'MANUAL'))
  AND ("priceReason" IS NULL OR char_length("priceReason") <= 1000)
);

-- A manual-price order line carries its reason and its authoriser.
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_manual_price"
CHECK (
  NOT "manualPrice"
  OR (length(btrim(coalesce("priceReason", ''))) > 0 AND "manualApprovedById" IS NOT NULL)
);

-- Requests: a percentage only for the global discount; manual prices carry
-- their snapshot instead. Same status rules as before.
ALTER TABLE "quote_discount_requests" DROP CONSTRAINT "quote_discount_requests_values";

ALTER TABLE "quote_discount_requests" ADD CONSTRAINT "quote_discount_requests_values"
CHECK (
  CASE "kind"
    WHEN 'GLOBAL_DISCOUNT' THEN "requestedPercent" IS NOT NULL AND "requestedPercent" > 0 AND "requestedPercent" <= 100
    ELSE "requestedPercent" IS NULL AND "details" IS NOT NULL
  END
  AND ("status" = 'PENDING') = ("resolvedAt" IS NULL)
  AND ("resolution" IS NULL OR "status" = 'REJECTED')
  AND ("replacedById" IS NULL OR "status" = 'CANCELLED')
  AND ("reason" IS NULL OR char_length("reason") <= 500)
  AND ("resolution" IS NULL OR char_length("resolution") <= 500)
  AND "approverId" <> "requestedById"
);

-- At most one open request of each kind per quote.
DROP INDEX "quote_discount_requests_one_pending";

CREATE UNIQUE INDEX "quote_discount_requests_one_pending"
ON "quote_discount_requests" ("quoteId", "kind") WHERE "status" = 'PENDING';
