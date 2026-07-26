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

        const transactions = await prismaRead.transaction.findMany({
          where: {
            walletAddress: address,
            type: { in: ['PAYOUT_CLAIMED', 'PAYOUT_ALLOCATED'] },
            ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter }),
          },
          orderBy: { createdAt: 'desc' },
        });

        const orgIds = [...new Set(transactions.map(tx => tx.rawData ? JSON.parse(tx.rawData).orgId : null).filter(Boolean))];
        const organizations = await prismaRead.organization.findMany({
          where: { id: { in: orgIds } },
          select: { id: true, name: true },
        });

        const orgMap = new Map(organizations.map(org => [org.id, org.name]));

        const exportData: ExportRecord[] = transactions.map((tx) => {
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

          return {
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
        });

        const filename = 'payout-history-' + address + '-' + new Date().toISOString().split('T')[0];

        if (type === 'csv') {
          reply.header('Content-Type', 'text/csv');
          reply.header('Content-Disposition', 'attachment; filename="' + filename + '.csv"');

          const csvStream = csv.format({
            headers: ['Date', 'Org ID', 'Org Name', 'Maintainer Address', 'Amount XLM', 'Amount Stroops', 'USD Value', 'Transaction Hash', 'Ledger', 'Event Type'],
          });

          reply.send(csvStream);

          for (const record of exportData) {
            csvStream.write([record.date, record.orgId, record.orgName || '', record.maintainerAddress, record.amountXlm, record.amountStroops, record.usdValue, record.transactionHash, record.ledger.toString(), record.eventType]);
          }

          csvStream.end();
          return reply;
        } else {
          reply.header('Content-Type', 'application/json');
          reply.header('Content-Disposition', 'attachment; filename="' + filename + '.json"');
          return { metadata: { address, exportDate: new Date().toISOString(), recordCount: exportData.length, dateRange: { start: startDate || null, end: endDate || null } }, data: exportData };
        }
      } catch (error) {
        fastify.log.error(error as Error, 'Export error');
        return reply.status(500).send({ error: 'Failed to export data', message: error instanceof Error ? error.message : 'Unknown error' });
      }
    }
  );
};
