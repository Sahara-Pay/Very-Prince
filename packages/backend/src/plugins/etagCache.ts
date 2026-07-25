/**
 * @file etagCache.ts
 * @description Fastify plugin that turns tRPC query responses into
 * conditionally-cacheable HTTP responses via deterministic ETags.
 *
 * The dashboard polls tRPC query endpoints frequently. Most polls return
 * data identical to the previous response. This plugin buffers the
 * outgoing JSON payload in an `onSend` hook, canonicalizes + SHA-1 hashes it
 * (see `../utils/etag.ts`), and:
 *   - always sets the `ETag` header on query responses, and
 *   - short-circuits to `304 Not Modified` (empty body) when the request's
 *     `If-None-Match` header already matches the freshly computed ETag.
 *
 * Only responses explicitly opted in via `request.etagCacheable = true` are
 * touched. Route handlers must only set that flag for successful, read-only
 * (tRPC `query`) results — never for mutations, since a 304 has no body and
 * a mutation caller needs its result to know the call actually ran.
 */

import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { canonicalStringify, computeEtag, ifNoneMatchSatisfied } from "../utils/etag.js";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Opt-in flag a route handler sets before returning, marking the
     * response as a safe candidate for deterministic ETag caching.
     */
    etagCacheable?: boolean;
  }
}

const etagCachePluginFn: FastifyPluginAsync = async (server) => {
  server.addHook("onSend", async (request, reply, payload) => {
    if (!request.etagCacheable) {
      return payload;
    }

    // Only buffer/hash plain successful JSON string bodies. Streams,
    // buffers, and non-2xx responses are left untouched.
    if (reply.statusCode !== 200 || typeof payload !== "string") {
      return payload;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // Not JSON — nothing to canonicalize or hash.
      return payload;
    }

    const canonicalPayload = canonicalStringify(parsed);
    const etag = computeEtag(canonicalPayload);

    reply.header("ETag", etag);
    reply.header("Cache-Control", "private, must-revalidate");

    const ifNoneMatch = request.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatchSatisfied(ifNoneMatch, etag)) {
      reply.code(304);
      reply.removeHeader("content-type");
      return "";
    }

    // Send the canonical bytes so the ETag always matches what was
    // actually transmitted, even though the wire body's key order may
    // differ slightly from the resolver's original object.
    return canonicalPayload;
  });
};

// Wrapped with fastify-plugin so `addHook` attaches to the *parent* Fastify
// instance rather than a new encapsulated child context. Without this, the
// onSend hook would never run for sibling routes (like `/trpc/:path`)
// registered on the same instance after this plugin.
export const etagCachePlugin = fp(etagCachePluginFn, { name: "etag-cache" });

export default etagCachePlugin;
