import {
  parse,
  DocumentNode,
  OperationDefinitionNode,
  FieldNode,
  Kind,
  ValueNode,
} from "graphql";

export interface ParsedOperation {
  operationType: "query" | "mutation";
  name?: string;
  rootFields: FieldNode[];
  variableValues: Record<string, any>;
}

export function parseGraphQLQuery(
  queryString: string,
  variables: Record<string, any> = {}
): ParsedOperation {
  let documentAST: DocumentNode;

  try {
    documentAST = parse(queryString);
  } catch (err: any) {
    throw new Error(`Invalid GraphQL Syntax: ${err.message}`);
  }

  const operationDef = documentAST.definitions.find(
    (def): def is OperationDefinitionNode => def.kind === Kind.OPERATION_DEFINITION
  );

  if (!operationDef) {
    throw new Error("No executable operation (query/mutation) found in GraphQL document.");
  }

  const operationType = operationDef.operation;
  if (operationType !== "query" && operationType !== "mutation") {
    throw new Error(`Unsupported operation type: ${operationType}`);
  }

  const rootFields = operationDef.selectionSet.selections.filter(
    (selection): selection is FieldNode => selection.kind === Kind.FIELD
  );

  return {
    operationType,
    name: operationDef.name?.value,
    rootFields,
    variableValues: variables,
  };
}

export function resolveASTValue(node: ValueNode, variables: Record<string, any>): any {
  switch (node.kind) {
    case Kind.VARIABLE:
      return variables[node.name.value];
    case Kind.INT:
      return parseInt(node.value, 10);
    case Kind.FLOAT:
      return parseFloat(node.value);
    case Kind.STRING:
    case Kind.BOOLEAN:
    case Kind.ENUM:
      return node.value;
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return node.values.map((v) => resolveASTValue(v, variables));
    case Kind.OBJECT: {
      const obj: Record<string, any> = {};
      for (const field of node.fields) {
        obj[field.name.value] = resolveASTValue(field.value, variables);
      }
      return obj;
    }
    default:
      throw new Error(`Unsupported AST value kind: ${(node as any).kind}`);
  }
}
