import { executeGraphQLViaTRPC } from "../executor";

describe("GraphQL-to-tRPC AST Transpiler End-to-End", () => {
  const mockTRPCCaller = {
    organization: {
      getById: async (input: { id: string }) => {
        if (input.id === "org_stellar") {
          return {
            id: "org_stellar",
            name: "Stellar Foundation",
            balance: 5000,
          };
        }
        throw new Error("Organization not found");
      },
    },
    payout: {
      claim: async (input: { maintainerId: string }) => {
        return {
          success: true,
          txHash: "0xabc123789",
          amountClaimed: 250,
        };
      },
    },
  };

  it("transpiles legacy GraphQL query into internal tRPC caller", async () => {
    const query = `
      query GetOrg($orgId: String!) {
        orgAlias: organization(id: $orgId) {
          id
          name
          balance
        }
      }
    `;

    const result = await executeGraphQLViaTRPC(query, { orgId: "org_stellar" }, mockTRPCCaller);

    expect(result).toEqual({
      data: {
        orgAlias: {
          id: "org_stellar",
          name: "Stellar Foundation",
          balance: 5000,
        },
      },
    });
  });

  it("transpiles legacy GraphQL mutation into tRPC procedure", async () => {
    const mutation = `
      mutation Claim($mId: String!) {
        claimPayout(maintainerId: $mId) {
          success
          txHash
          amountClaimed
        }
      }
    `;

    const result = await executeGraphQLViaTRPC(mutation, { mId: "m_001" }, mockTRPCCaller);

    expect(result).toEqual({
      data: {
        claimPayout: {
          success: true,
          txHash: "0xabc123789",
          amountClaimed: 250,
        },
      },
    });
  });
});
