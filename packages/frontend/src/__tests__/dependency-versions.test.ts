import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function readPackageJson(relativePath: string) {
  return JSON.parse(readFileSync(path.resolve(process.cwd(), relativePath), 'utf8'));
}

describe('security dependency policy', () => {
  it('keeps the frontend on a patched Next.js release', () => {
    const frontendPackage = readPackageJson('package.json');

    expect(frontendPackage.dependencies.next).toBe('14.2.35');
    expect(frontendPackage.devDependencies['eslint-config-next']).toBe('14.2.35');
  });

  it('keeps the docs toolchain on a patched Docusaurus release', () => {
    const docsPackage = readPackageJson('../docs/package.json');

    expect(docsPackage.dependencies['@docusaurus/core']).toBe('3.10.2');
    expect(docsPackage.dependencies['@docusaurus/preset-classic']).toBe('3.10.2');
  });
});
