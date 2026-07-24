import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
const { mockRedis, mockStellarService, mockOrganizationRepository, mockLogger } = vi.hoisted(() => ({
  mockRedis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
  mockStellarService: {
    readOrganization: vi.fn(),
    registerOrg: vi.fn(),
    readOrgBudget: vi.fn(),
  },
  mockOrganizationRepository: {
    upsert: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  mockLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../services/cache.js", () => ({
  redis: mockRedis,
}));

vi.mock("../services/stellarService.js", () => ({
  stellarService: mockStellarService,
}));

vi.mock("../repositories/OrganizationRepository.js", () => ({
  organizationRepository: mockOrganizationRepository,
}));

vi.mock("../utils/logger.js", () => ({
  logger: mockLogger,
}));

import { organizationService } from "./organizationService.js";

describe("OrganizationService Caching", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("getOrganization", () => {
    it("should fetch from stellarService and set Redis cache on cache miss", async () => {
      const orgId = "stellar";
      const orgMockData = {
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadata_cid: "QmCID123",
      };

      mockRedis.get.mockResolvedValueOnce(null);
      mockStellarService.readOrganization.mockResolvedValueOnce(orgMockData);

      const result = await organizationService.getOrganization(orgId);

      expect(mockRedis.get).toHaveBeenCalledWith("org:stellar");
      expect(mockStellarService.readOrganization).toHaveBeenCalledWith("stellar");
      expect(mockRedis.set).toHaveBeenCalledWith(
        "org:stellar",
        JSON.stringify({
          id: "stellar",
          name: "Stellar Dev Fund",
          admin: "GB...",
          metadataCid: "QmCID123",
        }),
        "EX",
        300
      );
      expect(result).toEqual({
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadataCid: "QmCID123",
      });
    });

    it("should retrieve organization details from cache on cache hit", async () => {
      const orgId = "stellar";
      const cachedData = {
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadataCid: "QmCID123",
      };

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(cachedData));

      const result = await organizationService.getOrganization(orgId);

      expect(mockRedis.get).toHaveBeenCalledWith("org:stellar");
      expect(mockStellarService.readOrganization).not.toHaveBeenCalled();
      expect(mockRedis.set).not.toHaveBeenCalled();
      expect(result).toEqual(cachedData);
    });

    it("should gracefully handle Redis get failures and fallback to stellarService", async () => {
      const orgId = "stellar";
      const orgMockData = {
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadata_cid: "QmCID123",
      };

      mockRedis.get.mockRejectedValueOnce(new Error("Redis connection down"));
      mockStellarService.readOrganization.mockResolvedValueOnce(orgMockData);

      const result = await organizationService.getOrganization(orgId);

      expect(mockRedis.get).toHaveBeenCalledWith("org:stellar");
      expect(mockStellarService.readOrganization).toHaveBeenCalledWith(orgId);
      expect(result).toEqual({
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadataCid: "QmCID123",
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cacheKey: "org:stellar" }),
        expect.stringContaining("Redis get failed")
      );
    });

    it("should log a structured warning (not throw) when the Redis set after a cache miss fails", async () => {
      const orgId = "stellar";
      const orgMockData = {
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadata_cid: "QmCID123",
      };

      mockRedis.get.mockResolvedValueOnce(null);
      mockStellarService.readOrganization.mockResolvedValueOnce(orgMockData);
      mockRedis.set.mockRejectedValueOnce(new Error("Redis connection down"));

      const result = await organizationService.getOrganization(orgId);

      expect(result).toEqual({
        id: "stellar",
        name: "Stellar Dev Fund",
        admin: "GB...",
        metadataCid: "QmCID123",
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ cacheKey: "org:stellar" }),
        expect.stringContaining("Redis set failed")
      );
    });
  });

  describe("getOrganizations", () => {
    it("logs a structured warning and omits the budget when the budget fetch fails", async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      mockOrganizationRepository.findMany.mockResolvedValueOnce([
        { id: "org-1", name: "Org One", admin: "GA..." },
      ]);
      mockOrganizationRepository.count.mockResolvedValueOnce(1);
      mockStellarService.readOrgBudget.mockRejectedValueOnce(new Error("RPC unavailable"));

      const result = await organizationService.getOrganizations(1, 10);

      expect(result.data).toEqual([{ id: "org-1", name: "Org One", admin: "GA..." }]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: "org-1" }),
        expect.stringContaining("Failed to fetch org budget")
      );
    });
  });

  describe("registerOrganization", () => {
    it("should invalidate the cache when organization is successfully registered", async () => {
      const orgId = "stellar";
      mockStellarService.registerOrg.mockResolvedValueOnce({ success: true, transactionHash: "hash" });
      mockOrganizationRepository.upsert.mockResolvedValueOnce({});

      const result = await organizationService.registerOrganization(
        orgId,
        "Stellar Dev Fund",
        "GB...",
        "S..."
      );

      expect(result.success).toBe(true);
      expect(mockRedis.del).toHaveBeenCalledWith("orgs:page:1:limit:10");
      expect(mockRedis.del).toHaveBeenCalledWith("org:stellar");
    });
  });
});
