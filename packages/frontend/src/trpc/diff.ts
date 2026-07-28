/**
 * @file diff.ts
 * @description JSON Patch (RFC 6902) client application logic for differential synchronization.
 */

export interface PatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: any;
}

/**
 * Applies a list of RFC 6902 JSON patch operations to a base object and returns the modified copy.
 */
export function applyPatch(obj: any, patches: PatchOperation[]): any {
  if (obj === null || obj === undefined) {
    throw new Error('Cannot apply patch to null or undefined');
  }

  // Deep clone to prevent mutations of the original cached object
  const newObj = JSON.parse(JSON.stringify(obj));

  for (const patch of patches) {
    if (patch.path === '') {
      if (patch.op === 'replace') {
        return patch.value;
      }
      continue;
    }

    const parts = patch.path.split('/').slice(1).map(unescapeKey);
    let current = newObj;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (current[part] === undefined || current[part] === null) {
        // Automatically construct nested paths if missing (resiliency fallback)
        current[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      }
      current = current[part];
    }

    const lastPart = parts[parts.length - 1];
    
    if (patch.op === 'add') {
      if (Array.isArray(current)) {
        const index = parseInt(lastPart, 10);
        current.splice(index, 0, patch.value);
      } else {
        current[lastPart] = patch.value;
      }
    } else if (patch.op === 'remove') {
      if (Array.isArray(current)) {
        const index = parseInt(lastPart, 10);
        current.splice(index, 1);
      } else {
        delete current[lastPart];
      }
    } else if (patch.op === 'replace') {
      current[lastPart] = patch.value;
    }
  }

  return newObj;
}

function unescapeKey(key: string): string {
  return key.replace(/~1/g, '/').replace(/~0/g, '~');
}
