import Dexie, { type EntityTable } from 'dexie';
import type { CRDTDocument, SyncState, CRDTUpdate } from '@/lib/crdtTypes';

export class AppDB extends Dexie {
  documents!: EntityTable<CRDTDocument, 'id'>;
  crdtUpdates!: EntityTable<{
    id: string;
    docId: string;
    docType: CRDTDocument['type'];
    update: Uint8Array;
    timestamp: number;
    synced: boolean;
  }, 'id'>;
  syncState!: EntityTable<SyncState, 'lastPullTime'>;

  constructor() {
    super('VeryPrinceDB');
    this.version(1).stores({
      documents: 'id, type, updatedAt, deleted',
      crdtUpdates: 'id, docId, docType, timestamp, synced',
      syncState: 'lastPullTime',
    });
  }
}

export const db = new AppDB();
