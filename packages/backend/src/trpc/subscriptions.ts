import { observable } from '@trpc/server/observable';
import { t } from './trpc.js';
import { eventBus } from '../services/eventBus.js';
import { logger } from '../utils/logger.js';

export interface StreamEventFrame {
  id: string;
  eventName: string;
  data: Record<string, unknown>;
  producedAt: number;
  receivedAt: number;
  latencyMs: number;
}

export const subscriptionRouter = t.router({
  onEvent: t.procedure
    .subscription(() => {
      return observable<string>((emit) => {
        const handler = (event: string, data: unknown) => {
          emit.next(JSON.stringify({ event, data, timestamp: Date.now() }));
        };
        eventBus.on('sse', handler);
        logger.debug('Client subscribed to all events');
        return () => {
          eventBus.off('sse', handler);
          logger.debug('Client unsubscribed from all events');
        };
      });
    }),

  /**
   * Live event stream sourced directly from the Redis Streams fan-out path.
   * Includes end-to-end latency (producedAt → subscriber receivedAt).
   * This is the recommended path for clients that want sub-100 ms updates.
   */
  onStreamEvent: t.procedure
    .subscription(() => {
      return observable<StreamEventFrame>((emit) => {
        const handler = (frame: {
          envelope: { id: string; eventName: string; payload: Record<string, unknown>; producedAt: number };
          latencyMs: number;
        }) => {
          emit.next({
            id: frame.envelope.id,
            eventName: frame.envelope.eventName,
            data: frame.envelope.payload,
            producedAt: frame.envelope.producedAt,
            receivedAt: Date.now(),
            latencyMs: frame.latencyMs,
          });
        };
        eventBus.on('soroban:stream', handler);
        logger.debug('Client subscribed to Redis Stream events');
        return () => {
          eventBus.off('soroban:stream', handler);
          logger.debug('Client unsubscribed from Redis Stream events');
        };
      });
    }),

  onPayoutAllocated: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('payout_allocated', handler);
        return () => eventBus.off('payout_allocated', handler);
      });
    }),

  onPayoutClaimed: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('payout_claimed', handler);
        return () => eventBus.off('payout_claimed', handler);
      });
    }),

  onFundsDeposited: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('funds_deposited', handler);
        return () => eventBus.off('funds_deposited', handler);
      });
    }),

  onOrgRegistered: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('org_registered', handler);
        return () => eventBus.off('org_registered', handler);
      });
    }),

  onMaintainerAdded: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('maintainer_added', handler);
        return () => eventBus.off('maintainer_added', handler);
      });
    }),

  onProtocolEvent: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('protocol_paused', handler);
        eventBus.on('protocol_unpaused', handler);
        return () => {
          eventBus.off('protocol_paused', handler);
          eventBus.off('protocol_unpaused', handler);
        };
      });
    }),

  onContractEvent: t.procedure
    .subscription(() => {
      return observable<Record<string, unknown>>((emit) => {
        const handler = (data: Record<string, unknown>) => emit.next(data);
        eventBus.on('contract_initialized', handler);
        eventBus.on('contract_upgraded', handler);
        return () => {
          eventBus.off('contract_initialized', handler);
          eventBus.off('contract_upgraded', handler);
        };
      });
    }),

  onHeartbeat: t.procedure
    .subscription(() => {
      return observable<{ timestamp: number }>((emit) => {
        const interval = setInterval(() => {
          emit.next({ timestamp: Date.now() });
        }, 30_000);
        return () => clearInterval(interval);
      });
    }),
});
