-- Login by user name (e.g. «pedro.alvarez») instead of e-mail, the ID number
-- as initial password that must be changed at the first login, and a log of
-- logins and password changes. Design: docs/usuarios-y-contrasenas.md.
-- Existing users keep their password (no forced change) and get as user name
-- the part of their e-mail before the @ (the administrator can change it).

-- CreateEnum
CREATE TYPE "LoginEventType" AS ENUM ('LOGIN_OK', 'LOGIN_FAILED', 'LOGIN_LOCKED', 'LOGIN_INACTIVE', 'PASSWORD_CHANGED', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordChangedAt" TIMESTAMPTZ(3),
ADD COLUMN     "username" TEXT,
ALTER COLUMN "email" DROP NOT NULL;

-- User names of the existing users: e-mail before the @, lowercase, any other
-- character as a dot («Ana_Perez+x@…» → «ana.perez.x»); too short ones get
-- «usuario.<hash>»; repeated ones a number («ana.perez.2»), oldest first.
WITH base AS (
  SELECT id, "createdAt",
         btrim(substr(btrim(regexp_replace(lower(split_part(coalesce(email, ''), '@', 1)), '[^a-z0-9]+', '.', 'g'), '.'), 1, 45), '.') AS b
  FROM "users"
), named AS (
  SELECT id, "createdAt", CASE WHEN length(b) >= 3 THEN b ELSE 'usuario.' || substr(md5(id), 1, 10) END AS b
  FROM base
), ranked AS (
  SELECT id, b, row_number() OVER (PARTITION BY b ORDER BY "createdAt", id) AS n
  FROM named
)
UPDATE "users" u
SET username = CASE WHEN r.n = 1 THEN r.b ELSE r.b || '.' || r.n END
FROM ranked r
WHERE r.id = u.id;

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL,
ALTER COLUMN "username" SET DEFAULT ('usuario.'::text || substr(md5((random())::text), 1, 10));

-- CreateTable
CREATE TABLE "login_events" (
    "id" TEXT NOT NULL,
    "type" "LoginEventType" NOT NULL,
    "identifier" TEXT NOT NULL,
    "userId" TEXT,
    "actorId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_events_at_idx" ON "login_events"("at");

-- CreateIndex
CREATE INDEX "login_events_userId_at_idx" ON "login_events"("userId", "at");

-- CreateIndex
CREATE INDEX "login_events_actorId_idx" ON "login_events"("actorId");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Business rules enforced by the database (custom SQL, keep when editing) ----

-- A user name: 3 to 50 characters, lowercase letters and digits, separated by
-- single dots, dashes or underscores («pedro.alvarez», «ana_2»).
ALTER TABLE public.users
ADD CONSTRAINT users_username_format
CHECK (length(username) BETWEEN 3 AND 50 AND username ~ '^[a-z0-9]+([._-][a-z0-9]+)*$');

-- E-mails are kept lowercase (they are still accepted to log in). The API
-- always saved them so; normalized here in case one was written by hand.
UPDATE public.users SET email = lower(btrim(email)) WHERE email <> lower(btrim(email));
ALTER TABLE public.users
ADD CONSTRAINT users_email_lowercase
CHECK (email IS NULL OR email = lower(btrim(email)));

-- The log keeps short texts, and a reset always says which administrator did it.
ALTER TABLE public.login_events
ADD CONSTRAINT login_events_valid
CHECK (
    length(identifier) <= 254
    AND (ip IS NULL OR length(ip) <= 64)
    AND ("userAgent" IS NULL OR length("userAgent") <= 300)
    AND ((type::text = 'PASSWORD_RESET') = ("actorId" IS NOT NULL))
);
