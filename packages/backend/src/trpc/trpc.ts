/**
 * @file trpc.ts
 * @description Shared tRPC instance with standard error formatting.
 */

import { initTRPC } from "@trpc/server";
import { ZodError } from "zod";
import type { FastifyReply } from "fastify";

export interface TRPCContext {
  stateHash?: string;
  reply?: FastifyReply;
}

export const t = initTRPC.context<TRPCContext>().create({
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Expose flattened Zod issues for BAD_REQUEST only; never stack in prod shape beyond defaults
        zodError:
          error.code === "BAD_REQUEST" && error.cause instanceof ZodError
            ? error.cause.flatten()
            : null,
      },
    };
  },
});
