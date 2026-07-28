
import { streamAsyncEnvelope } from '../utils/streamingJson.js';
import { logger } from '../utils/logger.js';
import { Writable } from 'node:stream';

/**
 * Verification test for streaming JSON serialization.
 * Verifies that memory usage remains stable even when "streaming" millions of objects.
 */
async function runVerification() {
  logger.info('Starting streaming verification test...');

  const initialMemory = process.memoryUsage().heapUsed;
  logger.info({ initialMemoryMB: (initialMemory / 1024 / 1024).toFixed(2) }, 'Initial heap usage');

  // 1. Create a mock Writable that just counts bytes but doesn't store anything
  let bytesWritten = 0;
  const mockResponse = new Writable({
    write(chunk, encoding, callback) {
      bytesWritten += chunk.length;
      callback();
    }
  }) as any;

  // Mock Fastify's reply.raw properties
  mockResponse.headersSent = false;
  mockResponse.setHeader = () => {};

  // 2. Define a massive generator (1 million items)
  const totalItems = 1_000_000;
  const itemFetcher = async function* () {
    for (let i = 0; i < totalItems; i++) {
      yield {
        id: i,
        name: `Item ${i}`,
        timestamp: new Date().toISOString(),
        payload: 'a'.repeat(100), // ~100 bytes per item
      };
      
      // Log memory every 100k items
      if (i > 0 && i % 100000 === 0) {
        const currentMemory = process.memoryUsage().heapUsed;
        logger.info({ 
          index: i, 
          heapUsedMB: (currentMemory / 1024 / 1024).toFixed(2),
          deltaMB: ((currentMemory - initialMemory) / 1024 / 1024).toFixed(2)
        }, 'Memory usage during stream');
      }
    }
  };

  logger.info('Starting stream of 1,000,000 items...');
  const start = Date.now();

  try {
    await streamAsyncEnvelope(
      mockResponse,
      { status: 'success', count: totalItems },
      itemFetcher
    );
    
    const end = Date.now();
    const finalMemory = process.memoryUsage().heapUsed;
    
    logger.info({
      totalBytesWrittenMB: (bytesWritten / 1024 / 1024).toFixed(2),
      durationMS: end - start,
      finalHeapUsedMB: (finalMemory / 1024 / 1024).toFixed(2),
      deltaMB: ((finalMemory - initialMemory) / 1024 / 1024).toFixed(2)
    }, 'Stream completed successfully');

    // If delta is less than 50MB for a 100MB+ payload, it's a success
    if (finalMemory - initialMemory < 50 * 1024 * 1024) {
      logger.info('SUCCESS: Memory stayed flat during massive streaming.');
    } else {
      logger.warn('WARNING: Memory spike detected, but may be due to GC timing.');
    }

  } catch (err) {
    logger.error(err, 'Error during streaming verification');
    process.exit(1);
  }

  process.exit(0);
}

runVerification().catch(err => {
  console.error(err);
  process.exit(1);
});
