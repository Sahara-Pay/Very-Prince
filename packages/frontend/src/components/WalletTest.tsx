/**
 * @file WalletTest.tsx
 * @description Test component to demonstrate and verify wallet functionality
 */

'use client';

import { useWallet } from '@/contexts/WalletContext';

export function WalletTest() {
  const {
    publicKey,
    network,
    isConnected,
    isConnecting,
    error,
    connectWallet,
    disconnectWallet,
  } = useWallet();

  const handleTestTransaction = async () => {
    if (!isConnected || !publicKey) return;
    
    try {
      // This is just a test - in real usage you'd create a proper transaction
      console.log('Testing transaction signing with network:', network);
      // const result = await signTransaction('test-transaction-xdr');
      // console.log('Signed transaction:', result);
    } catch (error) {
      console.error('Test transaction failed:', error);
    }
  };

  return (
    <div className="p-4 border border-stellar-purple/30 rounded-lg bg-stellar-purple/10">
      <h3 className="text-lg font-semibold mb-4">Wallet Status Test</h3>
      
      <div className="space-y-2 text-sm">
        <p><strong>Status:</strong> {isConnected ? 'Connected' : 'Disconnected'}</p>
        <p><strong>Connecting:</strong> {isConnecting ? 'Yes' : 'No'}</p>
        <p><strong>Network:</strong> {network}</p>
        <p><strong>Public Key:</strong> {publicKey || 'Not connected'}</p>
        {error && <p className="text-red-400"><strong>Error:</strong> {error}</p>}
      </div>

      <div className="mt-4 space-x-2">
        {!isConnected ? (
          <button
            onClick={connectWallet}
            disabled={isConnecting}
            aria-label="Connect wallet"
            className="px-4 py-2 bg-stellar-purple text-white rounded hover:bg-stellar-purple/80 disabled:opacity-50"
          >
            {isConnecting ? 'Connecting...' : 'Connect Wallet'}
          </button>
        ) : (
          <>
            <button
              onClick={disconnectWallet}
              aria-label="Disconnect wallet"
              className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-500/80"
            >
              Disconnect
            </button>
            <button
              onClick={handleTestTransaction}
              aria-label="Test signing a transaction"
              className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-500/80"
            >
              Test Sign
            </button>
          </>
        )}
      </div>
    </div>
  );
}
