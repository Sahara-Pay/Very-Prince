/**
 * @file WebhookWorker.ts
 * @description Worker for processing webhook dispatches from BullMQ or SQS.
 */

import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { Worker, type Job } from "bullmq";
import {
  AWS_REGION,
  WEBHOOK_QUEUE_MAX_MESSAGES,
  WEBHOOK_QUEUE_MAX_RECEIVE_COUNT,
  WEBHOOK_QUEUE_PROVIDER,
  WEBHOOK_QUEUE_URL,
  WEBHOOK_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
  WEBHOOK_QUEUE_WAIT_TIME_SECONDS,
} from "../config/env.js";
import { webhookRepository } from "../repositories/WebhookRepository.js";
import {
  webhookJobDataSchema,
  type WebhookDispatchPayload,
  type WebhookJobData,
} from "../schemas/webhookJobSchemas.js";
import { bullRedisConnection } from "../services/cache.js";
import {
  webhookDlqService,
  type WebhookDlqFailure,
  type WebhookQueueProvider,
} from "../services/webhookDlqService.js";
import { webhookService } from "../services/webhookService.js";
import { logger } from "../utils/logger.js";

interface WebhookJobContext {
  id: string;
  name: string;
  data: WebhookJobData;
  attemptsMade: number;
  maxAttempts: number;
  queueProvider: WebhookQueueProvider;
  originalMessageId?: string;
  rawBody?: string;
}

interface WebhookProcessResult {
  success: true;
  status: number;
}

class WebhookProcessingError extends Error {
  readonly dlqFailure: WebhookDlqFailure;
  readonly originalError: unknown;

  constructor(errorMessage: string, dlqFailure: WebhookDlqFailure, originalError: unknown) {
    super(errorMessage);
    this.name = "WebhookProcessingError";
    this.dlqFailure = dlqFailure;
    this.originalError = originalError;
  }
}

export class WebhookWorker {
  private readonly worker: Worker<WebhookJobData> | null;
  private readonly sqsClient: SQSClient | null;
  private sqsPolling = false;
  private sqsPollPromise: Promise<void> | null = null;

  constructor() {
    if (WEBHOOK_QUEUE_PROVIDER === "sqs") {
      if (!WEBHOOK_QUEUE_URL) {
        throw new Error("WEBHOOK_QUEUE_URL is required for the SQS webhook worker");
      }

      this.worker = null;
      this.sqsClient = new SQSClient({ region: AWS_REGION });
      this.startSqsPolling();
    } else {
      this.sqsClient = null;
      this.worker = this.createBullMqWorker();
    }
  }

  async stop(): Promise<void> {
    this.sqsPolling = false;

    if (this.worker) {
      await this.worker.close();
    }

    if (this.sqsPollPromise) {
      await this.sqsPollPromise;
    }

    this.sqsClient?.destroy();
  }

  private createBullMqWorker(): Worker<WebhookJobData> {
    const worker = new Worker<WebhookJobData>(
      "webhook-dispatch",
      async (job: Job<WebhookJobData>) => {
        const context = this.createBullMqContext(job);

        try {
          return await this.processWebhookJob(context);
        } catch (error) {
          if (this.isFinalAttempt(context)) {
            await this.routeFailureToDlq(this.getDlqFailure(error, context));
          }

          throw error;
        }
      },
      {
        connection: bullRedisConnection,
        concurrency: 5,
      },
    );

    worker.on("completed", (job) => {
      logger.info({ jobId: job.id }, "Webhook job completed successfully");
    });

    worker.on("failed", (job, err) => {
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job ? this.getBullMqMaxAttempts(job) : 1;
      logger.error(
        { err, jobId: job?.id, attemptsMade, maxAttempts, exhausted: attemptsMade >= maxAttempts },
        "Webhook job failed",
      );
    });

    return worker;
  }

  private startSqsPolling(): void {
    this.sqsPolling = true;
    this.sqsPollPromise = this.pollSqsMessages();
  }

