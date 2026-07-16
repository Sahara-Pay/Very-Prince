-- Migration: add_funding_event
-- Resolves: https://github.com/Sahara-Pay/Very-Prince/issues/16
--
-- Creates the FundingEvent table to persist every on-chain OrgFunded event.
-- This enables a single SQL aggregation (SUM) for total funds raised,
-- replacing the previous N+1 Stellar RPC approach in getGlobalStats().

CREATE TABLE "FundingEvent" (
    "id"            TEXT NOT NULL,
    "orgId"         TEXT NOT NULL,
    "from"          TEXT NOT NULL,
    "amountStroops" BIGINT NOT NULL,
    "amountXlm"     DECIMAL(65,30) NOT NULL,
    "ledger"        INTEGER NOT NULL,
    "txHash"        TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL,

    -- Composite primary key mirrors the pattern used by PayoutEvent
    CONSTRAINT "FundingEvent_pkey" PRIMARY KEY ("id", "createdAt")
);

-- Idempotency: prevent duplicate indexing of the same on-chain event
CREATE UNIQUE INDEX "FundingEvent_txHash_orgId_createdAt_key"
    ON "FundingEvent" ("txHash", "orgId", "createdAt");

-- Indexes to support efficient filtered aggregations and lookups
CREATE INDEX "FundingEvent_orgId_idx"    ON "FundingEvent" ("orgId");
CREATE INDEX "FundingEvent_from_idx"     ON "FundingEvent" ("from");
CREATE INDEX "FundingEvent_createdAt_idx" ON "FundingEvent" ("createdAt");
CREATE INDEX "FundingEvent_ledger_idx"   ON "FundingEvent" ("ledger");
