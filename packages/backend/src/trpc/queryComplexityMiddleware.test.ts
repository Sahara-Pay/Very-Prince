/**
 * @file queryComplexityMiddleware.test.ts
 * @description Tests for the tRPC batch query complexity analyzer.
 *
 * Coverage:
 * - computeBatchComplexity: single-procedure and batch scoring, static
 *   weights, AST-derived risk contribution, unknown-procedure fallback
 * - queryComplexityMiddleware as a Fastify preHandler: light batches reach
 *   the route handler, heavy batches are rejected with 429 before the
 *   handler (and therefore any "database access") ever runs
 * - the enabled/disabled config switch
 * - per-call overhead stays well under 1ms for a representative payload
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import fastify from "fastify";
import {
  computeBatchComplexity,
  queryComplexityMiddleware,
} from "./queryComplexityMiddleware.js";
import { queryComplexityConfig } from "../config/queryComplexityConfig.js";

function buildDeepObject(depth: number): Record<string, unknown> {
  if (depth <= 0) return { leaf: true };
  return { a: buildDeepObject(depth - 1) };
}

const HEAVY_PROCEDURE = 'organization.list';

function buildBatchBody(count: number, inputs: Record<number, unknown> = {}): Record<string, { json: unknown }> {
  const body: Record<string, { json: unknown }> = {};
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line security/detect-object-injection
    body[String(i)] = { json: inputs[i] ?? {} };
  }
  return body;
}

const originalEnabled = queryComplexityConfig.enabled;
const originalMaxBatchScore = queryComplexityConfig.maxBatchScore;
const originalLogBlocked = queryComplexityConfig.logBlocked;

afterEach(() => {
  queryComplexityConfig.enabled = originalEnabled;
  queryComplexityConfig.maxBatchScore = originalMaxBatchScore;
  queryComplexityConfig.logBlocked = originalLogBlocked;
});

describe("computeBatchComplexity — single procedure", () => {
  it("scores a cheap, known-light procedure well under the default threshold", () => {
    const result = computeBatchComplexity("contract.getStatus", {});
    expect(result.procedures).toHaveLength(1);
    expect(result.procedures[0]?.weight).toBe(1);
    expect(result.totalScore).toBeLessThan(queryComplexityConfig.maxBatchScore);
    expect(result.exceeds).toBe(false);
  });

  it("falls back to the default weight for an unknown procedure path", () => {
    const result = computeBatchComplexity("some.unlistedProcedure", {});
    expect(result.procedures[0]?.weight).toBe(queryComplexityConfig.defaultProcedureWeight);
  });

  it("increases the score when the procedure's input is deeply nested", () => {
    const shallow = computeBatchComplexity(HEAVY_PROCEDURE, { limit: 10 });
    const deep = computeBatchComplexity(HEAVY_PROCEDURE, { filter: buildDeepObject(15) });

    expect(deep.totalScore).toBeGreaterThan(shallow.totalScore);
  });
});

describe("computeBatchComplexity — batched requests", () => {
  it("sums scores across a comma-joined batch path", () => {
    const single = computeBatchComplexity("stats.getTopMaintainers", {});
    const batch = computeBatchComplexity("stats.getTopMaintainers,stats.getTopMaintainers", buildBatchBody(2));

    expect(batch.procedures).toHaveLength(2);
    expect(batch.totalScore).toBeCloseTo(single.totalScore * 2, 5);
  });

  it("exceeds the threshold when several database-intensive procedures are batched together", () => {
    const result = computeBatchComplexity(
      Array(5).fill(HEAVY_PROCEDURE).join(","),
      buildBatchBody(5),
    );

    expect(result.exceeds).toBe(true);
    expect(result.totalScore).toBeGreaterThan(queryComplexityConfig.maxBatchScore);
  });

  it("does not exceed the threshold for a batch of lightweight procedures", () => {
    const result = computeBatchComplexity("contract.getStatus,contract.getDetails", buildBatchBody(2));

    expect(result.exceeds).toBe(false);
  });

  it("unwraps the tRPC batch envelope's json key when reading each procedure's input", () => {
    const result = computeBatchComplexity(
      `${HEAVY_PROCEDURE},${HEAVY_PROCEDURE}`,
      buildBatchBody(2, { 0: { filter: buildDeepObject(15) } }),
    );

    expect(result.procedures[0]?.riskScore).toBeGreaterThan(result.procedures[1]?.riskScore ?? 0);
  });
});

describe("queryComplexityMiddleware — Fastify preHandler", () => {
  function buildApp() {
    const app = fastify();
    const handler = vi.fn(async (_request, reply) => reply.send({ ok: true }));

    app.post(
      "/trpc/:path",
      { preHandler: queryComplexityMiddleware },
      handler,
    );

    return { app, handler };
  }

  it("lets a light batch through to the route handler", async () => {
    const { app, handler } = buildApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/trpc/contract.getStatus",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("rejects a heavy batch with 429 and never calls the route handler", async () => {
    const { app, handler } = buildApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/trpc/${Array(5).fill(HEAVY_PROCEDURE).join(",")}`,
      payload: buildBatchBody(5),
    });

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: "Too Many Requests" });
    expect(handler).not.toHaveBeenCalled();

    await app.close();
  });

  it("bypasses scoring entirely when disabled via config", async () => {
    queryComplexityConfig.enabled = false;
    const { app, handler } = buildApp();
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: `/trpc/${Array(5).fill(HEAVY_PROCEDURE).join(",")}`,
      payload: buildBatchBody(5),
    });

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

describe("queryComplexityMiddleware — performance", () => {
  it("computes a typical batch's complexity in well under 1ms on average", () => {
    const batchBody = {
      "0": { json: { id: "org-1" } },
      "1": { json: { limit: 10, cursor: "abc" } },
      "2": { json: {} },
    };

    const iterations = 500;
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      computeBatchComplexity("organization.get,organization.list,contract.getStatus", batchBody);
    }
    const end = process.hrtime.bigint();

    const averageMs = Number(end - start) / 1_000_000 / iterations;
    expect(averageMs).toBeLessThan(1);
  });
});

describe("queryComplexityMiddleware — Web3 Webhook Ingestion", () => {
  it("correctly weights and scores webhook.ingest procedures", () => {
    const single = computeBatchComplexity("webhook.ingest", {
      organizationId: "org-1",
      event: "payout_claimed",
      data: { amount: "1000" },
    });
    expect(single.procedures[0]?.weight).toBe(12);
    expect(single.exceeds).toBe(false);

    const heavyBatch = computeBatchComplexity(
      "webhook.ingest,webhook.ingest,webhook.ingest,webhook.ingest",
      buildBatchBody(4, {
        0: { organizationId: "org-1", event: "block_finalized", data: buildDeepObject(15) },
      })
    );
    expect(heavyBatch.exceeds).toBe(true);
  });
});

