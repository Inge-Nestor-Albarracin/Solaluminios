-- Opening a bundle: its profiles become LOOSE profiles in the same location.
-- The bundle row stays (EPC, history, lot = provenance) and its `quantity`
-- is, from then on, the loose profiles left from it. Existing bundles stay
-- closed (openedAt NULL); nothing is recomputed.

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'OPENING';

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "openedAt" TIMESTAMPTZ(3),
ADD COLUMN     "openedById" TEXT;

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Who opened it is always recorded with the date.
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_opened_by_consistent" CHECK (("openedAt" IS NULL) = ("openedById" IS NULL));

-- A bundle is opened once: the opening can never be undone or repeated.
CREATE FUNCTION bundle_opened_is_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."openedAt" IS NOT NULL AND (NEW."openedAt" IS DISTINCT FROM OLD."openedAt" OR NEW."openedById" IS DISTINCT FROM OLD."openedById") THEN
    RAISE EXCEPTION 'bundle % was already opened', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bundles_opened_is_final
BEFORE UPDATE OF "openedAt", "openedById" ON public.bundles
FOR EACH ROW EXECUTE FUNCTION bundle_opened_is_final();

-- Balance rule of each movement type, now with OPENING (no change of balance
-- or place). Compared as text: the new enum value cannot be used as an enum
-- literal in the same transaction that adds it.
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
