import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = process.cwd();
// Audit sécurité du 30/08 (MEDIUM #5) : extension/ (le connecteur
// WebExtension Leclerc/Hyper U) n'était scanné par aucun des deux outils de
// contrôle réseau — ni ce script, ni un équivalent dédié. Une primitive
// réseau ou un import distant y ajouté par erreur serait passé complètement
// inaperçu malgré `npm run privacy:check`. Le connecteur ne fait aujourd'hui
// aucun appel réseau lui-même (il navigue/lit le DOM de vrais onglets via
// scripting.executeScript, jamais fetch/XHR côté extension) — le scan doit
// donc rester vide de violation ; s'il en trouve une, c'est un signal réel.
const scanRoots = ['src', 'public', 'index.html', 'extension'];
const networkPattern = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/g;
const remoteImportPattern = /\b(?:import\s*\(|from)\s*['"]https?:\/\//g;
const remoteAssetPattern = /<(?:script|link|img|iframe|source)\b[^>]+(?:src|href)=['"]https?:\/\//g;
const remoteCssImportPattern = /@import\s+(?:url\()?['"]?https?:\/\//g;
const absoluteUrlPattern = /https?:\/\/([a-z0-9.-]+)/gi;

// --- Frontière réseau déclarée -------------------------------------------
//
// La politique reste « aucun backend, aucune télémétrie ». Deux services
// publics tiers sont malgré tout appelés, chacun depuis UN seul module
// déclaré ici, et chacun documenté dans PRIVACY.md :
//
//   - world.openfoodfacts.org : base de codes-barres ouverte, reçoit
//     uniquement l'EAN scanné.
//     Le même hôte sert aussi la recherche par nom (/cgi/search.pl), qui
//     reçoit les mots tapés par l'utilisateur — et UNIQUEMENT sur un geste
//     explicite : cette fonction est désactivée par défaut (réglage
//     openFoodFactsNameSearch) et ne se déclenche jamais à la frappe.
//   - nominatim.openstreetmap.org : géocodage, reçoit uniquement la ville
//     saisie manuellement par l'utilisateur.
//
// Toute autre primitive réseau, dans tout autre fichier, reste une
// violation. Ajouter une entrée ici est un acte délibéré qui doit
// s'accompagner d'une mise à jour de PRIVACY.md.
const NETWORK_ALLOWLIST = {
  'src/features/scan/openFoodFactsClient.ts': ['world.openfoodfacts.org'],
  'src/features/stores/storeLocatorClient.ts': ['nominatim.openstreetmap.org']
};

// Les tests injectent un `fetch` factice ou décrivent des URLs attendues ;
// ils ne s'exécutent jamais chez l'utilisateur.
const isTestFile = (relativePath) => /\.test\.(ts|tsx|js)$/.test(relativePath);

const violations = [];

for (const scanRoot of scanRoots) {
  scanPath(join(root, scanRoot));
}

const serviceWorkerSource = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
if (!serviceWorkerSource.includes('requestUrl.origin !== self.location.origin')) {
  violations.push('public/sw.js: missing same-origin guard');
}
if (!serviceWorkerSource.includes('fetch(event.request)') && !serviceWorkerSource.includes('fetch(request)')) {
  violations.push('public/sw.js: unexpected fetch target');
}

// Un fichier retiré de l'allowlist mais toujours listé passerait inaperçu et
// finirait par autoriser silencieusement autre chose : la déclaration doit
// correspondre à la réalité dans les deux sens.
for (const allowedPath of Object.keys(NETWORK_ALLOWLIST)) {
  try {
    statSync(join(root, allowedPath));
  } catch {
    violations.push(`${allowedPath}: fichier de l'allowlist réseau introuvable (allowlist obsolète)`);
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log('privacy check passed');

function scanPath(path) {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(path)) {
      scanPath(join(path, entry));
    }
    return;
  }

  if (!/\.(ts|tsx|js|html|webmanifest|svg)$/.test(path)) {
    return;
  }

  const relativePath = relative(root, path).replace(/\\/g, '/');
  const source = readFileSync(path, 'utf8');
  const matches = source.match(networkPattern) ?? [];
  const remoteImports = source.match(remoteImportPattern) ?? [];
  const remoteAssets = source.match(remoteAssetPattern) ?? [];
  const remoteCssImports = source.match(remoteCssImportPattern) ?? [];

  if (matches.length === 0 && remoteImports.length === 0 && remoteAssets.length === 0 && remoteCssImports.length === 0) {
    return;
  }

  if (relativePath === 'public/sw.js') {
    const unexpected = matches.filter((match) => match !== 'fetch');
    if (unexpected.length > 0) {
      violations.push(`${relativePath}: unexpected network primitive ${unexpected.join(', ')}`);
    }
    if (remoteImports.length > 0 || remoteAssets.length > 0 || remoteCssImports.length > 0) {
      violations.push(`${relativePath}: unexpected remote resource or import`);
    }
    return;
  }

  const allowedHosts = NETWORK_ALLOWLIST[relativePath];
  if (allowedHosts) {
    // Le fichier a le droit d'appeler le réseau, mais uniquement vers les
    // hôtes déclarés : sans ce contrôle, l'allowlist deviendrait un
    // blanc-seing sur le module entier.
    const unexpectedHosts = [
      ...new Set(
        [...source.matchAll(absoluteUrlPattern)]
          .map((match) => match[1].toLowerCase())
          .filter((host) => !allowedHosts.includes(host))
      )
    ];
    if (unexpectedHosts.length > 0) {
      violations.push(`${relativePath}: hôte non déclaré ${unexpectedHosts.join(', ')}`);
    }
    if (remoteImports.length > 0 || remoteAssets.length > 0 || remoteCssImports.length > 0) {
      violations.push(`${relativePath}: remote resource or import`);
    }
    return;
  }

  if (isTestFile(relativePath)) {
    // remoteAssetPattern (src=/href= vers du https://) est volontairement
    // exclu ici : les tests real-DOM du connecteur extension rejouent des
    // extraits HTML réellement capturés sur les sites Leclerc/Hyper U (voir
    // extension/adapters/*/  *-real-dom.test.js), qui contiennent forcément
    // des <img src="https://...">  du CDN photo de l'enseigne — une chaîne
    // de fixture JSDOM inerte, jamais chargée, pas une ressource distante
    // réellement récupérée par l'app. remoteImportPattern (import/from
    // 'https://...') et remoteCssImportPattern restent contrôlés même en
    // test : un vrai import de code distant, lui, s'exécuterait.
    if (remoteImports.length > 0 || remoteCssImports.length > 0) {
      violations.push(`${relativePath}: remote resource or import`);
    }
    return;
  }

  if (matches.length > 0) {
    violations.push(`${relativePath}: network primitive ${[...new Set(matches)].join(', ')}`);
  }
  if (remoteImports.length > 0 || remoteAssets.length > 0 || remoteCssImports.length > 0) {
    violations.push(`${relativePath}: remote resource or import`);
  }
}
