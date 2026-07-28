/**
 * @file useClaimPayout.ts
 * @description Hook for claiming payouts using Freighter wallet.
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { toastTransaction } from '../lib/transactionToast';

export function useClaimPayout() {
  const [isClaiming, setIsClaiming] = useState(false);

  const claimPayout = async (orgId: string) => {
    if (!window.freighter) {
      toast.error('Please install Freighter wallet to claim payouts');
      return;
    }

    setIsClaiming(true);

    try {
      // Get the connected wallet address
      const { address } = await window.freighter.getPublicKey();
      
      if (!address) {
        throw new Error('No wallet connected');
      }

      // Build the claim_payout transaction
      // This would typically involve calling the backend to create the transaction
      const response = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/v1/contract/claim`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          orgId,
          maintainerAddress: address,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(errorData.message || 'Failed to create claim transaction');
      }

      const { transactionXdr } = await response.json();

      // Sign the transaction with Freighter
      const signedTransaction = await window.freighter.signTransaction(transactionXdr);

      // Submit the signed transaction
      const submitResponse = await fetch(`${process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001'}/api/v1/contract/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          signedTransaction,
        }),
      });

      if (!submitResponse.ok) {
        const errorData = await submitResponse.json().catch(() => ({ message: submitResponse.statusText }));
        throw new Error(errorData.message || 'Failed to submit transaction');
      }

      const result = await submitResponse.json();

      toastTransaction.success('Successfully claimed payout!', result.transactionHash);
      return result;

    } catch (error) {
      console.error('Error claiming payout:', error);
      toastTransaction.error(error, 'Failed to claim payout');
      throw error;
    } finally {
      setIsClaiming(false);
    }
  };

  return {
    claimPayout,
    isClaiming,
  };
}
