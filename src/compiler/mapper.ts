import { FieldNode } from "graphql";
import { resolveASTValue } from "./parser";

export interface TRPCProcedureMapping {
  procedurePath: string;
  type: "query" | "mutation";
}

export const FIELD_TO_TRPC_MAP: Record<string, TRPCProcedureMapping> = {
  organization: { procedurePath: "organization.getById", type: "query" },
  organizations: { procedurePath: "organization.list", type: "query" },
  maintainer: { procedurePath: "maintainer.getById", type: "query" },
  fundOrganization: { procedurePath: "organization.fund", type: "mutation" },
  claimPayout: { procedurePath: "payout.claim", type: "mutation" },
};

export interface MappedTRPCCall {
  outputKey: string;
  procedurePath: string;
  inputPayload: Record<string, any>;
  childSelections?: FieldNode[];
}

export function mapFieldToTRPCCall(
  fieldNode: FieldNode,
  variables: Record<string, any>
): MappedTRPCCall {
  const originalFieldName = fieldNode.name.value;
  const outputKey = fieldNode.alias ? fieldNode.alias.value : originalFieldName;

  const mapping = FIELD_TO_TRPC_MAP[originalFieldName];
  if (!mapping) {
    throw new Error(`Unmapped GraphQL field: "${originalFieldName}". No corresponding tRPC procedure configured.`);
  }

  const inputPayload: Record<string, any> = {};
  if (fieldNode.arguments && fieldNode.arguments.length > 0) {
    for (const arg of fieldNode.arguments) {
      inputPayload[arg.name.value] = resolveASTValue(arg.value, variables);
    }
  }

  const childSelections = fieldNode.selectionSet?.selections.filter(
    (sel): sel is FieldNode => sel.kind === "Field"
  );

  return {
    outputKey,
    procedurePath: mapping.procedurePath,
    inputPayload,
    childSelections,
  };
}
