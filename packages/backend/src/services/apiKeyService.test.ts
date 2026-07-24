import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma, mockLogger } = vi.hoisted(() => ({
  mockPrisma: {
    apiKey: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  mockLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./db.js", () => ({
  prisma: mockPrisma,
}));

vi.mock("../utils/logger.js", () => ({
  logger: mockLogger,
}));

import { ApiKeyService } from "./apiKeyService.js";

describe("ApiKeyService", () => {
  let apiKeyService: ApiKeyService;

  beforeEach(() => {
    vi.clearAllMocks();
    apiKeyService = new ApiKeyService();
  });

  describe("generateApiKey", () => {
    it("logs an audit event with the key id and organization, but never the plaintext or hashed key", async () => {
      mockPrisma.apiKey.findFirst.mockResolvedValueOnce(null);
      const createdAt = new Date();
      mockPrisma.apiKey.create.mockResolvedValueOnce({
        id: "key-1",
        organizationId: "org-1",
        name: "CI key",
        isActive: true,
        lastUsedAt: null,
        createdAt,
        updatedAt: createdAt,
      });

      const result = await apiKeyService.generateApiKey("org-1", "CI key");

      expect(result.plainTextKey.length).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { organizationId: "org-1", apiKeyId: "key-1", name: "CI key" },
        "API key generated"
      );

      const [loggedFields] = mockLogger.info.mock.calls[0];
      expect(JSON.stringify(loggedFields)).not.toContain(result.plainTextKey);
    });
  });

  describe("revokeApiKey", () => {
    it("logs an info event when a key is successfully revoked", async () => {
      mockPrisma.apiKey.updateMany.mockResolvedValueOnce({ count: 1 });

      const revoked = await apiKeyService.revokeApiKey("org-1", "key-1");

      expect(revoked).toBe(true);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { organizationId: "org-1", apiKeyId: "key-1" },
        "API key revoked"
      );
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it("logs a warning when no matching key is found to revoke", async () => {
      mockPrisma.apiKey.updateMany.mockResolvedValueOnce({ count: 0 });

      const revoked = await apiKeyService.revokeApiKey("org-1", "missing-key");

      expect(revoked).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { organizationId: "org-1", apiKeyId: "missing-key" },
        "API key revocation requested but no matching key found"
      );
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });
});
