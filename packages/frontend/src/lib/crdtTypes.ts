export interface CRDTDocument<T = unknown> {
  id: string;
  type: 'organization' | 'maintainer' | 'transaction' | 'draft';
  data: T;
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
