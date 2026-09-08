import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { createZip } from './zip-writer.mjs';
import { findDevOriginContentScriptMatches, findPortedContentScriptMatches } from './validate-extension.mjs';

// Fabrique le .zip à téléverser sur addons.mozilla.org.
//
// Ce script existe pour supprimer trois erreurs qui ne se voient qu'une fois
// le paquet refusé — ou, pire, publié :
//   1. archiver le DOSSIER au lieu de son contenu : Mozilla cherche
//      manifest.json à la racine de l'archive et rejette tout le reste ;
//   2. téléverser un build `--dev`, qui embarque les origines locales du
//      poste de développement (localhost, IP privées, nom `.local`) — donc,
//      chez un utilisateur, le droit d'injecter le pont depuis n'importe
//      quelle page portant ces mêmes adresses sur son propre réseau ;
//   3. livrer un numéro de version déjà soumis, refusé par AMO sans
//      explication utile.
//
// Les deux premiers sont vérifiés ici, à l'arrêt : mieux vaut ne pas produire
// d'archive du tout que d'en produire une qu'il ne faut pas envoyer.

const root = fileURLToPath(new URL('..', import.meta.url));
const buildDir = join(root, 'dist', 'extension-firefox');
const outDir = join(root, 'release-assets');

export function collectFiles(directory, base = directory) {
  const entries = [];
  for (const name of readdirSync(directory).sort()) {
    const absolute = join(directory, name);
    if (statSync(absolute).isDirectory()) {
      entries.push(...collectFiles(absolute, base));
      continue;
    }
    entries.push({
      // Séparateurs POSIX imposés par le format ZIP : un chemin en
      // antislashs produit une archive que plusieurs outils lisent comme un
      // seul fichier au nom bizarre, jamais comme une arborescence.
      name: relative(base, absolute).replaceAll('\\', '/'),
      data: readFileSync(absolute)
    });
  }
  return entries;
}

export function assertPackageable(manifest, entries) {
  const problems = [];

  if (!entries.some((entry) => entry.name === 'manifest.json')) {
    problems.push('manifest.json absent de la racine de l’archive');
  }

  const devOrigins = findDevOriginContentScriptMatches(manifest);
  if (devOrigins.length > 0) {
    problems.push(
      `origines de développement présentes (build --dev) : ${devOrigins.join(', ')}. ` +
        'Reconstruire avec « npm run extension:build:firefox » avant de packager.'
    );
  }

  const ported = findPortedContentScriptMatches(manifest);
  if (ported.length > 0) {
    problems.push(`numéro de port interdit dans content_scripts.matches : ${ported.join(', ')}`);
  }

  const geckoId = manifest.browser_specific_settings?.gecko?.id;
  if (!geckoId) {
    problems.push('browser_specific_settings.gecko.id absent : AMO ne saurait pas quel module mettre à jour');
  } else if (/\bdev\b|localtest/i.test(geckoId)) {
    problems.push(`identifiant de test dans le paquet : ${geckoId}`);
  }

  if (entries.some((entry) => entry.name.endsWith('.test.js'))) {
    problems.push('fichiers de test présents dans l’archive');
  }

  return problems;
}

function run() {
  const manifest = JSON.parse(readFileSync(join(buildDir, 'manifest.json'), 'utf8'));
  const entries = collectFiles(buildDir);

  const problems = assertPackageable(manifest, entries);
  if (problems.length > 0) {
    console.error(`Paquet NON produit :\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(outDir, { recursive: true });
  const fileName = `comparateur-de-paniers-connecteur-drive-${manifest.version}.zip`;
  const target = join(outDir, fileName);
  // Date fixe : deux constructions du même contenu donnent le même fichier,
  // donc une empreinte reproductible et vérifiable.
  writeFileSync(target, createZip(entries, new Date('2026-01-01T12:00:00Z')));

  const sizeKo = Math.round(statSync(target).size / 1024);
  console.log(`Paquet AMO prêt : release-assets/${fileName} (${entries.length} fichiers, ${sizeKo} Ko)`);
  console.log(`Version ${manifest.version} — identifiant ${manifest.browser_specific_settings.gecko.id}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
