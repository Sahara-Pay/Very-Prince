export interface CRDTDocument<T = unknown> {
  id: string;
  type: 'organization' | 'maintainer' | 'transaction' | 'draft';
  data: T;
  /**
   * Serialised Yjs state vector stored as a plain number array so IndexedDB
   * (via Dexie) can serialise it without needing special adapters.
   * Populated by the CRDT worker whenever a document is persisted.
   */
  yjsState?: number[];
  version: number;
  updatedAt: number;
  deleted?: boolean;
}

export interface OrganizationCRDT {
  id: string;
  name: string;
  admin: string;
  maintainers: string[];
  budgetStroops: string;
  metadataCid?: string;
}

export interface MaintainerCRDT {
  address: string;
  orgId: string;
  claimableStroops: string;
  name?: string;
}

export interface PendingTransactionCRDT {
  id: string;
  type: 'fund' | 'allocate' | 'claim';
  orgId: string;
  payload: Record<string, unknown>;
  signedXdr?: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

export interface SyncState {
  lastPullTime: number;
  lastPushTime: number;
  pendingChanges: number;
  isSyncing: boolean;
}

export interface CRDTUpdate {
  docId: string;
  docType: CRDTDocument['type'];
  update: Uint8Array;
  timestamp: number;
}

/**
 * A generic key-value draft edited offline (e.g. RegisterOrg form, AllocatePayout form).
 * The `fields` map is backed by a Yjs Y.Map so concurrent edits across tabs merge via CRDT.
 */
export interface DraftCRDT {
  /** Matches the form key, e.g. "register-org" or "allocate-payout-<orgId>" */
  draftKey: string;
  fields: Record<string, unknown>;
  savedAt: number;
}
