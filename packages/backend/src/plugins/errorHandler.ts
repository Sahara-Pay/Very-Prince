import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from "fastify";
import * as Sentry from "@sentry/node";

export async function errorHandler(server: FastifyInstance) {
  server.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error({ err: error, reqId: request.id }, error.message);

    if (process.env.NODE_ENV === "production" && process.env.SENTRY_DSN) {
      Sentry.captureException(error);
    }

    // Determine status code
    const statusCode = error.statusCode || 500;
    let message = error.message || "An unexpected error occurred.";
    let errorType = "Internal Server Error";
    let details = (error as any).validation || undefined;

    // Custom logic
    if (error.message?.includes("timeout") || (error as any).code === "ETIMEDOUT") {
      message = "Blockchain service timed out.";
      errorType = "Gateway Timeout";
    } else if (error.validation) {
      errorType = "Bad Request";
    }

    // FINAL STANDARDIZED RESPONSE
    return reply.status(statusCode).send({
      success: false,
      statusCode: statusCode,
      error: errorType,
      message: message,
      details: details // Ykoun undefined ila ma kanch
    });
  });

  // ... (Keep your unhandledRejection and uncaughtException logic here)
}
