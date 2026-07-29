// OPFS Storage Worker - Handles binary serialization and file system operations
// for historical candlestick data with near-native performance

interface CandlestickData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface StorageMetadata {
  version: number;
  lastUpdated: number;
  recordCount: number;
  oldestTimestamp: number;
  newestTimestamp: number;
  fileSize: number;
}

interface WriteRequest {
  type: 'write';
  key: string;
  data: CandlestickData[];
}

interface ReadRequest {
  type: 'read';
  key: string;
  fromTimestamp?: number;
  toTimestamp?: number;
}

interface DeleteRequest {
  type: 'delete';
  key: string;
}

interface QuotaRequest {
  type: 'getQuota';
}

interface LRURequest {
  type: 'evictLRU';
  bytesNeeded: number;
}

interface WorkerResponse {
  success: boolean;
  data?: any;
  error?: string;
  metadata?: StorageMetadata;
}

// Binary serialization format for OHLCV data
// Layout per candlestick: [timestamp(8B)][open(8B)][high(8B)][low(8B)][close(8B)][volume(8B)] = 48 bytes
const CANDLESTICK_SIZE = 48; // 6 * 8 bytes (Float64)
const METADATA_SIZE = 32; // version(4) + lastUpdated(8) + recordCount(8) + oldestTimestamp(8) + newestTimestamp(8) + fileSize(8) = 44 bytes, rounded to 48 for alignment

function serializeCandlestick(data: CandlestickData): Uint8Array {
  const buffer = new ArrayBuffer(CANDLESTICK_SIZE);
  const view = new DataView(buffer);
  
  view.setFloat64(0, data.timestamp, true);
  view.setFloat64(8, data.open, true);
  view.setFloat64(16, data.high, true);
  view.setFloat64(24, data.low, true);
  view.setFloat64(32, data.close, true);
  view.setFloat64(40, data.volume, true);
  
  return new Uint8Array(buffer);
}

function deserializeCandlestick(buffer: Uint8Array, offset: number): CandlestickData {
  const view = new DataView(buffer.buffer, buffer.byteOffset + offset);
  return {
    timestamp: view.getFloat64(0, true),
    open: view.getFloat64(8, true),
    high: view.getFloat64(16, true),
    low: view.getFloat64(24, true),
    close: view.getFloat64(32, true),
    volume: view.getFloat64(40, true),
  };
}

function serializeMetadata(metadata: StorageMetadata): Uint8Array {
  const buffer = new ArrayBuffer(METADATA_SIZE);
  const view = new DataView(buffer);
  
  view.setUint32(0, metadata.version, true);
  view.setFloat64(4, metadata.lastUpdated, true);
  view.setFloat64(12, metadata.recordCount, true);
  view.setFloat64(20, metadata.oldestTimestamp, true);
  view.setFloat64(28, metadata.newestTimestamp, true);
  view.setFloat64(36, metadata.fileSize, true);
  
  return new Uint8Array(buffer);
}

function deserializeMetadata(buffer: Uint8Array): StorageMetadata {
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  return {
    version: view.getUint32(0, true),
    lastUpdated: view.getFloat64(4, true),
    recordCount: view.getFloat64(12, true),
    oldestTimestamp: view.getFloat64(20, true),
    newestTimestamp: view.getFloat64(28, true),
    fileSize: view.getFloat64(36, true),
  };
}

// LRU Cache for tracking file access times
const lruCache = new Map<string, number>();

function updateLRU(key: string): void {
  lruCache.set(key, Date.now());
}

// OPFS Storage Manager
class OPFSStorageManager {
  private opfsRoot: FileSystemDirectoryHandle | null = null;
  private maxStorageBytes: number = 100 * 1024 * 1024; // 100MB default limit
  private currentUsage: number = 0;

  async init(): Promise<void> {
    if (!('storage' in navigator && 'getDirectory' in navigator.storage)) {
      throw new Error('OPFS not supported in this browser');
    }
    
    this.opfsRoot = await navigator.storage.getDirectory();
    await this.calculateUsage();
  }

  private async calculateUsage(): Promise<void> {
    if (!this.opfsRoot) return;
    
    let total = 0;
    for await (const [name, handle] of this.opfsRoot.entries()) {
      if (handle.kind === 'file') {
        const file = await handle.getFile();
        total += file.size;
      }
    }
    this.currentUsage = total;
  }

  private async ensureCapacity(bytesNeeded: number): Promise<void> {
    if (this.currentUsage + bytesNeeded <= this.maxStorageBytes) {
      return;
    }

    // Sort by LRU access time
    const entries = Array.from(lruCache.entries()).sort((a, b) => a[1] - b[1]);
    let freed = 0;

    for (const [key, _] of entries) {
      if (freed >= bytesNeeded) break;
      
      try {
        await this.deleteFile(key);
        const fileHandle = await this.opfsRoot!.getFileHandle(key);
        const file = await fileHandle.getFile();
        freed += file.size;
      } catch (e) {
        // File might not exist, skip
        lruCache.delete(key);
      }
    }

    await this.calculateUsage();
  }

