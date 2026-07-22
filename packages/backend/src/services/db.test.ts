import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("db read replica routing", () => {
  const originalReplicaUrl = process.env.DATABASE_REPLICA_URL;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalReplicaUrl === undefined) {
      delete process.env.DATABASE_REPLICA_URL;
    } else {
      process.env.DATABASE_REPLICA_URL = originalReplicaUrl;
    }
  });

  it("extends Prisma with readReplicas when DATABASE_REPLICA_URL is set", async () => {
    process.env.DATABASE_REPLICA_URL =
      "postgresql://reader:password@replica.example.com:5432/very_prince";

    const readReplicasMock = vi.fn((config: { url: string }) => ({
      name: "readReplicas",
      config,
    }));
    const replicaClient = { tag: "replica" };
    const extendMock = vi.fn(() => ({ ...replicaClient, $replica: () => replicaClient }));

    vi.doMock("@prisma/extension-read-replicas", () => ({
      readReplicas: readReplicasMock,
    }));
    vi.doMock("@prisma/client", () => ({
      PrismaClient: class {
        $extends = extendMock;
      },
    }));

    const { prisma, prismaRead } = await import("./db.js");

    expect(readReplicasMock).toHaveBeenCalledWith({
      url: "postgresql://reader:password@replica.example.com:5432/very_prince",
    });
    expect(extendMock).toHaveBeenCalledOnce();
    expect(prismaRead).toBe(replicaClient);
    expect(prisma).toEqual(expect.objectContaining({ $replica: expect.any(Function) }));
  });

  it("falls back to the primary client when DATABASE_REPLICA_URL is unset", async () => {
    delete process.env.DATABASE_REPLICA_URL;

    const extendMock = vi.fn();
    vi.doMock("@prisma/extension-read-replicas", () => ({
      readReplicas: vi.fn(),
    }));
    vi.doMock("@prisma/client", () => ({
      PrismaClient: class {
        $extends = extendMock;
      },
    }));

    const { prisma, prismaRead } = await import("./db.js");

    expect(extendMock).not.toHaveBeenCalled();
    expect(prismaRead).toBe(prisma);
  });
});
