import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  DEV_ORIGIN_PATTERN,
  findDevOriginContentScriptMatches,
  findPortedContentScriptMatches
} from './validate-extension.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDir = join(root, 'extension');

// Les origines de développement (localhost, boucle locale, IP LAN du poste)
// n'ont rien à faire dans un paquet distribué : elles décrivent le réseau de
// la machine de dev, et injectent le bridge chez n'importe quel utilisateur
// dont une machine porte la même IP privée. Elles sont retirées par défaut et
// ne sont conservées que pour un build de test explicite
// (`npm run extension:build:firefox -- --dev`), typiquement pour piloter la
// PWA servie par le dev server depuis un téléphone du même réseau.
// DEV_ORIGIN_PATTERN vit dans validate-extension.mjs (source unique) pour
// que le filtrage ici et le contrôle post-build restent garantis identiques.
const keepDevOrigins = process.argv.includes('--dev') || process.argv.some((arg) => arg.startsWith('--dev-port='));
const DEV_EXTENSION_ID = 'drive-price-splitter-dev@fredo0xjtl.github.io';

// Sans --dev-port, un build --dev parle à N'IMPORTE QUEL port localhost/LAN
// (dev ET prod local confondus) : c'est le seul mode qui existait jusqu'ici,
// mais il empêche de charger en parallèle une extension "dev" et une
// extension "prod locale" sans qu'elles se marchent dessus (les deux
// s'injecteraient sur les deux PWA à la fois). --dev-port=<port> restreint
// les origines de dev à CE port précis uniquement, pour permettre deux
// paquets distincts et coexistants (dev et production locale).
const devPortArg = process.argv.find((arg) => arg.startsWith('--dev-port='));
const devPort = devPortArg ? devPortArg.slice('--dev-port='.length) : null;

// Dossier de sortie distinct par port pour permettre de charger les deux
// paquets simultanément dans le navigateur (about:debugging / web-ext) sans
// que l'un écrase le fichier de l'autre sur disque.
const outDir = join(root, 'dist', devPort ? `extension-firefox-${devPort}` : 'extension-firefox');

export function configureBridgeOrigins(manifest, { dev, port = null, lanAddresses = [] }) {
  if (!Array.isArray(manifest.content_scripts)) {
    return manifest;
  }
  const devHostPermissions = dev
    ? [
        'http://localhost/*',
        'https://localhost/*',
        'http://127.0.0.1/*',
        'https://127.0.0.1/*',
        ...lanAddresses.map((address) => `https://${address}/*`),
        ...readExplicitDevOrigins().map((origin) => stripPort(origin))
      ]
    : [];
  // ATTENTION : ces motifs partent dans content_scripts.matches du manifest,
  // et un match pattern WebExtension NE PEUT PAS contenir de numéro de port.
  // Firefox refuse un motif du genre "http://localhost:5174/*" (bugs Mozilla
  // 1362809 / 1468162) : l'entrée content_scripts est alors rejetée et le
  // bridge n'est JAMAIS injecté — la PWA affiche "Extension Drive
  // indisponible" alors que l'extension est bien installée (régression du
  // 01/09, introduite en même temps que --dev-port). La restriction au port
  // exact se fait donc à l'exécution, via BRIDGE_ORIGIN_PATTERNS
  // (extension/shared/bridge-origins.js), jamais dans le manifest.
  const devMatches = dev ? devOriginPatterns({ suffix: '', lanAddresses }) : [];
  return {
    ...manifest,
    name: dev ? `${manifest.name} (dev${port ? ` :${port}` : ''})` : manifest.name,
    browser_specific_settings: dev
      ? {
          ...(manifest.browser_specific_settings ?? {}),
          gecko: {
            ...(manifest.browser_specific_settings?.gecko ?? {}),
            id: DEV_EXTENSION_ID
          }
        }
      : manifest.browser_specific_settings,
    host_permissions: dev
      ? [...new Set([...(manifest.host_permissions ?? []), ...devHostPermissions])]
      : manifest.host_permissions,
    // Nom distinct par port pour se repérer visuellement dans
    // about:debugging quand les deux paquets (dev + prod locale) sont
    // chargés en même temps -- sans ça, deux entrées identiques "Drive Price
    // Splitter Connector" sont impossibles à distinguer une fois installées.
    content_scripts: manifest.content_scripts
      .map((entry) => ({
        ...entry,
        matches: [...new Set([
          ...(entry.matches ?? []).filter((match) => !DEV_ORIGIN_PATTERN.test(match)),
          ...devMatches
        ])]
      }))
      .filter((entry) => entry.matches.length > 0)
  };
}

// Origines de développement de ce paquet. `suffix` vaut ':<port>' pour la
// liste d'exécution (BRIDGE_ORIGIN_PATTERNS) et '' pour les match patterns du
// manifest, qui n'acceptent aucun port — une seule source pour les deux, pour
// qu'elles ne puissent pas diverger.
function devOriginPatterns({ suffix, lanAddresses }) {
  // Une origine explicite (DRIVE_DEV_ORIGINS) peut être tapée avec son port
  // par l'utilisateur. Ce port est légitime dans la liste d'exécution, mais
  // interdit dans un match pattern : on le retire pour le manifest, sinon la
  // garde anti-port ferait échouer le build sur une saisie parfaitement
  // normale.
  const explicit = readExplicitDevOrigins();
  return [
    `http://localhost${suffix}/*`,
    `https://localhost${suffix}/*`,
    `http://127.0.0.1${suffix}/*`,
    `https://127.0.0.1${suffix}/*`,
    ...lanAddresses.map((address) => `https://${address}${suffix}/*`),
    ...(suffix ? explicit : explicit.map((origin) => stripPort(origin)))
  ];
}

