import { z } from 'zod';
import dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(__dirname, '../../.env') });

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }

  return value;
}, z.boolean());

const envSchema = z.object({
  JWT_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().min(1),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().default(3001),
  HOST: z.string().default('0.0.0.0'),
  HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),
  RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  HORIZON_FALLBACK_URL: z.string().url().optional(),
  NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  CONTRACT_ID: z.string().default(''),
  DEPLOYMENT_LEDGER: z.coerce.number().int().default(0),
  DATABASE_URL: z.string().optional(),
  DATABASE_REPLICA_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  AWS_REGION: z.string().min(1).default(process.env["AWS_REGION"] ?? process.env["AWS_DEFAULT_REGION"] ?? "us-east-1"),
  WEBHOOK_QUEUE_PROVIDER: z.enum(["bullmq", "sqs"]).optional(),
  WEBHOOK_QUEUE_URL: z.string().url().optional(),
  WEBHOOK_DLQ_URL: z.string().url().optional(),
  WEBHOOK_DLQ_ENABLED: booleanFromEnv.default(false),
  WEBHOOK_QUEUE_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  WEBHOOK_QUEUE_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(5),
  WEBHOOK_QUEUE_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  WEBHOOK_QUEUE_VISIBILITY_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
});

const config = envSchema.parse(process.env);
const webhookQueueProvider = config.WEBHOOK_QUEUE_PROVIDER ?? (config.WEBHOOK_QUEUE_URL ? "sqs" : "bullmq");

if (webhookQueueProvider === "sqs" && !config.WEBHOOK_QUEUE_URL) {
  throw new Error("WEBHOOK_QUEUE_URL is required when WEBHOOK_QUEUE_PROVIDER=sqs");
}

if (config.WEBHOOK_DLQ_ENABLED && !config.WEBHOOK_DLQ_URL) {
  throw new Error("WEBHOOK_DLQ_URL is required when WEBHOOK_DLQ_ENABLED=true");
}

export const JWT_SECRET = config.JWT_SECRET;
export const RESEND_API_KEY = config.RESEND_API_KEY;
export const FRONTEND_URL = config.FRONTEND_URL;
export const SERVER_PORT = config.PORT;
export const SERVER_HOST = config.HOST;
export const HORIZON_URL = config.HORIZON_URL;
export const RPC_URL = config.RPC_URL;
export const HORIZON_FALLBACK_URL = config.HORIZON_FALLBACK_URL;
export const NETWORK_PASSPHRASE = config.NETWORK_PASSPHRASE;
export const CONTRACT_ID = config.CONTRACT_ID;
export const DEPLOYMENT_LEDGER = config.DEPLOYMENT_LEDGER;
export const DATABASE_URL = config.DATABASE_URL;
export const DATABASE_REPLICA_URL = config.DATABASE_REPLICA_URL;
export const AWS_REGION = config.AWS_REGION;
export const WEBHOOK_QUEUE_PROVIDER = webhookQueueProvider;
export const WEBHOOK_QUEUE_URL = config.WEBHOOK_QUEUE_URL;
export const WEBHOOK_DLQ_URL = config.WEBHOOK_DLQ_URL;
export const WEBHOOK_DLQ_ENABLED = config.WEBHOOK_DLQ_ENABLED;
export const WEBHOOK_QUEUE_MAX_RECEIVE_COUNT = config.WEBHOOK_QUEUE_MAX_RECEIVE_COUNT;
export const WEBHOOK_QUEUE_MAX_MESSAGES = config.WEBHOOK_QUEUE_MAX_MESSAGES;
export const WEBHOOK_QUEUE_WAIT_TIME_SECONDS = config.WEBHOOK_QUEUE_WAIT_TIME_SECONDS;
export const WEBHOOK_QUEUE_VISIBILITY_TIMEOUT_SECONDS = config.WEBHOOK_QUEUE_VISIBILITY_TIMEOUT_SECONDS;
