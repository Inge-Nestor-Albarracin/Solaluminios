-- Accessories role (additive): the user of the accessories warehouse. Only the
-- enum value; its screens and operations come in later migrations
-- (docs/accesorios-fase-1.md). Existing users do not change.

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'ACCESSORIES';
