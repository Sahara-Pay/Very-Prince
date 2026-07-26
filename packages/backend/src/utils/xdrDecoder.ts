/**
 * @file xdrDecoder.ts
 * @description XDR decoding utilities for Soroban events.
 *
 * Handles decoding of Base64-encoded XDR data returned by Soroban RPC getEvents.
 * Special attention is given to i128 types to prevent JavaScript number precision loss.
 * 
 * ## XDR in Soroban
 * External Data Representation (XDR) is the standard format used by Stellar for 
 * serializing data. In Soroban, contract return values, storage keys, and event 
 * data are all XDR-encoded `ScVal` objects.
 * 
 * ## Precision Management
 * JavaScript's `Number` type is an IEEE 754 double-precision 64-bit float, 
 * which cannot safely represent integers larger than 2^53 - 1. Since Soroban 
 * natively supports 128-bit integers (`i128`, `u128`), we must use `BigInt` 
 * or `string` representations when handling these values in Node.js.
 */

import { xdr, scValToNative } from "@stellar/stellar-sdk";
import { logger } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Raw event from Soroban RPC getEvents.
 * 
 * The Soroban RPC `getEvents` method returns a JSON structure where cryptographic 
 * data (topics, values) is Base64-encoded XDR.
 */
export interface RawSorobanEvent {
  /** The sequence number of the ledger containing the event. */
  ledger: number;
  /** ISO 8601 timestamp of when the ledger was closed. */
  ledgerClosedAt: string;
  /** The hex-encoded hash of the transaction that emitted the event. */
  txHash: string;
  /** Unique identifier for the event within the ledger. */
  id: string;
  /** Token used for pagination in subsequent RPC calls. */
  pagingToken: string;
  /** Array of Base64-encoded XDR topics (max 4 topics per event). */
  topic: string[];
  /** Base64-encoded XDR data payload of the event. */
  value: string;
}

/**
 * Decoded topic value - can be various ScVal types.
 */
export type DecodedTopic = string | bigint | number | boolean;

/**
 * Decoded event with all values converted to native TypeScript types.
 * 
 * This interface represents the "human-readable" version of a Soroban event, 
 * ready for consumption by frontend or database storage.
 */
export interface DecodedEvent {
  /** The sequence number of the ledger containing the event. */
  ledger: number;
  /** ISO 8601 timestamp of when the ledger was closed. */
  ledgerClosedAt: string;
  /** The hex-encoded hash of the transaction that emitted the event. */
  txHash: string;
  /** The name of the event (typically the first topic as a Symbol). */
  eventName: string;
  /** Array of decoded topics (Strings, Numbers, BigInts, etc.). */
  topics: DecodedTopic[];
  /** The decoded data payload of the event. */
  data: unknown;
}

// ─── i128 Decoding ───────────────────────────────────────────────────────────

/**
 * Decode an i128 ScVal to a string representation.
 *
 * Soroban's i128 is a 128-bit signed integer. JavaScript's Number type can only
 * safely represent integers up to 2^53 - 1 (Number.MAX_SAFE_INTEGER).
 *
 * Implementation Note:
 * The `stellar-sdk` `scValToNative` method returns an object with `hi` (high 64 bits) 
 * and `lo` (low 64 bits) BigInts for i128/u128 values. We bit-shift `hi` by 64 bits 
 * and add `lo` to reconstruct the original 128-bit integer without any loss 
 * of precision.
 *
 * @param scVal - The ScVal to decode (expected to be i128)
 * @returns String representation of the i128 value
 */
export function decodeI128ToString(scVal: xdr.ScVal): string {
  const native = scValToNative(scVal);

  // scValToNative returns an object with hi and lo parts for i128
  if (typeof native === "object" && native !== null) {
    const parts = native as { hi?: bigint | number; lo?: bigint | number };
    if ("hi" in parts && "lo" in parts) {
      // Reconstruct the full 128-bit value
      const hi = BigInt(parts.hi ?? 0);
      const lo = BigInt(parts.lo ?? 0);
      // Combine hi (high 64 bits) and lo (low 64 bits)
      const value = (hi << BigInt(64)) + lo;
      return value.toString();
    }
  }

  // Fallback: if it's already a number or bigint, convert to string
  if (typeof native === "bigint") {
    return native.toString();
  }

  if (typeof native === "number") {
    return native.toString();
  }

  throw new Error(`Cannot decode i128: unexpected type ${typeof native}`);
}

/**
 * Decode an i128 ScVal to a BigInt.
 *
 * @param scVal - The ScVal to decode (expected to be i128)
 * @returns BigInt representation of the i128 value
 */
export function decodeI128ToBigInt(scVal: xdr.ScVal): bigint {
  const str = decodeI128ToString(scVal);
  return BigInt(str);
}

// ─── General XDR Decoding ───────────────────────────────────────────────────

/**
 * Decode a Base64-encoded XDR string to an ScVal.
 *
 * @param base64Xdr - Base64-encoded XDR string
 * @returns Decoded ScVal object
 */
