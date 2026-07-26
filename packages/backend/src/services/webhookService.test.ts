import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWebhookRepository, mockLogger, mockQueueAdd, mockSqsSend } = vi.hoisted(() => ({
  mockWebhookRepository: {
    getConfig: vi.fn(),
    upsertConfig: vi.fn(),
  },
  mockLogger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  mockQueueAdd: vi.fn(),
  mockSqsSend: vi.fn(),
}));

vi.mock("../repositories/WebhookRepository.js", () => ({
  webhookRepository: mockWebhookRepository,
}));

vi.mock("../utils/logger.js", () => ({
  logger: mockLogger,
}));

vi.mock("./cache.js", () => ({
  bullRedisConnection: {},
}));

vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
  })),
}));

vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: vi.fn().mockImplementation(() => ({
    send: mockSqsSend,
  })),
  SendMessageCommand: vi.fn().mockImplementation((input) => input),
}));

vi.mock("../config/env.js", () => ({
  AWS_REGION: "us-east-1",
  WEBHOOK_QUEUE_PROVIDER: "bullmq",
  WEBHOOK_QUEUE_URL: undefined,
}));

import { WebhookService } from "./webhookService.js";

describe("WebhookService", () => {
  let webhookService: WebhookService;

  beforeEach(() => {
    vi.clearAllMocks();
    webhookService = new WebhookService();
  });

  describe("queueWebhook", () => {
    it("logs at debug level and skips dispatch when no webhook is configured", async () => {
      mockWebhookRepository.getConfig.mockResolvedValueOnce(null);

      await webhookService.queueWebhook("org-1", "payout_claimed", {
        message: "hi",
        timestamp: new Date().toISOString(),
      });

      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org-1", event: "payout_claimed" }),
        expect.stringContaining("Skipping webhook dispatch")
      );
    });

    it("logs an info event with organizationId, event, and provider on successful dispatch", async () => {
      mockWebhookRepository.getConfig.mockResolvedValueOnce({ url: "https://example.com/hook" });
      mockQueueAdd.mockResolvedValueOnce(undefined);

      await webhookService.queueWebhook("org-1", "payout_claimed", {
        message: "hi",
        timestamp: new Date().toISOString(),
      });

      expect(mockQueueAdd).toHaveBeenCalledWith(
        "webhook:payout_claimed:org-1",
        expect.objectContaining({ organizationId: "org-1", event: "payout_claimed" })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: "org-1", event: "payout_claimed", provider: "bullmq" }),
        expect.stringContaining("Webhook queued for dispatch")
      );
    });

    it("logs a structured error and rethrows when the queue backend fails", async () => {
      mockWebhookRepository.getConfig.mockResolvedValueOnce({ url: "https://example.com/hook" });
      const queueError = new Error("Redis connection lost");
      mockQueueAdd.mockRejectedValueOnce(queueError);

      await expect(
        webhookService.queueWebhook("org-1", "payout_claimed", {
          message: "hi",
          timestamp: new Date().toISOString(),
        })
      ).rejects.toThrow("Redis connection lost");

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: queueError, organizationId: "org-1", event: "payout_claimed" }),
        expect.stringContaining("Failed to queue webhook for dispatch")
      );
    });
  });

  describe("generateSecretForOrganization", () => {
    it("logs when a new webhook secret is generated", async () => {
      mockWebhookRepository.getConfig.mockResolvedValueOnce(null);
      mockWebhookRepository.upsertConfig.mockResolvedValueOnce({});

      const secret = await webhookService.generateSecretForOrganization("org-1");

      expect(secret).toHaveLength(64);
      expect(mockLogger.info).toHaveBeenCalledWith(
        { organizationId: "org-1" },
        "Generated new webhook signing secret"
      );
    });

    it("does not log or generate a new secret when one already exists", async () => {
      mockWebhookRepository.getConfig.mockResolvedValueOnce({ secret: "existing-secret", url: "https://x.com" });

      const secret = await webhookService.generateSecretForOrganization("org-1");

      expect(secret).toBe("existing-secret");
      expect(mockWebhookRepository.upsertConfig).not.toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });
});
