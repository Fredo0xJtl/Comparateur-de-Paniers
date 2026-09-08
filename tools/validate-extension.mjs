import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { FIREFOX_OVERLAY_FILENAME, extensionSourceDir, readFirefoxManifest } from './firefox-manifest.mjs';

const allowedPermissions = new Set(['tabs', 'storage', 'scripting', 'notifications']);
const forbiddenPermissions = new Set([
  'cookies',
  'history',
  'downloads',
  'clipboardRead',
  'clipboardWrite',
  'geolocation',
  'webRequestBlocking'
]);
const allowedHosts = new Set([
  'https://*.leclercdrive.fr/*',
  'https://*.coursesu.com/*'
]);

// Permissions d'hôtes FACULTATIVES : jamais accordées à l'installation.
// Firefox ne les demande que lorsque l'utilisateur déclare lui-même
// l'adresse de son installation auto-hébergée dans la page d'options, et
// uniquement pour cette adresse-là (`permissions.request`). Elles sont
// nécessaires parce qu'une adresse privée (ordinateur, NAS, Raspberry Pi,
// domaine personnel) ne peut par définition pas figurer dans un paquet
// distribué — voir extension/shared/custom-origins.js.
//
// La liste est verrouillée ici pour deux raisons :
//   1. `*://*/*` — donc http:// sur n'importe quel hôte — n'a jamais à
//      apparaître : une page servie en clair peut être imitée par quiconque
//      s'interpose sur le réseau (Wi-Fi partagé, DNS ou ARP détourné), et
//      hériterait alors du droit de piloter l'extension dans la session
//      authentifiée de l'utilisateur sur les sites des enseignes. http:// est
//      donc restreint à la boucle locale, où ce risque n'existe pas.
//   2. Une permission facultative ajoutée à la légère se voit dans la fiche
//      AMO et durcit la revue. Toute évolution doit être un choix conscient,
//      pas une ligne ajoutée en passant.
const allowedOptionalHosts = new Set([
  'https://*/*',
  'http://localhost/*',
  'http://127.0.0.1/*'
]);

export function validateExtensionManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || manifest.manifest_version !== 3) {
    return ['Manifest V3 requis'];
  }

  for (const permission of manifest.permissions ?? []) {
    if (forbiddenPermissions.has(permission)) {
      errors.push(`Permission interdite : ${permission}`);
    } else if (!allowedPermissions.has(permission)) {
      errors.push(`Permission non autorisée : ${permission}`);
    }
  }

  for (const host of manifest.host_permissions ?? []) {
    if (!allowedHosts.has(host)) {
      errors.push(`Hôte interdit : ${host}`);
    }
  }

  for (const host of manifest.optional_host_permissions ?? []) {
    if (!allowedOptionalHosts.has(host)) {
      errors.push(`Hôte facultatif interdit : ${host}`);
    }
  }

  // Une permission facultative ne sert à rien si rien ne peut la demander :
  // seule la page d'options appelle `permissions.request`. Sans elle, la
  // liste ci-dessus ne serait qu'une permission affichée sur la fiche AMO
  // sans contrepartie fonctionnelle — exactement ce qu'une revue reproche.
  if ((manifest.optional_host_permissions ?? []).length > 0 && !manifest.options_page && !manifest.options_ui) {
    errors.push('optional_host_permissions déclaré sans page d’options pour les demander');
  }

  const worker = manifest.background;
  // Chrome/Chromium MV3 uses background.service_worker; Firefox's MV3
  // implementation doesn't support that key the same way and uses
  // background.scripts instead (voir les surcharges Firefox) — both must be
  // accepted since this validator runs against both manifest flavors.
  const hasValidBackgroundEntry =
    worker?.service_worker === 'background/service-worker.js' ||
    (Array.isArray(worker?.scripts) && worker.scripts.includes('background/service-worker.js'));
  if (!worker || !hasValidBackgroundEntry || worker.type !== 'module') {
    errors.push('Service worker invalide');
  }

  if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'none'") {
    errors.push('CSP extension invalide');
  }

  return errors;
}

// Audit sécurité du 30/08 (MEDIUM #4) : une origine de dev (localhost,
// boucle locale, IP privée) dans content_scripts.matches d'un manifest
// EMBARQUÉ (build de prod) laisserait n'importe quelle page portant la même
// IP privée/le même port local injecter le bridge Drive
// (extension/bridge/pwa-bridge.js) et parler au service worker avec la
// session réelle de l'utilisateur — voir extension/shared/origin-allowlist.js.
// Les manifests SOURCE (extension/manifest.json et ses surcharges Firefox)
// contiennent ces origines par design (pour le dev server local/LAN) : ce contrôle ne s'applique donc qu'au manifest
// réellement construit (dist/extension-firefox/manifest.json), jamais aux
// sources — voir tools/build-firefox-extension.mjs.
// Les noms en `.local` (mDNS/Bonjour) sont ici pour la même raison que
// localhost et les IP privées : ils ne désignent jamais une origine publique,
// seulement une machine du réseau où se trouve l'utilisateur. Laisser
// un nom `.local` dans un paquet distribué reviendrait à injecter le bridge Drive chez n'importe quel
// utilisateur dont le réseau contient une machine annonçant ce nom — un nom
// mDNS n'est ni réservé ni authentifié, n'importe qui sur le même LAN peut le
// revendiquer. Ajouté le 05/09 : le manifest source portait cette origine avec
// une note « à retirer avant toute soumission AMO publique », c'est-à-dire un
// geste manuel qu'aucun contrôle n'imposait.
export const DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|[a-z0-9-]+(\.[a-z0-9-]+)*\.local)(:\d+)?\//i;

