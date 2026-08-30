-- Create partitioned webhook tables for high-throughput ingestion

-- Create WebhookEvent table (partitioned by month)
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "payload" TEXT NOT NULL,
    "metadata" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Create WebhookDeliveryLog table (partitioned by month)
CREATE TABLE "WebhookDeliveryLog" (
    "id" TEXT NOT NULL,
    "webhookEventId" TEXT NOT NULL,
    "webhookConfigId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "statusCode" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryLog_pkey" PRIMARY KEY ("id", "createdAt")
) PARTITION BY RANGE ("createdAt");

-- Create PartitionMetadata table for managing partition lifecycle
CREATE TABLE "PartitionMetadata" (
    "id" TEXT NOT NULL,
    "tableName" TEXT NOT NULL,
    "partitionName" TEXT NOT NULL,
    "partitionStart" TIMESTAMP(3) NOT NULL,
    "partitionEnd" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartitionMetadata_pkey" PRIMARY KEY ("id")
);

-- Create indexes for WebhookEvent
CREATE INDEX "WebhookEvent_organizationId_idx" ON "WebhookEvent"("organizationId");
CREATE INDEX "WebhookEvent_eventType_idx" ON "WebhookEvent"("eventType");
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");
CREATE INDEX "WebhookEvent_processedAt_idx" ON "WebhookEvent"("processedAt");
CREATE INDEX "WebhookEvent_organizationId_createdAt_idx" ON "WebhookEvent"("organizationId", "createdAt");

-- Create indexes for WebhookDeliveryLog
CREATE INDEX "WebhookDeliveryLog_webhookEventId_idx" ON "WebhookDeliveryLog"("webhookEventId");
CREATE INDEX "WebhookDeliveryLog_webhookConfigId_idx" ON "WebhookDeliveryLog"("webhookConfigId");
CREATE INDEX "WebhookDeliveryLog_createdAt_idx" ON "WebhookDeliveryLog"("createdAt");
CREATE INDEX "WebhookDeliveryLog_deliveredAt_idx" ON "WebhookDeliveryLog"("deliveredAt");

-- Create unique constraint for PartitionMetadata
CREATE UNIQUE INDEX "PartitionMetadata_tableName_partitionName_key" ON "PartitionMetadata"("tableName", "partitionName");
CREATE INDEX "PartitionMetadata_tableName_idx" ON "PartitionMetadata"("tableName");
CREATE INDEX "PartitionMetadata_isActive_idx" ON "PartitionMetadata"("isActive");

-- Create monthly partitions for WebhookEvent (2024-2027)
DO $$
DECLARE
    start_date DATE := '2024-01-01';
    end_date DATE := '2027-01-01';
    curr_date DATE := start_date;
BEGIN
    WHILE curr_date < end_date LOOP
        EXECUTE format('CREATE TABLE IF NOT EXISTS "WebhookEvent_%s_%s" PARTITION OF "WebhookEvent" FOR VALUES FROM (%L) TO (%L)',
            to_char(curr_date, 'YYYY'), to_char(curr_date, 'MM'), curr_date, curr_date + interval '1 month');
            
        curr_date := curr_date + interval '1 month';
    END LOOP;
END $$;

-- Create monthly partitions for WebhookDeliveryLog (2024-2027)
DO $$
DECLARE
    start_date DATE := '2024-01-01';
    end_date DATE := '2027-01-01';
    curr_date DATE := start_date;
BEGIN
    WHILE curr_date < end_date LOOP
        EXECUTE format('CREATE TABLE IF NOT EXISTS "WebhookDeliveryLog_%s_%s" PARTITION OF "WebhookDeliveryLog" FOR VALUES FROM (%L) TO (%L)',
            to_char(curr_date, 'YYYY'), to_char(curr_date, 'MM'), curr_date, curr_date + interval '1 month');
            
        curr_date := curr_date + interval '1 month';
    END LOOP;
END $$;