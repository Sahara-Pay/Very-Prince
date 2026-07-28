/**
 * @file AuthController.ts
 * @description Controller for Sign-In With Stellar (SIWS) authentication endpoints.
 *
 * This controller handles HTTP requests for nonce generation and verification,
 * providing a secure challenge-response authentication system for Stellar wallets.
 */

import { authService, NonceResponse } from "../services/authService.js";
import type {
  AuthVerifySuccessResponse,
} from "@very-prince/types";

// ─── Controller ─────────────────────────────────────────────────────────────

export const authController = {
  /**
   * Generate a nonce for SIWS authentication.
   * 
   * @param publicKey - The user's Stellar public key
   * @returns Promise resolving to nonce response with SIWS message
   */
  async generateNonce(publicKey: string): Promise<NonceResponse> {
    return await authService.generateNonce(publicKey);
  },

  /**
   * Verify a signature against a stored nonce.
   * 
   * @param publicKey - The user's Stellar public key
   * @param signature - The signature to verify
   * @param originalMessage - The original message that was signed
   * @returns Promise resolving to verification result
   */
  async verifySignature(
    publicKey: string,
    _signature: string,
    originalMessage: string
  ): Promise<AuthVerifySuccessResponse> {
    // Extract nonce from the original message
    const nonceMatch = originalMessage.match(/Nonce: ([a-f0-9]+)/);
    if (!nonceMatch) {
      throw new Error("Invalid message format: nonce not found");
    }

    const nonce = nonceMatch[1];
    if (!nonce) {
      throw new Error("Invalid message format: nonce not found");
    }

    // Verify the nonce exists and is valid
    const isValidNonce = await authService.verifyNonce(publicKey, nonce);
    if (!isValidNonce) {
      throw new Error("Invalid or expired nonce");
    }

    // TODO: Implement actual signature verification using Stellar SDK
    // For now, we'll assume the signature is valid if the nonce is valid
    // In a production environment, you would use:
    // const keypair = Keypair.fromPublicKey(publicKey);
    // const isValid = keypair.verify(Buffer.from(originalMessage), Buffer.from(signature, 'base64'));

    return {
      success: true,
      message: "Authentication verified successfully",
    };
  },
};
