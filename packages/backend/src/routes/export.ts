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
import { prisma } from "../services/db.js";

// ─── Validation Schemas ──────────────────────────────────────────────────────

const ExportQuerySchema = z.object({
  type: z.enum(["csv", "json"]),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

const AddressParamsSchema = z.object({
  address: z.string().startsWith("G").length(56),
});

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExportRecord {
  date: string;
  orgId: string;
  orgName: string | undefined;
  maintainerAddress: string;
  amountXlm: string;
  amountStroops: string;
  usdValue: string;
  transactionHash: string;
  ledger: number;
  eventType: string;
}

// ─── Route Plugin ────────────────────────────────────────────────────────────

export const exportRoutes: FastifyPluginAsync = async (fastify) => {
  /**
   * GET /api/export/payouts/:address
   * Export payout history for a specific address (maintainer or org admin)
   * 
   * @param address - Stellar address (G...) to export data for
   * @query type - Export format: 'csv' or 'json'
   * @query startDate - Optional start date filter (ISO string)
   * @query endDate - Optional end date filter (ISO string)
   * 
   * @example
   * GET /api/export/payouts/GABC...XYZ?type=csv&startDate=2024-01-01T00:00:00Z
   */
  fastify.get<{
    Params: z.infer<typeof AddressParamsSchema>;
    Querystring: z.infer<typeof ExportQuerySchema>;
  }>(
    "/payouts/:address",
    {
      schema: {
        params: AddressParamsSchema,
        querystring: ExportQuerySchema,
      },
    },
    async (request, reply) => {
      const { address } = request.params;
      const { type, startDate, endDate } = request.query;

      try {
        // Build date filter
        const dateFilter: any = {};
        if (startDate) {
          dateFilter.gte = new Date(startDate);
        }
        if (endDate) {
          dateFilter.lte = new Date(endDate);
        }

        // Query transactions from database
        const transactions = await prisma.transaction.findMany({
          where: {
            walletAddress: address,
            type: {
              in: ["PAYOUT_CLAIMED", "PAYOUT_ALLOCATED"],
            },
            ...(Object.keys(dateFilter).length > 0 && {
              createdAt: dateFilter,
            }),
          },
          orderBy: {
            createdAt: "desc",
          },
        });

        // Get organization information for org names
        const orgIds = [...new Set(transactions.map(tx => tx.rawData ? JSON.parse(tx.rawData).orgId : null).filter(Boolean))];
        const organizations = await prisma.organization.findMany({
          where: {
            id: {
              in: orgIds,
            },
          },
          select: {
            id: true,
            name: true,
          },
        });

        const orgMap = new Map(organizations.map(org => [org.id, org.name]));

        // Transform data for export
        const exportData: ExportRecord[] = transactions.map((tx) => {
          let orgId = "";
          let orgName: string | undefined;
          let maintainerAddress = address;
          let amountStroops = "0";
          let amountXlm = "0";
          const usdValue = tx.volumeUSD?.toString() || "0";

          try {
            // Parse raw data to extract additional information
            const rawData = tx.rawData ? JSON.parse(tx.rawData) : {};
            orgId = rawData.orgId || "";
            orgName = orgMap.get(orgId);
            
            if (tx.type === "PAYOUT_ALLOCATED") {
              maintainerAddress = rawData.maintainer || address;
              amountStroops = rawData.amount || "0";
            } else if (tx.type === "PAYOUT_CLAIMED") {
              amountStroops = rawData.amount || "0";
            }

            // Convert stroops to XLM
            amountXlm = (Number(amountStroops) / 10_000_000).toFixed(7);
          } catch (error) {
            fastify.log.error(error as Error, "Error parsing transaction raw data");
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

        // Set appropriate headers
        const filename = `payout-history-${address}-${new Date().toISOString().split('T')[0]}`;
        
        if (type === "csv") {
          reply.header("Content-Type", "text/csv");
          reply.header("Content-Disposition", `attachment; filename="${filename}.csv"`);

          // Create CSV stream
          const csvStream = csv.format({
            headers: [
              "Date",
              "Org ID", 
              "Org Name",
              "Maintainer Address",
              "Amount XLM",
              "Amount Stroops",
              "USD Value at time of claim",
              "Transaction Hash",
              "Ledger",
              "Event Type"
            ],
          });

          // Pipe CSV stream to response
          reply.send(csvStream);

          // Write data rows
          for (const record of exportData) {
            csvStream.write([
              record.date,
              record.orgId,
              record.orgName || "",
              record.maintainerAddress,
              record.amountXlm,
              record.amountStroops,
              record.usdValue,
              record.transactionHash,
              record.ledger.toString(),
              record.eventType,
            ]);
          }

          csvStream.end();

          return reply;
        } else {
          // JSON export
          reply.header("Content-Type", "application/json");
          reply.header("Content-Disposition", `attachment; filename="${filename}.json"`);

          return {
            metadata: {
              address,
              exportDate: new Date().toISOString(),
              recordCount: exportData.length,
              dateRange: {
                start: startDate || null,
                end: endDate || null,
              },
            },
            data: exportData,
          };
        }
      } catch (error) {
        fastify.log.error(error as Error, "Export error");
        return reply.status(500).send({
          error: "Failed to export data",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );
};
