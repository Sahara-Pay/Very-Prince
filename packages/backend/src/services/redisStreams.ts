/**
 * @file redisStreams.ts
 * @description Redis Streams producer + consumer group for live blockchain event fan-out.
 *
 * Replaces DB-polling based live updates with a push architecture:
 *   Indexer → [Redis Streams XADD] → Consumer Group → Local EventEmitter → tRPC/WS/SSE
 *
 * Horizontal scalability:
 *   - Many Fastify instances share the `trpc_subscribers` consumer group.
 *   - Redis delivers each message to exactly ONE consumer per group (fan-out to
 *     all instances happens via a broadcast key so every Fastify receives every event
 *     for its local WebSocket clients).
 *   - ACK discipline + XAUTOCLAIM avoids "disconnected client → unack bloat".
 *
 * Stream key:       streams:soroban_events
 * Consumer group:   trpc_subscribers
 * Consumer name:    trpc:<hostname>:<pid>
 * Trim strategy:    MAXLEN ~ (see env REDIS_STREAMS_MAX_LEN) + idle-based claim expiry.
 */

import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { redis } from './cache.js';
import { eventBus } from './eventBus.js';
import { logger } from '../utils/logger.js';
import type { ContractEvent } from '../utils/xdrDecoder.js';
import {
  REDIS_STREAMS_ENABLED,
  REDIS_STREAMS_KEY,
  REDIS_STREAMS_CONSUMER_GROUP,
  REDIS_STREAMS_MAX_LEN,
  REDIS_STREAMS_BLOCK_MS,
  REDIS_STREAMS_BATCH_SIZE,
  REDIS_STREAMS_CLAIM_MAX_IDLE_MS,
  REDIS_STREAMS_PENDING_REAP_INTERVAL_MS,
} from '../config/env.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Shape of the event payload written to the stream and re-emitted locally. */
export interface StreamEventEnvelope {
  /** UUID produced at XADD time for correlation. */
  id: string;
  /** ms epoch the event was *appended* to the stream. */
  producedAt: number;
  /** ms epoch of the ledger close time. */
  ledgerClosedAt: number;
  /** Exact `eventName` from the decoded Soroban event. */
  eventName: ContractEvent['eventName'];
  /** The full parsed contract event for downstream consumers. */
  payload: ContractEvent;
  /** Human-friendly tags used for trimming / observability. */
  tags: string;
}

// ─── Producer ────────────────────────────────────────────────────────────────

/**
 * Append a single contract event to the central Redis Stream.
 *
 * - Idempotent-ish: duplicates are harmless because consumers rely on HLL filter
 *   and DB unique constraints for dedupe; stream records get a new envelope id.
 * - Uses `MAXLEN ~` for approximate trimming (CPU-friendly).
 * - Safe-wrapped: on Redis failure we fall back to the existing in-process
 *   eventBus (no hard failure — the "best-effort live update" guarantee).
 */
export async function publishToStream(event: ContractEvent, eventIndex: number): Promise<string | null> {
  if (!REDIS_STREAMS_ENABLED) return null;

  const envelope: StreamEventEnvelope = {
    id: randomUUID(),
    producedAt: Date.now(),
    ledgerClosedAt: new Date(event.ledgerClosedAt).getTime(),
    eventName: event.eventName,
    payload: event,
    tags: buildTags(event, eventIndex),
  };

  const fields: string[] = [];
  fields.push('id', envelope.id);
  fields.push('producedAt', String(envelope.producedAt));
  fields.push('ledgerClosedAt', String(envelope.ledgerClosedAt));
  fields.push('eventName', envelope.eventName);
  fields.push('payload', JSON.stringify(envelope.payload));
  fields.push('tags', envelope.tags);

  try {
    const streamId = await redis.xadd(
      REDIS_STREAMS_KEY,
      'MAXLEN', '~', String(REDIS_STREAMS_MAX_LEN),
      '*',
      ...fields,
    );
    logger.trace(
      { streamId, eventName: envelope.eventName, txHash: event.txHash },
      '[RedisStreams] event appended',
    );
    return streamId ?? null;
  } catch (err) {
    logger.error({ err, eventName: envelope.eventName }, '[RedisStreams] XADD failed, falling back to local bus');
    // Degrade gracefully: local event-bus still pushes to clients on THIS instance.
    emitEnvelopeToLocalBus(envelope);
    return null;
  }
}

