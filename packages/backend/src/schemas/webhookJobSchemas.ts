import { z } from "zod";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WebhookEventData = Record<string, JsonValue>;

const jsonLiteralSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([jsonLiteralSchema, z.array(jsonValueSchema), z.record(jsonValueSchema)]),
);

export const webhookJobDataSchema = z.object({
  organizationId: z.string().trim().min(1).max(191),
  event: z.string().trim().min(1).max(128),
  data: z.record(jsonValueSchema),
}).strict();

export type WebhookJobData = z.infer<typeof webhookJobDataSchema>;

export interface WebhookDispatchPayload {
  id: string;
  event: string;
  timestamp: string;
  organizationId: string;
  data: WebhookEventData;
}
