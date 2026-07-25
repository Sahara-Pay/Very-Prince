import {
  SendMessageCommand,
  SQSClient,
  type MessageAttributeValue,
} from "@aws-sdk/client-sqs";
import {
  AWS_REGION,
  WEBHOOK_DLQ_ENABLED,
  WEBHOOK_DLQ_URL,
} from "../config/env.js";
import type {
  WebhookDispatchPayload,
  WebhookJobData,
} from "../schemas/webhookJobSchemas.js";
import { logger } from "../utils/logger.js";

const SQS_MAX_MESSAGE_BYTES = 256 * 1024;

export type WebhookQueueProvider = "bullmq" | "sqs";

export interface WebhookDlqFailure {
  schemaVersion: 1;
  sourceQueue: "webhook-dispatch";
  queueProvider: WebhookQueueProvider;
  failedAt: string;
  errorMessage: string;
  attemptsMade: number;
  maxAttempts: number;
  jobId?: string;
  jobName?: string;
  originalMessageId?: string;
  organizationId?: string;
  event?: string;
  webhookConfigId?: string;
  webhookDeliveryId?: string;
  webhookUrl?: string;
  payload?: WebhookDispatchPayload;
  jobData?: WebhookJobData;
  rawBody?: string;
  truncationReason?: string;
}

type WebhookDlqPublishResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "disabled" };

export class WebhookDlqService {
  private readonly client: SQSClient | null;

  constructor() {
    this.client = WEBHOOK_DLQ_ENABLED && WEBHOOK_DLQ_URL
      ? new SQSClient({ region: AWS_REGION })
      : null;
  }

  isEnabled(): boolean {
    return this.client !== null && WEBHOOK_DLQ_URL !== undefined;
  }

  async sendFailure(failure: WebhookDlqFailure): Promise<WebhookDlqPublishResult> {
    if (!this.client || !WEBHOOK_DLQ_URL) {
      logger.warn(
        {
          jobId: failure.jobId,
          originalMessageId: failure.originalMessageId,
          provider: failure.queueProvider,
        },
        "Webhook DLQ is disabled; exhausted failure retained in source queue",
      );
      return { sent: false, reason: "disabled" };
    }

    const response = await this.client.send(new SendMessageCommand({
      QueueUrl: WEBHOOK_DLQ_URL,
      MessageBody: this.serializeFailure(failure),
      MessageAttributes: this.buildMessageAttributes(failure),
    }));

    logger.info(
      {
        dlqMessageId: response.MessageId,
        jobId: failure.jobId,
        originalMessageId: failure.originalMessageId,
        provider: failure.queueProvider,
      },
      "Webhook failure routed to DLQ",
    );

    return response.MessageId
      ? { sent: true, messageId: response.MessageId }
      : { sent: true };
  }

  private serializeFailure(failure: WebhookDlqFailure): string {
    const body = JSON.stringify(failure);
    if (Buffer.byteLength(body, "utf8") <= SQS_MAX_MESSAGE_BYTES) {
      return body;
    }

    const compactFailure = this.compactFailure(failure);
    const compactBody = JSON.stringify(compactFailure);
    if (Buffer.byteLength(compactBody, "utf8") <= SQS_MAX_MESSAGE_BYTES) {
      return compactBody;
    }

    return JSON.stringify({
      schemaVersion: failure.schemaVersion,
      sourceQueue: failure.sourceQueue,
      queueProvider: failure.queueProvider,
      failedAt: failure.failedAt,
      errorMessage: failure.errorMessage.slice(0, 4096),
      attemptsMade: failure.attemptsMade,
      maxAttempts: failure.maxAttempts,
      jobId: failure.jobId,
      originalMessageId: failure.originalMessageId,
      organizationId: failure.organizationId,
      event: failure.event,
      truncationReason: "Original failure envelope exceeded the SQS message size limit.",
    });
  }

  private compactFailure(failure: WebhookDlqFailure): WebhookDlqFailure {
    const compact: WebhookDlqFailure = {
      schemaVersion: failure.schemaVersion,
      sourceQueue: failure.sourceQueue,
      queueProvider: failure.queueProvider,
      failedAt: failure.failedAt,
      errorMessage: failure.errorMessage.slice(0, 4096),
      attemptsMade: failure.attemptsMade,
      maxAttempts: failure.maxAttempts,
      truncationReason: "Payload fields were omitted because the original failure envelope exceeded the SQS message size limit.",
    };

    if (failure.jobId) compact.jobId = failure.jobId;
    if (failure.jobName) compact.jobName = failure.jobName;
    if (failure.originalMessageId) compact.originalMessageId = failure.originalMessageId;
    if (failure.organizationId) compact.organizationId = failure.organizationId;
    if (failure.event) compact.event = failure.event;
    if (failure.webhookConfigId) compact.webhookConfigId = failure.webhookConfigId;
    if (failure.webhookDeliveryId) compact.webhookDeliveryId = failure.webhookDeliveryId;
    if (failure.webhookUrl) compact.webhookUrl = failure.webhookUrl;
    if (failure.rawBody) compact.rawBody = failure.rawBody.slice(0, 8192);

    return compact;
  }

  private buildMessageAttributes(failure: WebhookDlqFailure): Record<string, MessageAttributeValue> {
    const attributes: Record<string, MessageAttributeValue> = {
      sourceQueue: { DataType: "String", StringValue: failure.sourceQueue },
      queueProvider: { DataType: "String", StringValue: failure.queueProvider },
      attemptsMade: { DataType: "Number", StringValue: String(failure.attemptsMade) },
    };

    this.setStringAttribute(attributes, "jobId", failure.jobId);
    this.setStringAttribute(attributes, "originalMessageId", failure.originalMessageId);
    this.setStringAttribute(attributes, "organizationId", failure.organizationId);
    this.setStringAttribute(attributes, "event", failure.event);

    return attributes;
  }

  private setStringAttribute(
    attributes: Record<string, MessageAttributeValue>,
    key: string,
    value: string | undefined,
  ): void {
    if (value) {
      attributes[key] = { DataType: "String", StringValue: value };
    }
  }
}

export const webhookDlqService = new WebhookDlqService();
