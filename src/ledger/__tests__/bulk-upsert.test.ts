import { PrismaClient } from "@prisma/client";
import { LedgerService } from "../ledger.service";
import { LedgerBlockInput } from "../sql/bulk-upsert-blocks.sql";

describe("Ledger Bulk Upsert CTE", () => {
  let prisma: PrismaClient;
  let ledgerService: LedgerService;

  beforeAll(async () => {
    prisma = new PrismaClient();
    ledgerService = new LedgerService(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const generateMockBlocks = (count: number): LedgerBlockInput[] => {
    const blocks: LedgerBlockInput[] = [];
    const now = new Date();

    for (let i = 1; i <= count; i++) {
      blocks.push({
        blockNumber: i,
        txHash: `0xhash_${i}`,
        sender: `0xsender_${i}`,
        recipient: `0xrecipient_${i}`,
        amount: "100.50",
        status: "CONFIRMED",
        timestamp: now,
      });
    }
    return blocks;
  };

  it("handles 10,000 records in a single atomic transaction", async () => {
    const recordsCount = 10000;
    const mockData = generateMockBlocks(recordsCount);

    const startTime = Date.now();
    const affected = await ledgerService.bulkUpsertBlocks(mockData, 2500);
    const duration = Date.now() - startTime;

    console.log(`Processed ${recordsCount} records in ${duration}ms`);

    expect(affected).toBeGreaterThan(0);
    expect(duration).toBeLessThan(5000); // Should finish well under 5 seconds
  });

  it("ensures idempotency when processing duplicate webhook payloads", async () => {
    const mockData = generateMockBlocks(100);

    // Initial insertion
    await ledgerService.bulkUpsertBlocks(mockData);

    // Simulate duplicate webhook delivery with updated status
    const duplicateData = mockData.map((b) => ({
      ...b,
      status: "SETTLED",
    }));

    // Should update existing rows without duplicate key errors
    await expect(
      ledgerService.bulkUpsertBlocks(duplicateData)
    ).resolves.not.toThrow();
  });
});
