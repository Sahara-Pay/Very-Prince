import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { webhookService } from "../services/webhookService.js";
import { stellarService } from "../services/stellarService.js";

const WebhookConfigBody = z.object({
  url: z.string().url(),
});

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  // Simple auth middleware for these routes
  // In a real app, this would use fastify.jwt.verify()
  fastify.addHook("preHandler", async (request, reply) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized", message: "Missing or invalid token" });
    }
    
    // MOCK: Extracting public key from token (assuming token is just the public key for now)
    // TODO: Implement real JWT verification
    const token = authHeader.split(" ")[1];
    (request as any).user = { publicKey: token };
  });

  /**
   * GET /
   * Returns the webhook configuration for an organization, masking the secret.
   * Requires admin authentication.
   *
   * @param request - Fastify request containing `orgId` path parameter and Bearer token.
   * @param reply - Fastify reply.
   * @returns Webhook URL and a masked secret indicator.
   */
  fastify.get("/", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const user = (request as any).user;

    // Verify admin
    try {
      const org = await stellarService.readOrganization(orgId);
      // Multi-admin support check (from my previous edit in lib.rs)
      const admins = org.admins as any[];
      const isAdmin = admins.some(admin => String(admin) === user.publicKey);
      
      if (!isAdmin) {
        return reply.status(403).send({ error: "Forbidden", message: "Only organization admins can manage webhooks" });
      }

      const config = await webhookService.getConfig(orgId);
      if (!config) {
        return reply.send({ url: "", hasSecret: false });
      }

      return reply.send({
        url: config.url,
        hasSecret: true,
        // Mask the secret unless it's a reveal request (separate endpoint)
        secret: "********************************"
      });
    } catch (error) {
      return reply.status(500).send({ error: "Failed to fetch webhook config" });
    }
  });

  /**
   * POST /
   * Creates or updates the webhook URL for an organization.
   * Requires admin authentication.
   *
   * @param request - Fastify request with `orgId` path param, Bearer token, and `{ url }` body.
   * @param reply - Fastify reply.
   * @returns Updated webhook configuration.
   */
  fastify.post("/", {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const user = (request as any).user;
    const { url } = WebhookConfigBody.parse(request.body);

    try {
      const org = await stellarService.readOrganization(orgId);
      const admins = org.admins as any[];
      const isAdmin = admins.some(admin => String(admin) === user.publicKey);
      
      if (!isAdmin) {
        return reply.status(403).send({ error: "Forbidden", message: "Only organization admins can manage webhooks" });
      }

      const config = await webhookService.updateConfig(orgId, url);
      return reply.send(config);
    } catch (error) {
      return reply.status(500).send({ error: "Failed to update webhook config" });
    }
  });

  /**
   * GET /deliveries
   * Returns the delivery history for an organization's webhook.
   * Requires admin authentication.
   *
   * @param request - Fastify request containing `orgId` path parameter and Bearer token.
   * @param reply - Fastify reply.
   * @returns Array of past webhook delivery records.
   */
  fastify.get("/deliveries", {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const user = (request as any).user;

    try {
      const org = await stellarService.readOrganization(orgId);
      const admins = org.admins as any[];
      const isAdmin = admins.some(admin => String(admin) === user.publicKey);
      
      if (!isAdmin) {
        return reply.status(403).send({ error: "Forbidden", message: "Only organization admins can view deliveries" });
      }

      const config = await webhookService.getConfig(orgId);
      return reply.send(config?.deliveries || []);
    } catch (error) {
      return reply.status(500).send({ error: "Failed to fetch deliveries" });
    }
  });

  /**
   * POST /test
   * Sends a test event to the configured webhook URL for an organization.
   * Requires admin authentication.
   *
   * @param request - Fastify request containing `orgId` path parameter and Bearer token.
   * @param reply - Fastify reply.
   * @returns Result of the test delivery attempt.
   */
  fastify.post("/test", {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const user = (request as any).user;

    try {
      const org = await stellarService.readOrganization(orgId);
      const admins = org.admins as any[];
      const isAdmin = admins.some(admin => String(admin) === user.publicKey);
      
      if (!isAdmin) {
        return reply.status(403).send({ error: "Forbidden", message: "Only organization admins can test webhooks" });
      }

      const result = await webhookService.sendTestWebhook(orgId);
      return reply.send(result);
    } catch (error) {
      return reply.status(500).send({ error: "Test webhook failed", message: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  /**
   * GET /reveal
   * Reveals the plaintext webhook secret for an organization.
   * Requires admin authentication.
   *
   * @param request - Fastify request containing `orgId` path parameter and Bearer token.
   * @param reply - Fastify reply.
   * @returns The plaintext webhook signing secret.
   */
  fastify.get("/reveal", {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
      },
    },
  }, async (request, reply) => {
    const { orgId } = request.params as { orgId: string };
    const user = (request as any).user;

    try {
      const org = await stellarService.readOrganization(orgId);
      const admins = org.admins as any[];
      const isAdmin = admins.some(admin => String(admin) === user.publicKey);
      
      if (!isAdmin) {
        return reply.status(403).send({ error: "Forbidden", message: "Only organization admins can reveal secrets" });
      }

      const config = await webhookService.getConfig(orgId);
      return reply.send({ secret: config?.secret });
    } catch (error) {
      return reply.status(500).send({ error: "Failed to reveal secret" });
    }
  });
};