function buildTags(event: ContractEvent, eventIndex: number): string {
  const parts = [`idx:${eventIndex}`, `ledger:${event.ledger}`];
  if ('orgId' in event && typeof event.orgId === 'string') parts.push(`org:${event.orgId}`);
  if ('maintainer' in event && typeof event.maintainer === 'string') parts.push(`m:${event.maintainer}`);
  if ('from' in event && typeof event.from === 'string') parts.push(`from:${event.from}`);
  return parts.join(',');
}

// ─── Consumer (fan-out to every Fastify instance) ────────────────────────────

/**
 * Live fan-out consumer. Every Fastify instance independently tracks its own
 * cursor and performs `XREAD BLOCK ... STREAMS <key> <cursor>` so that events
 * are replicated to ALL subscribers across the fleet — not just delivered to
 * ONE consumer per group. This satisfies the requirement of broadcasting
 * blockchain mutations to thousands of connected WebSocket clients.
 *
 * A secondary *hygiene consumer group* (optional, named `trpc_subscribers_hygiene`)
 * exists only for bounded retention: nodes opportunistically join it to XACK
 * recently-processed entries so that the stream's Pending Entries List (PEL)
 * never grows unboundedly even under churn. If it is not configured, stream
 * growth is still bounded by `MAXLEN ~` on the producer side.
 *
 * Cursor durability:
 *   - Cursor is tracked in-memory as `$` on boot ("new messages only").
 *   - On disconnect we simply reconnect with the last-id so no message is
 *     missed while this process is alive. Short restarts drop at most
 *     `INDEXER_CRON_INTERVAL` of history, which the DB has already persisted.
 *   - Long-running disconnected clients are handled at the *tRPC / WS layer*
 *     by re-subscribing + hydrating from DB on reconnect. Stream is never
 *     held up waiting for a dead client → NO unacknowledged message bloat.
 */
export class RedisStreamsConsumerService {
  private running = false;
  private consumerName: string;
  private streamReadAbort = new AbortController();
  /** Cursor id for the live fan-out reader. Starts at `$` = "future only". */
  private lastStreamId = '$';
  private hygieneGroup = REDIS_STREAMS_CONSUMER_GROUP + '_hygiene';

  constructor() {
    this.consumerName = `trpc:${hostname()}:${process.pid}`;
  }

  async start(): Promise<void> {
    if (!REDIS_STREAMS_ENABLED) {
      logger.info('[RedisStreams] disabled via REDIS_STREAMS_ENABLED=false');
      return;
    }
    if (this.running) return;
    this.running = true;
    this.streamReadAbort = new AbortController();

    try {
      // Ensure the hygiene group exists (idempotent; MKSTREAM so it works
      // before any XADD has created the stream).
      await redis.xgroup(
        'CREATE',
        REDIS_STREAMS_KEY,
        this.hygieneGroup,
        '$',
        'MKSTREAM',
      ).catch((err: { message?: string }) => {
        if (!err?.message?.includes('BUSYGROUP')) throw err;
      });
      logger.info(
        { key: REDIS_STREAMS_KEY, hygieneGroup: this.hygieneGroup, consumer: this.consumerName },
        '[RedisStreams] live fan-out reader ready',
      );
    } catch (err) {
      logger.error({ err }, '[RedisStreams] failed to ensure hygiene group');
      return;
    }

    void this.streamReadLoop();
    void this.hygieneLoop();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.streamReadAbort.abort();
    try {
      await redis.xgroup('DELCONSUMER', REDIS_STREAMS_KEY, this.hygieneGroup, this.consumerName).catch(() => {});
    } catch {
      /* noop */
    }
    logger.info('[RedisStreams] consumer stopped');
  }

