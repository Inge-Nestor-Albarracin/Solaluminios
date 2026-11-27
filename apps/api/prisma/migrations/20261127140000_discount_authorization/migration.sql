-- Discounts above the seller's 3 % carry who authorised them (QA finding
-- SEC-01): a seller could keep a discount nobody authorised by saving a line
-- again with the enabled price. Additive: new nullable columns, checks of
-- consistency, a backfill of the global approvals already given, and
-- triggers that refuse inserting an order with an unauthorised discount.

-- AlterTable
ALTER TABLE "quote_lines" ADD COLUMN     "discountApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "discountApprovedById" TEXT;

-- AlterTable
ALTER TABLE "quotes" ADD COLUMN     "globalDiscountApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "globalDiscountApprovedBase" DECIMAL(18,2),
ADD COLUMN     "globalDiscountApprovedById" TEXT,
ADD COLUMN     "globalDiscountApprovedPercent" DECIMAL(9,4);

-- AlterTable
ALTER TABLE "sales_order_lines" ADD COLUMN     "discountApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "discountApprovedById" TEXT;

-- AlterTable
ALTER TABLE "sales_orders" ADD COLUMN     "globalDiscountApprovedAt" TIMESTAMPTZ(3),
ADD COLUMN     "globalDiscountApprovedById" TEXT;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_globalDiscountApprovedById_fkey" FOREIGN KEY ("globalDiscountApprovedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_discountApprovedById_fkey" FOREIGN KEY ("discountApprovedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_globalDiscountApprovedById_fkey" FOREIGN KEY ("globalDiscountApprovedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_discountApprovedById_fkey" FOREIGN KEY ("discountApprovedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who and when go together; the global approval also with its percentage
-- and base.
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_discount_approval"
  CHECK (("discountApprovedById" IS NULL) = ("discountApprovedAt" IS NULL));
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_discount_approval"
  CHECK (("discountApprovedById" IS NULL) = ("discountApprovedAt" IS NULL));
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_global_discount_approval"
  CHECK (
    num_nulls("globalDiscountApprovedPercent", "globalDiscountApprovedBase", "globalDiscountApprovedById", "globalDiscountApprovedAt") IN (0, 4)
    AND ("globalDiscountApprovedPercent" IS NULL OR ("globalDiscountApprovedPercent" > 0 AND "globalDiscountApprovedPercent" <= 100))
    AND ("globalDiscountApprovedBase" IS NULL OR "globalDiscountApprovedBase" >= 0)
  );
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_global_discount_approval"
  CHECK (("globalDiscountApprovedById" IS NULL) = ("globalDiscountApprovedAt" IS NULL));

-- Global discounts already approved through a request: the largest approved
-- percentage of each quote, by the administrator who answered it, bound to
-- the quote's current base (from now on the seller keeps it only while the
-- base does not grow). Line discounts are not backfilled: nothing records
-- who set them, so an unauthorised one needs an administrator again.
UPDATE "quotes" AS q
SET "globalDiscountApprovedPercent" = r."requestedPercent",
    "globalDiscountApprovedBase" = q."subtotal" - q."discountTotal",
    "globalDiscountApprovedById" = r."approverId",
    "globalDiscountApprovedAt" = COALESCE(r."resolvedAt", r."updatedAt")
FROM (
  SELECT DISTINCT ON ("quoteId") "quoteId", "requestedPercent", "approverId", "resolvedAt", "updatedAt"
  FROM "quote_discount_requests"
  WHERE "kind"::text = 'GLOBAL_DISCOUNT' AND "status"::text = 'APPROVED' AND "requestedPercent" IS NOT NULL
  ORDER BY "quoteId", "requestedPercent" DESC, "resolvedAt" DESC NULLS LAST, "id" DESC
) AS r
WHERE r."quoteId" = q."id";

-- Orders converted from those quotes record the same approval.
UPDATE "sales_orders" AS o
SET "globalDiscountApprovedById" = q."globalDiscountApprovedById",
    "globalDiscountApprovedAt" = q."globalDiscountApprovedAt"
FROM "quotes" AS q
WHERE o."quoteId" = q."id"
  AND q."globalDiscountApprovedById" IS NOT NULL
  AND o."globalDiscountPercent" > 3
  AND o."globalDiscountPercent" <= q."globalDiscountApprovedPercent";

-- An order is inserted only with authorised discounts. Above 3 % (the
-- seller's limits SELLER_LINE_DISCOUNT_LIMIT and SELLER_GLOBAL_DISCOUNT_LIMIT
-- of pricing.ts; change them together) a line needs its manual price or its
-- discount authorised, and the order its global discount. On insert only:
-- orders made before keep their data and are still updated as usual.
CREATE FUNCTION sales_order_lines_discount_authorised() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."discountPercent" > 3
     AND NOT (NEW."manualPrice" AND NEW."manualApprovedById" IS NOT NULL)
     AND NEW."discountApprovedById" IS NULL THEN
    RAISE EXCEPTION 'Renglón %: el descuento de % %% no tiene autorización de un administrador', NEW."lineNo", NEW."discountPercent"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_lines_discount_authorised
  BEFORE INSERT ON "sales_order_lines"
  FOR EACH ROW EXECUTE FUNCTION sales_order_lines_discount_authorised();

CREATE FUNCTION sales_orders_global_discount_authorised() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."globalDiscountPercent" > 3 AND NEW."globalDiscountApprovedById" IS NULL THEN
    RAISE EXCEPTION 'El descuento global de % %% no tiene autorización de un administrador', NEW."globalDiscountPercent"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_orders_global_discount_authorised
  BEFORE INSERT ON "sales_orders"
  FOR EACH ROW EXECUTE FUNCTION sales_orders_global_discount_authorised();