  private async pollSqsMessages(): Promise<void> {
    if (!this.sqsClient || !WEBHOOK_QUEUE_URL) {
      return;
    }

    while (this.sqsPolling) {
      try {
        const response = await this.sqsClient.send(new ReceiveMessageCommand({
          QueueUrl: WEBHOOK_QUEUE_URL,
          MaxNumberOfMessages: WEBHOOK_QUEUE_MAX_MESSAGES,
          WaitTimeSeconds: WEBHOOK_QUEUE_WAIT_TIME_SECONDS,
          VisibilityTimeout: WEBHOOK_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
          MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          MessageAttributeNames: ["All"],
        }));

        await Promise.all(
          (response.Messages ?? []).map((message) => this.processSqsMessage(message)),
        );
      } catch (error) {
        if (this.sqsPolling) {
          logger.error({ err: error }, "SQS webhook poll failed");
          await this.delay(1000);
        }
      }
    }
  }

  private async processSqsMessage(message: Message): Promise<void> {
    if (!this.sqsClient || !WEBHOOK_QUEUE_URL) {
      return;
    }

    const attemptsMade = this.getSqsReceiveCount(message);
    let jobData: WebhookJobData | undefined;

    try {
      jobData = this.parseSqsMessage(message);
      const context: WebhookJobContext = {
        id: message.MessageId ?? "unknown-sqs-message",
        name: "webhook-dispatch",
        data: jobData,
        attemptsMade,
        maxAttempts: WEBHOOK_QUEUE_MAX_RECEIVE_COUNT,
        queueProvider: "sqs",
      };
      if (message.MessageId) context.originalMessageId = message.MessageId;
      if (message.Body) context.rawBody = message.Body;

      await this.processWebhookJob(context);

      await this.deleteSqsMessage(message);
      logger.info(
        { messageId: message.MessageId, attemptsMade },
        "SQS webhook message completed successfully",
      );
    } catch (error) {
      const finalAttempt = attemptsMade >= WEBHOOK_QUEUE_MAX_RECEIVE_COUNT;

      if (finalAttempt) {
        const dlqFailure = this.getDlqFailure(
          error,
          this.createSqsFailureContext(message, attemptsMade, jobData),
        );
        const routed = await this.routeFailureToDlq(dlqFailure);

        if (routed) {
          await this.deleteSqsMessage(message);
        }
      }

      logger.error(
        {
          err: error,
          messageId: message.MessageId,
          attemptsMade,
          maxAttempts: WEBHOOK_QUEUE_MAX_RECEIVE_COUNT,
          finalAttempt,
        },
        "SQS webhook message failed",
      );
    }
  }

