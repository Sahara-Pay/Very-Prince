import { Account, TransactionBuilder, BASE_FEE, Contract, nativeToScVal } from '@stellar/stellar-sdk';
import { topologicalSort, OperationIntent } from './dagSorter';

const ctx: Worker = self as any;

ctx.onmessage = (event: MessageEvent) => {
  try {
    const { intents, sourceAccount, sequenceNumber, networkPassphrase, contractId } = event.data;

    // 1. Topologically sort the operation intents (CPU intensive math with cycle detection)
    const sortedIntents = topologicalSort(intents);

    // 2. Load the account using Account from sdk directly
    const account = new Account(sourceAccount, sequenceNumber);

    const txBuilder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    });

    const contract = new Contract(contractId);

    // 3. Construct sorted operations inside a single transaction
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
    const xdr = tx.toXDR();

    // 4. Encode XDR into ArrayBuffer for zero-copy memory transfer
    const encoder = new TextEncoder();
    const uint8 = encoder.encode(xdr);
    const buffer = uint8.buffer;

    ctx.postMessage({ type: 'success', buffer, sortedIntents }, [buffer]);
  } catch (error: any) {
    ctx.postMessage({ type: 'error', error: error.message || 'Unknown worker error' });
  }
};