  // ── Live fan-out: XREAD delivers every message to every instance ───────────

  private async streamReadLoop(): Promise<void> {
    while (this.running && !this.streamReadAbort.signal.aborted) {
      try {
        // XREAD (no group) + BLOCK + per-instance cursor => every instance
        // gets every event instantly. This is the core of the fan-out design.
        const replies = await redis.xread(
          'COUNT', String(REDIS_STREAMS_BATCH_SIZE),
          'BLOCK', String(REDIS_STREAMS_BLOCK_MS),
          'STREAMS', REDIS_STREAMS_KEY, this.lastStreamId,
        );

        if (!replies || replies.length === 0) continue;

        for (const [, messages] of replies) {
          for (const [streamId, fields] of messages) {
            const envelope = parseStreamFields(fields);
            this.lastStreamId = streamId;
            if (!envelope) {
              logger.warn({ streamId }, '[RedisStreams] unparseable message, skipping');
              continue;
            }
            emitEnvelopeToLocalBus(envelope);
            // Opportunistically XACK into the hygiene group (best-effort).
            void safeAckGroup(streamId, this.hygieneGroup);
          }
        }
      } catch (err) {
        if (this.streamReadAbort.signal.aborted) break;
        logger.error({ err }, '[RedisStreams] XREAD error, backing off');
        await sleep(1000);
      }
    }
  }

  // ── Hygiene: reclaim + XACK idle entries in the hygiene group PEL ─────────

