-- Migration: add_funding_event_composite_index
--
-- Creates a composite index on (createdAt, orgId) columns of the FundingEvent table.
-- This index optimizes Prisma groupBy queries that filter by date range and group by orgId.
-- Matches the @@index([createdAt, orgId]) defined in the Prisma schema.
--
-- Performance Impact:
-- - Enables sub-100ms aggregation queries for total funds raised metrics
-- - Supports efficient date-filtered groupBy operations
-- - Prevents full table scans in statistical dashboards

CREATE INDEX "FundingEvent_createdAt_orgId_idx" ON "FundingEvent"("createdAt", "orgId");
