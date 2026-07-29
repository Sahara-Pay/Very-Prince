
import { writeHeapSnapshot } from 'node:v8';
import { prismaRead } from '../services/db.js';
import { logger } from '../utils/logger.js';

/**
 * Baseline memory test: triggers a large JSON stringification to observe heap spikes.
 * Run with: NODE_OPTIONS="--inspect" npx tsx packages/backend/src/tests/memory-baseline.test.ts
 */
async function runBaseline() {
  logger.info('Starting memory baseline test...');
  
  // 1. Capture snapshot before allocation
  const beforeFile = writeHeapSnapshot();
  logger.info({ beforeFile }, 'Captured pre-allocation heap snapshot');

  // 2. Fetch a large number of transactions (or mock them if DB is empty)
  const txCount = await prismaRead.transaction.count();
  logger.info({ txCount }, 'Found transactions in database');
  
  let transactions;
  if (txCount < 10000) {
    logger.info('Database has few transactions, mocking 50,000 records for stress test...');
    transactions = Array.from({ length: 50000 }, (_, i) => ({
      id: `mock-id-${i}`,
      txHash: `hash-${i}`,
      eventIndex: i,
      walletAddress: 'GBXGQ4U...MOCK',
      volumeUSD: 100.5,
      createdAt: new Date(),
      type: 'PAYOUT_CLAIMED',
      ledger: 1000 + i,
      rawData: JSON.stringify({ orgId: 'ORG', amount: '10000000' })
    }));
  } else {
    transactions = await prismaRead.transaction.findMany({ take: 50000 });
  }

  logger.info('Materializing large JSON string in memory (RISK OF OOM)...');
  
  try {
    const start = Date.now();
    const largeJson = JSON.stringify({ 
      metadata: { count: transactions.length }, 
      data: transactions 
    });
    const end = Date.now();
    
    logger.info({ 
      sizeMB: (largeJson.length / 1024 / 1024).toFixed(2),
      durationMS: end - start,
      heapUsedMB: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)
    }, 'Successfully stringified large JSON (observe heap spike in inspector)');
    
    // 3. Capture snapshot after allocation
    const afterFile = writeHeapSnapshot();
    logger.info({ afterFile }, 'Captured post-allocation heap snapshot');
    
  } catch (err) {
    logger.error(err, 'OOM or stringification error during baseline');
    process.exit(1);
  }

  process.exit(0);
}

runBaseline().catch(err => {
  console.error(err);
  process.exit(1);
});
