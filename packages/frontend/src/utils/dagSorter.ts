export interface OperationIntent {
  id: string;
  type: 'fund_org' | 'claim_payout' | 'allocate_payout' | 'update_org_metadata';
  params: any;
  dependencies: string[];
}

/**
 * Topologically sorts a list of operation intents based on their dependency declarations.
 * Uses Kahn's algorithm (BFS-based) which also detects cycles.
 * Throws an explicit error if a cycle is found.
 */
export function topologicalSort(intents: OperationIntent[]): OperationIntent[] {
  const adjList: Map<string, string[]> = new Map();
  const inDegree: Map<string, number> = new Map();
  const idToIntent: Map<string, OperationIntent> = new Map();

  // Initialize nodes
  for (const intent of intents) {
    idToIntent.set(intent.id, intent);
    inDegree.set(intent.id, 0);
    adjList.set(intent.id, []);
  }

  // Build the adjacency list and compute in-degrees
  // If B depends on A (i.e. depId is A, intent.id is B), then A must execute before B (A -> B).
  for (const intent of intents) {
    for (const depId of intent.dependencies) {
      if (!idToIntent.has(depId)) {
        throw new Error(`Missing dependency: Operation "${intent.id}" depends on non-existent operation "${depId}"`);
      }
      adjList.get(depId)!.push(intent.id);
      inDegree.set(intent.id, inDegree.get(intent.id)! + 1);
    }
  }

  // Find all nodes with in-degree 0
  const queue: string[] = [];
  for (const [id, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const sorted: OperationIntent[] = [];

  while (queue.length > 0) {
    const u = queue.shift()!;
    const intent = idToIntent.get(u);
    if (intent) {
      sorted.push(intent);
    }

    const neighbors = adjList.get(u) || [];
    for (const v of neighbors) {
      const currentInDegree = inDegree.get(v);
      if (currentInDegree !== undefined) {
        const nextInDegree = currentInDegree - 1;
        inDegree.set(v, nextInDegree);
        if (nextInDegree === 0) {
          queue.push(v);
        }
      }
    }
  }

  // If sorted list does not contain all nodes, there is a cycle
  if (sorted.length < intents.length) {
    const unsortedIds = intents
      .filter((intent) => !sorted.some((s) => s.id === intent.id))
      .map((intent) => intent.id);
    throw new Error(`Cyclic dependency detected involving: ${unsortedIds.join(', ')}`);
  }

  return sorted;
}
