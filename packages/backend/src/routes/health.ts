import type { FastifyPluginAsync } from "fastify";

const API_VERSION = "0.1.0";

export interface HealthResponse {
  status: "ok";
  version: string;
  timestamp: string;
  uptime: number;
}

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
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
