/**
 * @file apiKeys.ts
 * @description HTTP route definitions for API key management.
 *
 * This file provides endpoints for organizations to manage their API keys
 * for third-party integrations. API keys allow read-only access to organization
 * data via Bearer token authentication.
 *
 * Registered at: /api/org/:orgId/api-keys (see src/index.ts)
 *
 * ## Available Endpoints
 *
 * GET  /:orgId/api-keys      — List all API keys for an organization
 * POST /:orgId/api-keys      — Generate a new API key
 * DELETE /:orgId/api-keys/:id — Revoke an API key
 * PUT  /:orgId/api-keys/:id — Update API key name
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiKeyService } from "../services/apiKeyService.js";

// ─── Validation Schemas ──────────────────────────────────────────────────────

/** Validation for the organization ID parameter. */
const OrgIdParam = z.object({
  orgId: z.string().min(1).max(32),
});

/** Validation for the API key ID parameter. */
const ApiKeyIdParam = z.object({
  id: z.string().cuid(),
});

/** Validation for generating a new API key request body. */
const CreateApiKeyBody = z.object({
  name: z.string().optional(),
});

/** Validation for updating an API key request body. */
const UpdateApiKeyBody = z.object({
  name: z.string().min(1).max(100),
});

// ─── Route Plugin ────────────────────────────────────────────────────────────

