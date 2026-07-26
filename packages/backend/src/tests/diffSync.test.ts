import { describe, it, expect } from 'vitest';
import { compare, cyrb53, deterministicStringify } from '../trpc/diff.js';
import { applyPatch } from '../../../frontend/src/trpc/diff.js';

describe('tRPC Differential Sync Hashing & Diffing', () => {
  it('should generate deterministic serialization regardless of key ordering', () => {
    const objA = { z: 1, a: 2, m: { y: 3, x: 4 } };
    const objB = { a: 2, z: 1, m: { x: 4, y: 3 } };
    expect(deterministicStringify(objA)).toBe(deterministicStringify(objB));
    expect(cyrb53(deterministicStringify(objA))).toBe(cyrb53(deterministicStringify(objB)));
  });

  it('should compute and apply diffs correctly', () => {
    const oldState = {
      id: 'org_1',
      name: 'Old Name',
      admins: ['addr_1', 'addr_2'],
      budget: { stroops: '1000' }
    };
    
    const newState = {
      id: 'org_1',
      name: 'New Name',
      admins: ['addr_1', 'addr_3'],
      budget: { stroops: '2000' },
      newField: 'hello'
    };
    
    const patch = compare(oldState, newState);
    expect(patch.length).toBeGreaterThan(0);
    
    const reconstructed = applyPatch(oldState, patch);
    expect(reconstructed).toEqual(newState);
  });

  it('should handle addition, replacement, and removal in arrays', () => {
    const oldArray = [1, 2, 3];
    const newArray = [1, 4, 3, 5];
    
    const patch = compare(oldArray, newArray);
    const reconstructed = applyPatch(oldArray, patch);
    expect(reconstructed).toEqual(newArray);
  });
});
