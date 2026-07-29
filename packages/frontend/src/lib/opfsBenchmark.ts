// Performance benchmarks comparing OPFS vs IndexedDB for historical data storage
import { getOPFSClient, CandlestickData } from './opfsStorage';

interface BenchmarkResult {
  name: string;
  operation: string;
  dataSize: number;
  recordCount: number;
  opfsTime: number;
  indexedDBTime: number;
  speedup: number;
}

// Generate synthetic candlestick data for benchmarking
function generateCandlestickData(count: number): CandlestickData[] {
  const data: CandlestickData[] = [];
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  
  for (let i = 0; i < count; i++) {
    const timestamp = now - (count - i) * dayMs;
    const basePrice = 100 + Math.random() * 50;
    const volatility = 0.02;
    
    data.push({
      timestamp,
      open: basePrice,
      high: basePrice * (1 + Math.random() * volatility),
      low: basePrice * (1 - Math.random() * volatility),
      close: basePrice * (1 + (Math.random() - 0.5) * volatility),
      volume: Math.random() * 1000000,
    });
  }
  
  return data;
}

// IndexedDB implementation for comparison
class IndexedDBStorage {
  private db: IDBDatabase | null = null;
  private dbName = 'OPFSBenchmarkDB';
  private storeName = 'candlesticks';

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };
      
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
    });
  }

  async write(key: string, data: CandlestickData[]): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      
      // Store as JSON string
      const request = store.put(JSON.stringify(data), key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async read(key: string): Promise<CandlestickData[]> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const data = request.result;
        if (data) {
          resolve(JSON.parse(data));
        } else {
          resolve([]);
        }
      };
    });
  }

  async delete(key: string): Promise<void> {
    if (!this.db) await this.init();
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(key);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Benchmark runner
export async function runBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const opfsClient = getOPFSClient();
  const indexedDB = new IndexedDBStorage();
  
  const testSizes = [
    { count: 100, name: 'Small (100 records)' },
    { count: 1000, name: 'Medium (1K records)' },
    { count: 10000, name: 'Large (10K records)' },
    { count: 50000, name: 'Very Large (50K records)' },
  ];

  for (const size of testSizes) {
    const data = generateCandlestickData(size.count);
    const key = `benchmark-${size.count}`;
    const dataSize = new Blob([JSON.stringify(data)]).size;

    // Benchmark OPFS write
    const opfsWriteStart = performance.now();
    await opfsClient.write(key, data);
    const opfsWriteTime = performance.now() - opfsWriteStart;

    // Benchmark IndexedDB write
    const idbWriteStart = performance.now();
    await indexedDB.write(key, data);
    const idbWriteTime = performance.now() - idbWriteStart;

    results.push({
      name: size.name,
      operation: 'write',
      dataSize,
      recordCount: size.count,
      opfsTime: opfsWriteTime,
      indexedDBTime: idbWriteTime,
      speedup: idbWriteTime / opfsWriteTime,
    });

    // Benchmark OPFS read
    const opfsReadStart = performance.now();
    await opfsClient.read(key);
    const opfsReadTime = performance.now() - opfsReadStart;

    // Benchmark IndexedDB read
    const idbReadStart = performance.now();
    await indexedDB.read(key);
    const idbReadTime = performance.now() - idbReadStart;

    results.push({
      name: size.name,
      operation: 'read',
      dataSize,
      recordCount: size.count,
      opfsTime: opfsReadTime,
      indexedDBTime: idbReadTime,
      speedup: idbReadTime / opfsReadTime,
    });

    // Cleanup
    await opfsClient.delete(key);
    await indexedDB.delete(key);
  }

  await indexedDB.close();
  return results;
}

// Format benchmark results for display
export function formatBenchmarkResults(results: BenchmarkResult[]): string {
  let output = '\n=== OPFS vs IndexedDB Performance Benchmarks ===\n\n';
  
  const grouped = results.reduce((acc, result) => {
    if (!acc[result.name]) {
      acc[result.name] = {};
    }
    acc[result.name][result.operation] = result;
    return acc;
  }, {} as Record<string, Record<string, BenchmarkResult>>);

  for (const [sizeName, operations] of Object.entries(grouped)) {
    output += `--- ${sizeName} ---\n`;
    output += `Data Size: ${operations.write?.dataSize ? (operations.write.dataSize / 1024).toFixed(2) : 'N/A'} KB\n`;
    output += `Record Count: ${operations.write?.recordCount ?? 'N/A'}\n\n`;
    
    for (const [opName, result] of Object.entries(operations)) {
      output += `${opName.toUpperCase()}:\n`;
      output += `  OPFS: ${result.opfsTime.toFixed(2)}ms\n`;
      output += `  IndexedDB: ${result.indexedDBTime.toFixed(2)}ms\n`;
      output += `  Speedup: ${result.speedup.toFixed(2)}x ${result.speedup > 1 ? '✓' : '✗'}\n\n`;
    }
    
    output += '\n';
  }

  // Calculate averages
  const writeResults = results.filter(r => r.operation === 'write');
  const readResults = results.filter(r => r.operation === 'read');
  
  const avgWriteSpeedup = writeResults.reduce((sum, r) => sum + r.speedup, 0) / writeResults.length;
  const avgReadSpeedup = readResults.reduce((sum, r) => sum + r.speedup, 0) / readResults.length;
  
  output += '=== Summary ===\n';
  output += `Average Write Speedup: ${avgWriteSpeedup.toFixed(2)}x\n`;
  output += `Average Read Speedup: ${avgReadSpeedup.toFixed(2)}x\n`;
  output += `Overall Average Speedup: ${((avgWriteSpeedup + avgReadSpeedup) / 2).toFixed(2)}x\n`;
  
  return output;
}

// Run benchmarks in browser console
export async function runAndDisplayBenchmarks(): Promise<void> {
  console.log('Starting OPFS vs IndexedDB benchmarks...');
  
  try {
    const results = await runBenchmarks();
    const formatted = formatBenchmarkResults(results);
    console.log(formatted);
  } catch (error) {
    console.error('Benchmark failed:', error);
  }
}

// Memory usage comparison
export async function compareMemoryUsage(): Promise<void> {
  const opfsClient = getOPFSClient();
  const indexedDB = new IndexedDBStorage();
  
  const data = generateCandlestickData(10000);
  const key = 'memory-test';
  
  // OPFS memory
  const opfsQuotaBefore = await opfsClient.getQuota();
  await opfsClient.write(key, data);
  const opfsQuotaAfter = await opfsClient.getQuota();
  const opfsMemoryUsed = opfsQuotaAfter.used - opfsQuotaBefore.used;
  
  // IndexedDB memory (estimate)
  const idbQuotaBefore = await navigator.storage.estimate();
  await indexedDB.write(key, data);
  const idbQuotaAfter = await navigator.storage.estimate();
  const idbMemoryUsed = (idbQuotaAfter.usage || 0) - (idbQuotaBefore.usage || 0);
  
  console.log('=== Memory Usage Comparison (10K records) ===');
  console.log(`OPFS: ${(opfsMemoryUsed / 1024).toFixed(2)} KB`);
  console.log(`IndexedDB: ${(idbMemoryUsed / 1024).toFixed(2)} KB`);
  console.log(`OPFS is ${(idbMemoryUsed / opfsMemoryUsed).toFixed(2)}x more efficient`);
  
  // Cleanup
  await opfsClient.delete(key);
  await indexedDB.delete(key);
  await indexedDB.close();
}