  private async processWebhookJob(context: WebhookJobContext): Promise<WebhookProcessResult> {
    const { organizationId, event, data } = context.data;
    const payload: WebhookDispatchPayload = {
      id: context.id,
      event,
      timestamp: new Date().toISOString(),
      organizationId,
      data,
    };
    let config: Awaited<ReturnType<typeof webhookRepository.getConfig>> | null = null;
    let deliveryId: string | undefined;

    try {
      config = await webhookRepository.getConfig(organizationId);
      if (!config || !config.url) {
        throw new Error(`Webhook configuration missing for org: ${organizationId}`);
      }

      const payloadString = JSON.stringify(payload);
      const signature = webhookService.calculateSignature(payloadString, config.secret);
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Very-prince-Webhook/1.0",
          "X-Very-prince-Signature": signature,
          "X-Very-prince-Timestamp": payload.timestamp,
        },
        body: payloadString,
        signal: AbortSignal.timeout(10000),
      });

      const responseBody = await response.text();
      const errorMessage = response.ok
        ? undefined
        : `Webhook failed with status: ${response.status}`;
      const delivery = await webhookRepository.createDelivery(
        config.id,
        payload,
        response.status,
        responseBody,
        errorMessage,
      );
      deliveryId = delivery.id;

      if (!response.ok) {
        throw new Error(errorMessage);
      }

      return { success: true, status: response.status };
    } catch (error) {
      const errorMessage = this.getErrorMessage(error);

      if (config?.id && !deliveryId) {
        try {
          const delivery = await webhookRepository.createDelivery(
            config.id,
            payload,
            undefined,
            undefined,
            errorMessage,
          );
          deliveryId = delivery.id;
        } catch (deliveryError) {
          logger.error(
            { err: deliveryError, jobId: context.id, organizationId },
            "Failed to persist webhook delivery failure",
          );
        }
      }

      throw new WebhookProcessingError(
        errorMessage,
        this.buildDlqFailure(context, errorMessage, payload, config, deliveryId),
        error,
      );
    }
  }

  private createBullMqContext(job: Job<WebhookJobData>): WebhookJobContext {
    return {
      id: job.id ?? job.name,
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade + 1,
      maxAttempts: this.getBullMqMaxAttempts(job),
      queueProvider: "bullmq",
    };
  }

  private createSqsFailureContext(
    message: Message,
    attemptsMade: number,
    jobData: WebhookJobData | undefined,
  ): WebhookJobContext {
    const context: WebhookJobContext = {
      id: message.MessageId ?? "unknown-sqs-message",
      name: "webhook-dispatch",
      data: jobData ?? {
        organizationId: "unknown",
        event: "unknown",
        data: {},
      },
      attemptsMade,
      maxAttempts: WEBHOOK_QUEUE_MAX_RECEIVE_COUNT,
      queueProvider: "sqs",
    };
    if (message.MessageId) context.originalMessageId = message.MessageId;
    if (message.Body) context.rawBody = message.Body;

    return context;
  }

  private buildDlqFailure(
    context: WebhookJobContext,
    errorMessage: string,
    payload?: WebhookDispatchPayload,
    config?: Awaited<ReturnType<typeof webhookRepository.getConfig>> | null,
    deliveryId?: string,
  ): WebhookDlqFailure {
    const failure: WebhookDlqFailure = {
      schemaVersion: 1,
      sourceQueue: "webhook-dispatch",
      queueProvider: context.queueProvider,
      failedAt: new Date().toISOString(),
      errorMessage,
      attemptsMade: context.attemptsMade,
      maxAttempts: context.maxAttempts,
      jobId: context.id,
      jobName: context.name,
      organizationId: context.data.organizationId,
      event: context.data.event,
      jobData: context.data,
    };

    if (context.originalMessageId) failure.originalMessageId = context.originalMessageId;
    if (context.rawBody) failure.rawBody = context.rawBody;
    if (payload) failure.payload = payload;
    if (config?.id) failure.webhookConfigId = config.id;
    if (config?.url) failure.webhookUrl = config.url;
    if (deliveryId) failure.webhookDeliveryId = deliveryId;

    return failure;
  }

  private getDlqFailure(error: unknown, fallbackContext: WebhookJobContext): WebhookDlqFailure {
    if (error instanceof WebhookProcessingError) {
      return error.dlqFailure;
    }

    return this.buildDlqFailure(
      fallbackContext,
      this.getErrorMessage(error),
      undefined,
      null,
      undefined,
    );
  }

  private async routeFailureToDlq(failure: WebhookDlqFailure): Promise<boolean> {
    if (!webhookDlqService.isEnabled()) {
      await webhookDlqService.sendFailure(failure);
      return false;
    }

    try {
      await webhookDlqService.sendFailure(failure);
      return true;
    } catch (error) {
      logger.error(
        {
          err: error,
          jobId: failure.jobId,
          originalMessageId: failure.originalMessageId,
          provider: failure.queueProvider,
        },
        "Failed to route webhook failure to DLQ",
      );
      return false;
    }
  }

  private parseSqsMessage(message: Message): WebhookJobData {
    if (!message.Body) {
      throw new Error("SQS webhook message body is empty");
    }

    return webhookJobDataSchema.parse(JSON.parse(message.Body) as unknown);
  }

  private async deleteSqsMessage(message: Message): Promise<void> {
    if (!this.sqsClient || !WEBHOOK_QUEUE_URL) {
      return;
    }

    if (!message.ReceiptHandle) {
      throw new Error(`SQS webhook message ${message.MessageId ?? "unknown"} has no receipt handle`);
    }

    await this.sqsClient.send(new DeleteMessageCommand({
      QueueUrl: WEBHOOK_QUEUE_URL,
      ReceiptHandle: message.ReceiptHandle,
    }));
  }

  private getSqsReceiveCount(message: Message): number {
    const receiveCount = Number(message.Attributes?.["ApproximateReceiveCount"] ?? "1");
    return Number.isFinite(receiveCount) && receiveCount > 0 ? receiveCount : 1;
  }

  private getBullMqMaxAttempts(job: Job<WebhookJobData>): number {
    return typeof job.opts.attempts === "number" && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
  }

  private isFinalAttempt(context: WebhookJobContext): boolean {
    return context.attemptsMade >= context.maxAttempts;
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}

export const webhookWorker = new WebhookWorker();
