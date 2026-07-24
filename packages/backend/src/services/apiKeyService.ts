/**
 * @file apiKeyService.ts
 * @description Service for managing API keys with secure generation and hashing.
 *
 * This service handles:
 * - Generating secure 32-character alphanumeric API keys
 * - Hashing API keys using SHA-256 for secure storage
 * - Validating API keys against hashed versions
 * - Database operations for API key CRUD operations
 */

import crypto from 'crypto';
import { prisma } from './db.js';
import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────

export interface ApiKeyData {
  id: string;
  organizationId: string;
  name: string | null;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GeneratedApiKey {
  plainTextKey: string; // Only shown once during generation
  apiKey: ApiKeyData;
}

// ─── Service Implementation ────────────────────────────────────────────────

class ApiKeyService {
  private prisma = prisma;

  /**
   * Generate a secure 32-character alphanumeric API key
   * Uses crypto.randomBytes for cryptographically secure random generation
   */
  generatePlainTextApiKey(): string {
    const bytes = crypto.randomBytes(16); // 16 bytes = 128 bits of entropy
    return bytes
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '') // Remove non-alphanumeric characters
      .substring(0, 32); // Ensure exactly 32 characters
  }

  /**
   * Hash an API key using SHA-256 for secure storage
   */
  private hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Generate a new API key for an organization
   * Returns the plain text key (only shown once) and the stored API key data
   */
  async generateApiKey(organizationId: string, name?: string): Promise<GeneratedApiKey> {
    const plainTextKey = this.generatePlainTextApiKey();
    const hashedKey = this.hashApiKey(plainTextKey);

    // Check if this exact key already exists (extremely unlikely but possible)
    const existingKey = await this.prisma.apiKey.findFirst({
      where: {
        organizationId,
        hashedKey,
        isActive: true,
      },
    });

    if (existingKey) {
      // In the extremely unlikely case of collision, generate again
      return this.generateApiKey(organizationId, name);
    }

    const apiKey = await this.prisma.apiKey.create({
      data: {
        organizationId,
        hashedKey,
        name: name ?? null,
        isActive: true,
      },
    });

    logger.info(
      { organizationId, apiKeyId: apiKey.id, name: apiKey.name },
      "API key generated"
    );

    return {
      plainTextKey,
      apiKey: {
        id: apiKey.id,
        organizationId: apiKey.organizationId,
        name: apiKey.name,
        isActive: apiKey.isActive,
        lastUsedAt: apiKey.lastUsedAt,
        createdAt: apiKey.createdAt,
        updatedAt: apiKey.updatedAt,
      },
    };
  }

  /**
   * Validate an API key and return the associated API key data
   * Updates the lastUsedAt timestamp on successful validation
   */
  async validateApiKey(apiKey: string): Promise<ApiKeyData | null> {
    const hashedKey = this.hashApiKey(apiKey);

    const keyRecord = await this.prisma.apiKey.findFirst({
      where: {
        hashedKey,
        isActive: true,
      },
    });

    if (!keyRecord) {
      return null;
    }

    // Update last used timestamp
    await this.prisma.apiKey.update({
      where: { id: keyRecord.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      id: keyRecord.id,
      organizationId: keyRecord.organizationId,
      name: keyRecord.name,
      isActive: keyRecord.isActive,
      lastUsedAt: keyRecord.lastUsedAt,
      createdAt: keyRecord.createdAt,
      updatedAt: keyRecord.updatedAt,
    };
  }

  /**
   * List all API keys for an organization (excluding the actual keys)
   */
  async listApiKeys(organizationId: string): Promise<ApiKeyData[]> {
    const apiKeys = await this.prisma.apiKey.findMany({
      where: {
        organizationId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return apiKeys.map(key => ({
      id: key.id,
      organizationId: key.organizationId,
      name: key.name,
      isActive: key.isActive,
      lastUsedAt: key.lastUsedAt,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
    }));
  }

  /**
   * Revoke an API key (soft delete by setting isActive to false)
   */
  async revokeApiKey(organizationId: string, apiKeyId: string): Promise<boolean> {
    const result = await this.prisma.apiKey.updateMany({
      where: {
        id: apiKeyId,
        organizationId, // Ensure the key belongs to the organization
      },
      data: {
        isActive: false,
      },
    });

    const revoked = result.count > 0;
    if (revoked) {
      logger.info({ organizationId, apiKeyId }, "API key revoked");
    } else {
      logger.warn({ organizationId, apiKeyId }, "API key revocation requested but no matching key found");
    }

    return revoked;
  }

  /**
   * Update the name of an API key
   */
  async updateApiKeyName(organizationId: string, apiKeyId: string, name: string): Promise<boolean> {
    const result = await this.prisma.apiKey.updateMany({
      where: {
        id: apiKeyId,
        organizationId, // Ensure the key belongs to the organization
      },
      data: {
        name,
      },
    });

    return result.count > 0;
  }
}

// ─── Export ─────────────────────────────────────────────────────────────────

export { ApiKeyService };
export default ApiKeyService;
