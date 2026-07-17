/**
 * @file contract.ts
 * @description HTTP route definitions for the PayoutRegistry API.
 *
 * Routes are defined as a Fastify plugin so they can be registered with a
 * URL prefix. This file intentionally contains only routing concerns —
 * all business logic lives in `contractController.ts`.
 *
 * Registered at: /api/v1/contract (see src/index.ts)
 *
 * ## Available Endpoints
 *
 * GET  /orgs/:orgId                          — Get organization details
 * GET  /orgs/:orgId/maintainers              — List maintainers for an org
 * GET  /orgs/:orgId/budget                   — Get organization's available budget
 * POST /orgs/:orgId/fund                     — Fund an organization's budget
 * GET  /maintainers/:address/balance         — Get claimable balance
 * POST /payouts                              — Allocate a payout
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { contractController } from "../controllers/contractController.js";
import { stellarService } from "../services/stellarService.js";
import { Keypair } from "@stellar/stellar-sdk";

const OrganizationListQuery = z.object({
  page: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return 1;
    return Number(String(value));
  }, z.number().int().min(1).max(100)),
  limit: z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return 10;
    return Number(String(value));
  }, z.number().int().min(1).max(100)),
  search: z.preprocess((value) => {
    if (typeof value !== "string") {
      return undefined;
    }

    const sanitized = value.trim().replace(/[\u0000-\u001F\u007F]/g, "");
    return sanitized.length === 0 ? undefined : sanitized;
  }, z.string().min(1).max(100).optional()),
});

// ─── Validation Schemas ──────────────────────────────────────────────────────

/** Validation for the POST /orgs registration request body. */
const RegisterOrgBody = z.object({
  id: z.string().min(1).max(9),
  name: z.string().min(1).max(64),
  admin: z.string().startsWith("G").length(56),
  signerSecret: z.string().startsWith("S").length(56),
});

/** Validation for the POST /orgs/:orgId/fund request body. */
const FundOrgBody = z.object({
  fromAddress: z.string().startsWith("G").length(56),
  amountStroops: z.string().regex(/^\d+$/, "Must be a positive integer string"),
  signerSecret: z.string().startsWith("S").length(56),
});

/** Validation for the POST /payouts request body. */
const AllocatePayoutBody = z.object({
  /** Organization Symbol ID (max 9 characters). */
  orgId: z.string().min(1).max(9),
  /** Recipient maintainer's Stellar address (G...). */
  maintainerAddress: z.string().startsWith("G").length(56),
  /**
   * Amount in stroops, supplied as a string to avoid JS number precision loss.
   * 1 XLM = 10,000,000 stroops.
   */
  amountStroops: z.string().regex(/^\d+$/, "Must be a positive integer string"),
  /**
   * Admin's Stellar secret key. See controller note — this is a scaffold
   * convenience and should be replaced with client-signed XDR in production.
   */
  signerSecret: z.string().startsWith("S").length(56),
});

/** Validation for the POST /auth/verify request body. */
const VerifyAuthBody = z.object({
  publicKey: z.string().startsWith("G").length(56),
  signature: z.string(),
  originalMessage: z.string(),
});

// ─── Route Plugin ────────────────────────────────────────────────────────────

// Export mock cache for nonce verification
export const nonceCache = new Map<
  string,
  { nonce: string; expiresAt: number }
>();

