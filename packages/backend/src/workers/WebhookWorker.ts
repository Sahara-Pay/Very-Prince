/**
 * @file WebhookWorker.ts
 * @description BullMQ worker for processing webhook dispatches.
 */

import { Worker, Job } from "bullmq";
import { bullRedisConnection } from "../services/cache.js";
import { webhookService, WebhookJobData } from "../services/webhookService.js";
import { webhookRepository } from "../repositories/WebhookRepository.js";
import { logger } from "../utils/logger.js";

export class WebhookWorker {
  private worker: Worker;

  constructor() {
    this.worker = new Worker(
      "webhook-dispatch",
      async (job: Job<WebhookJobData>) => {
        const { organizationId, event, data } = job.data;
        
        const config = await webhookRepository.getConfig(organizationId);
        if (!config || !config.url) {
          throw new Error(`Webhook configuration missing for org: ${organizationId}`);
        }

        const payload = {
          id: job.id,
          event,
          timestamp: new Date().toISOString(),
          organizationId,
          data,
        };

        const payloadString = JSON.stringify(payload);
        const signature = webhookService.calculateSignature(payloadString, config.secret);

        try {
          const response = await fetch(config.url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "User-Agent": "Very-prince-Webhook/1.0",
              "X-Very-prince-Signature": signature,
              "X-Very-prince-Timestamp": payload.timestamp,
            },
            body: payloadString,
            signal: AbortSignal.timeout(10000) as any, 
          });

          const responseBody = await response.text();

          // Log delivery attempt
          await webhookRepository.createDelivery(
            config.id,
            payload,
            response.status,
            responseBody
          );

          if (!response.ok) {
            // Throwing will trigger BullMQ retry logic
            throw new Error(`Webhook failed with status: ${response.status}`);
          }

          return { success: true, status: response.status };
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          
          // Log failure
          await webhookRepository.createDelivery(
            config.id,
            payload,
            undefined,
            undefined,
            errorMessage
          );

          throw error; // Rethrow for BullMQ retry
        }
      },
      {
        connection: bullRedisConnection,
        concurrency: 5,
      }
    );

    this.worker.on("completed", (job) => {
      logger.info({ jobId: job.id }, "Webhook job completed successfully");
    });

    this.worker.on("failed", (job, err) => {
      logger.error({ err, jobId: job?.id }, "Webhook job failed");
    });
  }

  async stop() {
    await this.worker.close();
  }
}

// Export singleton instance
export const webhookWorker = new WebhookWorker();
