import { webhookRepository } from "../repositories/WebhookRepository.js";
import { createHash, randomBytes } from "node:crypto";
import { Queue } from "bullmq";
import { redis } from "./cache.js";

export interface WebhookJobData {
  /** The unique ID of the organization to notify. */
  organizationId: string;
  /** The name of the event being dispatched (e.g., 'payout_claimed'). */
  event: string;
  /** The JSON-serializable payload data for the webhook. */
  data: any;
}

/**
 * Service for managing webhook configurations and dispatching events via BullMQ.
 */
export class WebhookService {
  /** The BullMQ queue for background webhook delivery. */
  private webhookQueue: Queue;

  constructor() {
    this.webhookQueue = new Queue("webhook-dispatch", {
      connection: redis,
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
  async queueWebhook(organizationId: string, event: string, data: any) {
    const config = await webhookRepository.getConfig(organizationId);
    if (!config || !config.url) {
      return;
    }

    await this.webhookQueue.add(`webhook:${event}:${organizationId}`, {
      organizationId,
      event,
      data,
    });
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
}

export const webhookService = new WebhookService();
