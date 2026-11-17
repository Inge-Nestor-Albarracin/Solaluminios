-- When the seller saw the administrator's answer to its request for a global
-- discount or a manual price (in-app notice of the sales menu). NULL = the
-- answer was not seen yet.
ALTER TABLE "quote_discount_requests" ADD COLUMN "requesterSeenAt" TIMESTAMPTZ(3);

-- Answers given before this notice existed are not announced again: they
-- count as seen when they were answered. Nothing else changes.
UPDATE "quote_discount_requests"
SET "requesterSeenAt" = "resolvedAt"
WHERE status IN ('APPROVED', 'REJECTED') AND "resolvedAt" IS NOT NULL;

-- CreateIndex
CREATE INDEX "quote_discount_requests_requestedById_requesterSeenAt_idx" ON "quote_discount_requests"("requestedById", "requesterSeenAt");
