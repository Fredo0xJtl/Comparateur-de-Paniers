import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');

test('Pages deploys to the public address recognized by the Firefox connector', () => {
  assert.match(workflow, /PUBLIC_BASE:\s*\/Comparateur-de-Paniers\//);
  assert.match(workflow, /adresse="https:\/\/\$\{proprietaire\}\.github\.io\$\{PUBLIC_BASE\}"/);
  assert.match(workflow, /echo "PUBLIC_BASE=\$\{PUBLIC_BASE\}" >> "\$GITHUB_ENV"/);
});
