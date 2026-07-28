import { describe, it, expect } from 'vitest';
import { sortAndBuildBatchTransaction } from '../xdrWorkerManager';
import { OperationIntent } from '../dagSorter';
import { Keypair, Networks, StrKey } from '@stellar/stellar-sdk';

describe('xdrWorkerManager - Transaction Builder & Sorter', () => {
  const keypair = Keypair.random();
  const sourceAccount = keypair.publicKey();
  const sequenceNumber = '100';
  const networkPassphrase = Networks.TESTNET;
  const contractId = StrKey.encodeContract(new Uint8Array(32));

  it('should successfully sort and build a transaction with multiple operations', async () => {
    const intents: OperationIntent[] = [
      {
        id: 'claim_1',
        type: 'claim_payout',
        params: { userAddress: sourceAccount },
        dependencies: ['fund_1'],
      },
      {
        id: 'fund_1',
        type: 'fund_org',
        params: {
          orgId: 'stellar',
          fromAddress: sourceAccount,
          amountStroops: '10000000',
        },
        dependencies: [],
      },
    ];

    const result = await sortAndBuildBatchTransaction({
      intents,
      sourceAccount,
      sequenceNumber,
      networkPassphrase,
      contractId,
    });

    expect(result.xdr).toBeTypeOf('string');
    expect(result.sortedIntents.map(i => i.id)).toEqual(['fund_1', 'claim_1']);
  });

  it('should propagate errors from cyclic dependencies', async () => {
    const intents: OperationIntent[] = [
      { id: 'A', type: 'claim_payout', params: { userAddress: sourceAccount }, dependencies: ['B'] },
      { id: 'B', type: 'claim_payout', params: { userAddress: sourceAccount }, dependencies: ['A'] },
    ];

    await expect(
      sortAndBuildBatchTransaction({
        intents,
        sourceAccount,
        sequenceNumber,
        networkPassphrase,
        contractId,
      })
    ).rejects.toThrow(/Cyclic dependency/);
  });
});
