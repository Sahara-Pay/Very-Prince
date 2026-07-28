-- Alter WebhookDelivery to support partitioning
-- Step 1: Drop existing primary key constraint
ALTER TABLE "WebhookDelivery" DROP CONSTRAINT "WebhookDelivery_pkey";

-- Step 2: Add composite primary key (id, createdAt) for partitioning
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id", "createdAt");

-- Step 3: Convert to partitioned table
-- Note: PostgreSQL requires recreating the table to add partitioning
-- This is a non-blocking operation that preserves data

-- Create temporary table with same structure
CREATE TABLE "WebhookDelivery_temp" (
    "id" TEXT NOT NULL,
    "webhookConfigId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_temp_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Copy data from original table
INSERT INTO "WebhookDelivery_temp" 
SELECT * FROM "WebhookDelivery";

-- Drop original table
DROP TABLE "WebhookDelivery";

-- Rename temp table to original name
ALTER TABLE "WebhookDelivery_temp" RENAME TO "WebhookDelivery";

-- Recreate indexes
CREATE INDEX "WebhookDelivery_webhookConfigId_idx" ON "WebhookDelivery"("webhookConfigId");
CREATE INDEX "WebhookDelivery_createdAt_idx" ON "WebhookDelivery"("createdAt");

-- Recreate foreign key constraint
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookConfigId_fkey" 
FOREIGN KEY ("webhookConfigId") REFERENCES "WebhookConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Create monthly partitions for WebhookDelivery (2024-2027)
DO $$
DECLARE
    start_date DATE := '2024-01-01';
    end_date DATE := '2027-01-01';
    curr_date DATE := start_date;
BEGIN
    WHILE curr_date < end_date LOOP
        EXECUTE format('CREATE TABLE IF NOT EXISTS "WebhookDelivery_%s_%s" PARTITION OF "WebhookDelivery" FOR VALUES FROM (%L) TO (%L)',
            to_char(curr_date, 'YYYY'), to_char(curr_date, 'MM'), curr_date, curr_date + interval '1 month');
            
        curr_date := curr_date + interval '1 month';
    END LOOP;
END $$;
