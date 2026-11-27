-- The login log outlives a deleted user: the event keeps what was typed and
-- loses only the link (users are normally deactivated, never deleted; test
-- cleanups do delete them). Follows 20261127120000_usernames_password_policy.

-- DropForeignKey
ALTER TABLE "login_events" DROP CONSTRAINT "login_events_actorId_fkey";

-- DropForeignKey
ALTER TABLE "login_events" DROP CONSTRAINT "login_events_userId_fkey";

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Business rules enforced by the database (custom SQL, keep when editing) ----

-- Only a reset names an administrator (the API always sets it); it may be
-- emptied if that administrator is ever deleted.
ALTER TABLE public.login_events DROP CONSTRAINT login_events_valid;
ALTER TABLE public.login_events
ADD CONSTRAINT login_events_valid
CHECK (
    length(identifier) <= 254
    AND (ip IS NULL OR length(ip) <= 64)
    AND ("userAgent" IS NULL OR length("userAgent") <= 300)
    AND (type::text = 'PASSWORD_RESET' OR "actorId" IS NULL)
);
