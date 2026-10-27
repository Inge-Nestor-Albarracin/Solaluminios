-- CreateEnum
CREATE TYPE "MaterialOrigin" AS ENUM ('CHINA', 'NATIONAL');

-- CreateEnum
CREATE TYPE "TaskKind" AS ENUM ('GENERAL', 'DISPATCH');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "LotKind" AS ENUM ('CHINA_SHIPMENT', 'MANUAL_ENTRY', 'OPENING');

-- CreateEnum
CREATE TYPE "PreRegistrationStatus" AS ENUM ('PENDING', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseStatus" AS ENUM ('DRAFT', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('NONE', 'PERCENT', 'AMOUNT');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'CONVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PricingMethod" AS ENUM ('MARKUP_ON_COST', 'GROSS_MARGIN', 'MANUAL');

-- CreateEnum
CREATE TYPE "SalesOrderStatus" AS ENUM ('DRAFT', 'PENDING_SUPPLY', 'CONFIRMED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "DispatchStatus" AS ENUM ('OPEN', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncidentKind" AS ENUM ('UNKNOWN_EPC', 'WRONG_MATERIAL', 'WRONG_ORIGIN', 'WRONG_SUPPLIER', 'UNKNOWN_ORIGIN', 'WRONG_LOCATION', 'INSUFFICIENT', 'NOT_AVAILABLE', 'ALREADY_DISPATCHED', 'OTHER');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ReaderSessionStatus" AS ENUM ('OPEN', 'CLOSED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'CHINA_OPERATOR';

-- AlterTable
ALTER TABLE "bundles" ADD COLUMN     "lotId" TEXT;

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "dispatchId" TEXT;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "cancelledAt" TIMESTAMPTZ(3),
ADD COLUMN     "dispatchId" TEXT,
ADD COLUMN     "kind" "TaskKind" NOT NULL DEFAULT 'GENERAL';

-- CreateTable
CREATE TABLE "settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "origins" "MaterialOrigin"[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_shipments" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'OPEN',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbound_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_lots" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "LotKind" NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "origin" "MaterialOrigin" NOT NULL,
    "supplierId" TEXT,
    "shipmentId" TEXT,
    "entryKey" TEXT,
    "purchaseLineId" TEXT,
    "unitCost" DECIMAL(18,6),
    "costConfirmedAt" TIMESTAMPTZ(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_pre_registrations" (
    "id" TEXT NOT NULL,
    "epc" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "expectedQuantity" INTEGER NOT NULL,
    "status" "PreRegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "operationKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBundleId" TEXT,
    "receivedQuantity" INTEGER,
    "receivedAt" TIMESTAMPTZ(3),
    "receivedById" TEXT,
    "discrepancyReason" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inbound_pre_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchases" (
    "id" TEXT NOT NULL,
    "supplierId" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "documentDate" DATE NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'COP',
    "exchangeRate" DECIMAL(18,6),
    "exchangeRateDate" DATE,
    "exchangeRateSource" TEXT,
    "globalDiscountType" "DiscountType" NOT NULL DEFAULT 'NONE',
    "globalDiscountValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "conditionalDiscountNote" TEXT,
    "status" "PurchaseStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "grossTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lineDiscountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "globalDiscountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "chargesTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "documentTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_lines" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "origin" "MaterialOrigin" NOT NULL,
    "unitName" TEXT NOT NULL,
    "profilesPerUnit" DECIMAL(18,3) NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "unitPrice" DECIMAL(18,6) NOT NULL,
    "lineDiscountType" "DiscountType" NOT NULL DEFAULT 'NONE',
    "lineDiscountValue" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxRatePercent" DECIMAL(9,4),
    "taxRecoverable" BOOLEAN,
    "grossAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lineDiscountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "globalDiscountAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "chargesAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "costAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "costAmountCop" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "profiles" INTEGER NOT NULL DEFAULT 0,
    "unitCostCop" DECIMAL(18,6),

    CONSTRAINT "purchase_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_charges" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "validUntil" DATE,
    "currency" CHAR(3) NOT NULL DEFAULT 'COP',
    "notes" TEXT,
    "subtotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_lines" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "origin" "MaterialOrigin" NOT NULL,
    "supplierId" TEXT,
    "quantity" INTEGER NOT NULL,
    "pricingMethod" "PricingMethod" NOT NULL,
    "pricingPercent" DECIMAL(9,4),
    "costBasis" DECIMAL(18,6),
    "costLotId" TEXT,
    "priceReason" TEXT,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "taxRatePercent" DECIMAL(9,4) NOT NULL,
    "lineSubtotal" DECIMAL(18,2) NOT NULL,
    "discountAmount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "referenceDescription" TEXT,
    "finishCode" TEXT NOT NULL,
    "finishDescription" TEXT,
    "supplierName" TEXT,

    CONSTRAINT "quote_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_orders" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "quoteId" TEXT,
    "customerId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "inventoryLocationId" TEXT,
    "status" "SalesOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" CHAR(3) NOT NULL DEFAULT 'COP',
    "subtotal" DECIMAL(18,2) NOT NULL,
    "discountTotal" DECIMAL(18,2) NOT NULL,
    "taxTotal" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "notes" TEXT,
    "convertOperationKey" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sales_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_order_lines" (
    "id" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "referenceId" TEXT NOT NULL,
    "finishId" TEXT NOT NULL,
    "origin" "MaterialOrigin" NOT NULL,
    "supplierId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(18,2) NOT NULL,
    "discountPercent" DECIMAL(9,4) NOT NULL,
    "taxRatePercent" DECIMAL(9,4) NOT NULL,
    "lineSubtotal" DECIMAL(18,2) NOT NULL,
    "discountAmount" DECIMAL(18,2) NOT NULL,
    "taxAmount" DECIMAL(18,2) NOT NULL,
    "lineTotal" DECIMAL(18,2) NOT NULL,
    "referenceCode" TEXT NOT NULL,
    "referenceDescription" TEXT,
    "finishCode" TEXT NOT NULL,
    "finishDescription" TEXT,
    "supplierName" TEXT,

    CONSTRAINT "sales_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reservations" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "dispatchLineId" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stock_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatches" (
    "id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "salesOrderId" TEXT NOT NULL,
    "inventoryLocationId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "dueAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "DispatchStatus" NOT NULL DEFAULT 'OPEN',
    "partial" BOOLEAN NOT NULL DEFAULT false,
    "createOperationKey" TEXT NOT NULL,
    "confirmOperationKey" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMPTZ(3),
    "confirmedById" TEXT,
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_lines" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "salesOrderLineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "dispatchedQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "dispatch_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_picks" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "dispatchLineId" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispatch_picks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_incidents" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "kind" "IncidentKind" NOT NULL,
    "epc" TEXT NOT NULL,
    "bundleId" TEXT,
    "message" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "source" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "dispatch_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "dispatchId" TEXT,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_devices" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "inventoryLocationId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "simulator" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reader_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_sessions" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "status" "ReaderSessionStatus" NOT NULL DEFAULT 'OPEN',
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "reader_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reader_events" (
    "deviceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reader_events_pkey" PRIMARY KEY ("deviceId","eventId")
);

-- CreateTable
CREATE TABLE "reader_observations" (
    "id" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "contextKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "deviceId" TEXT,
    "sessionId" TEXT,
    "userId" TEXT,
    "epc" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "antenna" INTEGER,
    "rssi" INTEGER,

    CONSTRAINT "reader_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "data" JSONB,
    "reason" TEXT,
    "userId" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "suppliers_code_key" ON "suppliers"("code");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_shipments_code_key" ON "inbound_shipments"("code");

-- CreateIndex
CREATE INDEX "inbound_shipments_supplierId_status_idx" ON "inbound_shipments"("supplierId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_code_key" ON "stock_lots"("code");

-- CreateIndex
CREATE INDEX "stock_lots_referenceId_finishId_origin_supplierId_idx" ON "stock_lots"("referenceId", "finishId", "origin", "supplierId");

-- CreateIndex
CREATE INDEX "stock_lots_purchaseLineId_idx" ON "stock_lots"("purchaseLineId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_shipmentId_referenceId_finishId_key" ON "stock_lots"("shipmentId", "referenceId", "finishId");

-- CreateIndex
CREATE UNIQUE INDEX "stock_lots_entryKey_referenceId_finishId_key" ON "stock_lots"("entryKey", "referenceId", "finishId");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_pre_registrations_operationKey_key" ON "inbound_pre_registrations"("operationKey");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_pre_registrations_receivedBundleId_key" ON "inbound_pre_registrations"("receivedBundleId");

-- CreateIndex
CREATE INDEX "inbound_pre_registrations_epc_idx" ON "inbound_pre_registrations"("epc");

-- CreateIndex
CREATE INDEX "inbound_pre_registrations_createdById_createdAt_idx" ON "inbound_pre_registrations"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "inbound_pre_registrations_shipmentId_idx" ON "inbound_pre_registrations"("shipmentId");

-- CreateIndex
CREATE UNIQUE INDEX "purchases_supplierId_documentNumber_key" ON "purchases"("supplierId", "documentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_lines_purchaseId_lineNo_key" ON "purchase_lines"("purchaseId", "lineNo");

-- CreateIndex
CREATE INDEX "customers_name_idx" ON "customers"("name");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_number_key" ON "quotes"("number");

-- CreateIndex
CREATE INDEX "quotes_createdById_createdAt_idx" ON "quotes"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "quote_lines_quoteId_lineNo_key" ON "quote_lines"("quoteId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_number_key" ON "sales_orders"("number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_quoteId_key" ON "sales_orders"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "sales_orders_convertOperationKey_key" ON "sales_orders"("convertOperationKey");

-- CreateIndex
CREATE INDEX "sales_orders_createdById_createdAt_idx" ON "sales_orders"("createdById", "createdAt");

-- CreateIndex
CREATE INDEX "sales_orders_status_idx" ON "sales_orders"("status");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_lines_salesOrderId_lineNo_key" ON "sales_order_lines"("salesOrderId", "lineNo");

-- CreateIndex
CREATE INDEX "stock_reservations_bundleId_status_idx" ON "stock_reservations"("bundleId", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_salesOrderLineId_status_idx" ON "stock_reservations"("salesOrderLineId", "status");

-- CreateIndex
CREATE INDEX "stock_reservations_dispatchLineId_status_idx" ON "stock_reservations"("dispatchLineId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dispatches_number_key" ON "dispatches"("number");

-- CreateIndex
CREATE UNIQUE INDEX "dispatches_createOperationKey_key" ON "dispatches"("createOperationKey");

-- CreateIndex
CREATE UNIQUE INDEX "dispatches_confirmOperationKey_key" ON "dispatches"("confirmOperationKey");

-- CreateIndex
CREATE INDEX "dispatches_salesOrderId_idx" ON "dispatches"("salesOrderId");

-- CreateIndex
CREATE INDEX "dispatches_assigneeId_status_idx" ON "dispatches"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "dispatches_inventoryLocationId_status_idx" ON "dispatches"("inventoryLocationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_lines_dispatchId_salesOrderLineId_key" ON "dispatch_lines"("dispatchId", "salesOrderLineId");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_picks_dispatchId_bundleId_key" ON "dispatch_picks"("dispatchId", "bundleId");

-- CreateIndex
CREATE INDEX "dispatch_incidents_dispatchId_status_idx" ON "dispatch_incidents"("dispatchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_dedupeKey_key" ON "notification_outbox"("dedupeKey");

-- CreateIndex
CREATE INDEX "notification_outbox_status_nextAttemptAt_idx" ON "notification_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "reader_devices_code_key" ON "reader_devices"("code");

-- CreateIndex
CREATE INDEX "reader_sessions_deviceId_status_idx" ON "reader_sessions"("deviceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "reader_observations_dispatchId_contextKey_epc_key" ON "reader_observations"("dispatchId", "contextKey", "epc");

-- CreateIndex
CREATE INDEX "audit_events_entity_entityId_idx" ON "audit_events"("entity", "entityId");

-- CreateIndex
CREATE INDEX "bundles_lotId_idx" ON "bundles"("lotId");

-- CreateIndex
CREATE INDEX "inventory_movements_dispatchId_idx" ON "inventory_movements"("dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_dispatchId_key" ON "tasks"("dispatchId");

-- AddForeignKey
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_shipments" ADD CONSTRAINT "inbound_shipments_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_finishId_fkey" FOREIGN KEY ("finishId") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "inbound_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_purchaseLineId_fkey" FOREIGN KEY ("purchaseLineId") REFERENCES "purchase_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "stock_lots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "inbound_shipments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_finishId_fkey" FOREIGN KEY ("finishId") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_pre_registrations" ADD CONSTRAINT "inbound_pre_registrations_receivedBundleId_fkey" FOREIGN KEY ("receivedBundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_finishId_fkey" FOREIGN KEY ("finishId") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_charges" ADD CONSTRAINT "purchase_charges_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_finishId_fkey" FOREIGN KEY ("finishId") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_inventoryLocationId_fkey" FOREIGN KEY ("inventoryLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "references"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_finishId_fkey" FOREIGN KEY ("finishId") REFERENCES "finishes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "sales_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_dispatchLineId_fkey" FOREIGN KEY ("dispatchLineId") REFERENCES "dispatch_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reservations" ADD CONSTRAINT "stock_reservations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "sales_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_inventoryLocationId_fkey" FOREIGN KEY ("inventoryLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_lines" ADD CONSTRAINT "dispatch_lines_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_lines" ADD CONSTRAINT "dispatch_lines_salesOrderLineId_fkey" FOREIGN KEY ("salesOrderLineId") REFERENCES "sales_order_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_picks" ADD CONSTRAINT "dispatch_picks_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_picks" ADD CONSTRAINT "dispatch_picks_dispatchLineId_fkey" FOREIGN KEY ("dispatchLineId") REFERENCES "dispatch_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_picks" ADD CONSTRAINT "dispatch_picks_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "bundles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_picks" ADD CONSTRAINT "dispatch_picks_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_incidents" ADD CONSTRAINT "dispatch_incidents_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_incidents" ADD CONSTRAINT "dispatch_incidents_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_devices" ADD CONSTRAINT "reader_devices_inventoryLocationId_fkey" FOREIGN KEY ("inventoryLocationId") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_devices" ADD CONSTRAINT "reader_devices_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_sessions" ADD CONSTRAINT "reader_sessions_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "reader_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_sessions" ADD CONSTRAINT "reader_sessions_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_sessions" ADD CONSTRAINT "reader_sessions_openedById_fkey" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_events" ADD CONSTRAINT "reader_events_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "reader_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_observations" ADD CONSTRAINT "reader_observations_dispatchId_fkey" FOREIGN KEY ("dispatchId") REFERENCES "dispatches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_observations" ADD CONSTRAINT "reader_observations_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "reader_devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_observations" ADD CONSTRAINT "reader_observations_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "reader_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reader_observations" ADD CONSTRAINT "reader_observations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ==========================================================================
-- Business rules enforced by the database (custom SQL, keep when editing).
-- ==========================================================================

-- Document numbers (gaps are possible and harmless).
CREATE SEQUENCE IF NOT EXISTS quote_number_seq;
CREATE SEQUENCE IF NOT EXISTS sales_order_number_seq;
CREATE SEQUENCE IF NOT EXISTS dispatch_number_seq;
CREATE SEQUENCE IF NOT EXISTS stock_lot_code_seq;

-- Suppliers and customers -------------------------------------------------
ALTER TABLE public.suppliers
ADD CONSTRAINT suppliers_text_not_blank
CHECK (length(btrim(code)) > 0 AND length(btrim(name)) > 0 AND code = upper(btrim(code)));

ALTER TABLE public.suppliers
ADD CONSTRAINT suppliers_origins_not_empty
CHECK (cardinality(origins) > 0);

ALTER TABLE public.customers
ADD CONSTRAINT customers_name_not_blank
CHECK (length(btrim(name)) > 0);

-- One open China shipment per supplier: operators never switch silently.
CREATE UNIQUE INDEX inbound_shipments_one_open_per_supplier
ON public.inbound_shipments ("supplierId") WHERE status = 'OPEN';

-- Lots ----------------------------------------------------------------------
-- A cost is either pending (NULL) or positive: never a silent zero.
ALTER TABLE public.stock_lots
ADD CONSTRAINT stock_lots_cost_positive
CHECK ("unitCost" IS NULL OR "unitCost" > 0);

ALTER TABLE public.stock_lots
ADD CONSTRAINT stock_lots_cost_confirmed_consistent
CHECK (("unitCost" IS NULL) = ("costConfirmedAt" IS NULL));

-- China shipment lots are Chinese and belong to a shipment.
ALTER TABLE public.stock_lots
ADD CONSTRAINT stock_lots_shipment_consistent
CHECK (kind <> 'CHINA_SHIPMENT' OR (origin = 'CHINA' AND "shipmentId" IS NOT NULL AND "supplierId" IS NOT NULL));

-- National material needs its supplier, except opening lots of historical
-- stock whose supplier is not documented.
ALTER TABLE public.stock_lots
ADD CONSTRAINT stock_lots_national_supplier
CHECK (origin <> 'NATIONAL' OR "supplierId" IS NOT NULL OR kind = 'OPENING');

-- A bundle and its lot describe the same material.
CREATE FUNCTION bundle_lot_matches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lot_reference TEXT;
  lot_finish TEXT;
BEGIN
  IF NEW."lotId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "referenceId", "finishId" INTO lot_reference, lot_finish
  FROM public.stock_lots WHERE id = NEW."lotId";
  IF lot_reference IS DISTINCT FROM NEW."referenceId" OR lot_finish IS DISTINCT FROM NEW."finishId" THEN
    RAISE EXCEPTION 'bundle % does not match the reference/finish of lot %', NEW.id, NEW."lotId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bundles_lot_matches
BEFORE INSERT OR UPDATE OF "lotId", "referenceId", "finishId" ON public.bundles
FOR EACH ROW EXECUTE FUNCTION bundle_lot_matches();

-- The provenance of a lot in use is immutable (corrections move bundles to
-- another lot with an audit record).
CREATE FUNCTION stock_lot_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."referenceId", NEW."finishId", NEW.origin, NEW."supplierId") IS DISTINCT FROM
     (OLD."referenceId", OLD."finishId", OLD.origin, OLD."supplierId") THEN
    RAISE EXCEPTION 'the material and provenance of lot % cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stock_lots_identity_immutable
BEFORE UPDATE ON public.stock_lots
FOR EACH ROW EXECUTE FUNCTION stock_lot_identity_immutable();

-- Pre-registrations ---------------------------------------------------------
ALTER TABLE public.inbound_pre_registrations
ADD CONSTRAINT inbound_pre_registrations_epc_normalized
CHECK (length(epc) > 0 AND epc = upper(btrim(epc)));

ALTER TABLE public.inbound_pre_registrations
ADD CONSTRAINT inbound_pre_registrations_quantities
CHECK (
  "expectedQuantity" > 0 AND "expectedQuantity" <= 1000000
  AND ("receivedQuantity" IS NULL OR ("receivedQuantity" >= 0 AND "receivedQuantity" <= 1000000))
);

-- RECEIVED <=> linked to the bundle created by the reception; a received
-- quantity different from the expected one needs a reason.
ALTER TABLE public.inbound_pre_registrations
ADD CONSTRAINT inbound_pre_registrations_reception_consistent
CHECK (
  (status = 'RECEIVED') = ("receivedBundleId" IS NOT NULL)
  AND (status <> 'RECEIVED' OR ("receivedQuantity" IS NOT NULL AND "receivedAt" IS NOT NULL AND "receivedById" IS NOT NULL))
  AND ("receivedQuantity" IS NULL OR "receivedQuantity" = "expectedQuantity" OR length(btrim(coalesce("discrepancyReason", ''))) > 0)
);

-- At most one live pre-registration per chip.
CREATE UNIQUE INDEX inbound_pre_registrations_epc_live
ON public.inbound_pre_registrations (epc) WHERE status <> 'CANCELLED';

-- Purchases -----------------------------------------------------------------
ALTER TABLE public.purchases
ADD CONSTRAINT purchases_currency_code
CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE public.purchases
ADD CONSTRAINT purchases_exchange_rate_positive
CHECK ("exchangeRate" IS NULL OR "exchangeRate" > 0);

ALTER TABLE public.purchases
ADD CONSTRAINT purchases_discount_valid
CHECK (
  "globalDiscountValue" >= 0
  AND ("globalDiscountType" <> 'PERCENT' OR "globalDiscountValue" <= 100)
  AND ("globalDiscountType" <> 'NONE' OR "globalDiscountValue" = 0)
);

-- Foreign currency needs the applied rate, its date and source to confirm.
ALTER TABLE public.purchases
ADD CONSTRAINT purchases_confirmed_rate
CHECK (
  status <> 'CONFIRMED' OR currency = 'COP'
  OR ("exchangeRate" IS NOT NULL AND "exchangeRateDate" IS NOT NULL AND length(btrim(coalesce("exchangeRateSource", ''))) > 0)
);

ALTER TABLE public.purchase_lines
ADD CONSTRAINT purchase_lines_values
CHECK (
  quantity > 0 AND "profilesPerUnit" > 0 AND "unitPrice" >= 0
  AND "lineDiscountValue" >= 0
  AND ("lineDiscountType" <> 'PERCENT' OR "lineDiscountValue" <= 100)
  AND ("lineDiscountType" <> 'NONE' OR "lineDiscountValue" = 0)
  AND ("taxRatePercent" IS NULL OR ("taxRatePercent" >= 0 AND "taxRatePercent" <= 100))
  AND profiles >= 0
  AND ("unitCostCop" IS NULL OR "unitCostCop" > 0)
  AND length(btrim("unitName")) > 0
);

ALTER TABLE public.purchase_charges
ADD CONSTRAINT purchase_charges_values
CHECK (amount >= 0 AND length(btrim(description)) > 0);

-- Quotes and orders ---------------------------------------------------------
ALTER TABLE public.quote_lines
ADD CONSTRAINT quote_lines_values
CHECK (
  quantity > 0 AND "unitPrice" >= 0
  AND "discountPercent" >= 0 AND "discountPercent" <= 100
  AND "taxRatePercent" >= 0 AND "taxRatePercent" <= 100
  AND CASE "pricingMethod"
    WHEN 'MARKUP_ON_COST' THEN "pricingPercent" IS NOT NULL AND "pricingPercent" >= 0 AND "costBasis" > 0
    WHEN 'GROSS_MARGIN' THEN "pricingPercent" IS NOT NULL AND "pricingPercent" >= 0 AND "pricingPercent" < 100 AND "costBasis" > 0
    ELSE length(btrim(coalesce("priceReason", ''))) > 0
  END
);

ALTER TABLE public.sales_order_lines
ADD CONSTRAINT sales_order_lines_values
CHECK (
  quantity > 0 AND "unitPrice" >= 0
  AND "discountPercent" >= 0 AND "discountPercent" <= 100
  AND "taxRatePercent" >= 0 AND "taxRatePercent" <= 100
);

-- Reservations: never more than the physical quantity of the bundle.
ALTER TABLE public.stock_reservations
ADD CONSTRAINT stock_reservations_quantity_positive
CHECK (quantity > 0);

ALTER TABLE public.stock_reservations
ADD CONSTRAINT stock_reservations_closed_consistent
CHECK ((status = 'ACTIVE') = ("closedAt" IS NULL));

CREATE FUNCTION assert_bundle_reservations(target TEXT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  reserved BIGINT;
  physical INT;
BEGIN
  SELECT quantity INTO physical FROM public.bundles WHERE id = target;
  SELECT coalesce(sum(quantity), 0) INTO reserved
  FROM public.stock_reservations WHERE "bundleId" = target AND status = 'ACTIVE';
  IF reserved > physical THEN
    RAISE EXCEPTION 'active reservations (%) exceed the quantity of bundle % (%)', reserved, target, physical
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION check_reservation_bundle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_bundle_reservations(NEW."bundleId");
  RETURN NULL;
END;
$$;

CREATE FUNCTION check_bundle_reserved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_bundle_reservations(NEW.id);
  RETURN NULL;
END;
$$;

-- Deferred to commit: a transaction may consume a reservation and its stock
-- in any order; only the final state must hold.
CREATE CONSTRAINT TRIGGER stock_reservations_within_bundle
AFTER INSERT OR UPDATE ON public.stock_reservations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_reservation_bundle();

CREATE CONSTRAINT TRIGGER bundles_quantity_covers_reservations
AFTER UPDATE OF quantity ON public.bundles
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_bundle_reserved();

-- Dispatches ----------------------------------------------------------------
ALTER TABLE public.dispatch_lines
ADD CONSTRAINT dispatch_lines_quantities
CHECK (quantity > 0 AND "dispatchedQuantity" >= 0 AND "dispatchedQuantity" <= quantity);

ALTER TABLE public.dispatch_picks
ADD CONSTRAINT dispatch_picks_quantity_positive
CHECK (quantity > 0);

ALTER TABLE public.dispatches
ADD CONSTRAINT dispatches_state_consistent
CHECK (
  (status = 'CONFIRMED') = ("confirmedAt" IS NOT NULL)
  AND (status = 'CONFIRMED') = ("confirmOperationKey" IS NOT NULL)
  AND (status = 'CANCELLED') = ("cancelledAt" IS NOT NULL)
);

-- Per order line: dispatches never authorise nor deliver more than ordered.
CREATE FUNCTION check_order_line_dispatches() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ordered INT;
  authorised BIGINT;
  delivered BIGINT;
BEGIN
  SELECT quantity INTO ordered FROM public.sales_order_lines WHERE id = NEW."salesOrderLineId";
  SELECT coalesce(sum(dl.quantity) FILTER (WHERE d.status <> 'CANCELLED'), 0),
         coalesce(sum(dl."dispatchedQuantity"), 0)
    INTO authorised, delivered
  FROM public.dispatch_lines dl JOIN public.dispatches d ON d.id = dl."dispatchId"
  WHERE dl."salesOrderLineId" = NEW."salesOrderLineId";
  IF authorised > ordered OR delivered > ordered THEN
    RAISE EXCEPTION 'dispatches exceed the quantity of order line %', NEW."salesOrderLineId"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER dispatch_lines_within_order_line
AFTER INSERT OR UPDATE ON public.dispatch_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION check_order_line_dispatches();

-- Tasks ---------------------------------------------------------------------
-- A dispatch task is linked to its dispatch and may be completed after its
-- deadline (completion comes from confirming the dispatch). General tasks
-- keep the original rule.
ALTER TABLE public.tasks DROP CONSTRAINT tasks_completed_before_due;

ALTER TABLE public.tasks
ADD CONSTRAINT tasks_completed_before_due
CHECK (
  "completedAt" IS NULL
  OR ("completedAt" >= "createdAt" AND (kind = 'DISPATCH' OR "completedAt" <= "dueAt"))
);

ALTER TABLE public.tasks
ADD CONSTRAINT tasks_dispatch_link
CHECK ((kind = 'DISPATCH') = ("dispatchId" IS NOT NULL));

ALTER TABLE public.tasks
ADD CONSTRAINT tasks_not_completed_and_cancelled
CHECK ("completedAt" IS NULL OR "cancelledAt" IS NULL);

-- Readers -------------------------------------------------------------------
CREATE UNIQUE INDEX reader_sessions_one_open_per_device
ON public.reader_sessions ("deviceId") WHERE status = 'OPEN';

ALTER TABLE public.reader_observations
ADD CONSTRAINT reader_observations_count_positive
CHECK (count > 0 AND epc = upper(btrim(epc)));
