import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const packageDirs = ['packages/backend', 'packages/contracts', 'packages/docs', 'packages/frontend', 'packages/types'];

for (const packageDir of packageDirs) {
  test(`${packageDir} includes a README file`, () => {
    const readmePath = path.join(repoRoot, packageDir, 'README.md');
    assert.ok(fs.existsSync(readmePath), `${packageDir}/README.md should exist`);

    const content = fs.readFileSync(readmePath, 'utf8');
    assert.ok(content.trim().length > 0, `${packageDir}/README.md should not be empty`);
  });
}
