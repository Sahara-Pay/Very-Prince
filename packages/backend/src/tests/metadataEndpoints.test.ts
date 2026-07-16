/**
 * @file metadataEndpoints.test.ts
 * @description API integration tests for all backend metadata (read-only) endpoints.
 *
 * These tests exercise the HTTP request/response contract of every metadata
 * endpoint without hitting real Stellar RPC, Redis, or PostgreSQL. All external
 * dependencies are mocked at the module level using Vitest.
 *
 * Coverage targets:
 *  - Health & diagnostics
 *  - Organization listing, detail, maintainers, and budget
 *  - Maintainer balance and payout lookup
 *  - Profile stats
 *  - Global stats, TVL, and top maintainers
 *  - Token verification
 *  - Auth nonce generation
 *  - Analytics leaderboard
 *  - Organization details (SOROBAN direct)
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ─── Hoisted mocks (required because vi.mock factories are hoisted) ─────────

const {
  mockStellarService,
  cacheStore,
  mockSafeGet,
  mockSafeSet,
  mockPrisma,
} = vi.hoisted(() => {
  const mockStellarService = {
    readAllOrganizations: vi.fn().mockResolvedValue(["stellar", "soroban"]),
    readOrganization: vi.fn().mockResolvedValue({
      id: "stellar",
      name: "Stellar Dev Fund",
      admin: "GALABSTTESTADDRESS1234567890123456789012345678",
      metadata_cid: "QmTestCid123",
    }),
    readOrganizationDetails: vi.fn().mockResolvedValue({
      id: "stellar",
      name: "Stellar Dev Fund",
      admin: "GALABSTTESTADDRESS1234567890123456789012345678",
      budgetStroops: "50000000",
      budgetXlm: "5.0000000",
    }),
    readOrgBudget: vi.fn().mockResolvedValue(BigInt(50000000)),
    readMaintainers: vi.fn().mockResolvedValue([
      "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111",
      "GBCEXAMPLEMAINTAINER2ADDRESS2222222222222222222222",
    ]),
    readClaimableBalance: vi.fn().mockResolvedValue(BigInt(10000000)),
    readProfileStats: vi.fn().mockResolvedValue({
      address: "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111",
      totalStroops: BigInt(25000000),
      totalXlm: "2.5000000",
      orgIds: ["stellar"],
      payouts: [
        {
          orgId: "stellar",
          amountStroops: BigInt(10000000),
          ledger: 12345,
          ledgerClosedAt: "2026-01-01T00:00:00Z",
          txHash: "abc123def456",
        },
      ],
    }),
    getMaintainerPayouts: vi.fn().mockResolvedValue([
      { orgId: "stellar", amount: 5000000 },
    ]),
    registerOrg: vi.fn().mockResolvedValue({ success: true, transactionHash: "tx_hash_123" }),
    fundOrg: vi.fn().mockResolvedValue({ success: true, transactionHash: "tx_hash_456" }),
    allocatePayout: vi.fn().mockResolvedValue({ success: true, transactionHash: "tx_hash_789" }),
    createClaimPayoutTransaction: vi.fn().mockResolvedValue("AAAAAg..."),
    submitTransaction: vi.fn().mockResolvedValue({ success: true, transactionHash: "tx_hash_submit" }),
  };

  const cacheStore = new Map<string, string>();
  const mockSafeGet = vi.fn(async (key: string) => cacheStore.get(key) ?? null);
  const mockSafeSet = vi.fn(async (key: string, value: string, _ttl: number) => {
    cacheStore.set(key, value);
  });

  const mockPrisma = {
    verifiedContract: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    transaction: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    invoice: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { faceValueUSD: null } }),
    },
    maintainerNotification: {
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    apiKey: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
  };

  return { mockStellarService, cacheStore, mockSafeGet, mockSafeSet, mockPrisma };
});

// ─── Mock: @very-prince/types ────────────────────────────────────────────────

vi.mock("@very-prince/types", () => ({}));

// ─── Mock: services/stellarService ──────────────────────────────────────────

vi.mock("../services/stellarService.js", () => ({
  stellarService: mockStellarService,
}));

// ─── Mock: services/cache ───────────────────────────────────────────────────

vi.mock("../services/cache.js", () => ({
  safeGet: mockSafeGet,
  safeSet: mockSafeSet,
  redis: {
    get: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ..._args: unknown[]) => {
      cacheStore.set(key, value);
    }),
    del: vi.fn(async (key: string) => {
      cacheStore.delete(key);
    }),
    getBuffer: vi.fn().mockResolvedValue(null),
  },
  bullRedisConnection: {},
}));

// ─── Mock: services/db (Prisma) ────────────────────────────────────────────

vi.mock("../services/db.js", () => ({
  prisma: mockPrisma,
}));

// ─── Mock: services/organizationService ─────────────────────────────────────

vi.mock("../services/organizationService.js", () => ({
  organizationService: {
    getOrganizations: vi.fn().mockResolvedValue({
      data: [
        { id: "stellar", name: "Stellar Dev Fund", admin: "GAAAA...", publicBudget: "50000000" },
      ],
      meta: { totalPages: 1, currentPage: 1, totalCount: 1 },
    }),
    registerOrganization: vi.fn().mockResolvedValue({
      success: true,
      transactionHash: "tx_hash_reg",
    }),
    getOrganization: vi.fn().mockResolvedValue({
      id: "stellar",
      name: "Stellar Dev Fund",
      admin: "GAAAA...",
    }),
    getMaintainers: vi.fn().mockResolvedValue([
      "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111",
    ]),
    getOrgBudget: vi.fn().mockResolvedValue({
      orgId: "stellar",
      budgetStroops: "50000000",
      budgetXlm: "5.0000000",
    }),
    uploadMetadata: vi.fn().mockResolvedValue("QmNewCid456"),
  },
  PaginatedOrgsResponse: {},
}));

// ─── Mock: services/payoutService ───────────────────────────────────────────

vi.mock("../services/payoutService.js", () => ({
  payoutService: {
    getClaimableBalance: vi.fn().mockResolvedValue({
      maintainer: "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111",
      claimableStroops: "10000000",
      claimableXlm: "1.0000000",
    }),
    fundOrg: vi.fn().mockResolvedValue({
      success: true,
      transactionHash: "tx_hash_fund",
    }),
    allocatePayout: vi.fn().mockResolvedValue({
      success: true,
      transactionHash: "tx_hash_alloc",
    }),
  },
}));

// ─── Mock: services/authService ─────────────────────────────────────────────

vi.mock("../services/authService.js", () => ({
  authService: {
    generateNonce: vi.fn().mockImplementation(async (publicKey: string) => ({
      message: `tradeflow.app wants you to sign in with your Stellar account:\n\n${publicKey}\n\nNonce: abc123`,
      nonce: "abc123",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
    verifyNonce: vi.fn().mockResolvedValue(true),
    getStoredNonce: vi.fn().mockResolvedValue(null),
  },
  NonceResponse: {},
}));

// ─── Mock: services/indexerService ──────────────────────────────────────────

vi.mock("../services/indexerService.js", () => ({
  indexerService: {
    getStatus: vi.fn().mockReturnValue({
      isRunning: true,
      lastSyncAt: "2026-01-01T00:00:00Z",
      cronExpression: "*/5 * * * *",
    }),
    triggerSync: vi.fn().mockResolvedValue(undefined),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

