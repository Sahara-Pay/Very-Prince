import { prisma } from "../services/db.js";
import { randomBytes } from "node:crypto";
import { nonBlockingStringify } from "../utils/streamingJson.js";

export class WebhookRepository {
  async getConfig(organizationId: string) {
    return prisma.webhookConfig.findUnique({
      where: { organizationId },
      include: {
        deliveries: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });
  }

  async upsertConfig(organizationId: string, url: string, secret?: string) {
    const existing = await prisma.webhookConfig.findUnique({
      where: { organizationId },
    });

    if (existing) {
      return prisma.webhookConfig.update({
        where: { organizationId },
        data: { url, ...(secret && { secret }) },
      });
    } else {
      const webhookSecret = secret || `whsec_${randomBytes(24).toString("hex")}`;
      return prisma.webhookConfig.create({
        data: {
          organizationId,
          url,
          secret: webhookSecret,
        },
      });
    }
  }

  async createDelivery(webhookConfigId: string, payload: unknown, statusCode?: number, responseBody?: string, errorMessage?: string) {
    // Use non-blocking stringify for large payloads to prevent event loop blocking
    let payloadString: string;
    const estimatedSize = JSON.stringify(payload).length;
    
    if (estimatedSize > 256 * 1024) { // 256KB threshold
      const chunks: string[] = [];
      for await (const chunk of nonBlockingStringify(payload, 64 * 1024)) {
        chunks.push(chunk);
      }
      payloadString = chunks.join('');
    } else {
      payloadString = JSON.stringify(payload);
    }
    
    return prisma.webhookDelivery.create({
      data: {
        webhookConfigId,
        payload: payloadString,
        statusCode: statusCode ?? null,
        responseBody: responseBody ?? null,
        errorMessage: errorMessage ?? null,
      },
    });
  }
}

export const webhookRepository = new WebhookRepository();
