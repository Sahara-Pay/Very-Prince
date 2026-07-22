/**
 * @file authService.ts
 * @description Sign-In With Stellar (SIWS) authentication service
 */

import { toast } from "sonner";
import freighterApi from "@stellar/freighter-api";

const BACKEND_URL = process.env["NEXT_PUBLIC_BACKEND_URL"] ?? "http://localhost:3001";

export interface AuthResponse {
  token: string;
  user: {
    publicKey: string;
  };
}

export interface AuthError {
  message: string;
  code?: string;
}

/**
 * Step 1: Fetch nonce challenge from backend
 */
export async function getNonce(): Promise<string> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/auth/nonce`);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || `Failed to fetch nonce: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.nonce;
  } catch (error) {
    console.error("Error fetching nonce:", error);
    throw error;
  }
}

/**
 * Step 2: Sign the nonce using Freighter wallet
 */
export async function signNonce(nonce: string): Promise<{ signature: string; publicKey: string }> {
  try {
    // Get user's public key from Freighter
    const publicKey = await freighterApi.getPublicKey();
    
    if (!publicKey) {
      throw new Error("No public key found. Please connect your Freighter wallet.");
    }
    
    // Sign the nonce message
    const freighter = (window as any).freighter;
    if (!freighter?.signMessage) {
      throw new Error("Message signing not supported by this wallet");
    }

    const signature = await freighter.signMessage(nonce);
    
    if (!signature) {
      throw new Error("Failed to sign message. Please try again.");
    }
    
    return { signature, publicKey };
  } catch (error) {
    console.error("Error signing nonce:", error);
    
    // Handle user rejection gracefully
    if (error instanceof Error) {
      if (error.message.includes("User rejected") || error.message.includes("rejected")) {
        toast.error("Signature cancelled. Please try again if you want to sign in.");
        throw new Error("USER_REJECTED");
      }
      
      if (error.message.includes("No public key found")) {
        toast.error("Please connect your Freighter wallet first.");
        throw new Error("WALLET_NOT_CONNECTED");
      }
    }
    
    toast.error("Failed to sign message. Please try again.");
    throw error;
  }
}

/**
 * Step 3: Verify signature with backend and get JWT token
 */
export async function verifySignature(
  signature: string,
  publicKey: string,
  nonce: string
): Promise<AuthResponse> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/auth/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        signature,
        publicKey,
        nonce,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ message: response.statusText }));
      throw new Error(errorData.message || `Authentication failed: ${response.statusText}`);
    }
    
    const result = await response.json();
    if (result.success) {
      return {
        token: `mock-jwt-token-for-${publicKey}`,
        user: {
          publicKey,
        },
      };
    }
    throw new Error(result.message || "Verification failed");
  } catch (error) {
    console.error("Error verifying signature:", error);
    throw error;
  }
}

/**
 * Complete SIWS authentication flow
 */
export async function signInWithStellar(): Promise<AuthResponse> {
  try {
    // Step 1: Get nonce
    toast.loading("Requesting authentication challenge...");
    const nonce = await getNonce();
    
    // Step 2: Sign nonce
    toast.loading("Please sign the message in your Freighter wallet...");
    const { signature, publicKey } = await signNonce(nonce);
    
    // Step 3: Verify signature
    toast.loading("Verifying signature...");
    const authResponse = await verifySignature(signature, publicKey, nonce);
    
    toast.success("Successfully authenticated!");
    return authResponse;
  } catch (error) {
    // Don't show toast for user rejection (already handled in signNonce)
    if (error instanceof Error && error.message !== "USER_REJECTED") {
      toast.error("Authentication failed. Please try again.");
    }
    throw error;
  }
}

/**
 * Store JWT token in localStorage
 */
export function storeAuthToken(token: string): void {
  if (typeof window !== "undefined") {
    localStorage.setItem("auth_token", token);
  }
}

/**
 * Get JWT token from localStorage
 */
export function getAuthToken(): string | null {
  if (typeof window !== "undefined") {
    return localStorage.getItem("auth_token");
  }
  return null;
}

/**
 * Remove JWT token from localStorage (logout)
 */
export function removeAuthToken(): void {
  if (typeof window !== "undefined") {
    localStorage.removeItem("auth_token");
  }
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(): boolean {
  return getAuthToken() !== null;
}

/**
 * Get Authorization header for API requests
 */
export function getAuthHeader(): { Authorization: string } | {} {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
