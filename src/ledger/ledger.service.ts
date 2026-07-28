import { PrismaClient } from "@prisma/client";
import {
  LedgerBlockInput,
  buildBulkUpsertBlocksQuery,
} from "./sql/bulk-upsert-blocks.sql";

export class LedgerService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Bulk upserts thousands of ledger records in a single atomic transaction.
   * Splits records into manageable chunks to stay well within Postgres parameter limits.
   *
   * @param blocks Array of ledger block inputs
   * @param chunkSize Size of each bulk CTE query (default 2500)
   */
  async bulkUpsertBlocks(
    blocks: LedgerBlockInput[],
    chunkSize: number = 2500
  ): Promise<number> {
    if (blocks.length === 0) return 0;

    let totalAffectedRows = 0;

    // Execute all chunked CTEs within a single atomic database transaction
    await this.prisma.$transaction(
      async (tx) => {
        for (let i = 0; i < blocks.length; i += chunkSize) {
          const chunk = blocks.slice(i, i + chunkSize);
          const query = buildBulkUpsertBlocksQuery(chunk);

          // Execute raw SQL CTE batch upsert
          const count = await tx.$executeRaw(query);
          totalAffectedRows += count;
        }
      },
      {
        timeout: 30000, // Extend timeout for massive 10,000+ batch transactions
      }
    );

    return totalAffectedRows;
  }
}
