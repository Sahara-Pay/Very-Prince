/**
 * @file etagCache.test.ts
 * @description Integration tests for the deterministic ETag caching plugin,
 * exercised through a real Fastify instance via `.inject()`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { etagCachePlugin } from "./etagCache.js";
import { canonicalStringify, computeEtag } from "../utils/etag.js";

const CACHEABLE_URL = "/cacheable";

async function buildServer() {
  const server = Fastify();
  await server.register(etagCachePlugin);

  server.get(CACHEABLE_URL, async (request) => {
    request.etagCacheable = true;
    return { b: 2, a: 1, org: "stellar" };
  });

  server.get("/opt-out", async () => {
    // Deliberately does NOT set request.etagCacheable — e.g. a mutation.
    return { mutated: true };
  });

  server.get("/error", async (request, reply) => {
    // Flagged cacheable, but a non-200 status must still bypass ETag logic.
    request.etagCacheable = true;
    reply.code(500);
    return { error: "boom" };
  });

  await server.ready();
  return server;
}

describe("etagCachePlugin", () => {
  let server: FastifyInstance;

  beforeEach(async () => {
    server = await buildServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it("sets an ETag header on a cacheable response", async () => {
    const res = await server.inject({ method: "GET", url: CACHEABLE_URL });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toMatch(/^"[0-9a-f]{40}"$/);
  });

  it("serves the canonical (key-sorted) JSON body", async () => {
    const res = await server.inject({ method: "GET", url: CACHEABLE_URL });
    expect(res.body).toBe(canonicalStringify({ b: 2, a: 1, org: "stellar" }));
  });

  it("computes an ETag matching the deterministic hash of the payload", async () => {
    const res = await server.inject({ method: "GET", url: CACHEABLE_URL });
    const expected = computeEtag(canonicalStringify({ a: 1, b: 2, org: "stellar" }));
    expect(res.headers.etag).toBe(expected);
  });

  it("returns 304 with an empty body when If-None-Match matches", async () => {
    const first = await server.inject({ method: "GET", url: CACHEABLE_URL });
    const etag = first.headers.etag as string;

    const second = await server.inject({
      method: "GET",
      url: CACHEABLE_URL,
      headers: { "if-none-match": etag },
    });

    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("returns 200 with the full body when If-None-Match does not match", async () => {
    const res = await server.inject({
      method: "GET",
      url: CACHEABLE_URL,
      headers: { "if-none-match": '"stale-hash"' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("leaves responses that did not opt in untouched", async () => {
    const res = await server.inject({ method: "GET", url: "/opt-out" });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ mutated: true });
  });

  it("does not attach an ETag to non-200 responses even if flagged", async () => {
    const res = await server.inject({ method: "GET", url: "/error" });
    expect(res.statusCode).toBe(500);
    expect(res.headers.etag).toBeUndefined();
  });
});
