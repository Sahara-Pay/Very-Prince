import { webhookRepository } from "../repositories/WebhookRepository.js";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHash, randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import {
  AWS_REGION,
  WEBHOOK_QUEUE_PROVIDER,
  WEBHOOK_QUEUE_URL,
} from "../config/env.js";
import {
  webhookJobDataSchema,
  type WebhookEventData,
  type WebhookJobData,
} from "../schemas/webhookJobSchemas.js";
import { bullRedisConnection } from "./cache.js";

export type { WebhookJobData } from "../schemas/webhookJobSchemas.js";

/**
 * Service for managing webhook configurations and dispatching events.
 */
export class WebhookService {
  private readonly webhookQueue: Queue<WebhookJobData> | null;
  private readonly sqsClient: SQSClient | null;

  constructor() {
    if (WEBHOOK_QUEUE_PROVIDER === "sqs") {
      this.sqsClient = new SQSClient({ region: AWS_REGION });
      this.webhookQueue = null;
    } else {
      this.sqsClient = null;
      this.webhookQueue = new Queue<WebhookJobData>("webhook-dispatch", {
        connection: bullRedisConnection,
        defaultJobOptions: {
          attempts: 5,
          backoff: {
            type: "exponential",
            delay: 5000,
          },
          removeOnComplete: true,
          removeOnFail: false,
        },
      });
    }
  }

  /**
   * Generates a cryptographically secure random secret for webhook signing.
   * @returns A 64-character hex string.
   */
  private generateWebhookSecret(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Calculates a SHA-256 HMAC signature for a webhook payload.
   * @param payload The raw stringified JSON payload.
   * @param secret The organization's webhook secret.
   * @returns The hex-encoded signature.
   */
  calculateSignature(payload: string, secret: string): string {
    return createHash('sha256').update(payload).update(secret).digest('hex');
  }

  /**
   * Ensures an organization has a webhook secret, generating one if necessary.
   * @param organizationId The organization to generate a secret for.
   * @returns The organization's secret.
   */
  async generateSecretForOrganization(organizationId: string): Promise<string> {
    const existingConfig = await webhookRepository.getConfig(organizationId);
    
    if (existingConfig && existingConfig.secret) {
      return existingConfig.secret;
    }

    const newSecret = this.generateWebhookSecret();
    await webhookRepository.upsertConfig(organizationId, existingConfig?.url || "", newSecret);
    return newSecret;
  }

  /**
   * Retrieves the current webhook configuration for an organization.
   * @param organizationId The ID of the organization.
   */
  async getConfig(organizationId: string) {
    return webhookRepository.getConfig(organizationId);
  }

  /**
   * Updates or creates a webhook URL configuration for an organization.
   * @param organizationId The ID of the organization.
   * @param url The external HTTP POST endpoint.
   */
  async updateConfig(organizationId: string, url: string) {
    const secret = await this.generateSecretForOrganization(organizationId);
    return webhookRepository.upsertConfig(organizationId, url, secret);
  }

  /**
   * Dispatches a webhook asynchronously using BullMQ.
   * @param organizationId The organization to notify.
   * @param event The event name.
   * @param data The payload data.
   */
  async queueWebhook(organizationId: string, event: string, data: WebhookEventData) {
    const config = await webhookRepository.getConfig(organizationId);
    if (!config || !config.url) {
      return;
    }

    const jobData = webhookJobDataSchema.parse({
      organizationId,
      event,
      data,
    });

    if (WEBHOOK_QUEUE_PROVIDER === "sqs") {
      await this.enqueueSqsWebhook(jobData);
      return;
    }

    if (!this.webhookQueue) {
      throw new Error("BullMQ webhook queue is not initialized");
    }

    await this.webhookQueue.add(`webhook:${event}:${organizationId}`, {
      ...jobData,
    });
  }

  private async enqueueSqsWebhook(jobData: WebhookJobData): Promise<void> {
    if (!this.sqsClient || !WEBHOOK_QUEUE_URL) {
      throw new Error("SQS webhook queue is not initialized");
    }

    await this.sqsClient.send(new SendMessageCommand({
      QueueUrl: WEBHOOK_QUEUE_URL,
      MessageBody: JSON.stringify(jobData),
      MessageAttributes: {
        organizationId: {
          DataType: "String",
          StringValue: jobData.organizationId,
        },
        event: {
          DataType: "String",
          StringValue: jobData.event,
        },
      },
    }));
  }

  /**
   * Specifically handles PayoutClaimed webhooks by queuing a background job.
   * @param organizationId The ID of the organization.
   * @param maintainer The address of the maintainer who claimed the payout.
   * @param amountStroops The payout amount in stroops.
   * @param txHash The transaction hash on the Stellar network.
   * @param ledger The ledger sequence number.
   */
  async dispatchPayoutClaimed(
    organizationId: string, 
    maintainer: string, 
    amountStroops: string, 
    txHash: string,
    ledger: number
  ) {
    await this.queueWebhook(organizationId, "payout_claimed", {
      maintainer,
      amountStroops,
      amountXlm: (Number(amountStroops) / 10_000_000).toFixed(7),
      txHash,
      ledger,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Dispatches a test webhook event.
   * @param organizationId The ID of the organization.
   */
  async sendTestWebhook(organizationId: string) {
    const config = await webhookRepository.getConfig(organizationId);
    if (!config || !config.url) {
      throw new Error("No webhook configuration found for this organization");
    }

    await this.queueWebhook(organizationId, "test_event", {
      message: "This is a test webhook from Very-prince.",
      timestamp: new Date().toISOString(),
    });

    return { success: true, message: "Test webhook queued successfully" };
  }
}

export const webhookService = new WebhookService();
