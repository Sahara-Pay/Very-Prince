/**
 * @file SignInButton.tsx
 * @description Sign-In With Stellar (SIWS) button component
 * Provides a complete authentication flow with loading states and error handling
 */

'use client';

import React from 'react';
import { useAuthWithWallet } from '@/hooks/useAuth';
import { useWallet } from '@/contexts/WalletContext';

export function SignInButton() {
  const { 
    isAuthenticated, 
    isWalletConnected, 
    signIn, 
    signOut, 
    isLoading, 
    user 
  } = useAuthWithWallet();
  
  const { connectWallet, publicKey: walletPublicKey } = useWallet();

  const handleSignIn = async () => {
    try {
      if (!isWalletConnected) {
        await connectWallet();
      }
      await signIn();
    } catch (error) {
      console.error('Sign in error:', error);
    }
  };

  const handleSignOut = () => {
    signOut();
  };

  if (isLoading) {
    return (
      <button 
        disabled 
        aria-label="Signing in with wallet"
        className="px-6 py-2 bg-stellar-blue/50 border border-stellar-purple/30 rounded-lg text-white/70 cursor-not-allowed"
      >
        Loading...
      </button>
    );
  }

  if (isAuthenticated && user) {
    return (
      <div className="flex items-center gap-4">
        <div className="text-sm text-white/80">
          <span className="text-white/60">Signed in as:</span>{' '}
          <span className="font-mono text-white">
            {user.publicKey.slice(0, 8)}...{user.publicKey.slice(-8)}
          </span>
        </div>
        <button
          onClick={handleSignOut}
          aria-label="Sign out of account"
          className="px-4 py-2 bg-red-500/20 border border-red-500/50 rounded-lg text-red-300 hover:bg-red-500/30 transition-colors"
        >
          Sign Out
        </button>
      </div>
    );
  }

  if (!isWalletConnected) {
    return (
      <button
        onClick={connectWallet}
        aria-label="Connect wallet to sign in"
        className="px-6 py-2 bg-stellar-purple border border-stellar-purple/50 rounded-lg text-white hover:bg-stellar-purple/80 transition-colors"
      >
        Connect Wallet
      </button>
    );
  }

  if (walletPublicKey && !isAuthenticated) {
    return (
      <div className="flex items-center gap-4">
        <div className="text-sm text-white/80">
          <span className="text-white/60">Wallet:</span>{' '}
          <span className="font-mono text-white">
            {walletPublicKey.slice(0, 8)}...{walletPublicKey.slice(-8)}
          </span>
        </div>
        <button
          onClick={handleSignIn}
          aria-label="Sign in with Stellar wallet"
          className="px-6 py-2 bg-stellar-purple border border-stellar-purple/50 rounded-lg text-white hover:bg-stellar-purple/80 transition-colors"
        >
          Sign In with Stellar
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={handleSignIn}
      aria-label="Sign in with Stellar wallet"
      className="px-6 py-2 bg-stellar-purple border border-stellar-purple/50 rounded-lg text-white hover:bg-stellar-purple/80 transition-colors"
    >
      Sign In with Stellar
    </button>
  );
}