export function decodeBase64Xdr(base64Xdr: string): xdr.ScVal {
  return xdr.ScVal.fromXDR(base64Xdr, "base64");
}

/**
 * Decode a topic value (from the topic array in events).
 *
 * Topics can be Symbols, Addresses, or other ScVal types.
 *
 * @param topicVal - Base64-encoded XDR string or raw ScVal object
 * @returns Decoded topic value
 */
export function decodeTopic(topicVal: string | xdr.ScVal): DecodedTopic {
  if (typeof topicVal === "string") {
    const scVal = decodeBase64Xdr(topicVal);
    return scValToNative(scVal) as DecodedTopic;
  }
  return scValToNative(topicVal) as DecodedTopic;
}

/**
 * Decode the event value (data payload).
 *
 * The value can be a single value or a tuple/struct containing multiple values.
 *
 * @param valueVal - Base64-encoded XDR string or raw ScVal object
 * @returns Decoded value (could be primitive, array, or object)
 */
export function decodeEventValue(valueVal: string | xdr.ScVal): unknown {
  if (typeof valueVal === "string") {
    const scVal = decodeBase64Xdr(valueVal);
    return scValToNative(scVal);
  }
  return scValToNative(valueVal);
}

/**
 * Fully decode a raw Soroban event.
 *
 * @param rawEvent - Raw event from getEvents or JSON RPC
 * @returns Decoded event with native TypeScript types
 */
export function decodeSorobanEvent(rawEvent: {
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: Array<string | xdr.ScVal>;
  value: string | xdr.ScVal;
}): DecodedEvent {
  // Decode all topics
  const decodedTopics = rawEvent.topic.map(decodeTopic);

  // Extract event name from topic[1] (topic[0] is the contract name "VeryPrince")
  const eventName = decodedTopics[1]?.toString() ?? "Unknown";

  // Decode the value/data payload
  const data = decodeEventValue(rawEvent.value);

  return {
    ledger: rawEvent.ledger,
    ledgerClosedAt: rawEvent.ledgerClosedAt,
    txHash: rawEvent.txHash,
    eventName,
    topics: decodedTopics,
    data,
  };
}

// ─── Contract-Specific Event Parsers ─────────────────────────────────────────

/**
 * Event types emitted by the PayoutRegistry contract.
 */
export type ContractEventName =
  | "Initialized"
  | "OrgRegistered"
  | "OrgFunded"
  | "MaintainerAdded"
  | "PayoutAllocated"
  | "PayoutClaimed"
  | "ProtocolPaused"
  | "ProtocolUnpaused"
  | "ContractUpgraded";

/**
 * Base interface for all contract events.
 */
export interface BaseContractEvent {
  eventName: ContractEventName;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
}

/**
 * Contract initialized event.
 * data: (token Address, protocol_admin Address)
 */
export interface InitializedEvent extends BaseContractEvent {
  eventName: "Initialized";
  token: string;
  protocolAdmin: string;
}

/**
 * Organization registered event.
 * data: id Symbol
 */
export interface OrgRegisteredEvent extends BaseContractEvent {
  eventName: "OrgRegistered";
  orgId: string;
}

/**
 * Organization funded event.
 * data: (org_id Symbol, from Address, amount i128)
 */
export interface OrgFundedEvent extends BaseContractEvent {
  eventName: "OrgFunded";
  orgId: string;
  from: string;
  amount: string; // String to preserve i128 precision
}

/**
 * Maintainer added event.
 * data: (org_id Symbol, maintainer Address)
 */
export interface MaintainerAddedEvent extends BaseContractEvent {
  eventName: "MaintainerAdded";
  orgId: string;
  maintainer: string;
}

/**
 * Payout allocated event.
 * data: (org_id Symbol, maintainer Address, amount i128)
 */
export interface PayoutAllocatedEvent extends BaseContractEvent {
  eventName: "PayoutAllocated";
  orgId: string;
  maintainer: string;
  amount: string; // String to preserve i128 precision
}

/**
 * Payout claimed event.
 * data: (maintainer Address, amount i128)
 */
export interface PayoutClaimedEvent extends BaseContractEvent {
  eventName: "PayoutClaimed";
  maintainer: string;
  amount: string; // String to preserve i128 precision
}

/**
 * Protocol paused event.
 * data: protocol_admin Address
 */
export interface ProtocolPausedEvent extends BaseContractEvent {
  eventName: "ProtocolPaused";
  protocolAdmin: string;
}

/**
 * Protocol unpaused event.
 * data: protocol_admin Address
 */
export interface ProtocolUnpausedEvent extends BaseContractEvent {
  eventName: "ProtocolUnpaused";
  protocolAdmin: string;
}

/**
 * Contract upgraded event.
 * data: (protocol_admin Address, new_wasm_hash BytesN<32>)
 */
export interface ContractUpgradedEvent extends BaseContractEvent {
  eventName: "ContractUpgraded";
  protocolAdmin: string;
  newWasmHash: string; // Hex string
}

