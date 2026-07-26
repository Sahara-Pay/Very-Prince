import type { FastifyPluginAsync } from "fastify";
import type { HealthResponse } from "@very-prince/types";

const API_VERSION = "0.1.0";

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /
   * Health check endpoint — reports whether the API process is running.
   *
   * @param _request - Fastify request (unused).
   * @param reply - Fastify reply.
   * @returns `{ status, version, timestamp, uptime }` indicating service health.
   */
  fastify.get(
    "/",
    {
      config: {
        rateLimit: false,
      },
      schema: {
        tags: ["Health"],
        description: "Reports whether the API process is running.",
        response: {
          200: {
            type: "object",
            required: ["status", "version", "timestamp", "uptime"],
            properties: {
              status: { type: "string", enum: ["ok"] },
              version: { type: "string" },
              timestamp: { type: "string", format: "date-time" },
              uptime: { type: "number", minimum: 0 },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const response: HealthResponse = {
        status: "ok",
        version: API_VERSION,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };

      return reply.code(200).send(response);
    },
  );
};
