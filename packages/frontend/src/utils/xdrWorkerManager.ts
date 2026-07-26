import { topologicalSort, OperationIntent } from './dagSorter';
import { Account, TransactionBuilder, BASE_FEE, Contract, nativeToScVal } from '@stellar/stellar-sdk';

export interface XdrWorkerInput {
  intents: OperationIntent[];
  sourceAccount: string;
  sequenceNumber: string;
  networkPassphrase: string;
  contractId: string;
}

export interface XdrWorkerOutput {
  xdr: string;
  sortedIntents: OperationIntent[];
}

/**
 * Fallback function to sort and build transaction on the main thread.
 * Used during SSR, in testing environments, or when workers are unsupported.
 */
export function buildTransactionOnMainThread(input: XdrWorkerInput): XdrWorkerOutput {
  const { intents, sourceAccount, sequenceNumber, networkPassphrase, contractId } = input;
  const sortedIntents = topologicalSort(intents);
  
  const account = new Account(sourceAccount, sequenceNumber);
  const txBuilder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  });

  const contract = new Contract(contractId);
  for (const intent of sortedIntents) {
    const { type, params } = intent;
    switch (type) {
      case 'fund_org':
        txBuilder.addOperation(
          contract.call(
            "fund_org",
            nativeToScVal(params.orgId),
            nativeToScVal(params.fromAddress),
            nativeToScVal(BigInt(params.amountStroops), { type: "i128" })
          )
        );
        break;
      case 'claim_payout':
        txBuilder.addOperation(
          contract.call("claim_payout", nativeToScVal(params.userAddress))
        );
        break;
      case 'allocate_payout':
        txBuilder.addOperation(
          contract.call(
            "allocate_payout",
            nativeToScVal(params.orgId, { type: "symbol" }),
            nativeToScVal(params.adminAddress, { type: "address" }),
            nativeToScVal(params.maintainerAddress, { type: "address" }),
            nativeToScVal(BigInt(params.amountStroops), { type: "i128" }),
            nativeToScVal(0, { type: "u64" })
          )
        );
        break;
      case 'update_org_metadata':
        txBuilder.addOperation(
          contract.call(
            "update_org_metadata",
            nativeToScVal(params.orgId, { type: "symbol" }),
            nativeToScVal(params.adminAddress, { type: "address" }),
            nativeToScVal(params.metadataCid, { type: "string" })
          )
        );
        break;
      default:
        throw new Error(`Unsupported operation type: ${type}`);
    }
  }

  const tx = txBuilder.setTimeout(60).build();
  return {
    xdr: tx.toXDR(),
    sortedIntents,
  };
}

/**
 * Orchestrates the Web Worker execution.
 * Spawns the Web Worker and posts inputs, receiving the results via zero-copy ArrayBuffer transfer.
 * If Web Workers are not supported (e.g. Server Side Rendering or Vitest environment),
 * it falls back to building the transaction on the main thread.
 */
export function sortAndBuildBatchTransaction(input: XdrWorkerInput): Promise<XdrWorkerOutput> {
  return new Promise((resolve, reject) => {
    // Check if worker environment is available
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
      try {
        const result = buildTransactionOnMainThread(input);
        resolve(result);
      } catch (err) {
        reject(err);
      }
      return;
    }

    try {
      // Instantiate worker using Next.js compatible URL syntax
      const worker = new Worker(new URL('./xdrWorker.ts', import.meta.url));

      worker.onmessage = (event: MessageEvent) => {
        const { type, buffer, sortedIntents, error } = event.data;
        if (type === 'success') {
          // Decode buffer back into string on the main thread
          const decoder = new TextDecoder();
          const xdr = decoder.decode(new Uint8Array(buffer));
          resolve({ xdr, sortedIntents });
          worker.terminate();
        } else {
          reject(new Error(error || 'Worker execution failed'));
          worker.terminate();
        }
      };

      worker.onerror = (err) => {
        reject(err);
        worker.terminate();
      };

      // Post the message to the worker thread
      worker.postMessage(input);
    } catch (err) {
      // Fallback if worker instantiation fails
      try {
        const result = buildTransactionOnMainThread(input);
        resolve(result);
      } catch (fallbackErr) {
        reject(fallbackErr);
      }
    }
  });
}
