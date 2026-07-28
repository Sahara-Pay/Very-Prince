/**
 * @file AuthContext.tsx
 * @description React Context provider for authentication state management
 * 
 * This context provides:
 * - Authentication state (isAuthenticated, user, token)
 * - Functions to sign in/out
 * - Integration with SIWS authentication flow
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';
import { signInWithStellar, storeAuthToken, removeAuthToken, getAuthToken, AuthResponse } from '@/lib/authService';
import { useWallet } from '@/contexts/WalletContext';

// ── Type Definitions ───────────────────────────────────────────────────────

export interface User {
  publicKey: string;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;
}

export interface AuthContextType extends AuthState {
  signIn: () => Promise<void>;
  signOut: () => void;
  checkAuth: () => Promise<void>;
}

// ── Context Creation ───────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ── Provider Component ─────────────────────────────────────────────────────

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    token: null,
    isLoading: true,
    error: null,
  });

  const { isConnected: isWalletConnected, publicKey: walletPublicKey, isInitialized: isWalletInitialized } = useWallet();

  // ── Authentication Functions ─────────────────────────────────────────────

  const signIn = useCallback(async () => {
    setAuthState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      const authResponse: AuthResponse = await signInWithStellar();
      
      // Store token and update state
      storeAuthToken(authResponse.token);
      
      setAuthState({
        isAuthenticated: true,
        user: authResponse.user,
        token: authResponse.token,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Authentication failed';
      setAuthState(prev => ({
        ...prev,
        isLoading: false,
        error: errorMessage,
      }));
    }
  }, []);

  const signOut = useCallback(() => {
    // Remove token and reset state
    removeAuthToken();
    
    setAuthState({
      isAuthenticated: false,
      user: null,
      token: null,
      isLoading: false,
      error: null,
    });
  }, []);

  const checkAuth = useCallback(async () => {
    setAuthState(prev => ({ ...prev, isLoading: true }));

    try {
      const token = getAuthToken();
      
      if (!token) {
        // No token found, user is not authenticated
        setAuthState({
          isAuthenticated: false,
          user: null,
          token: null,
          isLoading: false,
          error: null,
        });
        return;
      }

      // TODO: Validate token with backend if needed
      // For now, we'll assume the token is valid if it exists
      // In a production app, you might want to validate the token
      // by making a request to a /api/v1/auth/me endpoint
      
      // Extract user info from token (this is a simplified approach)
      // In production, you'd decode the JWT or call a validation endpoint
      let decodedPublicKey = 'decoded-from-token';
      if (token && token.startsWith('mock-jwt-token-for-')) {
        decodedPublicKey = token.replace('mock-jwt-token-for-', '');
      }
      const user: User = {
        publicKey: decodedPublicKey,
      };

      setAuthState({
        isAuthenticated: true,
        user,
        token,
        isLoading: false,
        error: null,
      });
    } catch (error) {
      console.error('Error checking authentication:', error);
      
      // If there's an error, clear the token and set unauthenticated state
      removeAuthToken();
      setAuthState({
        isAuthenticated: false,
        user: null,
        token: null,
        isLoading: false,
        error: null,
      });
    }
  }, []);

  // ── Sync Auth State with Wallet State ─────────────────────────────────────

  useEffect(() => {
    if (!isWalletInitialized) return;

    if (!isWalletConnected) {
      if (authState.isAuthenticated) {
        signOut();
      }
    } else if (walletPublicKey && authState.isAuthenticated && authState.user) {
      // If the authenticated user's public key doesn't match the current wallet public key
      if (authState.user.publicKey !== walletPublicKey) {
        signOut();
      }
    }
  }, [isWalletInitialized, isWalletConnected, walletPublicKey, authState.isAuthenticated, authState.user, signOut]);

  // ── Initial Auth Check ───────────────────────────────────────────────────

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // ── Context Value ─────────────────────────────────────────────────────────

  const contextValue: AuthContextType = useMemo(
    () => ({
      ...authState,
      signIn,
      signOut,
      checkAuth,
    }),
    [authState, signIn, signOut, checkAuth]
  );
  return (
    <AuthContext.Provider value={contextValue}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook for Using Auth Context ───────────────────────────────────────────

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// ── Export Context (for testing) ─────────────────────────────────────────────

export { AuthContext };
