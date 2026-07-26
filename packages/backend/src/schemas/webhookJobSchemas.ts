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
  organizationId: z.string().min(1),
  event: z.string().min(1),
  data: z.record(jsonValueSchema),
});

export type WebhookJobData = z.infer<typeof webhookJobDataSchema>;

export interface WebhookDispatchPayload {
  id: string;
  event: string;
  timestamp: string;
  organizationId: string;
  data: WebhookEventData;
}
