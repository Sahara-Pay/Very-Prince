import Fastify from "fastify";
import { registerGraphQLAdapter } from "../../src/compiler";

// Mock tRPC router caller (Replace with your actual appRouter caller)
const trpcCaller = {
  organization: {
    getById: async (input: { id: string }) => {
      return {
        id: input.id,
        name: "Stellar Foundation",
        balance: 5000,
      };
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

async function bootstrap() {
  const server = Fastify({ logger: true });

  // Register the legacy /graphql compatibility route
  registerGraphQLAdapter(server, trpcCaller);

  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
  await server.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`🚀 Fastify server listening on http://localhost:${PORT}`);
  console.log(`🔗 Legacy GraphQL endpoint active at http://localhost:${PORT}/graphql`);
}

bootstrap().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
