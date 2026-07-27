/**
 * @file organization.ts
 * @description HTTP route for fetching organization details directly from Soroban contract.
 *
 * This route provides a fast endpoint to fetch organization details by querying
 * the contract's DataKey::Org(id) and DataKey::OrgBudget(id) state directly,
 * bypassing the database for real-time data.
 *
 * Registered at: /api/org (see src/index.ts)
 *
 * ## Available Endpoints
 *
 * GET  /:id  — Get organization details with name, admin address, and budget
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { stellarService } from "../services/stellarService.js";
import { organizationService } from "../services/organizationService.js";
import { safeGet, safeSet } from "../services/cache.js";
import { validateApiKey } from "../plugins/apiKeyAuth.js";

// ─── Validation Schemas ──────────────────────────────────────────────────────

const UploadMetadataSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(2000),
  logoBase64: z.string().optional(),
});

/** Validation for the GET /:id route parameter. */
const OrgIdParam = z.object({
  id: z.string().min(1).max(32), // Support both symbol IDs and hash-based IDs
});

// ─── Route Plugin ────────────────────────────────────────────────────────────

export const organizationRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /:id
   * Returns the details of an organization by querying the contract directly.
   * This endpoint bypasses the database and fetches real-time data from the Soroban contract.
   *
   * The endpoint implements Redis caching for 5 seconds to prevent spamming the RPC
   * on high traffic while maintaining near real-time data freshness.
   *
   * @example
   * GET /api/org/stellar
   * GET /api/org/abc123def456... (32-byte hash)
   */
  fastify.get<{ Params: z.infer<typeof OrgIdParam> }>(
    "/:id",
    {
      preHandler: validateApiKey,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Get organization details directly from Soroban contract",
        tags: ["Organizations"],
        params: {
          type: "object",
          properties: {
            id: { 
              type: "string", 
              description: "Organization Symbol ID or 32-byte hash",
              minLength: 1,
              maxLength: 32
            },
          },
          required: ["id"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string", description: "Organization ID" },
              name: { type: "string", description: "Organization name" },
              admin: { type: "string", description: "Organization admin address" },
              budgetStroops: { type: "string", description: "Budget in stroops" },
              budgetXlm: { type: "string", description: "Budget in XLM" },
            },
          },
          404: {
            type: "object",
            properties: {
              error: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      
      // Validate the org ID parameter
      const parsed = OrgIdParam.safeParse({ id });
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid organization ID",
          message: "Organization ID must be a string between 1 and 32 characters",
        });
      }

      // Check cache first (5-second TTL)
      const cacheKey = `org_details:${id}`;
      const cachedResult = await safeGet(cacheKey);
      
      if (cachedResult) {
        try {
          const orgData = JSON.parse(cachedResult);
          return reply.send(orgData);
        } catch (error) {
          // Cache corrupted, continue to fetch from contract
          fastify.log.warn(error as Error, `Cache corruption for key ${cacheKey}`);
        }
      }

      try {
        // Fetch organization details directly from contract
        const orgDetails = await stellarService.readOrganizationDetails(id);
        
        // Cache the result for 5 seconds
        await safeSet(cacheKey, JSON.stringify(orgDetails), 5);
        
        return reply.send(orgDetails);
      } catch (error) {
        fastify.log.error(error as Error, `Failed to fetch organization details for ${id}`);
        
        // Check if it's a "not found" error from the contract
        if (error instanceof Error && error.message.includes("not found")) {
          return reply.status(404).send({
            error: "Organization not found",
            message: `Organization with ID '${id}' does not exist in the contract`,
          });
        }
        
        // Generic error response
        return reply.status(500).send({
          error: "Failed to fetch organization details",
          message: "Unable to query the Soroban contract. Please try again later.",
        });
      }
    }
  );

  /**
   * POST /upload-metadata
   * Uploads organization metadata to IPFS via Pinata.
   * Returns the CID to the frontend for Soroban transaction construction.
   */
  fastify.post<{ Body: z.infer<typeof UploadMetadataSchema> }>(
    "/upload-metadata",
    {
      preHandler: validateApiKey,
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Upload organization metadata to IPFS",
        tags: ["Organizations"],
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
            logoBase64: { type: "string" },
          },
          required: ["name", "description"],
        },
      },
    },
    async (request, reply) => {
      const { name, description, logoBase64 } = request.body;

      try {
        const cid = await organizationService.uploadMetadata(name, description, logoBase64);
        return reply.send({ cid });
      } catch (error) {
        fastify.log.error(error as Error, "IPFS upload failed");
        return reply.status(500).send({ error: "Failed to upload metadata to IPFS" });
      }
    }
  );
};
