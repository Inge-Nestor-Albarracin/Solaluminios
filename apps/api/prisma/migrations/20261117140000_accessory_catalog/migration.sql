-- Accessory catalog (additive; existing families stay PROFILE).
-- ProductFamily.kind: what the family groups. ACCESSORY families are catalog
-- only for now: operations (bundles, lots, purchases, quotes, material
-- requests) refuse their references.
CREATE TYPE "ProductKind" AS ENUM ('PROFILE', 'ACCESSORY');

ALTER TABLE "product_families" ADD COLUMN "kind" "ProductKind" NOT NULL DEFAULT 'PROFILE';

-- Reference.supplierCode: the supplier's / maker's code shown for accessories
-- (their own code is internal); it may repeat. Reference.brand: supplier or
-- brand as the catalog names it.
ALTER TABLE "references" ADD COLUMN "supplierCode" TEXT,
ADD COLUMN "brand" TEXT;
