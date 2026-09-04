import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// extension/manifest.firefox.json était une COPIE COMPLÈTE de
// extension/manifest.json, à deux clés près. Les deux fichiers ont
// forcément dérivé : la permission `notifications` a été ajoutée dans l'un
// mais pas dans l'autre (la notification de progression n'a donc jamais
// fonctionné, alors que le contrôle de manifest passait), et les numéros de
// version se sont désynchronisés au moins deux fois (0.5.24/0.5.29, puis
// 0.5.98/0.6.1). Le fichier Firefox ne contient donc plus QUE ses
// différences, appliquées par-dessus le manifest de base : une permission,
// un content script ou une version ne peut plus exister d'un seul côté.
export const FIREFOX_OVERLAY_FILENAME = 'manifest.firefox.overlay.json';

// Clés que Firefox ignore et qui n'ont de sens que pour un paquet Chrome :
// retirées du paquet publié plutôt que laissées traîner dans le manifest
// soumis à Mozilla.
export const CHROME_ONLY_KEYS = ['minimum_chrome_version'];

// Clé de documentation interne à l'overlay (JSON n'accepte pas de
// commentaires) : elle explique le fichier à qui l'ouvre, et ne doit jamais
// se retrouver dans le manifest livré.
const DOC_KEY = '//';

export function mergeFirefoxManifest(base, overlay) {
  // Fusion de surface volontaire : l'overlay ne porte que des clés de premier
  // niveau absentes de la base (browser_specific_settings). Fusionner en
  // profondeur permettrait de surcharger une permission ou un content script
  // à moitié — exactement l'ambiguïté que ce fichier supprime.
  const merged = { ...base, ...overlay };
  delete merged[DOC_KEY];
  for (const key of CHROME_ONLY_KEYS) {
    delete merged[key];
  }
  return merged;
}

export function readFirefoxManifest(extensionDir) {
  const base = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  const overlay = JSON.parse(readFileSync(join(extensionDir, FIREFOX_OVERLAY_FILENAME), 'utf8'));
  return mergeFirefoxManifest(base, overlay);
}

export function extensionSourceDir() {
  return fileURLToPath(new URL('../extension/', import.meta.url));
}
