import { describe, it, expect } from 'vitest';
import { topologicalSort, OperationIntent } from '../dagSorter';

describe('dagSorter - topologicalSort', () => {
  it('should correctly sort linear dependencies', () => {
    const intents: OperationIntent[] = [
      { id: 'C', type: 'claim_payout', params: {}, dependencies: ['B'] },
      { id: 'A', type: 'fund_org', params: {}, dependencies: [] },
      { id: 'B', type: 'allocate_payout', params: {}, dependencies: ['A'] },
    ];

    const sorted = topologicalSort(intents);
    expect(sorted.map(s => s.id)).toEqual(['A', 'B', 'C']);
  });

  it('should correctly sort branching/dag dependencies', () => {
    const intents: OperationIntent[] = [
      { id: 'D', type: 'claim_payout', params: {}, dependencies: ['B', 'C'] },
      { id: 'B', type: 'allocate_payout', params: {}, dependencies: ['A'] },
      { id: 'C', type: 'update_org_metadata', params: {}, dependencies: ['A'] },
      { id: 'A', type: 'fund_org', params: {}, dependencies: [] },
    ];

    const sorted = topologicalSort(intents);
    expect(sorted[0].id).toBe('A');
    expect(sorted[3].id).toBe('D');
    // B and C can be in any order in the middle
    const middle = [sorted[1].id, sorted[2].id];
    expect(middle).toContain('B');
    expect(middle).toContain('C');
  });

  it('should throw an explicit error on cyclic dependencies', () => {
    const intents: OperationIntent[] = [
      { id: 'A', type: 'fund_org', params: {}, dependencies: ['B'] },
      { id: 'B', type: 'allocate_payout', params: {}, dependencies: ['A'] },
    ];

    expect(() => topologicalSort(intents)).toThrow(/Cyclic dependency/);
  });

  it('should throw an explicit error on larger cycles', () => {
    const intents: OperationIntent[] = [
      { id: 'A', type: 'fund_org', params: {}, dependencies: ['C'] },
      { id: 'B', type: 'allocate_payout', params: {}, dependencies: ['A'] },
      { id: 'C', type: 'claim_payout', params: {}, dependencies: ['B'] },
    ];

    expect(() => topologicalSort(intents)).toThrow(/Cyclic dependency/);
  });

  it('should throw an error when a dependency is missing', () => {
    const intents: OperationIntent[] = [
      { id: 'A', type: 'fund_org', params: {}, dependencies: ['NON_EXISTENT'] },
    ];

    expect(() => topologicalSort(intents)).toThrow(/Missing dependency/);
  });
});
