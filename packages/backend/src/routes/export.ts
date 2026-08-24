/**
 * @file export.ts
 * @description Export route for accounting data (CSV/JSON).
 * 
 * This route allows organizations and maintainers to export their payout history
 * for tax purposes, accounting software (like QuickBooks), or internal audits.
 * 
 * Endpoint: GET /api/export/payouts/:address
 * Query parameters:
 * - type: csv or json (required)
 * - startDate: ISO date string (optional)
 * - endDate: ISO date string (optional)
 */

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import csv from "fast-csv";
import { prismaRead } from "../services/db.js";
import type { ExportRecord } from "@very-prince/types";
import { streamAsyncEnvelope, cursorIterable } from "../utils/streamingJson.js";

const ExportQuerySchema = z.object({
  type: z.enum(['csv', 'json']),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const AddressParamsSchema = z.object({
  address: z.string().startsWith('G').length(56),
});

export const exportRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /payouts/:address
   * Exports payout history for a Stellar wallet address as CSV or JSON.
   *
   * Supports optional date range filtering via `startDate` / `endDate` query
   * parameters. Suitable for tax accounting and internal audit workflows.
   *
   * @param request - Fastify request containing `address` path param and `type`,
   *   `startDate`, `endDate` query params.
   * @param reply - Fastify reply streamed as `text/csv` or `application/json`.
   * @returns Payout export file attachment.
   */
  fastify.get<{
    Params: z.infer<typeof AddressParamsSchema>;
    Querystring: z.infer<typeof ExportQuerySchema>;
  }>(
    '/payouts/:address',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
        },
      },
      schema: {
        params: AddressParamsSchema,
        querystring: ExportQuerySchema,
      },
    },
    async (request, reply) => {
      const { address } = request.params;
      const { type, startDate, endDate } = request.query;

      try {
        const dateFilter: any = {};
        if (startDate) dateFilter.gte = new Date(startDate);
        if (endDate) dateFilter.lte = new Date(endDate);

        // Pre-fetch organizations to avoid N+1 queries during streaming.
        // Even if there are 10k orgs, this is ~1MB of heap, which is safe.
        const organizations = await prismaRead.organization.findMany({
          select: { id: true, name: true },
        });
        const orgMap = new Map(organizations.map(org => [org.id, org.name]));

        const filename = `payout-history-${address}-${new Date().toISOString().split('T')[0]}`;
        const totalCount = await prismaRead.transaction.count({
          where: {
            walletAddress: address,
            type: { in: ['PAYOUT_CLAIMED', 'PAYOUT_ALLOCATED'] },
            ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
          },
        });

        const recordFetcher = async function* () {
          type TransactionRow = Awaited<ReturnType<typeof prismaRead.transaction.findMany>>[number];
          const iterator = cursorIterable<TransactionRow, { id: string; createdAt: Date }>(
            async (cursor) => {
              return prismaRead.transaction.findMany({
                where: {
                  walletAddress: address,
                  type: { in: ['PAYOUT_CLAIMED', 'PAYOUT_ALLOCATED'] },
                  ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
                },
                orderBy: { createdAt: 'desc' },
                take: 1000,
                ...(cursor ? { skip: 1, cursor: { id_createdAt: cursor } } : {}),
              });
            },
            (tx) => ({ id: tx.id, createdAt: tx.createdAt }),
            1000
          );

          for await (const tx of iterator) {
            let orgId = '';
            let orgName: string | undefined;
            let maintainerAddress = address;
            let amountStroops = '0';
            let amountXlm = '0';
            const usdValue = tx.volumeUSD?.toString() || '0';

            try {
              const rawData = tx.rawData ? JSON.parse(tx.rawData) : {};
              orgId = rawData.orgId || '';
              orgName = orgMap.get(orgId);
              if (tx.type === 'PAYOUT_ALLOCATED') {
                maintainerAddress = rawData.maintainer || address;
                amountStroops = rawData.amount || '0';
              } else if (tx.type === 'PAYOUT_CLAIMED') {
                amountStroops = rawData.amount || '0';
              }
              amountXlm = (Number(amountStroops) / 10_000_000).toFixed(7);
            } catch (error) {
              fastify.log.error(error as Error, 'Error parsing transaction raw data');
            }

            const record: ExportRecord = {
              date: tx.createdAt.toISOString(),
              orgId,
              orgName,
              maintainerAddress,
              amountXlm,
              amountStroops,
              usdValue,
              transactionHash: tx.txHash,
              ledger: tx.ledger,
              eventType: tx.type,
            };
            yield record;
          }
        };

        if (type === 'csv') {
          reply.header('Content-Type', 'text/csv');
          reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
          reply.header('X-Accel-Buffering', 'no');

          const csvStream = csv.format({
            headers: ['Date', 'Org ID', 'Org Name', 'Maintainer Address', 'Amount XLM', 'Amount Stroops', 'USD Value', 'Transaction Hash', 'Ledger', 'Event Type'],
          });

          csvStream.pipe(reply.raw);

          for await (const record of recordFetcher()) {
            csvStream.write([
              record.date,
              record.orgId,
              record.orgName || '',
              record.maintainerAddress,
              record.amountXlm,
              record.amountStroops,
              record.usdValue,
              record.transactionHash,
              record.ledger.toString(),
              record.eventType
            ]);
          }

          csvStream.end();
          return reply;
        } else {
          // Streaming JSON implementation
          reply.header('Content-Disposition', `attachment; filename="${filename}.json"`);
          
          const metadata = {
            address,
            exportDate: new Date().toISOString(),
            recordCount: totalCount,
            dateRange: { start: startDate || null, end: endDate || null }
          };

          await streamAsyncEnvelope(
            reply.raw,
            metadata,
            recordFetcher
          );
          return reply;
        }
      } catch (error) {
        fastify.log.error(error as Error, 'Export error');
        if (!reply.raw.headersSent) {
          return reply.status(500).send({ 
            error: 'Failed to export data', 
            message: error instanceof Error ? error.message : 'Unknown error' 
          });
        }
      }
    }
  );
};

