/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope;

const DB_NAME = 'TRPC_OFFLINE_DB';
const STORE_NAME = 'requests';

// Initialize IndexedDB
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e: any) => {
      e.target.result.createObjectStore(STORE_NAME, { autoIncrement: true });
    };
    request.onsuccess = (e: any) => resolve(e.target.result);
    request.onerror = (e) => reject(e);
  });
}

// Serialize and store failed request
async function saveRequestToIndexedDB(request: Request) {
  const db = await openDB();
  
  // Need to read body before storing
  const bodyText = await request.clone().text();
  
  const serialized = {
    url: request.url,
    headers: Array.from(request.headers.entries()),
    body: bodyText,
    timestamp: Date.now()
  };

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const addReq = store.add(serialized);
    addReq.onsuccess = () => resolve();
    addReq.onerror = () => reject();
  });
}

// Replay queued requests with strict causal ordering
async function replayQueue() {
  const db = await openDB();
  
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    
    const getAllReq = store.getAll();
    const getKeysReq = store.getAllKeys();
    
    getAllReq.onsuccess = async () => {
      const entries = getAllReq.result;
      const keys = getKeysReq.result;
      
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const key = keys[i];
        
        try {
          const res = await fetch(entry.url, {
            method: 'POST',
            headers: new Headers(entry.headers),
            body: entry.body
          });
          
          if (res.status === 401 || res.status === 403) {
            // Notify clients of auth failure
            const clients = await self.clients.matchAll();
            clients.forEach(client => {
              client.postMessage({ 
                type: 'SYNC_FAILED_AUTH', 
                url: entry.url,
                status: res.status
              });
            });
            // Delete from queue so it doesn't block future requests
            await new Promise((r) => {
              const delTx = db.transaction(STORE_NAME, 'readwrite');
              delTx.objectStore(STORE_NAME).delete(key).onsuccess = r;
            });
          } else if (res.ok) {
            // Successfully replayed, remove from queue
            await new Promise((r) => {
              const delTx = db.transaction(STORE_NAME, 'readwrite');
              delTx.objectStore(STORE_NAME).delete(key).onsuccess = r;
            });
          } else {
            // Other server error (e.g. 500), keep in queue or drop depending on policy
            // For now, let's keep it in the queue and stop syncing to preserve order
            break;
          }
        } catch (err) {
          // Network still down, stop replaying to preserve causal ordering
          break;
        }
      }
      resolve();
    };
    getAllReq.onerror = () => reject();
  });
}

// Intercept fetch requests
self.addEventListener('fetch', (event: FetchEvent) => {
  const url = new URL(event.request.url);
  
  // Intercept tRPC mutations (POST requests)
  if (event.request.method === 'POST' && url.pathname.includes('/trpc/')) {
    event.respondWith(
      fetch(event.request.clone()).catch(async (error) => {
        // Network failure caught here
        console.warn('Network failure on tRPC mutation. Queueing for offline sync.', error);
        await saveRequestToIndexedDB(event.request.clone());
        
        // Register for background sync if supported
        if ('sync' in self.registration) {
          try {
            await (self.registration as any).sync.register('trpc-replay-sync');
          } catch (e) {
            console.error('Failed to register background sync', e);
          }
        }
        
        // Return a mock response so the app doesn't crash completely, 
        // though tRPC will likely throw a TRPCClientError if it's not a standard shape.
        // Returning 503 Service Unavailable with a specific payload
        return new Response(JSON.stringify([{
          error: {
            message: 'Queued for offline sync',
            data: { code: 'CLIENT_CLOSED_REQUEST' }
          }
        }]), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
  }
});

// Listen for background sync events
self.addEventListener('sync', (event: any) => {
  if (event.tag === 'trpc-replay-sync') {
    event.waitUntil(replayQueue());
  }
});

// Also try to replay when the service worker becomes active
self.addEventListener('activate', (event) => {
  event.waitUntil(replayQueue());
});

// Allow clients to manually trigger a sync (e.g. via postMessage when they detect online event)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TRIGGER_SYNC') {
    event.waitUntil(replayQueue());
  }
});

// To ensure TypeScript compiles this correctly for next-pwa worker
export {};
