import Dexie, { type EntityTable } from 'dexie';
import type { CRDTDocument, SyncState, CRDTUpdate } from '@/lib/crdtTypes';

/**
 * Row stored in the `crdtUpdates` table.
 * `update` is kept as a plain `number[]` so that IndexedDB serialises it
 * without needing a structured-clone polyfill for Uint8Array — we convert
 * back when handing the bytes to the Yjs worker.
 */
export interface CRDTUpdateRow {
  id: string;
  docId: string;
  docType: CRDTDocument['type'];
  /** Yjs incremental update encoded as a plain number array. */
  update: number[];
  timestamp: number;
  synced: boolean;
}

export class AppDB extends Dexie {
  documents!: EntityTable<CRDTDocument, 'id'>;
  crdtUpdates!: EntityTable<CRDTUpdateRow, 'id'>;
  syncState!: EntityTable<SyncState, 'lastPullTime'>;

  constructor() {
    super('VeryPrinceDB');

    // v1 – original schema
    this.version(1).stores({
      documents: 'id, type, updatedAt, deleted',
      crdtUpdates: 'id, docId, docType, timestamp, synced',
      syncState: 'lastPullTime',
    });

    // v2 – add yjsState column to documents; migrate legacy `update` Uint8Array
    //       rows to number[] so serialisation is consistent across all browsers.
    this.version(2)
      .stores({
        documents: 'id, type, updatedAt, deleted',
        crdtUpdates: 'id, docId, docType, timestamp, synced',
        syncState: 'lastPullTime',
      })
      .upgrade(async (tx) => {
        // Migrate any existing crdtUpdates that stored Uint8Array → number[]
        await tx
          .table<CRDTUpdateRow>('crdtUpdates')
          .toCollection()
          .modify((row) => {
            if (row.update instanceof Uint8Array) {
              row.update = Array.from(row.update as unknown as Uint8Array);
            }
          });
      });
  }
}

export const db = new AppDB();
