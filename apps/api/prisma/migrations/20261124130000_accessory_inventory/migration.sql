-- Accessories, delivery 1 (additive; docs/accesorios-fase-1.md): accessory
-- warehouses, baskets (bundles with basket = true: one chip per fixed basket,
-- one basket per reference, finish and location, refilled by entries and
-- taken by parts), basket lots (origin only), entry and no-sale exit
-- vouchers whose lines are their movements, and the administrator's notice
-- task. Existing rows do not change (basket = false, no vouchers).
-- CreateEnum
CREATE TYPE "AccessoryVoucherKind" AS ENUM ('ENTRY', 'EXIT');

-- CreateEnum
CREATE TYPE "AccessoryExitType" AS ENUM ('UNREGISTERED_SALE', 'INTERNAL_USE');

-- AlterEnum
ALTER TYPE "InventoryLocationType" ADD VALUE 'ACCESSORY_WAREHOUSE';

-- AlterEnum
ALTER TYPE "LotKind" ADD VALUE 'ACCESSORY_BASKET';

-- AlterEnum
ALTER TYPE "TaskKind" ADD VALUE 'ACCESSORY_NOTICE';

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "basket" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "accessoryVoucherId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "accessoryVoucherId" TEXT;

-- CreateTable
CREATE TABLE "accessory_vouchers" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "kind" "AccessoryVoucherKind" NOT NULL,
    "inventoryLocationId" TEXT NOT NULL,
    "supplierName" TEXT,
    "documentNumber" TEXT,
    "arrivalDate" DATE,
    "exitType" "AccessoryExitType",
    "detail" TEXT,
    "receivedBy" TEXT,
    "notes" TEXT,
    "operationKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accessory_vouchers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accessory_vouchers_number_key" ON "accessory_vouchers"("number");

-- CreateIndex
CREATE UNIQUE INDEX "accessory_vouchers_operationKey_key" ON "accessory_vouchers"("operationKey");

-- CreateIndex
CREATE INDEX "accessory_vouchers_kind_createdAt_idx" ON "accessory_vouchers"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "accessory_vouchers_inventoryLocationId_idx" ON "accessory_vouchers"("inventoryLocationId");

-- CreateIndex
CREATE INDEX "accessory_vouchers_createdById_idx" ON "accessory_vouchers"("createdById");

-- CreateIndex
CREATE INDEX "inventory_movements_accessoryVoucherId_idx" ON "inventory_movements"("accessoryVoucherId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_accessoryVoucherId_key" ON "tasks"("accessoryVoucherId");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_accessoryVoucherId_fkey" FOREIGN KEY ("accessoryVoucherId") REFERENCES "accessory_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_accessoryVoucherId_fkey" FOREIGN KEY ("accessoryVoucherId") REFERENCES "accessory_vouchers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accessory_vouchers" ADD CONSTRAINT "accessory_vouchers_inventoryLocationId_fkey" FOREIGN KEY ("inventoryLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accessory_vouchers" ADD CONSTRAINT "accessory_vouchers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Business rules enforced by the database (custom SQL, keep when editing) ----

-- One basket per reference and finish in each accessories warehouse.
CREATE UNIQUE INDEX bundles_one_basket_per_material
ON public.bundles ("referenceId", "finishId", "inventoryLocationId") WHERE basket;

-- A basket is never opened: its units are always taken by parts.
ALTER TABLE public.bundles
ADD CONSTRAINT bundles_basket_never_opened
CHECK (NOT basket OR "openedAt" IS NULL);

-- Basket lots carry only the origin, so national ones have no supplier, like
-- opening lots. Compared as text: an enum value cannot be used as a literal
-- in the same transaction that adds it.
ALTER TABLE public.stock_lots DROP CONSTRAINT stock_lots_national_supplier;
ALTER TABLE public.stock_lots
ADD CONSTRAINT stock_lots_national_supplier
CHECK (origin <> 'NATIONAL' OR "supplierId" IS NOT NULL OR kind::text IN ('OPENING', 'ACCESSORY_BASKET'));

-- Header of a voucher by kind: an entry has its support (supplier and
-- invoice or delivery note); an exit its type and detail.
ALTER TABLE public.accessory_vouchers
ADD CONSTRAINT accessory_vouchers_valid
CHECK (
    CASE kind::text
        WHEN 'ENTRY' THEN
            length(btrim(coalesce("supplierName", ''))) > 0
            AND length(btrim(coalesce("documentNumber", ''))) > 0
            AND "exitType" IS NULL
            AND "detail" IS NULL
            AND "receivedBy" IS NULL
        WHEN 'EXIT' THEN
            "exitType" IS NOT NULL
            AND length(btrim(coalesce("detail", ''))) > 0
            AND "supplierName" IS NULL
            AND "documentNumber" IS NULL
            AND "arrivalDate" IS NULL
        ELSE false
    END
);

-- Lines of a voucher: ENTRY or EXIT movements, one per basket.
ALTER TABLE public.inventory_movements
ADD CONSTRAINT inventory_movements_accessory_voucher_type
CHECK ("accessoryVoucherId" IS NULL OR type::text IN ('ENTRY', 'EXIT'));

CREATE UNIQUE INDEX inventory_movements_one_line_per_basket
ON public.inventory_movements ("accessoryVoucherId", "bundleId")
WHERE "accessoryVoucherId" IS NOT NULL;

-- Notice tasks point to their voucher, and only they do.
ALTER TABLE public.tasks
ADD CONSTRAINT tasks_accessory_voucher_link
CHECK ((kind::text = 'ACCESSORY_NOTICE') = ("accessoryVoucherId" IS NOT NULL));

-- Numbering: IA-000001 (entries) and SS-000001 (exits without a sale).
CREATE SEQUENCE IF NOT EXISTS accessory_entry_number_seq;
CREATE SEQUENCE IF NOT EXISTS accessory_exit_number_seq;