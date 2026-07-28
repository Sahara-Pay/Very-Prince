import { FieldNode } from "graphql";
import { parseGraphQLQuery } from "./parser";
import { mapFieldToTRPCCall, MappedTRPCCall } from "./mapper";

async function resolveChildSelections(
  trpcCaller: any,
  parentResult: any,
  childFields: FieldNode[],
  variables: Record<string, any>
): Promise<any> {
  if (!parentResult || typeof parentResult !== "object") {
    return parentResult;
  }

  if (Array.isArray(parentResult)) {
    return Promise.all(
      parentResult.map((item) =>
        resolveChildSelections(trpcCaller, item, childFields, variables)
      )
    );
  }

  const resolvedObject: Record<string, any> = { ...parentResult };

  for (const childNode of childFields) {
    const childName = childNode.name.value;
    const outputKey = childNode.alias ? childNode.alias.value : childName;

    if (childNode.arguments && childNode.arguments.length > 0) {
      const mapped = mapFieldToTRPCCall(childNode, variables);
      const input = { ...mapped.inputPayload, parentId: parentResult.id };
      
      const procedureFn = mapped.procedurePath.split(".").reduce((acc, key) => acc[key], trpcCaller);
      let childResult = await procedureFn(input);

      if (mapped.childSelections && mapped.childSelections.length > 0) {
        childResult = await resolveChildSelections(
          trpcCaller,
          childResult,
          mapped.childSelections,
          variables
        );
      }
      resolvedObject[outputKey] = childResult;
    } else if (childNode.selectionSet) {
      const nestedSelections = childNode.selectionSet.selections.filter(
        (sel): sel is FieldNode => sel.kind === "Field"
      );

      if (resolvedObject[childName] !== undefined) {
        resolvedObject[outputKey] = await resolveChildSelections(
          trpcCaller,
          resolvedObject[childName],
          nestedSelections,
          variables
        );
      }
    }
  }

  return resolvedObject;
}

export async function executeGraphQLViaTRPC(
  queryString: string,
  variables: Record<string, any> = {},
  trpcCaller: any
): Promise<{ data: Record<string, any> }> {
  const parsed = parseGraphQLQuery(queryString, variables);
  const dataResponse: Record<string, any> = {};

  for (const rootField of parsed.rootFields) {
    const mappedCall: MappedTRPCCall = mapFieldToTRPCCall(rootField, parsed.variableValues);

    const procedureParts = mappedCall.procedurePath.split(".");
    let procedureFn = trpcCaller;
    for (const part of procedureParts) {
      if (!procedureFn[part]) {
        throw new Error(`tRPC procedure path "${mappedCall.procedurePath}" not found on appRouter caller.`);
      }
      procedureFn = procedureFn[part];
    }

    let result = await procedureFn(mappedCall.inputPayload);

    if (mappedCall.childSelections && mappedCall.childSelections.length > 0) {
      result = await resolveChildSelections(
        trpcCaller,
        result,
        mappedCall.childSelections,
        parsed.variableValues
      );
    }

    dataResponse[mappedCall.outputKey] = result;
  }

  return { data: dataResponse };
}