// Retire le ":<port>" de la partie hôte d'un motif ("https://h:5174/*" ->
// "https://h/*"), le seul endroit où il peut apparaître ici.
function stripPort(pattern) {
  return pattern.replace(new RegExp(':[0-9]+/'), '/');
}

// Liste blanche appliquée à l'exécution par le service worker (voir
// isAllowedSender). C'est ELLE qui restreint un paquet --dev-port au port
// demandé : le manifest, lui, laisse le navigateur injecter le bridge sur
// tout localhost/LAN puisqu'il ne sait pas filtrer par port.
export function computeBridgeOriginPatterns(manifest, { dev, port = null, lanAddresses = [] }) {
  const manifestMatches = (manifest.content_scripts ?? [])
    .flatMap((entry) => entry.matches ?? [])
    .filter((match) => !DEV_ORIGIN_PATTERN.test(match));
  if (!dev) return [...new Set(manifestMatches)];
  const suffix = port ? `:${port}` : '';
  return [...new Set([...manifestMatches, ...devOriginPatterns({ suffix, lanAddresses })])];
}

function readExplicitDevOrigins() {
  return (process.env.DRIVE_DEV_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
    .map((origin) => `${origin}/*`);
}

function getLanAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function run() {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  cpSync(sourceDir, outDir, {
    recursive: true,
    filter: (path) => {
      const base = path.split(/[\\/]/).pop() ?? '';
      if (base.endsWith('.test.js')) return false;
      if (base === 'manifest.firefox.json') return false;
      return true;
    }
  });

  const firefoxManifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.firefox.json'), 'utf8'));
  const chromeManifest = JSON.parse(readFileSync(join(sourceDir, 'manifest.json'), 'utf8'));

  // Les deux manifests avaient dérivé (0.5.24 côté Firefox contre 0.5.29 côté
  // Chrome), ce qui rend le numéro affiché dans la page d'options — et celui
  // renvoyé au PWA par DRIVE_CONNECTOR_STATUS — faux sur Firefox. Le manifest
  // Chrome fait foi.
  if (firefoxManifest.version !== chromeManifest.version) {
    console.warn(
      `Version Firefox (${firefoxManifest.version}) alignée sur celle du manifest Chrome (${chromeManifest.version}).`
    );
    firefoxManifest.version = chromeManifest.version;
  }

  const manifest = configureBridgeOrigins(firefoxManifest, {
    dev: keepDevOrigins,
    port: devPort,
    lanAddresses: getLanAddresses()
  });

  // Garde fail-closed (audit sécurité du 30/08, MEDIUM #4) : si le filtrage
  // ci-dessus a un jour une régression (nouveau motif d'origine de dev non
  // couvert par DEV_ORIGIN_PATTERN, ordre des étapes changé...), un build de
  // prod NE DOIT PAS partir silencieusement avec une origine de dev encore
  // présente — on arrête le build plutôt que de livrer une extension qui
  // laisserait n'importe quelle page de la même IP privée/du même port local
  // injecter le bridge Drive.
  if (!keepDevOrigins) {
    const leaked = findDevOriginContentScriptMatches(manifest);
    if (leaked.length > 0) {
      throw new Error(
        `Build Firefox de production : origine(s) de dev encore présentes après filtrage : ${leaked.join(', ')}`
      );
    }
  }

  // Garde fail-closed : Firefox n'accepte aucun numéro de port dans un match
  // pattern et rejette alors l'entrée content_scripts entière — le bridge
  // n'est plus injecté nulle part et la PWA répond "Extension Drive
  // indisponible" sans autre erreur visible. On arrête le build plutôt que de
  // livrer un paquet muet (régression du 01/09).
  const portedMatches = findPortedContentScriptMatches(manifest);
  if (portedMatches.length > 0) {
    throw new Error(
      `Build Firefox : numéro de port interdit dans content_scripts.matches (Firefox rejette ces motifs) : ${portedMatches.join(', ')}`
    );
  }

  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // Liste blanche appliquée à l'exécution par le service worker : c'est elle,
  // et non le manifest, qui restreint un paquet --dev-port au port demandé.
  const originPatterns = computeBridgeOriginPatterns(firefoxManifest, {
    dev: keepDevOrigins,
    port: devPort,
    lanAddresses: getLanAddresses()
  });
  writeFileSync(
    join(outDir, 'shared', 'bridge-origins.js'),
    [
      '// Genere par tools/build-firefox-extension.mjs -- ne pas editer a la main.',
      '// Voir extension/shared/bridge-origins.js pour le pourquoi de ce fichier.',
      `export const BRIDGE_ORIGIN_PATTERNS = ${JSON.stringify(originPatterns, null, 2)};`,
      ''
    ].join(String.fromCharCode(10))
  );


  if (devPort) {
    console.log(`Paquet Firefox généré dans ${outDir} (origines restreintes au port ${devPort} uniquement)`);
  } else if (keepDevOrigins) {
    console.log(`Paquet Firefox généré dans ${outDir} (origines de développement conservées, tous ports)`);
  } else {
    // Rappel bien visible : un build sans --dev n'injecte le bridge que sur
    // GitHub Pages — testé depuis le dev server local/LAN, ça se traduit par
    // "Extension Drive indisponible" sans aucune autre erreur (le content
    // script ne s'exécute simplement jamais sur la page). Cause déjà vécue —
    // voir docs/PROJECT_STATUS.md.
    console.log(`Paquet Firefox généré dans ${outDir} (build PRODUCTION — pas d'origines dev)`);
    console.log('⚠️  Pour tester depuis le dev server local/LAN, relance avec : npm run extension:build:firefox:dev');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