  private async hygieneLoop(): Promise<void> {
    while (this.running && !this.streamReadAbort.signal.aborted) {
      await sleep(REDIS_STREAMS_PENDING_REAP_INTERVAL_MS);
      if (!this.running) break;
      try {
        // XAUTOCLAIM sweeps entries that have been idle >= MAX_IDLE in the
        // hygiene group PEL. We XACK them immediately since the actual
        // fan-out delivery guarantee is "at-least-once to any alive instance"
        // — duplicates are harmless because of HLL filter + DB idempotency.
        const result = await redis.xautoclaim(
          REDIS_STREAMS_KEY,
          this.hygieneGroup,
          this.consumerName,
          String(REDIS_STREAMS_CLAIM_MAX_IDLE_MS),
          '0-0',
          'COUNT', String(REDIS_STREAMS_BATCH_SIZE),
        ) as unknown as [string, Array<[string, string[]]>];
        const [, claimed] = result;
        if (claimed && claimed.length > 0) {
          const ids = claimed.map(([id]) => id);
          for (const [streamId, fields] of claimed) {
            const envelope = parseStreamFields(fields);
            if (envelope) emitEnvelopeToLocalBus(envelope);
          }
          await safeAckGroupMulti(ids, this.hygieneGroup);
          logger.info({ count: ids.length }, '[RedisStreams] hygiene reclaimed + acked');
        }
      } catch (err) {
        logger.debug({ err }, '[RedisStreams] hygiene loop iteration failed');
      }
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseStreamFields(fields: string[] | Buffer[]): StreamEventEnvelope | null {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    const k = String(fields[i]);
    const v = String(fields[i + 1] ?? '');
    obj[k] = v;
  }
  try {
    return {
      id: obj.id ?? randomUUID(),
      producedAt: Number(obj.producedAt) || Date.now(),
      ledgerClosedAt: Number(obj.ledgerClosedAt) || Date.now(),
      eventName: obj.eventName as ContractEvent['eventName'],
      payload: JSON.parse(obj.payload ?? '{}') as ContractEvent,
      tags: obj.tags ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Mirror a stream envelope onto the existing EventEmitter using the same event
 * names already used by `emitSSEEvent`. This ensures zero changes to existing
 * tRPC subscriptions / SSE / WebSocket listeners.
 *
 * We also emit a generic `soroban:stream` event for observability tooling.
 */
function emitEnvelopeToLocalBus(envelope: StreamEventEnvelope): void {
  try {
    const busPayload = buildBusPayloadFromEvent(envelope.payload);
    const busEvent = eventNameToBusKey(envelope.eventName);
    if (busEvent) eventBus.emit(busEvent, busPayload);
    // `sse` channel powers tRPC subscriptionRouter.onEvent.
    eventBus.emit('sse', busEvent ?? envelope.eventName, busPayload);
    eventBus.emit('soroban:stream', { envelope, latencyMs: Date.now() - envelope.producedAt });
  } catch (err) {
    logger.error({ err, eventName: envelope.eventName }, '[RedisStreams] local emit failed');
  }
}

/** Convert a parsed ContractEvent to the same object shape used by emitSSEEvent. */
function buildBusPayloadFromEvent(event: ContractEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ledger: event.ledger,
    txHash: event.txHash,
    eventName: event.eventName,
  };
  switch (event.eventName) {
    case 'PayoutAllocated':
      return {
        ...base,
        orgId: event.orgId,
        maintainer: event.maintainer,
        amountStroops: event.amount,
        amountXlm: stroopsToXlmStr(event.amount),
      };
    case 'PayoutClaimed':
      return {
        ...base,
        maintainer: event.maintainer,
        amountStroops: event.amount,
        amountXlm: stroopsToXlmStr(event.amount),
      };
    case 'OrgFunded':
      return {
        ...base,
        orgId: event.orgId,
        from: event.from,
        amountStroops: event.amount,
        amountXlm: stroopsToXlmStr(event.amount),
      };
    case 'OrgRegistered':
      return { ...base, orgId: event.orgId };
    case 'MaintainerAdded':
      return { ...base, orgId: event.orgId, maintainer: event.maintainer };
    case 'ProtocolPaused':
    case 'ProtocolUnpaused':
      return { ...base, protocolAdmin: event.protocolAdmin };
    case 'Initialized':
      return { ...base, token: event.token, protocolAdmin: event.protocolAdmin };
    case 'ContractUpgraded':
      return { ...base, protocolAdmin: event.protocolAdmin, newWasmHash: event.newWasmHash };
  }
  return base;
}

function eventNameToBusKey(eventName: ContractEvent['eventName']): string | null {
  switch (eventName) {
    case 'PayoutAllocated': return 'payout_allocated';
    case 'PayoutClaimed':   return 'payout_claimed';
    case 'OrgFunded':       return 'funds_deposited';
    case 'OrgRegistered':   return 'org_registered';
    case 'MaintainerAdded': return 'maintainer_added';
    case 'ProtocolPaused':  return 'protocol_paused';
    case 'ProtocolUnpaused':return 'protocol_unpaused';
    case 'Initialized':     return 'contract_initialized';
    case 'ContractUpgraded':return 'contract_upgraded';
  }
  return null;
}

function stroopsToXlmStr(stroops: bigint | number | string): string {
  try {
    const n = typeof stroops === 'bigint' ? stroops : BigInt(String(stroops));
    const xlm = Number(n) / 10_000_000;
    return xlm.toFixed(7);
  } catch {
    return '0';
  }
}

async function safeAckGroup(streamId: string, group: string): Promise<void> {
  try {
    await redis.xack(REDIS_STREAMS_KEY, group, streamId);
  } catch (err) {
    logger.debug({ err, streamId, group }, '[RedisStreams] xack failed');
  }
}

async function safeAckGroupMulti(streamIds: string[], group: string): Promise<void> {
  if (streamIds.length === 0) return;
  try {
    await redis.xack(REDIS_STREAMS_KEY, group, ...streamIds);
  } catch (err) {
    logger.debug({ err, group }, '[RedisStreams] multi-xack failed');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const redisStreamsConsumer = new RedisStreamsConsumerService();