  private async deleteFile(key: string): Promise<void> {
    if (!this.opfsRoot) return;
    
    try {
      await this.opfsRoot.removeEntry(key);
      lruCache.delete(key);
    } catch (e) {
      // File might not exist
    }
  }

  async write(key: string, data: CandlestickData[]): Promise<StorageMetadata> {
    if (!this.opfsRoot) await this.init();
    
    // Calculate required space
    const dataSize = data.length * CANDLESTICK_SIZE + METADATA_SIZE;
    await this.ensureCapacity(dataSize);

    // Sort data by timestamp
    const sortedData = [...data].sort((a, b) => a.timestamp - b.timestamp);

    // Serialize data
    const dataBuffer = new Uint8Array(data.length * CANDLESTICK_SIZE);
    for (let i = 0; i < sortedData.length; i++) {
      const serialized = serializeCandlestick(sortedData[i]!);
      dataBuffer.set(serialized, i * CANDLESTICK_SIZE);
    }

    // Create metadata
    const metadata: StorageMetadata = {
      version: 1,
      lastUpdated: Date.now(),
      recordCount: sortedData.length,
      oldestTimestamp: sortedData[0]?.timestamp || 0,
      newestTimestamp: sortedData[sortedData.length - 1]?.timestamp || 0,
      fileSize: dataSize,
    };

    const metadataBuffer = serializeMetadata(metadata);

    // Write to file
    const fileHandle = await this.opfsRoot!.getFileHandle(key, { create: true });
    const writable = await fileHandle.createWritable();
    
    await writable.write(metadataBuffer);
    await writable.write(dataBuffer);
    await writable.close();

    updateLRU(key);
    await this.calculateUsage();

    return metadata;
  }

  async read(key: string, fromTimestamp?: number, toTimestamp?: number): Promise<{ data: CandlestickData[]; metadata: StorageMetadata }> {
    if (!this.opfsRoot) await this.init();

    const fileHandle = await this.opfsRoot!.getFileHandle(key);
    const file = await fileHandle.getFile();
    const buffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);

    // Read metadata
    const metadata = deserializeMetadata(uint8Array.slice(0, METADATA_SIZE));
    
    updateLRU(key);

    // Read candlestick data
    const data: CandlestickData[] = [];
    const offset = METADATA_SIZE;
    
    for (let i = 0; i < metadata.recordCount; i++) {
      const candlestick = deserializeCandlestick(uint8Array, offset + i * CANDLESTICK_SIZE);
      
      // Filter by timestamp range if specified
      if (fromTimestamp !== undefined && candlestick.timestamp < fromTimestamp) continue;
      if (toTimestamp !== undefined && candlestick.timestamp > toTimestamp) continue;
      
      data.push(candlestick);
    }

    return { data, metadata };
  }

  async delete(key: string): Promise<void> {
    if (!this.opfsRoot) await this.init();
    await this.deleteFile(key);
    await this.calculateUsage();
  }

  async getQuota(): Promise<{ used: number; limit: number; available: number }> {
    if (!this.opfsRoot) await this.init();
    await this.calculateUsage();
    
    const estimate = await navigator.storage.estimate();
    return {
      used: this.currentUsage,
      limit: this.maxStorageBytes,
      available: this.maxStorageBytes - this.currentUsage,
    };
  }

  async evictLRU(bytesNeeded: number): Promise<number> {
    await this.ensureCapacity(bytesNeeded);
    return this.currentUsage;
  }
}

const storageManager = new OPFSStorageManager();

// Message handler
self.onmessage = async (e: MessageEvent) => {
  const request = e.data;
  
  try {
    let response: WorkerResponse;

    switch (request.type) {
      case 'write': {
        const writeReq = request as WriteRequest;
        const metadata = await storageManager.write(writeReq.key, writeReq.data);
        response = { success: true, data: writeReq.data, metadata };
        break;
      }
      
      case 'read': {
        const readReq = request as ReadRequest;
        const result = await storageManager.read(readReq.key, readReq.fromTimestamp, readReq.toTimestamp);
        response = { success: true, data: result.data, metadata: result.metadata };
        break;
      }
      
      case 'delete': {
        const deleteReq = request as DeleteRequest;
        await storageManager.delete(deleteReq.key);
        response = { success: true };
        break;
      }
      
      case 'getQuota': {
        const quota = await storageManager.getQuota();
        response = { success: true, data: quota };
        break;
      }
      
      case 'evictLRU': {
        const lruReq = request as LRURequest;
        const usage = await storageManager.evictLRU(lruReq.bytesNeeded);
        response = { success: true, data: { currentUsage: usage } };
        break;
      }
      
      default:
        response = { success: false, error: 'Unknown request type' };
    }

    self.postMessage(response);
  } catch (error) {
    self.postMessage({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
};

export {};
