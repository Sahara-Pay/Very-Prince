/**
 * @file auth.ts
 * @description HTTP route definitions for Sign-In With Stellar (SIWS) authentication.
 *
 * This file provides endpoints for nonce generation and signature verification
 * to enable secure wallet-based authentication without passwords.
 *
 * Registered at: /api/v1/auth (see src/index.ts)
 *
 * ## Available Endpoints
 *
 * GET  /nonce?publicKey=...  — Generate SIWS nonce and formatted message
 * POST /verify               — Verify wallet signature for authentication
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { authController } from "../controllers/authController.js";

// ─── Validation Schemas ──────────────────────────────────────────────────────

/** Validation for the GET /nonce query parameter. */
const NonceQuery = z.object({
  publicKey: z.string().min(56).max(56).regex(/^G/, "Must be a valid Stellar public key starting with 'G'"),
});

/** Validation for the POST /verify request body. */
const VerifyAuthBody = z.object({
  publicKey: z.string().min(56).max(56).regex(/^G/, "Must be a valid Stellar public key starting with 'G'"),
  signature: z.string().min(1, "Signature is required"),
  originalMessage: z.string().min(1, "Original message is required"),
});

// ─── Route Plugin ────────────────────────────────────────────────────────────

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /nonce
   * Generate a cryptographic nonce for SIWS authentication.
   * 
   * This endpoint creates a secure random nonce, stores it in Redis with a 5-minute
   * expiration, and returns a formatted SIWS message for the user to sign.
   *
   * @example
   * GET /api/v1/auth/nonce?publicKey=GABC123...
   *
   * @response
   * {
   *   "success": true,
   *   "data": {
   *     "message": "tradeflow.app wants you to sign in with your Stellar account:\\n\\nGABC123...\\n\\nNonce: abc123def456...",
   *     "nonce": "abc123def456...",
   *     "expiresAt": 1640995200
   *   }
   * }
   */
  fastify.get<{
    Querystring: z.infer<typeof NonceQuery>;
  }>(
    "/nonce",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Generate SIWS nonce and formatted message for wallet authentication",
        tags: ["Authentication"],
        querystring: {
          type: "object",
          properties: {
            publicKey: {
              type: "string",
              description: "Stellar public key (G...)",
              minLength: 56,
              maxLength: 56,
              pattern: "^G",
            },
          },
          required: ["publicKey"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  message: { type: "string", description: "Formatted SIWS message to sign" },
                  nonce: { type: "string", description: "Generated nonce" },
                  expiresAt: { type: "integer", description: "Unix timestamp when nonce expires" },
                },
              },
            },
          },
          400: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Validate query parameters
        const parsed = NonceQuery.safeParse(request.query);
        if (!parsed.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid request parameters",
            message: "Public key must be a valid Stellar public key starting with 'G'",
          });
        }

        const { publicKey } = parsed.data;

        // Generate nonce and formatted message
        const nonceData = await authController.generateNonce(publicKey);

        return reply.send({
          success: true,
          data: nonceData,
        });
      } catch (error) {
        fastify.log.error(error as Error, "Failed to generate nonce:");
        
        return reply.status(500).send({
          success: false,
          error: "Failed to generate nonce",
          message: error instanceof Error ? error.message : "Internal server error",
        });
      }
    }
  );

  /**
   * POST /verify
   * Verify a wallet signature for SIWS authentication.
   * 
   * This endpoint verifies that the user's signature matches the expected message
   * and that the nonce is valid and not expired.
   *
   * @example
   * POST /api/v1/auth/verify
   * Body: {
   *   "publicKey": "GABC123...",
   *   "signature": "base64-encoded-signature",
   *   "originalMessage": "tradeflow.app wants you to sign in with your Stellar account..."
   * }
   */
  fastify.post<{
    Body: z.infer<typeof VerifyAuthBody>;
  }>(
    "/verify",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Verify wallet signature for SIWS authentication",
        tags: ["Authentication"],
        body: {
          type: "object",
          required: ["publicKey", "signature", "originalMessage"],
          properties: {
            publicKey: {
              type: "string",
              description: "Stellar public key (G...)",
              minLength: 56,
              maxLength: 56,
              pattern: "^G",
            },
            signature: {
              type: "string",
              description: "Base64-encoded signature",
            },
            originalMessage: {
              type: "string",
              description: "The original message that was signed",
            },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              message: { type: "string" },
            },
          },
          400: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: { type: "string" },
              message: { type: "string" },
            },
          },
          401: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Validate request body
        const parsed = VerifyAuthBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid request body",
            message: "Invalid public key, signature, or original message format",
          });
        }

        const { publicKey, signature, originalMessage } = parsed.data;

        // Verify signature and nonce
        const result = await authController.verifySignature(publicKey, signature, originalMessage);

        return reply.send(result);
      } catch (error) {
        fastify.log.error(error as Error, "Failed to verify signature:");
        
        if (error instanceof Error && error.message.includes("Invalid or expired nonce")) {
          return reply.status(401).send({
            success: false,
            error: "Authentication failed",
            message: "Invalid or expired nonce. Please request a new nonce.",
          });
        }

        return reply.status(401).send({
          success: false,
          error: "Authentication failed",
          message: error instanceof Error ? error.message : "Signature verification failed",
        });
      }
    }
  );
};