// ─── Mock: plugins/apiKeyAuth ───────────────────────────────────────────────

vi.mock("../plugins/apiKeyAuth.js", () => ({
  validateApiKey: vi.fn(async (_request: unknown, _reply: unknown) => {
    // Always pass in tests — no real API key validation
  }),
  apiKeyAuthPlugin: vi.fn(),
  checkOrganizationAccess: vi.fn().mockReturnValue(true),
  requireOrganizationAccess: vi.fn(),
}));

// ─── Mock: services/ipfsService ─────────────────────────────────────────────

vi.mock("../services/ipfsService.js", () => ({
  ipfsService: {
    uploadOrgMetadata: vi.fn().mockResolvedValue("QmIpfsCid789"),
  },
}));

// ─── Mock: services/webhookService ──────────────────────────────────────────

vi.mock("../services/webhookService.js", () => ({
  webhookService: {
    getConfig: vi.fn().mockResolvedValue({}),
    updateConfig: vi.fn().mockResolvedValue({}),
    sendTestWebhook: vi.fn().mockResolvedValue({}),
  },
}));

// ─── Mock: services/emailService ────────────────────────────────────────────

vi.mock("../services/emailService.js", () => ({
  emailService: {
    sendPayoutNotification: vi.fn().mockResolvedValue({}),
  },
}));

