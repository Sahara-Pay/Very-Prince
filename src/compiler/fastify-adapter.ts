import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { executeGraphQLViaTRPC } from "./executor";

export interface GraphQLRequestBody {
  query?: string;
  variables?: Record<string, any>;
  operationName?: string;
}

export function registerGraphQLAdapter(server: FastifyInstance, trpcCaller: any) {
  server.post(
    "/graphql",
    async (request: FastifyRequest<{ Body: GraphQLRequestBody }>, reply: FastifyReply) => {
      const { query, variables } = request.body || {};

      if (!query) {
        return reply.status(400).send({
          errors: [{ message: "Missing "query" in request body." }],
        });
      }

      try {
        const result = await executeGraphQLViaTRPC(query, variables || {}, trpcCaller);
        return reply.status(200).send(result);
      } catch (err: any) {
        request.log.error(err, "GraphQL Transpiler execution error");
        return reply.status(500).send({
          errors: [
            {
              message: err.message || "Internal error executing transpiled GraphQL operation.",
            },
          ],
        });
      }
    }
  );
}
