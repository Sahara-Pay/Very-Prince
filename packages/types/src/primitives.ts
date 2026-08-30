/**
 * @file primitives.ts
 * @description Leaf type aliases that form the shared base of every other
 * module in @very-prince/types. Kept intentionally tiny so that
 * `api-responses.ts` can safely import from here without introducing
 * circular imports with the barrel `index.ts` re-export.
 */

/** A Stellar public key (G…). */
export type StellarAddress = string;

/** A Soroban Symbol used as an organisation identifier. */
export type OrgId = string;
