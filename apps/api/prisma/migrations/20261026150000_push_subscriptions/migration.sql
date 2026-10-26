-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastSuccessAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Business rules enforced by the database (custom SQL, keep when editing).
-- Push services are only reached over HTTPS; the API also checks the host
-- against an allow-list of known push services before every request.
ALTER TABLE public.push_subscriptions
ADD CONSTRAINT push_subscriptions_endpoint_https
CHECK ("endpoint" LIKE 'https://%' AND length("endpoint") <= 1024);

-- Browser keys (base64url): p256dh is a 65-byte P-256 key, auth 16 bytes.
ALTER TABLE public.push_subscriptions
ADD CONSTRAINT push_subscriptions_keys_format
CHECK (
  "p256dh" ~ '^[A-Za-z0-9_-]{80,100}={0,2}$'
  AND "auth" ~ '^[A-Za-z0-9_-]{16,32}={0,2}$'
);
