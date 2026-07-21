/**
 * @file transactionSchemas.ts
 * @description Zod schemas validating transaction-payload inputs before a
 * client is allowed to build/sign the corresponding Soroban transaction.
 */

import { z } from "zod";

// Stellar/Soroban addresses are 56-char base32 strings starting with G or C.
const stellarAddress = z
  .string()
  .regex(/^[GC][A-Z2-7]{55}$/, "Invalid Stellar/Soroban address");

const orgId = z.string().min(1).max(32);

// Stroop amounts arrive as strings over the wire (bigint isn't JSON-safe);
// parse and bound-check them here.
const stroopAmount = z
  .string()
  .regex(/^\d+$/, "Amount must be a positive integer string")
  .refine((val) => BigInt(val) > BigInt(0), "Amount must be greater than zero")
  .refine((val) => BigInt(val) <= BigInt("922337203685477580"), "Amount exceeds maximum allowed");

export const fundOrgInputSchema = z.object({
  orgId,
  amount: stroopAmount,
  funderAddress: stellarAddress,
});

export const allocatePayoutInputSchema = z.object({
  orgId,
  maintainerAddress: stellarAddress,
  amount: stroopAmount,
});

export const claimPayoutInputSchema = z.object({
  maintainerAddress: stellarAddress,
});