// Un match pattern WebExtension n'accepte AUCUN numéro de port. Firefox le
// refuse (bugs Mozilla 1362809 / 1468162) et rejette l'entrée content_scripts
// concernée : le bridge n'est plus injecté et la PWA affiche "Extension Drive
// indisponible" alors que l'extension est installée — régression réellement
// vécue le 01/09 avec les builds --dev-port. Ce contrôle existe pour qu'elle
// ne puisse plus repartir en silence.
export const MATCH_PATTERN_WITH_PORT = new RegExp(String.raw`://[^/]*:[0-9]+`);

export function findPortedContentScriptMatches(manifest) {
  return (manifest?.content_scripts ?? [])
    .flatMap((entry) => entry.matches ?? [])
    .filter((match) => MATCH_PATTERN_WITH_PORT.test(match));
}

export function findDevOriginContentScriptMatches(manifest) {
  return (manifest?.content_scripts ?? []).flatMap((entry) => entry.matches ?? []).filter((match) => DEV_ORIGIN_PATTERN.test(match));
}

// Contrôler le seul extension/manifest.json donnait une fausse confiance : le
// paquet Firefox livré est le manifest FUSIONNÉ (base + surcharges), et c'est
// lui qui part sur le téléphone. On valide donc les deux : la base, et le
// résultat réellement embarqué. Tant que le manifest Firefox était une copie
// complète, une permission ajoutée d'un seul côté passait ce contrôle tout en
// manquant sur le téléphone — vécu avec la permission « notifications », dont
// la notification de progression n'a jamais fonctionné.
function manifestsToValidate() {
  const extensionDir = extensionSourceDir();
  return [
    ['extension/manifest.json', JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'))],
    [`extension/manifest.json + ${FIREFOX_OVERLAY_FILENAME}`, readFirefoxManifest(extensionDir)]
  ];
}

function run() {
  let hasErrors = false;
  for (const [relativePath, manifest] of manifestsToValidate()) {
    const errors = validateExtensionManifest(manifest);
    if (errors.length > 0) {
      hasErrors = true;
      console.error(`${relativePath}:\n${errors.join('\n')}`);
    }
    // Régression du 01/09 : un numéro de port dans un match pattern est
    // refusé par Firefox (bugs Mozilla 1362809 / 1468162), qui cesse alors
    // d'injecter le bridge — la PWA affiche "Extension Drive indisponible"
    // alors que l'extension est bien installée. Contrôlé ici pour que ça ne
    // puisse plus repartir en silence.
    const ported = findPortedContentScriptMatches(manifest);
    if (ported.length > 0) {
      hasErrors = true;
      console.error(
        `${relativePath}:\nNuméro de port interdit dans content_scripts.matches (Firefox rejette ces motifs et n'injecte plus le bridge) : ${ported.join(', ')}`
      );
    }
  }
  // Contrôle additionnel, best-effort : si un build Firefox existe déjà
  // (dist/extension-firefox/manifest.json), vérifie qu'il ne contient aucune
  // origine de dev — attrape une régression du filtrage même si
  // `extension:check` tourne seul (sans rebuild juste avant), ex. en CI.
  // Absent d'un clone frais : ignoré silencieusement, ce n'est pas une erreur.
  const distManifestPath = fileURLToPath(new URL('../dist/extension-firefox/manifest.json', import.meta.url));
  if (existsSync(distManifestPath)) {
    const distManifest = JSON.parse(readFileSync(distManifestPath, 'utf8'));
    const leaked = findDevOriginContentScriptMatches(distManifest);
    if (leaked.length > 0) {
      hasErrors = true;
      console.error(`dist/extension-firefox/manifest.json:\nOrigines de dev présentes dans un build embarqué : ${leaked.join(', ')}`);
    }
    const distPorted = findPortedContentScriptMatches(distManifest);
    if (distPorted.length > 0) {
      hasErrors = true;
      console.error(
        `dist/extension-firefox/manifest.json:\nNuméro de port interdit dans content_scripts.matches : ${distPorted.join(', ')}`
      );
    }
  }

  if (hasErrors) {
    process.exitCode = 1;
    return;
  }
  console.log('extension manifest check passed');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run();
}
