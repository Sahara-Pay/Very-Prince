import { describe, it, expect } from 'vitest';
import { applyPatch } from '../diff';

describe('Frontend diff application', () => {
  it('should apply JSON Patch correctly to reconstruct full state', () => {
    const oldState = { id: 'org_123', name: 'Org V1', admins: ['A'] };
    const patch = [
      { op: 'replace', path: '/name', value: 'Org V2' },
      { op: 'add', path: '/admins/1', value: 'B' }
    ] as any;
    
    const newState = applyPatch(oldState, patch);
    expect(newState).toEqual({ id: 'org_123', name: 'Org V2', admins: ['A', 'B'] });
  });

  it('should handle addition, replacement, and removal of fields', () => {
    const oldObj = { a: 1, b: 2 };
    const patch = [
      { op: 'remove', path: '/b' },
      { op: 'add', path: '/c', value: 3 }
    ] as any;

    const newObj = applyPatch(oldObj, patch);
    expect(newObj).toEqual({ a: 1, c: 3 });
  });
});
