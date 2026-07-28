import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: mockLogger,
}));

import { SagaCompensationError, SagaOrchestrator, type SagaStep } from "./sagaOrchestrator.js";

type TestState = {
  walletAddress: string;
  githubUsername: string;
  failFinalStep?: boolean;
};

type MockPrisma = {
  $transaction: ReturnType<typeof vi.fn>;
  sagaAuditLog: { create: ReturnType<typeof vi.fn> };
  web3Identity: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  githubProfile: { create: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
};

function createMockPrisma(): MockPrisma {
  const mockPrisma = {
    sagaAuditLog: { create: vi.fn().mockResolvedValue({}) },
    web3Identity: {
      create: vi.fn().mockResolvedValue({ id: "identity-1" }),
      delete: vi.fn().mockResolvedValue({ id: "identity-1" }),
    },
    githubProfile: {
      create: vi.fn().mockResolvedValue({ id: "profile-1" }),
      delete: vi.fn().mockResolvedValue({ id: "profile-1" }),
    },
    $transaction: vi.fn(),
  };

  mockPrisma.$transaction.mockImplementation((callback) => callback(mockPrisma));
  return mockPrisma;
}

function createIdentityLinkSteps(): SagaStep<TestState>[] {
  return [
    {
      name: "CREATE_WEB3_IDENTITY",
      execute: async ({ prisma, state }) => {
        const db = prisma as unknown as MockPrisma;

        return db.web3Identity.create({
          data: { walletAddress: state.walletAddress },
        });
      },
      compensate: async ({ prisma }, identity) => {
        const db = prisma as unknown as MockPrisma;
        const createdIdentity = identity as { id: string };

        await db.web3Identity.delete({ where: { id: createdIdentity.id } });
      },
    },
    {
      name: "CREATE_GITHUB_PROFILE",
      execute: async ({ prisma, state }) => {
        const db = prisma as unknown as MockPrisma;

        return db.githubProfile.create({
          data: { username: state.githubUsername },
        });
      },
      compensate: async ({ prisma }, profile) => {
        const db = prisma as unknown as MockPrisma;
        const createdProfile = profile as { id: string };

        await db.githubProfile.delete({ where: { id: createdProfile.id } });
      },
    },
    {
      name: "LINK_PROFILE",
      execute: async ({ state }) => {
        if (state.failFinalStep) {
          throw new Error("tRPC profile link failed");
        }

        return { linked: true };
      },
    },
  ];
}

describe("SagaOrchestrator", () => {
  let mockPrisma: MockPrisma;
  let orchestrator: SagaOrchestrator<TestState>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = createMockPrisma();
    orchestrator = new SagaOrchestrator(mockPrisma as never);
  });

  it("compensates completed database mutations in reverse order when a later tRPC step fails", async () => {
    await expect(
      orchestrator.run({
        sagaId: "saga-identity-link-1",
        state: {
          walletAddress: "GCOMZZY",
          githubUsername: "comzzy-comzzy",
          failFinalStep: true,
        },
        steps: createIdentityLinkSteps(),
      })
    ).rejects.toThrow("tRPC profile link failed");

    expect(mockPrisma.githubProfile.delete).toHaveBeenCalledWith({ where: { id: "profile-1" } });
    expect(mockPrisma.web3Identity.delete).toHaveBeenCalledWith({ where: { id: "identity-1" } });
    expect(mockPrisma.githubProfile.delete.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.web3Identity.delete.mock.invocationCallOrder[0]
    );
  });

  it("logs explicit audit transitions for failure and compensation", async () => {
    await expect(
      orchestrator.run({
        sagaId: "saga-identity-link-2",
        state: {
          walletAddress: "GCOMZZY",
          githubUsername: "comzzy-comzzy",
          failFinalStep: true,
        },
        steps: createIdentityLinkSteps(),
      })
    ).rejects.toThrow("tRPC profile link failed");

    const auditEvents = mockPrisma.sagaAuditLog.create.mock.calls.map((call) => call[0].data.event);

    expect(auditEvents).toContain("SAGA_STARTED");
    expect(auditEvents).toContain("STEP_STARTED");
    expect(auditEvents).toContain("STEP_COMPLETED");
    expect(auditEvents).toContain("SAGA_COMPENSATING");
    expect(auditEvents).toContain("COMPENSATION_STARTED");
    expect(auditEvents).toContain("COMPENSATION_COMPLETED");
    expect(auditEvents).toContain("SAGA_FAILED");
  });

  it("wraps the original error when a compensation handler fails", async () => {
    mockPrisma.githubProfile.delete.mockRejectedValueOnce(new Error("delete failed"));

    await expect(
      orchestrator.run({
        sagaId: "saga-identity-link-3",
        state: {
          walletAddress: "GCOMZZY",
          githubUsername: "comzzy-comzzy",
          failFinalStep: true,
        },
        steps: createIdentityLinkSteps(),
      })
    ).rejects.toMatchObject({
      name: "SagaCompensationError",
      originalError: expect.objectContaining({ message: "tRPC profile link failed" }),
      compensationErrors: [expect.objectContaining({ message: "delete failed" })],
    } satisfies Partial<SagaCompensationError>);

    expect(mockPrisma.web3Identity.delete).toHaveBeenCalledWith({ where: { id: "identity-1" } });
  });
});
