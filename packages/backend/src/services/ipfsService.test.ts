import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockAxiosPost, mockLogger } = vi.hoisted(() => ({
  mockAxiosPost: vi.fn(),
  mockLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("axios", () => ({
  default: { post: mockAxiosPost },
}));

vi.mock("../utils/logger.js", () => ({
  logger: mockLogger,
}));

import { IpfsService } from "./ipfsService.js";

describe("IpfsService", () => {
  const originalApiKey = process.env["PINATA_API_KEY"];
  const originalSecretKey = process.env["PINATA_SECRET_API_KEY"];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env["PINATA_API_KEY"] = "test-api-key";
    process.env["PINATA_SECRET_API_KEY"] = "test-secret-key";
  });

  afterEach(() => {
    process.env["PINATA_API_KEY"] = originalApiKey;
    process.env["PINATA_SECRET_API_KEY"] = originalSecretKey;
  });

  it("logs the org name and resulting CID on a successful upload, without logging the description or logo", async () => {
    mockAxiosPost.mockResolvedValueOnce({ data: { IpfsHash: "QmTestCid123" } });
    const ipfsService = new IpfsService();

    const cid = await ipfsService.uploadOrgMetadata("Stellar Dev Fund", "secret description", "base64logo==");

    expect(cid).toBe("QmTestCid123");
    expect(mockLogger.info).toHaveBeenCalledWith(
      { name: "Stellar Dev Fund", cid: "QmTestCid123" },
      "Uploaded organization metadata to IPFS"
    );

    const loggedPayload = JSON.stringify(mockLogger.info.mock.calls[0][0]);
    expect(loggedPayload).not.toContain("secret description");
    expect(loggedPayload).not.toContain("base64logo==");
  });

  it("logs a structured error with the org name (not the logo payload) and rethrows on upload failure", async () => {
    const uploadError = new Error("Pinata request failed");
    mockAxiosPost.mockRejectedValueOnce(uploadError);
    const ipfsService = new IpfsService();

    await expect(
      ipfsService.uploadOrgMetadata("Stellar Dev Fund", "a description", "base64logo==")
    ).rejects.toThrow("Pinata request failed");

    expect(mockLogger.error).toHaveBeenCalledWith(
      { err: uploadError, name: "Stellar Dev Fund" },
      "Failed to upload organization metadata to IPFS"
    );

    const loggedPayload = JSON.stringify(mockLogger.error.mock.calls[0][0]);
    expect(loggedPayload).not.toContain("base64logo==");
  });
});
