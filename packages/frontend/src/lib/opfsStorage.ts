// Client-side interface for OPFS Storage Worker
// Provides type-safe communication with the Web Worker

export interface CandlestickData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StorageMetadata {
  version: number;
  lastUpdated: number;
  recordCount: number;
  oldestTimestamp: number;
  newestTimestamp: number;
  fileSize: number;
}

export interface StorageQuota {
  used: number;
  limit: number;
  available: number;
}

type WorkerMessage = 
  | { type: 'write'; key: string; data: CandlestickData[] }
  | { type: 'read'; key: string; fromTimestamp?: number; toTimestamp?: number }
  | { type: 'delete'; key: string }
  | { type: 'getQuota' }
  | { type: 'evictLRU'; bytesNeeded: number };

type WorkerResponse = 
  | { success: true; data?: any; metadata?: StorageMetadata }
  | { success: false; error?: string };

class OPFSStorageClient {
  private worker: Worker | null = null;
  private messageQueue: Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
  private messageId = 0;
  private initPromise: Promise<void> | null = null;

  private async initWorker(): Promise<void> {
    if (this.worker) return;
    
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      try {
        // Create worker from blob to avoid bundling issues
        const workerCode = `
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

          // Binary serialization format for OHLCV data
          // Layout per candlestick: [timestamp(8B)][open(8B)][high(8B)][low(8B)][close(8B)][volume(8B)] = 48 bytes
          const CANDLESTICK_SIZE = 48; // 6 * 8 bytes (Float64)
          const METADATA_SIZE = 48; // version(4) + lastUpdated(8) + recordCount(8) + oldestTimestamp(8) + newestTimestamp(8) + fileSize(8) = 44 bytes, rounded to 48 for alignment

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
          self.onmessage = async (e) => {
            const request = e.data;
            
            try {
              let response;

              switch (request.type) {
                case 'write': {
                  const metadata = await storageManager.write(request.key, request.data);
                  response = { success: true, data: request.data, metadata };
                  break;
                }
                
                case 'read': {
                  const result = await storageManager.read(request.key, request.fromTimestamp, request.toTimestamp);
                  response = { success: true, data: result.data, metadata: result.metadata };
                  break;
                }
                
                case 'delete': {
                  await storageManager.delete(request.key);
                  response = { success: true };
                  break;
                }
                
                case 'getQuota': {
                  const quota = await storageManager.getQuota();
                  response = { success: true, data: quota };
                  break;
                }
                
                case 'evictLRU': {
                  const usage = await storageManager.evictLRU(request.bytesNeeded);
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
        `;

        const blob = new Blob([workerCode], { type: 'application/javascript' });
        this.worker = new Worker(URL.createObjectURL(blob));

        this.worker.onmessage = (e) => {
          const { messageId, response } = e.data;
          const pending = this.messageQueue.get(messageId);
          
          if (pending) {
            this.messageQueue.delete(messageId);
            
            if (response.success) {
              pending.resolve(response);
            } else {
              pending.reject(new Error(response.error || 'Unknown error'));
            }
          }
        };

        this.worker.onerror = (error) => {
          console.error('OPFS Worker error:', error);
        };
      } catch (error) {
        this.initPromise = null;
        throw error;
      }
    })();

    return this.initPromise;
  }

  private async sendMessage(message: WorkerMessage): Promise<WorkerResponse> {
    await this.initWorker();
    
    return new Promise((resolve, reject) => {
      const id = ++this.messageId;
      this.messageQueue.set(id, { resolve, reject });
      
      this.worker!.postMessage({ messageId: id, ...message });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.messageQueue.has(id)) {
          this.messageQueue.delete(id);
          reject(new Error('OPFS operation timeout'));
        }
      }, 30000);
    });
  }

  async write(key: string, data: CandlestickData[]): Promise<{ data: CandlestickData[]; metadata: StorageMetadata }> {
    const response = await this.sendMessage({ type: 'write', key, data });
    if (!response.success) throw new Error(response.error);
    return { data: response.data, metadata: response.metadata! };
  }

  async read(key: string, fromTimestamp?: number, toTimestamp?: number): Promise<{ data: CandlestickData[]; metadata: StorageMetadata }> {
    const message: WorkerMessage = { type: 'read', key };
    if (fromTimestamp !== undefined) message.fromTimestamp = fromTimestamp;
    if (toTimestamp !== undefined) message.toTimestamp = toTimestamp;
    
    const response = await this.sendMessage(message);
    if (!response.success) throw new Error(response.error);
    return { data: response.data, metadata: response.metadata! };
  }

  async delete(key: string): Promise<void> {
    const response = await this.sendMessage({ type: 'delete', key });
    if (!response.success) throw new Error(response.error);
  }

  async getQuota(): Promise<StorageQuota> {
    const response = await this.sendMessage({ type: 'getQuota' });
    if (!response.success) throw new Error(response.error);
    return response.data;
  }

  async evictLRU(bytesNeeded: number): Promise<number> {
    const response = await this.sendMessage({ type: 'evictLRU', bytesNeeded });
    if (!response.success) throw new Error(response.error);
    return response.data.currentUsage;
  }

  isSupported(): boolean {
    return typeof window !== 'undefined' && 
           'storage' in navigator && 
           'getDirectory' in navigator.storage;
  }

  terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.messageQueue.clear();
    this.initPromise = null;
  }
}

