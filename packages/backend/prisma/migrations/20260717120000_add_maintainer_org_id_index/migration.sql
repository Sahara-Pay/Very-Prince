-- Migration: add_maintainer_org_id_index
--
-- Creates an index on the orgId column of the Maintainer table in PostgreSQL.
-- Matches the @@index([orgId]) defined in the Prisma schema.

CREATE INDEX "Maintainer_orgId_idx" ON "Maintainer"("orgId");