// ─── Mock: workers/WebhookWorker ────────────────────────────────────────────

vi.mock("../workers/WebhookWorker.js", () => ({
  webhookWorker: {
    stop: vi.fn().mockResolvedValue(undefined),
  },
}));

// ─── Mock: trpc/server ─────────────────────────────────────────────────────

vi.mock("../trpc/server.js", () => ({
  configureTRPC: vi.fn(),
}));

// ─── Mock: routes/events ───────────────────────────────────────────────────

vi.mock("../routes/events.js", () => ({
  eventsRoutes: vi.fn(),
  emitSSEEvent: vi.fn(),
}));

// ─── Imports (resolved after mocks are in place) ───────────────────────────

import { contractRoutes } from "../routes/contract.js";
import { profileRoutes } from "../routes/profile.js";
import { statsRoutes } from "../routes/stats.js";
import { tokenRoutes } from "../routes/token.js";
import { authRoutes } from "../routes/auth.js";
import { analyticsRoutes } from "../routes/analytics.js";
import { organizationRoutes } from "../routes/organization.js";

// ─── Test App Builder ──────────────────────────────────────────────────────

function buildTestApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Register contract routes
  app.register(contractRoutes, { prefix: "/api/v1/contract" });

  // Register profile routes
  app.register(profileRoutes, { prefix: "/api/v1/profile" });

  // Register stats routes
  app.register(statsRoutes, { prefix: "/api/stats" });

  // Register token routes
  app.register(tokenRoutes, { prefix: "/api/v1/tokens" });

  // Register auth routes
  app.register(authRoutes, { prefix: "/api/v1/auth" });

  // Register analytics routes
  app.register(analyticsRoutes, { prefix: "/api/v1/analytics" });

  // Register organization routes
  app.register(organizationRoutes, { prefix: "/api/org" });

  // Health check (mirrors index.ts inline route)
  app.get("/health", async () => ({
    status: "ok",
    version: "0.1.0",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  }));

  // Indexer status (mirrors index.ts inline route)
  app.get("/indexer/status", async () => {
    const { indexerService } = await import("../services/indexerService.js");
    return indexerService.getStatus();
  });

  return app;
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("Metadata Endpoints — API Integration Tests", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildTestApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  // ── Health & Diagnostics ───────────────────────────────────────────────

  describe("GET /health", () => {
    it("should return 200 with status ok and version", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.status).toBe("ok");
      expect(body.version).toBe("0.1.0");
      expect(body.timestamp).toBeDefined();
      expect(body.uptime).toBeDefined();
    });
  });

  describe("GET /indexer/status", () => {
    it("should return indexer status with isRunning field", async () => {
      const res = await app.inject({ method: "GET", url: "/indexer/status" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.isRunning).toBe(true);
      expect(body.lastSyncAt).toBeDefined();
      expect(body.cronExpression).toBeDefined();
    });
  });

  // ── Organization Listing & Details ─────────────────────────────────────

  describe("GET /api/v1/contract/orgs", () => {
    it("should return paginated organizations with default pagination", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/contract/orgs" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("meta");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta).toHaveProperty("totalPages");
      expect(body.meta).toHaveProperty("currentPage");
      expect(body.meta).toHaveProperty("totalCount");
    });

    it("should accept custom page and limit query params", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs?page=2&limit=5",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.meta.currentPage).toBeDefined();
    });

    it("should accept search query param", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs?search=stellar",
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /api/v1/contract/orgs/:orgId", () => {
    it("should return organization details for a valid orgId", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs/stellar",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("id");
      expect(body).toHaveProperty("name");
      expect(body).toHaveProperty("admin");
    });

    it("should return 200 even for unknown org (delegates to service)", async () => {
      const { organizationService } = await import("../services/organizationService.js");
      (organizationService.getOrganization as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: "unknown",
        name: "Unknown Org",
        admin: "GAAAA...",
        metadataCid: undefined,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs/unknown",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.id).toBe("unknown");
    });
  });

  describe("GET /api/v1/contract/orgs/:orgId/maintainers", () => {
    it("should return maintainer list with count", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs/stellar/maintainers",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("orgId", "stellar");
      expect(body).toHaveProperty("maintainers");
      expect(Array.isArray(body.maintainers)).toBe(true);
      expect(body).toHaveProperty("count");
      expect(typeof body.count).toBe("number");
    });

    it("should return count matching maintainers array length", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs/stellar/maintainers",
      });

      const body = JSON.parse(res.payload);
      expect(body.count).toBe(body.maintainers.length);
    });
  });

  describe("GET /api/v1/contract/orgs/:orgId/budget", () => {
    it("should return budget in stroops and XLM", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs/stellar/budget",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("orgId", "stellar");
      expect(body).toHaveProperty("budgetStroops");
      expect(body).toHaveProperty("budgetXlm");
      expect(typeof body.budgetStroops).toBe("string");
      expect(typeof body.budgetXlm).toBe("string");
    });

    it("should correctly convert stroops to XLM", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs/stellar/budget",
      });

      const body = JSON.parse(res.payload);
      const stroops = parseInt(body.budgetStroops, 10);
      const xlm = parseFloat(body.budgetXlm);
      expect(xlm).toBeCloseTo(stroops / 10_000_000, 5);
    });
  });

  // ── Maintainer Balance & Payouts ───────────────────────────────────────

  describe("GET /api/v1/contract/maintainers/:address/balance", () => {
    it("should return claimable balance for a valid address", async () => {
      const address = "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111";
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/contract/maintainers/${address}/balance`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("maintainer", address);
      expect(body).toHaveProperty("claimableStroops");
      expect(body).toHaveProperty("claimableXlm");
      expect(typeof body.claimableStroops).toBe("string");
      expect(typeof body.claimableXlm).toBe("string");
    });

    it("should return zero balance when no claimable amount exists", async () => {
      const { payoutService } = await import("../services/payoutService.js");
      (payoutService.getClaimableBalance as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        maintainer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        claimableStroops: "0",
        claimableXlm: "0.0000000",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/maintainers/GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/balance",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.claimableStroops).toBe("0");
    });
  });

  describe("GET /api/v1/contract/maintainer/:address", () => {
    it("should return pending payouts array", async () => {
      const address = "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111";
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/contract/maintainer/${address}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
      if (body.length > 0) {
        expect(body[0]).toHaveProperty("orgId");
        expect(body[0]).toHaveProperty("amount");
      }
    });
  });

  // ── Profile Stats ──────────────────────────────────────────────────────

  describe("GET /api/v1/profile/:address/stats", () => {
    // 56-char Stellar public key for testing
    const VALID_ADDRESS = "GBCEXAMPLEMAINTAINERADDRESS11111111111111111111111111111";

    it("should return profile stats for a valid Stellar address", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/profile/${VALID_ADDRESS}/stats`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("address");
      expect(typeof body.address).toBe("string");
      expect(body).toHaveProperty("totalStroops");
      expect(body).toHaveProperty("totalXlm");
      expect(body).toHaveProperty("orgIds");
      expect(body).toHaveProperty("payouts");
      expect(Array.isArray(body.orgIds)).toBe(true);
      expect(Array.isArray(body.payouts)).toBe(true);
    });

    it("should return totalStroops as a string (bigint-safe)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/profile/${VALID_ADDRESS}/stats`,
      });

      const body = JSON.parse(res.payload);
      expect(typeof body.totalStroops).toBe("string");
    });

    it("should return payout entries with amountStroops as string", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/profile/${VALID_ADDRESS}/stats`,
      });

      const body = JSON.parse(res.payload);
      for (const payout of body.payouts) {
        expect(typeof payout.amountStroops).toBe("string");
        expect(payout).toHaveProperty("orgId");
        expect(payout).toHaveProperty("ledger");
        expect(payout).toHaveProperty("ledgerClosedAt");
        expect(payout).toHaveProperty("txHash");
      }
    });

    it("should return 400 for an invalid Stellar address", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/profile/invalid-address/stats",
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("error");
    });

    it("should return 400 for a non-G-prefixed address", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/profile/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/stats",
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── Global Stats ───────────────────────────────────────────────────────

  describe("GET /api/stats/global", () => {
    it("should return global stats with all required fields", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stats/global" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("totalOrganizations");
      expect(body).toHaveProperty("totalFundedStroops");
      expect(body).toHaveProperty("totalFundedXlm");
      expect(body).toHaveProperty("totalClaimedStroops");
      expect(body).toHaveProperty("totalClaimedXlm");
      expect(body).toHaveProperty("cachedAt");
      expect(body).toHaveProperty("cacheExpiresAt");
    });

    it("should return totalOrganizations as a number", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stats/global" });

      const body = JSON.parse(res.payload);
      expect(typeof body.totalOrganizations).toBe("number");
      expect(body.totalOrganizations).toBeGreaterThanOrEqual(0);
    });

    it("should return stroop values as strings", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stats/global" });

      const body = JSON.parse(res.payload);
      expect(typeof body.totalFundedStroops).toBe("string");
      expect(typeof body.totalClaimedStroops).toBe("string");
    });

    it("should return ISO timestamps for cachedAt and cacheExpiresAt", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stats/global" });

      const body = JSON.parse(res.payload);
      expect(new Date(body.cachedAt).toISOString()).toBe(body.cachedAt);
      expect(new Date(body.cacheExpiresAt).toISOString()).toBe(body.cacheExpiresAt);
    });
  });

  // ── TVL ────────────────────────────────────────────────────────────────

  describe("GET /api/stats/tvl", () => {
    it("should return TVL with tvlUSD and lastUpdated", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stats/tvl" });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("tvlUSD");
      expect(body).toHaveProperty("lastUpdated");
      expect(typeof body.tvlUSD).toBe("string");
    });

    it("should accept format=short query parameter", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/stats/tvl?format=short",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("tvlUSD");
    });

    it("should return valid ISO timestamp for lastUpdated", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stats/tvl" });

      const body = JSON.parse(res.payload);
      expect(new Date(body.lastUpdated).toISOString()).toBe(body.lastUpdated);
    });
  });

  // ── Top Maintainers ────────────────────────────────────────────────────

  describe("GET /api/stats/top-maintainers", () => {
    it("should return an array of top maintainers", async () => {
      mockStellarService.readProfileStats.mockResolvedValue({
        address: "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111",
        totalStroops: BigInt(25000000),
        totalXlm: "2.5000000",
        orgIds: ["stellar"],
        payouts: [],
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/stats/top-maintainers",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });

    it("each maintainer entry should have required fields", async () => {
      mockStellarService.readProfileStats.mockResolvedValue({
        address: "GBCEXAMPLEMAINTAINER1ADDRESS1111111111111111111111",
        totalStroops: BigInt(25000000),
        totalXlm: "2.5000000",
        orgIds: ["stellar"],
        payouts: [],
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/stats/top-maintainers",
      });

      const body = JSON.parse(res.payload);
      for (const maintainer of body) {
        expect(maintainer).toHaveProperty("address");
        expect(maintainer).toHaveProperty("totalEarningsXlm");
        expect(maintainer).toHaveProperty("totalEarningsStroops");
        expect(maintainer).toHaveProperty("organizationsAssisted");
        expect(typeof maintainer.organizationsAssisted).toBe("number");
      }
    });

    it("should return empty array when no maintainers exist", async () => {
      mockStellarService.readAllOrganizations.mockResolvedValueOnce([]);

      const res = await app.inject({
        method: "GET",
        url: "/api/stats/top-maintainers",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toEqual([]);
    });
  });

  // ── Token Verification ─────────────────────────────────────────────────

  describe("GET /api/v1/tokens/verify/:address", () => {
    it("should return isVerified=false for an unknown address", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tokens/verify/GUNKNOWNADDRESS123456789012345678901234567890",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("isVerified", false);
      expect(body).toHaveProperty("riskLevel", "HIGH");
    });

    it("should return isVerified=true for a verified address", async () => {
      mockPrisma.verifiedContract.findUnique.mockResolvedValueOnce({
        address: "GVERIFIEDADDRESS123456789012345678901234567890",
        riskLevel: "LOW",
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tokens/verify/GVERIFIEDADDRESS123456789012345678901234567890",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("isVerified", true);
      expect(body).toHaveProperty("riskLevel", "LOW");
    });

    it("should return riskLevel as either LOW or HIGH", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tokens/verify/GANYADDRESS12345678901234567890123456789012",
      });

      const body = JSON.parse(res.payload);
      expect(["LOW", "HIGH"]).toContain(body.riskLevel);
    });
  });

  // ── Auth Nonce ─────────────────────────────────────────────────────────

  describe("GET /api/v1/auth/nonce", () => {
    // 56-char Stellar public key for testing
    const VALID_PUBLIC_KEY = "GALABSTTESTADDRESS1234567890123456789012345678AAAAAAAAAA";

    it("should return nonce data for a valid public key", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/nonce?publicKey=${VALID_PUBLIC_KEY}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty("message");
      expect(body.data).toHaveProperty("nonce");
      expect(body.data).toHaveProperty("expiresAt");
    });

    it("should include the public key in the SIWS message", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/nonce?publicKey=${VALID_PUBLIC_KEY}`,
      });

      const body = JSON.parse(res.payload);
      expect(body.data.message).toContain(VALID_PUBLIC_KEY);
    });

    it("should include 'Nonce:' in the SIWS message", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/auth/nonce?publicKey=${VALID_PUBLIC_KEY}`,
      });

      const body = JSON.parse(res.payload);
      expect(body.data.message).toContain("Nonce:");
    });

    it("should return 400 for a missing publicKey", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/nonce",
      });

      expect(res.statusCode).toBe(400);
    });

    it("should return 400 for a short publicKey", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/nonce?publicKey=GSHORT",
      });

      expect(res.statusCode).toBe(400);
    });

    it("should return 400 for a non-G-prefixed publicKey", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/nonce?publicKey=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ── Analytics Leaderboard ──────────────────────────────────────────────

  describe("GET /api/v1/analytics/leaderboard", () => {
    it("should return an array leaderboard", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/leaderboard",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(Array.isArray(body)).toBe(true);
    });

    it("should return empty leaderboard when no transactions exist", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/leaderboard",
      });

      const body = JSON.parse(res.payload);
      expect(body).toEqual([]);
    });

    it("each entry should have rank, walletAddress, truncatedAddress, volumeUSD", async () => {
      mockPrisma.transaction.groupBy.mockResolvedValueOnce([
        {
          walletAddress: "GABCDE12345678901234567890123456789012345678",
          _sum: { volumeUSD: 1500.50 },
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/leaderboard",
      });

      const body = JSON.parse(res.payload);
      expect(body.length).toBe(1);
      expect(body[0]).toHaveProperty("rank", 1);
      expect(body[0]).toHaveProperty("walletAddress");
      expect(body[0]).toHaveProperty("truncatedAddress");
      expect(body[0]).toHaveProperty("volumeUSD");
      expect(typeof body[0].volumeUSD).toBe("number");
    });

    it("should truncate addresses correctly (first 6 + ... + last 4)", async () => {
      const fullAddress = "GABCDE12345678901234567890123456789012345678";
      mockPrisma.transaction.groupBy.mockResolvedValueOnce([
        {
          walletAddress: fullAddress,
          _sum: { volumeUSD: 500 },
        },
      ]);

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/leaderboard",
      });

      const body = JSON.parse(res.payload);
      expect(body[0].truncatedAddress).toBe("GABCDE...5678");
    });
  });

  // ── Organization Details (SOROBAN direct) ──────────────────────────────

  describe("GET /api/org/:id", () => {
    it("should return org details with budget info", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/org/stellar",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("id", "stellar");
      expect(body).toHaveProperty("name");
      expect(body).toHaveProperty("admin");
      expect(body).toHaveProperty("budgetStroops");
      expect(body).toHaveProperty("budgetXlm");
    });

    it("should call stellarService.readOrganizationDetails", async () => {
      await app.inject({ method: "GET", url: "/api/org/stellar" });

      expect(mockStellarService.readOrganizationDetails).toHaveBeenCalledWith("stellar");
    });

    it("should return 404 when organization is not found", async () => {
      mockStellarService.readOrganizationDetails.mockRejectedValueOnce(
        new Error("Organization not found")
      );

      const res = await app.inject({
        method: "GET",
        url: "/api/org/nonexistent",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("message");
    });

    it("should return 500 on RPC failure", async () => {
      mockStellarService.readOrganizationDetails.mockRejectedValueOnce(
        new Error("Soroban RPC connection timeout")
      );

      const res = await app.inject({
        method: "GET",
        url: "/api/org/stellar",
      });

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("error");
    });

    it("should use cache on subsequent requests", async () => {
      mockStellarService.readOrganizationDetails.mockClear();

      // First call — should hit the contract
      await app.inject({ method: "GET", url: "/api/org/stellar" });
      expect(mockStellarService.readOrganizationDetails).toHaveBeenCalledTimes(1);

      // Second call — should hit cache (within 5s TTL)
      await app.inject({ method: "GET", url: "/api/org/stellar" });
      expect(mockStellarService.readOrganizationDetails).toHaveBeenCalledTimes(1);
    });
  });

  // ── Response Content-Type ──────────────────────────────────────────────

  describe("Response Content-Type", () => {
    it("should return application/json for all metadata endpoints", async () => {
      const endpoints = [
        { method: "GET" as const, url: "/health" },
        { method: "GET" as const, url: "/api/v1/contract/orgs" },
        { method: "GET" as const, url: "/api/v1/contract/orgs/stellar" },
        { method: "GET" as const, url: "/api/v1/contract/orgs/stellar/maintainers" },
        { method: "GET" as const, url: "/api/v1/contract/orgs/stellar/budget" },
        { method: "GET" as const, url: "/api/stats/global" },
        { method: "GET" as const, url: "/api/stats/tvl" },
        { method: "GET" as const, url: "/api/stats/top-maintainers" },
        { method: "GET" as const, url: "/api/v1/analytics/leaderboard" },
      ];

      for (const endpoint of endpoints) {
        const res = await app.inject(endpoint);
        expect(
          res.headers["content-type"],
          `Content-Type for ${endpoint.method} ${endpoint.url}`
        ).toContain("application/json");
      }
    });
  });

  // ── Error Response Shapes ──────────────────────────────────────────────

  describe("Error Response Shapes", () => {
    it("400 responses should include error field", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/profile/short/stats",
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("error");
    });

    it("404 responses should include error and message fields", async () => {
      mockStellarService.readOrganizationDetails.mockRejectedValueOnce(
        new Error("Organization not found")
      );

      const res = await app.inject({
        method: "GET",
        url: "/api/org/missing",
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.payload);
      expect(body).toHaveProperty("error");
      expect(body).toHaveProperty("message");
    });
  });

  // ── Query Parameter Handling ───────────────────────────────────────────

  describe("Query Parameter Handling", () => {
    it("should handle empty search param gracefully", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs?search=",
      });

      expect(res.statusCode).toBe(200);
    });

    it("should handle page=1&limit=1 pagination", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/contract/orgs?page=1&limit=1",
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.data.length).toBeLessThanOrEqual(1);
    });

    it("should handle TVL format=full", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/stats/tvl?format=full",
      });

      expect(res.statusCode).toBe(200);
    });
  });
});
