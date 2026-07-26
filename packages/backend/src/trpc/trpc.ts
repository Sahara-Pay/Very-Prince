/**
 * @file trpc.ts
 * @description Shared tRPC instance for router and middleware modules.
 */

import { initTRPC } from "@trpc/server";

export const t = initTRPC.create();
