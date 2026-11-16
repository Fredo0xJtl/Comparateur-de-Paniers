import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { validateChromiumManifest } from './validate-extension.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'extension');
const outDir = join(root, 'dist', 'extension-chromium');

export function chromiumManifest(manifest) {
  return Object.fromEntries(Object.entries(manifest).filter(([key]) => !key.startsWith('//')));
}

function run() {
  const manifest = chromiumManifest(JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8')));
  const errors = validateChromiumManifest(manifest);
  if (errors.length > 0) throw new Error(`Manifest Chromium invalide : ${errors.join(', ')}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(sourceDir, outDir, {
    recursive: true,
    filter: (path) => {
      const name = path.split(/[\\/]/).pop() ?? '';
      return !name.endsWith('.test.js') && name !== 'manifest.firefox.overlay.json';
    }
  });
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('Paquet Chromium généré dans dist/extension-chromium (charger ce dossier non empaqueté dans Chrome, Brave ou un navigateur Chromium).');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