export const apiKeyRoutes: FastifyPluginAsync = async (fastify) => {
  const apiKeyService = new ApiKeyService();

  /**
   * GET /:orgId/api-keys
   * List all API keys for an organization.
   * 
   * This endpoint requires wallet authentication (public key) and returns
   * all API keys associated with the organization, excluding the actual
   * key values for security.
   *
   * @example
   * GET /api/org/stellar/api-keys
   * Authorization: Bearer <public-key>
   *
   * @response
   * {
   *   "success": true,
   *   "data": [
   *     {
   *       "id": "cuid...",
   *       "organizationId": "stellar",
   *       "name": "Production Key",
   *       "isActive": true,
   *       "lastUsedAt": "2024-01-15T10:30:00Z",
   *       "createdAt": "2024-01-01T00:00:00Z",
   *       "updatedAt": "2024-01-15T10:30:00Z"
   *     }
   *   ]
   * }
   */
  fastify.get<{
    Params: z.infer<typeof OrgIdParam>;
  }>(
    "/:orgId/api-keys",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "List all API keys for an organization",
        tags: ["API Keys"],
        params: {
          type: "object",
          properties: {
            orgId: { 
              type: "string", 
              description: "Organization ID",
              minLength: 1,
              maxLength: 32
            },
          },
          required: ["orgId"],
        },
        headers: {
          type: "object",
          properties: {
            authorization: {
              type: "string",
              description: "Bearer token with public key for authentication",
            },
          },
          required: ["authorization"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", description: "API key ID" },
                    organizationId: { type: "string", description: "Organization ID" },
                    name: { type: "string", description: "API key display name" },
                    isActive: { type: "boolean", description: "Whether the key is active" },
                    lastUsedAt: { type: "string", description: "Last usage timestamp" },
                    createdAt: { type: "string", description: "Creation timestamp" },
                    updatedAt: { type: "string", description: "Last update timestamp" },
                  },
                },
              },
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
          403: {
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
        // Validate organization ID parameter
        const parsed = OrgIdParam.safeParse(request.params);
        if (!parsed.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid organization ID",
            message: "Organization ID must be a string between 1 and 32 characters",
          });
        }

        const { orgId } = parsed.data;

        // Verify wallet authentication
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.status(401).send({
            success: false,
            error: "Unauthorized",
            message: "Wallet authentication required",
          });
        }

        // const publicKey = authHeader.replace('Bearer ', '').trim();
        
        // TODO: Verify the public key belongs to an admin of the organization
        // This would require checking against the contract or database
        // For now, we'll assume the authentication is handled by middleware

        // List API keys for the organization
        const apiKeys = await apiKeyService.listApiKeys(orgId);

        return reply.send({
          success: true,
          data: apiKeys,
        });
      } catch (error) {
        fastify.log.error(error as Error, "Failed to list API keys:");
        
        return reply.status(500).send({
          success: false,
          error: "Failed to list API keys",
          message: error instanceof Error ? error.message : "Internal server error",
        });
      }
    }
  );

  /**
   * POST /:orgId/api-keys
   * Generate a new API key for an organization.
   * 
   * This endpoint requires wallet authentication and generates a new
   * secure API key. The plain text key is only shown once in the response.
   *
   * @example
   * POST /api/org/stellar/api-keys
   * Authorization: Bearer <public-key>
   * Body: { "name": "Production Key" }
   *
   * @response
   * {
   *   "success": true,
   *   "data": {
   *     "plainTextKey": "abc123def456...",
   *     "apiKey": {
   *       "id": "cuid...",
   *       "organizationId": "stellar",
   *       "name": "Production Key",
   *       "isActive": true,
   *       "createdAt": "2024-01-01T00:00:00Z",
   *       "updatedAt": "2024-01-01T00:00:00Z"
   *     }
   *   }
   * }
   */
  fastify.post<{
    Params: z.infer<typeof OrgIdParam>;
    Body: z.infer<typeof CreateApiKeyBody>;
  }>(
    "/:orgId/api-keys",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Generate a new API key for an organization",
        tags: ["API Keys"],
        params: {
          type: "object",
          properties: {
            orgId: { 
              type: "string", 
              description: "Organization ID",
              minLength: 1,
              maxLength: 32
            },
          },
          required: ["orgId"],
        },
        body: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Optional display name for the API key",
              maxLength: 100,
            },
          },
        },
        headers: {
          type: "object",
          properties: {
            authorization: {
              type: "string",
              description: "Bearer token with public key for authentication",
            },
          },
          required: ["authorization"],
        },
        response: {
          201: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  plainTextKey: { type: "string", description: "The generated API key (shown only once)" },
                  apiKey: {
                    type: "object",
                    properties: {
                      id: { type: "string", description: "API key ID" },
                      organizationId: { type: "string", description: "Organization ID" },
                      name: { type: "string", description: "API key display name" },
                      isActive: { type: "boolean", description: "Whether the key is active" },
                      createdAt: { type: "string", description: "Creation timestamp" },
                      updatedAt: { type: "string", description: "Last update timestamp" },
                    },
                  },
                },
              },
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
          403: {
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
        // Validate organization ID parameter
        const parsedOrg = OrgIdParam.safeParse(request.params);
        if (!parsedOrg.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid organization ID",
            message: "Organization ID must be a string between 1 and 32 characters",
          });
        }

        // Validate request body
        const parsedBody = CreateApiKeyBody.safeParse(request.body);
        if (!parsedBody.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid request body",
            message: "Name must be a string with maximum 100 characters",
          });
        }

        const { orgId } = parsedOrg.data;
        const { name } = parsedBody.data;

        // Verify wallet authentication
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.status(401).send({
            success: false,
            error: "Unauthorized",
            message: "Wallet authentication required",
          });
        }

        // const publicKey = authHeader.replace('Bearer ', '').trim();
        
        // TODO: Verify the public key belongs to an admin of the organization
        // For now, we'll assume the authentication is handled by middleware

        // Generate new API key
        const result = await apiKeyService.generateApiKey(orgId, name);

        return reply.status(201).send({
          success: true,
          data: result,
        });
      } catch (error) {
        fastify.log.error(error as Error, "Failed to generate API key:");
        
        return reply.status(500).send({
          success: false,
          error: "Failed to generate API key",
          message: error instanceof Error ? error.message : "Internal server error",
        });
      }
    }
  );

  /**
   * DELETE /:orgId/api-keys/:id
   * Revoke an API key for an organization.
   * 
   * This endpoint requires wallet authentication and revokes the specified
   * API key by setting it to inactive.
   *
   * @example
   * DELETE /api/org/stellar/api-keys/cuid...
   * Authorization: Bearer <public-key>
   *
   * @response
   * {
   *   "success": true,
   *   "message": "API key revoked successfully"
   * }
   */
  fastify.delete<{
    Params: z.infer<typeof OrgIdParam> & z.infer<typeof ApiKeyIdParam>;
  }>(
    "/:orgId/api-keys/:id",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Revoke an API key for an organization",
        tags: ["API Keys"],
        params: {
          type: "object",
          properties: {
            orgId: { 
              type: "string", 
              description: "Organization ID",
              minLength: 1,
              maxLength: 32
            },
            id: {
              type: "string",
              description: "API key ID to revoke",
            },
          },
          required: ["orgId", "id"],
        },
        headers: {
          type: "object",
          properties: {
            authorization: {
              type: "string",
              description: "Bearer token with public key for authentication",
            },
          },
          required: ["authorization"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
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
          403: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: { type: "string" },
              message: { type: "string" },
            },
          },
          404: {
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
        // Validate parameters
        const parsedOrg = OrgIdParam.safeParse({ orgId: request.params.orgId });
        const parsedKey = ApiKeyIdParam.safeParse({ id: request.params.id });
        
        if (!parsedOrg.success || !parsedKey.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid parameters",
            message: "Invalid organization ID or API key ID",
          });
        }

        const { orgId } = parsedOrg.data;
        const { id } = parsedKey.data;

        // Verify wallet authentication
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.status(401).send({
            success: false,
            error: "Unauthorized",
            message: "Wallet authentication required",
          });
        }

        // const publicKey = authHeader.replace('Bearer ', '').trim();
        
        // TODO: Verify the public key belongs to an admin of the organization
        // For now, we'll assume the authentication is handled by middleware

        // Revoke the API key
        const success = await apiKeyService.revokeApiKey(orgId, id);
        
        if (!success) {
          return reply.status(404).send({
            success: false,
            error: "Not found",
            message: "API key not found or does not belong to this organization",
          });
        }

        return reply.send({
          success: true,
          message: "API key revoked successfully",
        });
      } catch (error) {
        fastify.log.error(error as Error, "Failed to revoke API key:");
        
        return reply.status(500).send({
          success: false,
          error: "Failed to revoke API key",
          message: error instanceof Error ? error.message : "Internal server error",
        });
      }
    }
  );

  /**
   * PUT /:orgId/api-keys/:id
   * Update the name of an API key for an organization.
   * 
   * This endpoint requires wallet authentication and updates the display
   * name of the specified API key.
   *
   * @example
   * PUT /api/org/stellar/api-keys/cuid...
   * Authorization: Bearer <public-key>
   * Body: { "name": "Updated Key Name" }
   *
   * @response
   * {
   *   "success": true,
   *   "message": "API key updated successfully"
   * }
   */
  fastify.put<{
    Params: z.infer<typeof OrgIdParam> & z.infer<typeof ApiKeyIdParam>;
    Body: z.infer<typeof UpdateApiKeyBody>;
  }>(
    "/:orgId/api-keys/:id",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        description: "Update the name of an API key for an organization",
        tags: ["API Keys"],
        params: {
          type: "object",
          properties: {
            orgId: { 
              type: "string", 
              description: "Organization ID",
              minLength: 1,
              maxLength: 32
            },
            id: {
              type: "string",
              description: "API key ID to update",
            },
          },
          required: ["orgId", "id"],
        },
        body: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "New display name for the API key",
              minLength: 1,
              maxLength: 100,
            },
          },
        },
        headers: {
          type: "object",
          properties: {
            authorization: {
              type: "string",
              description: "Bearer token with public key for authentication",
            },
          },
          required: ["authorization"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
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
          403: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: { type: "string" },
              message: { type: "string" },
            },
          },
          404: {
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
        // Validate parameters
        const parsedOrg = OrgIdParam.safeParse({ orgId: request.params.orgId });
        const parsedKey = ApiKeyIdParam.safeParse({ id: request.params.id });
        const parsedBody = UpdateApiKeyBody.safeParse(request.body);
        
        if (!parsedOrg.success || !parsedKey.success || !parsedBody.success) {
          return reply.status(400).send({
            success: false,
            error: "Invalid parameters",
            message: "Invalid organization ID, API key ID, or request body",
          });
        }

        const { orgId } = parsedOrg.data;
        const { id } = parsedKey.data;
        const { name } = parsedBody.data;

        // Verify wallet authentication
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.status(401).send({
            success: false,
            error: "Unauthorized",
            message: "Wallet authentication required",
          });
        }

        // const publicKey = authHeader.replace('Bearer ', '').trim();
        
        // TODO: Verify the public key belongs to an admin of the organization
        // For now, we'll assume the authentication is handled by middleware

        // Update the API key name
        const success = await apiKeyService.updateApiKeyName(orgId, id, name);
        
        if (!success) {
          return reply.status(404).send({
            success: false,
            error: "Not found",
            message: "API key not found or does not belong to this organization",
          });
        }

        return reply.send({
          success: true,
          message: "API key updated successfully",
        });
      } catch (error) {
        fastify.log.error(error as Error, "Failed to update API key:");
        
        return reply.status(500).send({
          success: false,
          error: "Failed to update API key",
          message: error instanceof Error ? error.message : "Internal server error",
        });
      }
    }
  );
};
