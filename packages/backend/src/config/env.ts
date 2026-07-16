import { z } from 'zod';
import dotenv from 'dotenv';
import { join } from 'path';

dotenv.config({ path: join(__dirname, '../../.env') });

const envSchema = z.object({
  JWT_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().min(1),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  PORT: z.coerce.number().int().default(3001),
  HOST: z.string().default('0.0.0.0'),
  HORIZON_URL: z.string().url().default('https://horizon-testnet.stellar.org'),
  RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  CONTRACT_ID: z.string().default(''),
  DEPLOYMENT_LEDGER: z.coerce.number().int().default(0),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
});

const config = envSchema.parse(process.env);

export const JWT_SECRET = config.JWT_SECRET;
export const RESEND_API_KEY = config.RESEND_API_KEY;
export const FRONTEND_URL = config.FRONTEND_URL;
export const SERVER_PORT = config.PORT;
export const SERVER_HOST = config.HOST;
export const HORIZON_URL = config.HORIZON_URL;
export const RPC_URL = config.RPC_URL;
export const NETWORK_PASSPHRASE = config.NETWORK_PASSPHRASE;
export const CONTRACT_ID = config.CONTRACT_ID;
export const DEPLOYMENT_LEDGER = config.DEPLOYMENT_LEDGER;
