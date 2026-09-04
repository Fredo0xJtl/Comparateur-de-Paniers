import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHROME_ONLY_KEYS,
  FIREFOX_OVERLAY_FILENAME,
  extensionSourceDir,
  mergeFirefoxManifest,
  readFirefoxManifest
} from './firefox-manifest.mjs';

const extensionDir = extensionSourceDir();
const baseManifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
const overlay = JSON.parse(readFileSync(join(extensionDir, FIREFOX_OVERLAY_FILENAME), 'utf8'));

describe('manifest Firefox', () => {
  // LE test de ce fichier : le manifest Firefox a longtemps été une copie
  // complète du manifest de base, et les deux ont dérivé — permission
  // `notifications` présente d'un seul côté (notification de progression
  // jamais déclenchée sur le téléphone), puis versions désynchronisées à deux
  // reprises. Toute clé redéclarée dans l'overlay recrée ce risque, quelle
  // qu'elle soit : on refuse la duplication elle-même, pas seulement ses
  // conséquences connues.
  it("ne redéclare aucune clé déjà portée par le manifest de base", () => {
    const duplicated = Object.keys(overlay).filter((key) => key !== '//' && key in baseManifest);
    expect(duplicated).toEqual([]);
  });

  it('prend sa version dans le manifest de base, jamais dans les surcharges', () => {
    expect(readFirefoxManifest(extensionDir).version).toBe(baseManifest.version);
    expect(overlay).not.toHaveProperty('version');
  });

  it('apporte les réglages Gecko exigés par Mozilla', () => {
    const gecko = readFirefoxManifest(extensionDir).browser_specific_settings?.gecko;
    expect(gecko?.id).toBeTruthy();
    // Obligatoire pour toute extension soumise à AMO depuis le 3 novembre
    // 2025 : « none » déclare qu'aucune donnée personnelle n'est collectée ni
    // transmise, ce que le paquet doit rester capable de tenir (aucun appel
    // réseau sortant dans extension/).
    expect(gecko?.data_collection_permissions?.required).toEqual(['none']);
  });

  it('ne livre ni la clé de documentation ni les clés propres à Chrome', () => {
    const merged = mergeFirefoxManifest(
      { ...baseManifest, minimum_chrome_version: '109' },
      { '//': 'doc', browser_specific_settings: { gecko: { id: 'x' } } }
    );
    expect(merged).not.toHaveProperty('//');
    for (const key of CHROME_ONLY_KEYS) {
      expect(merged).not.toHaveProperty(key);
    }
  });
});
