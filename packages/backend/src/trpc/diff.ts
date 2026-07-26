/**
 * @file diff.ts
 * @description Highly optimized JSON diffing and hashing utilities for differential synchronization.
 */

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: any;
}

/**
 * Creates a deterministic string representation of any value by sorting object keys.
 */
export function deterministicStringify(val: any): string {
  if (val === null) return 'null';
  if (val === undefined) return 'undefined';
  
  const type = typeof val;
  if (type !== 'object') {
    return JSON.stringify(val);
  }
  
  if (Array.isArray(val)) {
    return '[' + val.map(deterministicStringify).join(',') + ']';
  }
  
  if (val instanceof Date) {
    return JSON.stringify(val.toISOString());
  }

  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => `${JSON.stringify(k)}:${deterministicStringify(val[k])}`).join(',') + '}';
}

/**
 * cyrb53 - extremely fast, collision-resistant 53-bit hash generator.
 * Runs in pure JS without browser/Node crypto API overhead.
 */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Generates an RFC 6902 compliant JSON Patch representing the diff between oldObj and newObj.
 */
export function compare(oldObj: any, newObj: any): PatchOperation[] {
  const patches: PatchOperation[] = [];

  function escapeKey(key: string): string {
    return key.replace(/~/g, '~0').replace(/\//g, '~1');
  }

  function walk(o: any, n: any, path: string) {
    if (o === n) return;

    // If either value is not an object or is null, it's a replacement
    if (typeof o !== 'object' || o === null || typeof n !== 'object' || n === null) {
      patches.push({ op: 'replace', path, value: n });
      return;
    }

    // Check array vs non-array differences
    const oldIsArray = Array.isArray(o);
    const newIsArray = Array.isArray(n);
    if (oldIsArray !== newIsArray) {
      patches.push({ op: 'replace', path, value: n });
      return;
    }

    if (oldIsArray && newIsArray) {
      // Compare arrays by elements
      const minLen = Math.min(o.length, n.length);
      for (let i = 0; i < minLen; i++) {
        walk(o[i], n[i], `${path}/${i}`);
      }
      
      // If old array was longer, elements were removed
      if (o.length > n.length) {
        for (let i = o.length - 1; i >= n.length; i--) {
          patches.push({ op: 'remove', path: `${path}/${i}` });
        }
      } 
      // If new array is longer, elements were added
      else if (n.length > o.length) {
        for (let i = minLen; i < n.length; i++) {
          patches.push({ op: 'add', path: `${path}/${i}`, value: n[i] });
        }
      }
      return;
    }

    // Object comparison
    const oldKeys = Object.keys(o);
    const newKeys = Object.keys(n);

    // Find removed keys
    for (const key of oldKeys) {
      if (!(key in n)) {
        patches.push({ op: 'remove', path: `${path}/${escapeKey(key)}` });
      }
    }

    // Find added or modified keys
    for (const key of newKeys) {
      if (!(key in o)) {
        patches.push({ op: 'add', path: `${path}/${escapeKey(key)}`, value: n[key] });
      } else {
        walk(o[key], n[key], `${path}/${escapeKey(key)}`);
      }
    }
  }

  walk(oldObj, newObj, '');
  return patches;
}
