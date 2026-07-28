import { z } from 'zod';
import { t } from './trpc.js';
import { logger } from '../utils/logger.js';

const inMemoryChangesets: Array<{
  docId: string;
  docType: string;
  update: number[];
  timestamp: number;
}> = [];

const SYNC_WINDOW_MS = 10 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - SYNC_WINDOW_MS;
  while (inMemoryChangesets.length > 0 && inMemoryChangesets[0]!.timestamp < cutoff) {
    inMemoryChangesets.shift();
  }
}, 60_000);

export const syncRouter = t.router({
  push: t.procedure
    .input(z.object({
      docId: z.string(),
      docType: z.enum(['organization', 'maintainer', 'transaction', 'draft']),
      update: z.array(z.number()),
      timestamp: z.number(),
    }))
    .mutation(async ({ input }) => {
      inMemoryChangesets.push({
        docId: input.docId,
        docType: input.docType,
        update: input.update,
        timestamp: input.timestamp,
      });

      logger.debug({ docId: input.docId, docType: input.docType }, 'CRDT changeset pushed');

      return { success: true, received: input.timestamp };
    }),

  pull: t.procedure
    .input(z.object({
      since: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const since = input.since ?? (Date.now() - SYNC_WINDOW_MS);
      const changesets = inMemoryChangesets.filter((c) => c.timestamp >= since);

      return {
        changesets: changesets.map((c) => ({
          docId: c.docId,
          docType: c.docType,
          update: c.update,
          timestamp: c.timestamp,
        })),
        serverTime: Date.now(),
      };
    }),
});
