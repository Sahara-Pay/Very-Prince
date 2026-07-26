import { PrismaClient } from "@prisma/client";
import { readReplicas } from "@prisma/extension-read-replicas";

const replicaUrl = process.env.DATABASE_REPLICA_URL;

const basePrisma = new PrismaClient();

const extendedPrisma = replicaUrl
  ? basePrisma.$extends(
      readReplicas({
        url: replicaUrl,
      }),
    )
  : basePrisma;

/**
 * Primary Prisma client with automatic read/write routing when a replica is configured.
 * Cast to PrismaClient preserves end-to-end type safety for model operations.
 */
export const prisma = extendedPrisma as unknown as PrismaClient;

/**
 * Analytical read client. Explicitly targets the Aurora read replica when
 * `DATABASE_REPLICA_URL` is set; otherwise uses the primary connection.
 */
export const prismaRead: PrismaClient =
  replicaUrl && "$replica" in extendedPrisma
    ? ((extendedPrisma as unknown as PrismaClient & { $replica: () => PrismaClient }).$replica())
    : (extendedPrisma as unknown as PrismaClient);