/**
 * Union of all contract event types.
 */
export type ContractEvent =
  | InitializedEvent
  | OrgRegisteredEvent
  | OrgFundedEvent
  | MaintainerAddedEvent
  | PayoutAllocatedEvent
  | PayoutClaimedEvent
  | ProtocolPausedEvent
  | ProtocolUnpausedEvent
  | ContractUpgradedEvent;

/**
 * Parse a decoded event into a contract-specific event type.
 *
 * @param decodedEvent - The decoded event
 * @returns Parsed contract event, or null if not a recognized event
 */
export function parseContractEvent(decodedEvent: DecodedEvent): ContractEvent | null {
  const eventName = decodedEvent.eventName as ContractEventName;
  const base = {
    ledger: decodedEvent.ledger,
    ledgerClosedAt: decodedEvent.ledgerClosedAt,
    txHash: decodedEvent.txHash,
  };

  switch (eventName) {
    case "Initialized": {
      const data = decodedEvent.data as [string, string];
      return {
        ...base,
        eventName: "Initialized",
        token: data[0],
        protocolAdmin: data[1],
      };
    }

    case "OrgRegistered": {
      // data is just the orgId Symbol
      const orgId = decodedEvent.data as string;
      return {
        ...base,
        eventName: "OrgRegistered",
        orgId,
      };
    }

    case "OrgFunded": {
      // data: (org_id Symbol, from Address, amount i128)
      const data = decodedEvent.data as [string, string, unknown];
      const amount = extractI128AsString(data[2]);
      return {
        ...base,
        eventName: "OrgFunded",
        orgId: data[0],
        from: data[1],
        amount,
      };
    }

    case "MaintainerAdded": {
      // data: (org_id Symbol, maintainer Address)
      const data = decodedEvent.data as [string, string];
      return {
        ...base,
        eventName: "MaintainerAdded",
        orgId: data[0],
        maintainer: data[1],
      };
    }

    case "PayoutAllocated": {
      // data: (org_id Symbol, maintainer Address, amount i128)
      const data = decodedEvent.data as [string, string, unknown];
      const amount = extractI128AsString(data[2]);
      return {
        ...base,
        eventName: "PayoutAllocated",
        orgId: data[0],
        maintainer: data[1],
        amount,
      };
    }

    case "PayoutClaimed": {
      // data: (maintainer Address, amount i128)
      const data = decodedEvent.data as [string, unknown];
      const amount = extractI128AsString(data[1]);
      return {
        ...base,
        eventName: "PayoutClaimed",
        maintainer: data[0],
        amount,
      };
    }

    case "ProtocolPaused": {
      const protocolAdmin = decodedEvent.data as string;
      return {
        ...base,
        eventName: "ProtocolPaused",
        protocolAdmin,
      };
    }

    case "ProtocolUnpaused": {
      const protocolAdmin = decodedEvent.data as string;
      return {
        ...base,
        eventName: "ProtocolUnpaused",
        protocolAdmin,
      };
    }

    case "ContractUpgraded": {
      const data = decodedEvent.data as [string, string];
      return {
        ...base,
        eventName: "ContractUpgraded",
        protocolAdmin: data[0],
        newWasmHash: data[1],
      };
    }

    default:
      logger.warn({ eventName }, "Unknown contract event name");
      return null;
  }
}

/**
 * Extract an i128 value as a string from decoded data.
 *
 * Handles both object form (hi/lo) and primitive form.
 *
 * @param value - The decoded value (could be i128 in various forms)
 * @returns String representation of the i128
 */
function extractI128AsString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "number") {
    return value.toString();
  }

  if (typeof value === "object" && value !== null) {
    const parts = value as { hi?: bigint | number; lo?: bigint | number };
    if ("hi" in parts && "lo" in parts) {
      const hi = BigInt(parts.hi ?? 0);
      const lo = BigInt(parts.lo ?? 0);
      const fullValue = (hi << BigInt(64)) + lo;
      return fullValue.toString();
    }
  }

  logger.warn("Could not extract i128, returning '0'");
  return "0";
}

/**
 * Convert stroops (smallest unit) to XLM (display unit).
 *
 * @param stroops - Amount in stroops (as string or bigint)
 * @returns Amount in XLM as a string with 7 decimal places
 */
export function stroopsToXlm(stroops: string | bigint): string {
  const stroopsBigInt = typeof stroops === "string" ? BigInt(stroops) : stroops;
  const xlm = Number(stroopsBigInt) / 10_000_000;
  return xlm.toFixed(7);
}

/**
 * Convert XLM (display unit) to stroops (smallest unit).
 *
 * @param xlm - Amount in XLM
 * @returns Amount in stroops as a string
 */
export function xlmToStroops(xlm: string | number): string {
  const xlmNumber = typeof xlm === "string" ? parseFloat(xlm) : xlm;
  const stroops = Math.round(xlmNumber * 10_000_000);
  return stroops.toString();
}