// Singleton instance
let opfsClient: OPFSStorageClient | null = null;

export function getOPFSClient(): OPFSStorageClient {
  if (!opfsClient) {
    opfsClient = new OPFSStorageClient();
  }
  return opfsClient;
}

// Delta sync logic - fetches only new data from backend
export async function syncWithDelta(
  key: string,
  fetchFn: (fromTimestamp?: number) => Promise<CandlestickData[]>
): Promise<{ data: CandlestickData[]; fromCache: boolean; hasNewData: boolean }> {
  const client = getOPFSClient();
  
  if (!client.isSupported()) {
    // Fallback to direct fetch if OPFS not supported
    const data = await fetchFn();
    return { data, fromCache: false, hasNewData: false };
  }

  try {
    // Try to read existing data
    const cached = await client.read(key);
    
    // Fetch only new data since the newest cached timestamp
    const newData = await fetchFn(cached.metadata.newestTimestamp);
    
    if (newData.length === 0) {
      // No new data available
      return { 
        data: cached.data, 
        fromCache: true, 
        hasNewData: false 
      };
    }

    // Merge cached data with new data
    const mergedData = [...cached.data, ...newData];
    
    // Write merged data back to storage
    await client.write(key, mergedData);
    
    return { 
      data: mergedData, 
      fromCache: true, 
      hasNewData: true 
    };
  } catch (error) {
    // If cache doesn't exist or is corrupted, fetch all data
    const data = await fetchFn();
    await client.write(key, data);
    
    return { 
      data, 
      fromCache: false, 
      hasNewData: true 
    };
  }
}

// Convert funding history data to candlestick format
export function toCandlestickData(fundingHistory: any[]): CandlestickData[] {
  return fundingHistory.map((item) => ({
    timestamp: item.time || new Date(item.createdAt).getTime(),
    open: Number(item.cumulativeXlm),
    high: Number(item.cumulativeXlm),
    low: Number(item.cumulativeXlm),
    close: Number(item.cumulativeXlm),
    volume: Number(item.amountXlm),
  }));
}

// Convert candlestick data back to funding history format
export function fromCandlestickData(candlesticks: CandlestickData[]): any[] {
  return candlesticks.map((candle) => ({
    time: candle.timestamp,
    createdAt: new Date(candle.timestamp).toISOString(),
    cumulativeXlm: candle.close.toString(),
    amountXlm: candle.volume.toString(),
  }));
}
