import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service layer so we don't hit Soroban RPC / DB in unit tests.
vi.mock("../services/organizationService.js", () => ({
  organizationService: {
    getMaintainers: vi.fn(),
  },
}));

vi.mock("../services/payoutService.js", () => ({
  payoutService: {},
}));

vi.mock("../services/stellarService.js", () => ({
  stellarService: {},
}));

import { contractController } from "../controllers/contractController.js";
import { organizationService } from "../services/organizationService.js";

const mockedGetMaintainers = vi.mocked(organizationService.getMaintainers);

describe("contractController.getMaintainers pagination", () => {
  const orgId = "stellar";
  const allMaintainers = Array.from({ length: 45 }, (_, i) => `GADDR${i}`);

  beforeEach(() => {
    mockedGetMaintainers.mockReset();
    mockedGetMaintainers.mockResolvedValue(allMaintainers);
  });

  it("returns page 1 with default limit (20) when no params are given", async () => {
    const result = await contractController.getMaintainers(orgId);

    expect(result.orgId).toBe(orgId);
    expect(result.maintainers).toHaveLength(20);
    expect(result.maintainers).toEqual(allMaintainers.slice(0, 20));
    expect(result.count).toBe(20);
    expect(result.meta).toEqual({
      page: 1,
      limit: 20,
      totalCount: 45,
      totalPages: 3,
    });
  });

  it("returns the correct slice for a middle page", async () => {
    const result = await contractController.getMaintainers(orgId, 2, 20);

    expect(result.maintainers).toEqual(allMaintainers.slice(20, 40));
    expect(result.meta.page).toBe(2);
    expect(result.meta.totalPages).toBe(3);
  });

  it("returns the remaining (partial) items on the last page", async () => {
    const result = await contractController.getMaintainers(orgId, 3, 20);

    expect(result.maintainers).toEqual(allMaintainers.slice(40, 45));
    expect(result.count).toBe(5);
    expect(result.meta.totalPages).toBe(3);
  });

  it("returns an empty array for a page beyond the available data (no error)", async () => {
    const result = await contractController.getMaintainers(orgId, 10, 20);

    expect(result.maintainers).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.meta.totalCount).toBe(45);
  });

  it("respects a custom limit", async () => {
    const result = await contractController.getMaintainers(orgId, 1, 5);

    expect(result.maintainers).toEqual(allMaintainers.slice(0, 5));
    expect(result.meta.totalPages).toBe(9);
  });

  it("does not mutate or drop data when there are no maintainers", async () => {
    mockedGetMaintainers.mockResolvedValueOnce([]);

    const result = await contractController.getMaintainers(orgId);

    expect(result.maintainers).toEqual([]);
    expect(result.count).toBe(0);
    expect(result.meta.totalPages).toBe(1);
    expect(result.meta.totalCount).toBe(0);
  });
});