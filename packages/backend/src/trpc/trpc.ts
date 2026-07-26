/**
 * @file trpc.ts
 * @description Shared tRPC instance for router and middleware modules.
 */

import { initTRPC } from "@trpc/server";

export interface TRPCContext {
  stateHash?: string;
}

export const t = initTRPC.context<TRPCContext>().create();
