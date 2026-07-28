export interface GraphNode {
  id: string;
  name: string;
  type: 'org' | 'maintainer' | 'pool' | 'donor';
  amountXlm: number;
  payoutCount: number;
  x?: number;
  y?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  amountXlm: number;
  timestamp: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const ORG_NAMES = [
  "Stellar Soroban Registry",
  "OpenSource SAC Guild",
  "Vesper Ecosystem",
  "Orbit Payout Pool",
  "Lumen Infrastructure",
  "Soroban Smart Devs",
  "Rust Maintainers Co",
  "Stellar Horizon Guild",
  "Freighter Integrations",
  "Crypto Multi-Sig Escrow",
];

/**
 * Generate a large 2D dependency graph of organization funding.
 * Default generates 500 nodes and 10,000+ edges representing historical payouts.
 */
export function generateFundingGraphData(
  nodeCount = 500,
  edgeCount = 10000
): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const orgCount = Math.min(10, Math.floor(nodeCount * 0.05));
  const poolCount = Math.floor(nodeCount * 0.1);
  const donorCount = Math.floor(nodeCount * 0.15);
  const maintainerCount = nodeCount - orgCount - poolCount - donorCount;

  // 1. Orgs
  for (let i = 0; i < orgCount; i++) {
    nodes.push({
      id: `org-${i}`,
      name: ORG_NAMES[i % ORG_NAMES.length] || `Org ${i}`,
      type: "org",
      amountXlm: Math.round(50000 + Math.random() * 200000),
      payoutCount: Math.round(500 + Math.random() * 2000),
    });
  }

  // 2. Pools
  for (let i = 0; i < poolCount; i++) {
    nodes.push({
      id: `pool-${i}`,
      name: `SAC Pool #${i + 101}`,
      type: "pool",
      amountXlm: Math.round(10000 + Math.random() * 50000),
      payoutCount: Math.round(200 + Math.random() * 800),
    });
  }

  // 3. Donors
  for (let i = 0; i < donorCount; i++) {
    nodes.push({
      id: `donor-${i}`,
      name: `Donor G${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
      type: "donor",
      amountXlm: Math.round(1000 + Math.random() * 25000),
      payoutCount: Math.round(50 + Math.random() * 300),
    });
  }

  // 4. Maintainers
  for (let i = 0; i < maintainerCount; i++) {
    nodes.push({
      id: `maintainer-${i}`,
      name: `Maintainer G${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      type: "maintainer",
      amountXlm: Math.round(50 + Math.random() * 5000),
      payoutCount: Math.round(5 + Math.random() * 100),
    });
  }

  // Generate 10,000+ edges connecting funding flows: Donors -> Orgs/Pools -> Maintainers
  const now = Date.now();
  for (let i = 0; i < edgeCount; i++) {
    let sourceIdx: number;
    let targetIdx: number;

    const roll = Math.random();
    if (roll < 0.3) {
      // Donor -> Pool or Org
      sourceIdx = orgCount + poolCount + Math.floor(Math.random() * donorCount);
      targetIdx = Math.floor(Math.random() * (orgCount + poolCount));
    } else if (roll < 0.6) {
      // Pool -> Org
      sourceIdx = orgCount + Math.floor(Math.random() * poolCount);
      targetIdx = Math.floor(Math.random() * orgCount);
    } else {
      // Org or Pool -> Maintainer
      sourceIdx = Math.floor(Math.random() * (orgCount + poolCount));
      targetIdx =
        orgCount + poolCount + donorCount + Math.floor(Math.random() * maintainerCount);
    }

    const sourceNode = nodes[sourceIdx];
    const targetNode = nodes[targetIdx];

    if (sourceNode && targetNode && sourceNode.id !== targetNode.id) {
      edges.push({
        id: `edge-${i}`,
        source: sourceNode.id,
        target: targetNode.id,
        amountXlm: Math.round((5 + Math.random() * 500) * 100) / 100,
        timestamp: now - Math.floor(Math.random() * 86400000 * 30),
      });
    }
  }

  return { nodes, edges };
}
