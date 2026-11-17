-- Material requests: Sales asks a warehouse for profiles for a branch (e.g.
-- Almacén 7 de agosto) without chips or bundles; a warehouse worker prepares
-- whole bundles (reserved entirely), confirms the shipment (transfer) and the
-- branch marks it received. Existing data does not change: reservations of
-- sales orders keep their order line; existing tasks keep their kind.

-- CreateEnum
CREATE TYPE "MaterialRequestStatus" AS ENUM ('SENT', 'PREPARING', 'SHIPPED', 'RECEIVED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TaskKind" ADD VALUE 'MATERIAL_REQUEST';
ALTER TYPE "TaskKind" ADD VALUE 'MATERIAL_RECEPTION';

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "materialRequestId" TEXT;

-- AlterTable
ALTER TABLE "stock_reservations" ADD COLUMN     "materialRequestLineId" TEXT,
ALTER COLUMN "salesOrderLineId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "materialRequestId" TEXT;

-- CreateTable
CREATE TABLE "material_requests" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "status" "MaterialRequestStatus" NOT NULL DEFAULT 'SENT',
    "sourceLocationId" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "notes" TEXT,
    "assigneeId" TEXT NOT NULL,
    "createOperationKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "shipOperationKey" TEXT,
    "shippedAt" TIMESTAMPTZ(3),
    "shippedById" TEXT,
    "receivedAt" TIMESTAMPTZ(3),
    "receivedById" TEXT,
    "receptionNote" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "material_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_request_lines" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "origin" "MaterialOrigin" NOT NULL,
    "supplierId" TEXT,
    "quantity" INTEGER NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "referenceDescription" TEXT,
    "finishCode" TEXT NOT NULL,
    "finishDescription" TEXT,
    "supplierName" TEXT,

    CONSTRAINT "material_request_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_request_picks" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestLineId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_request_picks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "material_requests_number_key" ON "material_requests"("number");

-- CreateIndex
CREATE UNIQUE INDEX "material_requests_createOperationKey_key" ON "material_requests"("createOperationKey");

-- CreateIndex
CREATE UNIQUE INDEX "material_requests_shipOperationKey_key" ON "material_requests"("shipOperationKey");

-- CreateIndex
CREATE INDEX "material_requests_status_createdAt_idx" ON "material_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "material_requests_sourceLocationId_createdAt_idx" ON "material_requests"("sourceLocationId", "createdAt");

-- CreateIndex
CREATE INDEX "material_requests_createdById_createdAt_idx" ON "material_requests"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "material_requests_assigneeId_status_idx" ON "material_requests"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "material_request_lines_requestId_lineNo_key" ON "material_request_lines"("requestId", "lineNo");

-- CreateIndex
CREATE INDEX "material_request_picks_bundleId_idx" ON "material_request_picks"("bundleId");

-- CreateIndex
CREATE INDEX "material_request_picks_requestLineId_idx" ON "material_request_picks"("requestLineId");

-- CreateIndex
CREATE UNIQUE INDEX "material_request_picks_requestId_bundleId_key" ON "material_request_picks"("requestId", "bundleId");

-- CreateIndex
CREATE INDEX "inventory_movements_materialRequestId_idx" ON "inventory_movements"("materialRequestId");

-- CreateIndex
CREATE INDEX "stock_reservations_materialRequestLineId_status_idx" ON "stock_reservations"("materialRequestLineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_materialRequestId_kind_key" ON "tasks"("materialRequestId", "kind");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_materialRequestId_fkey" FOREIGN KEY ("materialRequestId") REFERENCES "material_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_materialRequestId_fkey" FOREIGN KEY ("materialRequestId") REFERENCES "material_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_materialRequestLineId_fkey" FOREIGN KEY ("materialRequestLineId") REFERENCES "material_request_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_sourceLocationId_fkey" FOREIGN KEY ("sourceLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_destinationLocationId_fkey" FOREIGN KEY ("destinationLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_shippedById_fkey" FOREIGN KEY ("shippedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "material_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_finishId_fkey" FOREIGN KEY ("finishId") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_picks" ADD CONSTRAINT "material_request_picks_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "material_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_picks" ADD CONSTRAINT "material_request_picks_requestLineId_fkey" FOREIGN KEY ("requestLineId") REFERENCES "material_request_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_picks" ADD CONSTRAINT "material_request_picks_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_request_picks" ADD CONSTRAINT "material_request_picks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Numbers SM-000001…
CREATE SEQUENCE IF NOT EXISTS material_request_number_seq;

-- A reservation belongs to exactly one need: a sales order line or a material
-- request line; only order reservations go through sales dispatches.
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_one_target" CHECK (
  ("salesOrderLineId" IS NULL) <> ("materialRequestLineId" IS NULL)
  AND ("dispatchLineId" IS NULL OR "salesOrderLineId" IS NOT NULL)
);

-- Material request tasks are linked to their request (compared as text: the
-- new enum values cannot be used as literals in the transaction that adds them).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_material_request_link" CHECK (
  (kind::text IN ('MATERIAL_REQUEST', 'MATERIAL_RECEPTION')) = ("materialRequestId" IS NOT NULL)
);

ALTER TABLE "material_requests" ADD CONSTRAINT "material_requests_valid" CHECK (
  "sourceLocationId" <> "destinationLocationId"
  AND (status::text IN ('SHIPPED', 'RECEIVED')) = ("shippedAt" IS NOT NULL)
  AND ("shippedAt" IS NULL) = ("shipOperationKey" IS NULL)
  AND ("shippedAt" IS NULL) = ("shippedById" IS NULL)
  AND (status::text = 'RECEIVED') = ("receivedAt" IS NOT NULL)
  AND ("receivedAt" IS NULL) = ("receivedById" IS NULL)
  AND (status::text = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
  AND ("cancelledAt" IS NULL) = ("cancelledById" IS NULL)
  AND ("notes" IS NULL OR char_length("notes") <= 1000)
  AND ("receptionNote" IS NULL OR char_length("receptionNote") <= 500)
  AND ("cancelReason" IS NULL OR char_length("cancelReason") <= 300)
);

ALTER TABLE "material_request_lines" ADD CONSTRAINT "material_request_lines_quantity" CHECK (quantity > 0);
ALTER TABLE "material_request_picks" ADD CONSTRAINT "material_request_picks_quantity" CHECK (quantity > 0);
