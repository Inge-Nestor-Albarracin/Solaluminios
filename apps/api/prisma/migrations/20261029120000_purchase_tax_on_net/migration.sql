-- Purchase lines recorded with the invoice order: gross value WITHOUT purchase
-- VAT, discount on that value, VAT on the discounted base. Existing lines keep
-- taxOnNet = false and their stored amounts (VAT-included rule or the earlier
-- definition); nothing is recomputed.
ALTER TABLE "purchase_lines" ADD COLUMN "taxOnNet" BOOLEAN NOT NULL DEFAULT false;

-- One rule per line.
ALTER TABLE "purchase_lines" ADD CONSTRAINT "purchase_lines_one_cost_rule" CHECK (NOT ("grossIncludesTax" AND "taxOnNet"));
