-- Entity where each transfer is received (additive): the list of entities
-- (stable ids, one row each) and, on every payment by transfer, the entity
-- where Solaluminios received that amount, for reports per entity.
--
-- Historical records: payments by transfer recorded before this migration
-- keep a NULL entity, shown as «Sin especificar»; none is assumed. Cash
-- payments never have an entity. A new entity is added later as a new row of
-- transfer_entities (no screen yet).
-- AlterTable
ALTER TABLE "sales_order_payments" ADD COLUMN     "transferEntityId" TEXT;

-- CreateTable
CREATE TABLE "transfer_entities" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transfer_entities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "transfer_entities_name_key" ON "transfer_entities"("name");

-- CreateIndex
CREATE INDEX "sales_order_payments_transferEntityId_paidOn_idx" ON "sales_order_payments"("transferEntityId", "paidOn");

-- AddForeignKey
ALTER TABLE "sales_order_payments" ADD CONSTRAINT "sales_order_payments_transferEntityId_fkey" FOREIGN KEY ("transferEntityId") REFERENCES "transfer_entities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Initial entities (ids are stable: reports and payments point to them).
INSERT INTO public.transfer_entities (id, name, "sortOrder") VALUES
    ('NEQUI', 'Nequi', 1),
    ('BANCO_CAJA_SOCIAL', 'Banco Caja Social', 2);

-- Business rules enforced by the database (custom SQL, keep when editing) ----

-- Only a transfer has a receiving entity.
ALTER TABLE public.sales_order_payments
ADD CONSTRAINT sales_order_payments_entity_only_transfer
CHECK (medium::text = 'TRANSFER' OR "transferEntityId" IS NULL);

-- Every new transfer, and every payment that becomes a transfer, says where
-- it was received; a known entity is never cleared. Transfers recorded before
-- this migration may keep NULL («Sin especificar») while their medium does not
-- change.
CREATE FUNCTION sales_order_payments_transfer_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.medium::text = 'TRANSFER' AND NEW."transferEntityId" IS NULL THEN
    IF TG_OP = 'INSERT' OR OLD.medium::text <> 'TRANSFER' OR OLD."transferEntityId" IS NOT NULL THEN
      RAISE EXCEPTION 'Indica dónde se recibió la transferencia' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sales_order_payments_transfer_entity
BEFORE INSERT OR UPDATE OF medium, "transferEntityId" ON public.sales_order_payments
FOR EACH ROW EXECUTE FUNCTION sales_order_payments_transfer_entity();