-- Catalog note: other families where operators also know a reference. A
-- reference still belongs to one family only; this text is a hint on screen.
-- AlterTable
ALTER TABLE "references" ADD COLUMN     "familyHint" TEXT;


-- Business rules enforced by the database (custom SQL, keep when editing) ---
ALTER TABLE "references" ADD CONSTRAINT "references_family_hint"
CHECK ("familyHint" IS NULL OR (char_length("familyHint") BETWEEN 1 AND 200));
