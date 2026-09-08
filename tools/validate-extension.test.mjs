import { describe, expect, it } from 'vitest';
import { findDevOriginContentScriptMatches, validateExtensionManifest } from './validate-extension.mjs';

const validManifest = {
  manifest_version: 3,
  permissions: ['tabs', 'storage', 'scripting'],
  host_permissions: ['https://*.leclercdrive.fr/*', 'https://*.coursesu.com/*'],
  background: { service_worker: 'background/service-worker.js', type: 'module' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" }
};

describe('validateExtensionManifest', () => {
  it('ne remonte aucune erreur sur un manifest valide', () => {
    expect(validateExtensionManifest(validManifest)).toEqual([]);
  });

  it('rejette un manifest_version différent de 3', () => {
    expect(validateExtensionManifest({ ...validManifest, manifest_version: 2 })).toEqual(['Manifest V3 requis']);
  });

  it('signale une permission interdite', () => {
    const errors = validateExtensionManifest({ ...validManifest, permissions: ['tabs', 'cookies'] });
    expect(errors).toContain('Permission interdite : cookies');
  });

  it('signale un hôte non autorisé', () => {
    const errors = validateExtensionManifest({ ...validManifest, host_permissions: ['https://evil.example/*'] });
    expect(errors).toContain('Hôte interdit : https://evil.example/*');
  });
});

// Les permissions d'hôtes FACULTATIVES existent pour qu'un utilisateur qui
// héberge lui-même le Comparateur de Paniers puisse déclarer SON adresse
// (voir extension/shared/custom-origins.js). Elles ne sont jamais accordées à
// l'installation, mais elles apparaissent sur la fiche AMO et élargissent ce
// que l'extension PEUT demander : la liste reste donc verrouillée.
describe('validateExtensionManifest — permissions d’hôtes facultatives', () => {
  const withOptional = (optional_host_permissions) => ({
    ...validManifest,
    options_page: 'options/options.html',
    optional_host_permissions
  });

  it('accepte la liste attendue', () => {
    expect(validateExtensionManifest(withOptional(['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*']))).toEqual(
      []
    );
  });

  it('refuse http:// sur un hôte quelconque', () => {
    // `*://*/*` autoriserait une page servie en clair — imitable par
    // quiconque s'interpose sur le réseau — à piloter l'extension dans la
    // session authentifiée de l'utilisateur sur les sites des enseignes.
    const errors = validateExtensionManifest(withOptional(['*://*/*']));
    expect(errors).toContain('Hôte facultatif interdit : *://*/*');
  });

  it('refuse http:// hors de la boucle locale', () => {
    const errors = validateExtensionManifest(withOptional(['http://*/*']));
    expect(errors).toContain('Hôte facultatif interdit : http://*/*');
  });

  it('refuse une permission facultative que rien ne peut demander', () => {
    // Sans page d'options, `permissions.request` n'est appelable nulle part :
    // la permission ne serait qu'une ligne de plus sur la fiche AMO, sans
    // aucune contrepartie — motif classique de rejet en revue.
    const { options_page: _ignored, ...sansOptions } = withOptional(['https://*/*']);
    expect(validateExtensionManifest(sansOptions)).toContain(
      'optional_host_permissions déclaré sans page d’options pour les demander'
    );
  });

  it('n’exige rien quand aucune permission facultative n’est déclarée', () => {
    expect(validateExtensionManifest(validManifest)).toEqual([]);
  });
});

// Audit sécurité du 30/08 (MEDIUM #4) : ce garde protège spécifiquement le
// manifest BUILD (dist/extension-firefox/manifest.json), pas les sources —
// voir le commentaire au-dessus de DEV_ORIGIN_PATTERN dans validate-extension.mjs.
describe('findDevOriginContentScriptMatches', () => {
  it('détecte localhost, la boucle locale et une IP privée', () => {
    const manifest = {
      content_scripts: [
        {
          matches: [
            'http://localhost/*',
            'http://127.0.0.1/*',
            'https://192.168.99.15/*',
            'https://fredo0xjtl.github.io/Comparateur-de-Paniers/*'
          ]
        }
      ]
    };
    expect(findDevOriginContentScriptMatches(manifest)).toEqual([
      'http://localhost/*',
      'http://127.0.0.1/*',
      'https://192.168.99.15/*'
    ]);
  });

  it("ne signale rien sur un manifest de production déjà nettoyé", () => {
    const manifest = {
      content_scripts: [{ matches: ['https://fredo0xjtl.github.io/Comparateur-de-Paniers/*'] }]
    };
    expect(findDevOriginContentScriptMatches(manifest)).toEqual([]);
  });

  it('gère un manifest sans content_scripts sans lever', () => {
    expect(findDevOriginContentScriptMatches({})).toEqual([]);
    expect(findDevOriginContentScriptMatches(null)).toEqual([]);
  });
});