export const contractRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /orgs
   * Returns a paginated list of registered organizations.
   *
   * @example
   * GET /api/v1/contract/orgs?page=1&limit=10
   */
  fastify.get<{
    Querystring: { page?: string; limit?: string; search?: string };
  }>(
    "/orgs",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
            search: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const parsedQuery = OrganizationListQuery.safeParse(request.query);
      if (!parsedQuery.success) {
        return reply.status(400).send({
          error: "Invalid query parameters",
          details: parsedQuery.error.flatten().fieldErrors,
        });
      }

      const { page, limit, search } = parsedQuery.data;
      const result = await contractController.getOrganizations(
        page,
        limit,
        search,
      );
      return reply.send(result);
    },
  );

  /**
   * POST /orgs
   * Registers a new organization on-chain and indexes it in the local database.
   */
  fastify.post<{ Body: z.infer<typeof RegisterOrgBody> }>(
    "/orgs",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["id", "name", "admin", "signerSecret"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 9 },
            name: { type: "string", minLength: 1, maxLength: 64 },
            admin: { type: "string" },
            signerSecret: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = RegisterOrgBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { id, name, admin, signerSecret } = parsed.data;
      const result = await contractController.registerOrganization(
        id,
        name,
        admin,
        signerSecret,
      );
      return reply.status(201).send(result);
    },
  );

  /**
   * GET /orgs/:orgId
   * Returns the details of a registered organization.
   *
   * @example
   * GET /api/v1/contract/orgs/stellar
   */
  fastify.get<{ Params: { orgId: string } }>(
    "/orgs/:orgId",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        // description: "Get a registered organization by its Symbol ID.",
        // tags: ["Organizations"],
        params: {
          type: "object",
          properties: {
            orgId: { type: "string", description: "Organization Symbol ID" },
          },
          required: ["orgId"],
        },
        response: {
          200: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              admin: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const org = await contractController.getOrganization(orgId);
      return reply.send(org);
    },
  );

  /**
   * GET /orgs/:orgId/maintainers
   * Returns the paginated list of maintainer addresses registered under an organization.
   *
   * Query params
   * - page (default 1)
   * - limit (default 20)
   * @example
   * GET /api/v1/contract/orgs/stellar/maintainers?page=2&limit=10
   */
  fastify.get<{
    Params: { orgId: string };
    Querystring: { page?: number; limit?: number };
  }>(
    "/orgs/:orgId/maintainers",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        // description: "List all maintainers for a given organization.",
        // tags: ["Maintainers"],
        params: {
          type: "object",
          properties: {
            orgId: { type: "string" },
          },
          required: ["orgId"],
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            limit: { type: "integer", minimum: 1, default: 20 },
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const { page = 1, limit = 20 } = request.query;
      const result = await contractController.getMaintainers(
        orgId,
        page,
        limit,
      );
      return reply.send(result);
    },
  );

  /**
   * GET /orgs/:orgId/budget
   * Returns the available budget for an organization.
   *
   * @example
   * GET /api/v1/contract/orgs/stellar/budget
   */
  fastify.get<{ Params: { orgId: string } }>(
    "/orgs/:orgId/budget",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        // description: "Get the secure available budget for an organization.",
        // tags: ["Organizations"],
        params: {
          type: "object",
          properties: {
            orgId: { type: "string" },
          },
          required: ["orgId"],
        },
      },
    },
    async (request, reply) => {
      const { orgId } = request.params;
      const result = await contractController.getOrgBudget(orgId);
      return reply.send(result);
    },
  );

  /**
   * POST /orgs/:orgId/fund
   * Fund an organization's budget via SAC token transfer.
   */
  fastify.post<{ Params: { orgId: string } }>(
    "/orgs/:orgId/fund",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        // description: "Fund an organization's budget using public Stellar Asset transfers.",
        // tags: ["Organizations", "Funding"],
        params: {
          type: "object",
          properties: { orgId: { type: "string" } },
          required: ["orgId"],
        },
        body: {
          type: "object",
          required: ["fromAddress", "amountStroops", "signerSecret"],
          properties: {
            fromAddress: { type: "string" },
            amountStroops: { type: "string" },
            signerSecret: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = FundOrgBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { orgId } = request.params;
      const { fromAddress, amountStroops, signerSecret } = parsed.data;

      const result = await contractController.fundOrg(
        orgId,
        fromAddress,
        amountStroops,
        signerSecret,
      );
      return reply.status(201).send(result);
    },
  );

  /**
   * GET /maintainers/:address/balance
   * Returns the claimable balance (in stroops and XLM) for a maintainer.
   *
   * @example
   * GET /api/v1/contract/maintainers/GABC.../balance
   */
  fastify.get<{ Params: { address: string } }>(
    "/maintainers/:address/balance",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        // description: "Get the claimable payout balance for a maintainer.",
        // tags: ["Maintainers"],
        params: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "Stellar public key (G...)",
            },
          },
          required: ["address"],
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params;
      const result = await contractController.getClaimableBalance(address);
      return reply.send(result);
    },
  );

  /**
   * POST /payouts
   * Allocate a payout from an organization to a specific maintainer.
   *
   * @example
   * POST /api/v1/contract/payouts
   * Body: { orgId, maintainerAddress, amountStroops, signerSecret }
   */
  fastify.post(
    "/payouts",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
        },
      },
      schema: {
        // description: "Allocate a payout to a maintainer (org admin only).",
        // tags: ["Payouts"],
        body: {
          type: "object",
          required: [
            "orgId",
            "maintainerAddress",
            "amountStroops",
            "signerSecret",
          ],
          properties: {
            orgId: { type: "string" },
            maintainerAddress: { type: "string" },
            amountStroops: { type: "string" },
            signerSecret: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      // Parse and validate the request body with Zod.
      const parsed = AllocatePayoutBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { orgId, maintainerAddress, amountStroops, signerSecret } =
        parsed.data;
      const result = await contractController.allocatePayout(
        orgId,
        maintainerAddress,
        amountStroops,
        signerSecret,
      );
      return reply.status(201).send(result);
    },
  );

  /**
   * GET /maintainer/:address
   * Return an array of pending payouts: [{ orgId: "...", amount: 500 }]
   */
  fastify.get<{ Params: { address: string } }>(
    "/maintainer/:address",
    {
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
        },
      },
      schema: {
        params: {
          type: "object",
          properties: {
            address: {
              type: "string",
              description: "Stellar public key (G...)",
            },
          },
          required: ["address"],
        },
      },
    },
    async (request, reply) => {
      const { address } = request.params;
      const payouts = await stellarService.getMaintainerPayouts(address);
      return reply.send(payouts);
    },
  );

  /**
   * POST /auth/nonce
   * Generate an authentication nonce.
   */
  fastify.post(
    "/auth/nonce",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["publicKey"],
          properties: { publicKey: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const { publicKey } = request.body as { publicKey: string };
      const nonce = Math.random().toString(36).substring(2);
      nonceCache.set(publicKey, {
        nonce,
        expiresAt: Date.now() + 1000 * 60 * 5,
      });
      return reply.send({ nonce });
    },
  );

  /**
   * POST /claim
   * Create a claim payout transaction for a maintainer.
   */
  fastify.post(
    "/claim",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["orgId", "maintainerAddress"],
          properties: {
            orgId: { type: "string" },
            maintainerAddress: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { orgId, maintainerAddress } = request.body as {
        orgId: string;
        maintainerAddress: string;
      };

      try {
        const transactionXdr = await contractController.createClaimTransaction(
          orgId,
          maintainerAddress,
        );
        return reply.send({ transactionXdr });
      } catch (error) {
        return reply.status(400).send({
          error: "Failed to create claim transaction",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /submit
   * Submit a signed transaction to the Stellar network.
   */
  fastify.post(
    "/submit",
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["signedTransaction"],
          properties: {
            signedTransaction: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { signedTransaction } = request.body as {
        signedTransaction: string;
      };

      try {
        const result =
          await contractController.submitTransaction(signedTransaction);
        return reply.send(result);
      } catch (error) {
        return reply.status(400).send({
          error: "Failed to submit transaction",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    },
  );

  /**
   * POST /auth/verify
   * Verify wallet signature for authentication.
   */
  fastify.post(
    "/auth/verify",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute",
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["publicKey", "signature", "originalMessage"],
          properties: {
            publicKey: { type: "string" },
            signature: { type: "string" },
            originalMessage: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = VerifyAuthBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          details: parsed.error.flatten().fieldErrors,
        });
      }

      const { publicKey, signature, originalMessage } = parsed.data;

      const cached = nonceCache.get(publicKey);
      if (!cached) {
        return reply
          .status(401)
          .send({ error: "No pending authentication request found." });
      }

      if (Date.now() > cached.expiresAt) {
        nonceCache.delete(publicKey);
        return reply
          .status(401)
          .send({ error: "Authentication request expired." });
      }

      try {
        const keypair = Keypair.fromPublicKey(publicKey);
        const isValid = keypair.verify(
          Buffer.from(originalMessage),
          Buffer.from(signature, "base64"),
        );

        if (!isValid) {
          return reply.status(401).send({ error: "Invalid signature." });
        }

        nonceCache.delete(publicKey);

        return reply.send({
          success: true,
          message: "Authentication verified.",
        });
      } catch (err) {
        return reply
          .status(401)
          .send({ error: "Signature verification failed." });
      }
    },
  );
};
