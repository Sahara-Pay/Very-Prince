/**
 * @file jwtCapabilityMiddleware.ts
 * @description Type-safe tRPC middleware for JWT capability validation.
 *
 * This middleware provides JWT capability validation for tRPC procedures:
 * - Validates JWT capability tokens without blocking
 * - Checks permissions and resource access
 * - Maintains type safety across the tRPC boundary
 * - Integrates with stale cache for performance
 *
 * IMPORTANT: Chain `.input()` before `.use(withJwtCapability(...))` so parsed input
 * is available when building capability checks.
 */

import { jwtCapabilityParser, type PermissionCheckResult } from "../services/jwtCapabilityParser.js";
import { logger } from "../utils/logger.js";
import { t } from "./trpc.js";

/**
 * JWT capability middleware options
 */
export interface JwtCapabilityMiddlewareOptions {
  /**
   * Required permissions for the procedure.
   * If provided, all permissions must be present.
   */
  permissions?: string[];
  /**
   * Required resource access.
   * If provided, the capability must have access to this resource.
   */
  resource?: string;
  /**
   * Whether to require any of the permissions (OR logic) instead of all (AND logic).
   * Default: false (requires all permissions)
   */
  requireAny?: boolean;
  /**
   * Custom function to extract JWT token from context.
   * Default: extracts from Authorization header
   */
  tokenExtractor?: (ctx: any) => string | undefined;
}

/**
 * Wraps a tRPC procedure with JWT capability validation.
 *
 * @param options - Capability validation options
 * @returns tRPC middleware
 */
export function withJwtCapability(options: JwtCapabilityMiddlewareOptions = {}) {
  const {
    permissions = [],
    resource,
    requireAny = false,
    tokenExtractor = (ctx) => {
      // Default: extract from Authorization header
      const authHeader = ctx.req?.headers?.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
      }
      return undefined;
    },
  } = options;

  return t.middleware(async ({ next, ctx }: { next: any; ctx: any }) => {
    // Extract JWT token from context
    const token = tokenExtractor(ctx);

    if (!token) {
      logger.warn("JWT capability token not found in request");
      throw new Error("Unauthorized: JWT capability token required");
    }

    try {
      // Check permissions if specified
      if (permissions.length > 0) {
        let permissionCheck: PermissionCheckResult;

        if (requireAny) {
          permissionCheck = await jwtCapabilityParser.hasAnyPermission(token, permissions);
        } else {
          // Check each permission (AND logic)
          for (const permission of permissions) {
            permissionCheck = await jwtCapabilityParser.hasPermission(token, permission);
            if (!permissionCheck.granted) {
              logger.warn(
                { permission, reason: permissionCheck.reason },
                "JWT capability permission check failed"
              );
              throw new Error(`Forbidden: ${permissionCheck.reason}`);
            }
          }
          // All permissions granted
          permissionCheck = { granted: true };
        }

        if (!permissionCheck.granted) {
          logger.warn(
            { permissions, reason: permissionCheck.reason },
            "JWT capability permission check failed"
          );
          throw new Error(`Forbidden: ${permissionCheck.reason}`);
        }
      }

      // Check resource access if specified
      if (resource) {
        const resourceCheck = await jwtCapabilityParser.hasResourceAccess(token, resource);
        if (!resourceCheck.granted) {
          logger.warn(
            { resource, reason: resourceCheck.reason },
            "JWT capability resource access check failed"
          );
          throw new Error(`Forbidden: ${resourceCheck.reason}`);
        }
      }

      // Parse capability and attach to context
      const capability = await jwtCapabilityParser.parseCapability(token);

      if (!capability.isValid) {
        logger.warn(
          { errors: capability.errors },
          "JWT capability is invalid or expired"
        );
        throw new Error("Unauthorized: Invalid or expired capability");
      }

      // Attach capability to context for use in procedures
      return next({
        ...ctx,
        capability,
      });
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("Unauthorized") || error.message.startsWith("Forbidden"))) {
        throw error;
      }
      
      logger.error({ err: error }, "JWT capability validation failed");
      throw new Error("Unauthorized: Failed to validate JWT capability");
    }
  });
}

/**
 * Wraps a tRPC procedure with optional JWT capability validation.
 * If no token is provided, the procedure proceeds without capability checks.
 * If a token is provided, it is validated.
 *
 * @param options - Capability validation options
 * @returns tRPC middleware
 */
export function withOptionalJwtCapability(options: JwtCapabilityMiddlewareOptions = {}) {
  const {
    permissions = [],
    resource,
    requireAny = false,
    tokenExtractor = (ctx) => {
      const authHeader = ctx.req?.headers?.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
      }
      return undefined;
    },
  } = options;

  return t.middleware(async ({ next, ctx }: { next: any; ctx: any }) => {
    const token = tokenExtractor(ctx);

    // If no token, proceed without capability checks
    if (!token) {
      return next(ctx);
    }

    try {
      // Check permissions if specified
      if (permissions.length > 0) {
        let permissionCheck: PermissionCheckResult;

        if (requireAny) {
          permissionCheck = await jwtCapabilityParser.hasAnyPermission(token, permissions);
        } else {
          for (const permission of permissions) {
            permissionCheck = await jwtCapabilityParser.hasPermission(token, permission);
            if (!permissionCheck.granted) {
              logger.warn(
                { permission, reason: permissionCheck.reason },
                "JWT capability permission check failed"
              );
              throw new Error(`Forbidden: ${permissionCheck.reason}`);
            }
          }
          permissionCheck = { granted: true };
        }

        if (!permissionCheck.granted) {
          logger.warn(
            { permissions, reason: permissionCheck.reason },
            "JWT capability permission check failed"
          );
          throw new Error(`Forbidden: ${permissionCheck.reason}`);
        }
      }

      // Check resource access if specified
      if (resource) {
        const resourceCheck = await jwtCapabilityParser.hasResourceAccess(token, resource);
        if (!resourceCheck.granted) {
          logger.warn(
            { resource, reason: resourceCheck.reason },
            "JWT capability resource access check failed"
          );
          throw new Error(`Forbidden: ${resourceCheck.reason}`);
        }
      }

      // Parse capability and attach to context
      const capability = await jwtCapabilityParser.parseCapability(token);

      if (!capability.isValid) {
        logger.warn(
          { errors: capability.errors },
          "JWT capability is invalid or expired"
        );
        throw new Error("Unauthorized: Invalid or expired capability");
      }

      return next({
        ...ctx,
        capability,
      });
    } catch (error) {
      if (error instanceof Error && (error.message.startsWith("Unauthorized") || error.message.startsWith("Forbidden"))) {
        throw error;
      }
      
      logger.error({ err: error }, "JWT capability validation failed");
      throw new Error("Unauthorized: Failed to validate JWT capability");
    }
  });
}

/**
 * Helper to extract JWT token from Authorization header
 */
export function extractBearerToken(ctx: any): string | undefined {
  const authHeader = ctx.req?.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  return undefined;
}

/**
 * Helper to extract JWT token from query parameter
 */
export function extractQueryToken(ctx: any, paramName: string = "token"): string | undefined {
  return ctx.req?.query?.[paramName] as string | undefined;
}

/**
 * Helper to extract JWT token from request body
 */
export function extractBodyToken(ctx: any, fieldName: string = "token"): string | undefined {
  return ctx.req?.body?.[fieldName] as string | undefined;
}
