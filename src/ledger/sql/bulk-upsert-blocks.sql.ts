import { Prisma, PrismaClient } from "@prisma/client";

export interface LedgerBlockInput {
  blockNumber: bigint | number;
  txHash: string;
  sender: string;
  recipient: string;
  amount: string;
  status: string;
  timestamp: Date;
}

/**
 * Builds a parameterized Prisma raw query utilizing a CTE and UNNEST
 * to perform a bulk upsert of thousands of ledger blocks in a single DB round-trip.
 */
export function buildBulkUpsertBlocksQuery(
  blocks: LedgerBlockInput[]
): Prisma.Sql {
  if (blocks.length === 0) {
    return Prisma.sql`SELECT 0;`;
  }

  // Extract parallel arrays for typed UNNEST parameters
  const blockNumbers: bigint[] = [];
  const txHashes: string[] = [];
  const senders: string[] = [];
  const recipients: string[] = [];
  const amounts: string[] = [];
  const statuses: string[] = [];
  const timestamps: Date[] = [];

  for (const b of blocks) {
    blockNumbers.push(BigInt(b.blockNumber));
    txHashes.push(b.txHash);
    senders.push(b.sender);
    recipients.push(b.recipient);
    amounts.push(b.amount);
    statuses.push(b.status);
    timestamps.push(b.timestamp);
  }

  // Raw CTE query with ON CONFLICT clause for dynamic update/idempotency
  return Prisma.sql`
    WITH incoming_data AS (
      SELECT * FROM UNNEST(
        ${blockNumbers}::bigint[],
        ${txHashes}::text[],
        ${senders}::text[],
        ${recipients}::text[],
        ${amounts}::numeric[],
        ${statuses}::text[],
        ${timestamps}::timestamptz[]
      ) AS t(
        block_number,
        tx_hash,
        sender,
        recipient,
        amount,
        status,
        timestamp
      )
    )
    INSERT INTO "LedgerBlock" (
      "blockNumber",
      "txHash",
      "sender",
      "recipient",
      "amount",
      "status",
      "timestamp",
      "createdAt",
      "updatedAt"
    )
    SELECT
      block_number,
      tx_hash,
      sender,
      recipient,
      amount,
      status,
      timestamp,
      NOW(),
      NOW()
    FROM incoming_data
    ON CONFLICT ("blockNumber", "txHash") DO UPDATE SET
      "sender" = EXCLUDED."sender",
      "recipient" = EXCLUDED."recipient",
      "amount" = EXCLUDED."amount",
      "status" = EXCLUDED."status",
      "timestamp" = EXCLUDED."timestamp",
      "updatedAt" = NOW();
  `;
}
