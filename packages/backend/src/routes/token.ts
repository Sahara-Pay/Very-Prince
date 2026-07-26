import { FastifyInstance } from "fastify";
import { prisma } from "../services/db.js";
import type { VerifyTokenResponse } from "@very-prince/types";

export const tokenController = {
  /**
   * Check whether a token contract address is verified and return its risk level.
   *
   * @param address - Token contract address to look up.
   * @returns Verification status and risk level (`LOW` or `HIGH`).
   */
  async verifyToken(address: string): Promise<VerifyTokenResponse> {
    const verifiedContract = await prisma.verifiedContract.findUnique({
      where: { address },
    });

    if (verifiedContract) {
      return {
        isVerified: true,
        riskLevel: verifiedContract.riskLevel as "LOW" | "HIGH",
      };
    }

    return {
      isVerified: false,
      riskLevel: "HIGH",
    };
  },
};

export async function tokenRoutes(fastify: FastifyInstance) {
  /**
   * GET /verify/:address
   * Verifies whether a token contract address is trusted and returns its risk level.
   *
   * @param request - Fastify request containing `address` path parameter.
   * @param reply - Fastify reply.
   * @returns `{ isVerified, riskLevel }` for the given contract address.
   */
  fastify.get("/verify/:address", {
    config: {
      rateLimit: {
        max: 60,
        timeWindow: "1 minute",
      },
    },
    schema: {
      description: "Verify if a token contract address is verified and check its risk level",
      tags: ["Tokens"],
      params: {
        type: "object",
        properties: {
          address: { 
            type: "string", 
            description: "Token contract address to verify" 
          },
        },
        required: ["address"],
      },
      response: {
        200: {
          type: "object",
          properties: {
            isVerified: { 
              type: "boolean", 
              description: "Whether the token contract is verified" 
            },
            riskLevel: { 
              type: "string", 
              enum: ["LOW", "HIGH"],
              description: "Risk level assessment of the token" 
            },
          },
        },
        400: {
          type: "object",
          properties: {
            error: { type: "string" },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { address } = request.params as { address: string };
    
    if (!address) {
      return reply.status(400).send({ error: "Address is required" });
    }

    return await tokenController.verifyToken(address);
  });
}
