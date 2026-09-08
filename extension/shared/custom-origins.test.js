import { describe, expect, it } from 'vitest';
import {
  MAX_CUSTOM_ORIGINS,
  addCustomOrigin,
  normalizeCustomOrigin,
  removeCustomOrigin,
  sanitizeStoredOrigins,
  toHostPatterns,
  toRuntimePatterns
} from './custom-origins.js';

describe('normalizeCustomOrigin', () => {
  it('accepte une adresse https simple', () => {
    const result = normalizeCustomOrigin('https://comparateur.exemple.fr');
    expect(result.ok).toBe(true);
    expect(result.entry).toEqual({
      origin: 'https://comparateur.exemple.fr',
      hostPattern: 'https://comparateur.exemple.fr/*',
      runtimePattern: 'https://comparateur.exemple.fr:443/*'
    });
  });

  it('suppose https:// quand le schéma est absent', () => {
    const result = normalizeCustomOrigin('mon-nas.local:8443');
    expect(result.ok).toBe(true);
    expect(result.entry.origin).toBe('https://mon-nas.local:8443');
  });

  it('sépare le motif Firefox (sans port) du motif d’exécution (avec port)', () => {
    // Un match pattern WebExtension ne peut pas porter de port : Firefox
    // rejetterait l'entrée et le pont ne serait jamais injecté (bugs Mozilla
    // 1362809 / 1468162, régression du 01/09).
    const result = normalizeCustomOrigin('https://mon-nas.local:8443/comparateur/');
    expect(result.ok).toBe(true);
    expect(result.entry.hostPattern).toBe('https://mon-nas.local/*');
    expect(result.entry.runtimePattern).toBe('https://mon-nas.local:8443/*');
  });

  it('ignore le chemin, la requête et le fragment collés depuis la barre d’adresse', () => {
    const result = normalizeCustomOrigin('https://exemple.fr/Comparateur-de-Paniers/?a=1#liste');
    expect(result.entry.origin).toBe('https://exemple.fr');
  });

  it('met le nom de serveur en minuscules', () => {
    expect(normalizeCustomOrigin('https://Mon-NAS.Local').entry.origin).toBe('https://mon-nas.local');
  });

  it('accepte http:// sur la boucle locale uniquement', () => {
    expect(normalizeCustomOrigin('http://localhost:5173').ok).toBe(true);
    expect(normalizeCustomOrigin('http://127.0.0.1:8080').ok).toBe(true);
  });

  it('refuse http:// ailleurs que sur la boucle locale', () => {
    // Une origine non chiffrée peut être imitée par quiconque s'interpose sur
    // le réseau, et obtiendrait alors le droit de piloter l'extension dans la
    // session authentifiée de l'utilisateur sur les sites des enseignes.
    const result = normalizeCustomOrigin('http://192.168.1.50:8080');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/http:\/\//);
  });

  it('refuse les jokers', () => {
    expect(normalizeCustomOrigin('https://*.exemple.fr').ok).toBe(false);
  });

  it('refuse un schéma non web', () => {
    expect(normalizeCustomOrigin('javascript:alert(1)').ok).toBe(false);
    expect(normalizeCustomOrigin('file:///C:/site/index.html').ok).toBe(false);
    expect(normalizeCustomOrigin('ftp://exemple.fr').ok).toBe(false);
  });

  it('refuse une adresse portant des identifiants', () => {
    expect(normalizeCustomOrigin('https://user:motdepasse@exemple.fr').ok).toBe(false);
  });

  it('refuse une saisie vide ou illisible', () => {
    expect(normalizeCustomOrigin('').ok).toBe(false);
    expect(normalizeCustomOrigin('   ').ok).toBe(false);
    expect(normalizeCustomOrigin('https://').ok).toBe(false);
  });
});

describe('addCustomOrigin', () => {
  const entry = (host) => normalizeCustomOrigin(host).entry;

  it('ajoute une entrée à une liste vide', () => {
    const result = addCustomOrigin([], entry('https://a.fr'));
    expect(result.ok).toBe(true);
    expect(result.entries).toHaveLength(1);
  });

  it('refuse un doublon', () => {
    const first = entry('https://a.fr');
    const result = addCustomOrigin([first], entry('https://a.fr'));
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(1);
  });

  it('refuse au-delà de la limite', () => {
    const full = Array.from({ length: MAX_CUSTOM_ORIGINS }, (_, index) => entry(`https://h${index}.fr`));
    const result = addCustomOrigin(full, entry('https://encore.fr'));
    expect(result.ok).toBe(false);
    expect(result.entries).toHaveLength(MAX_CUSTOM_ORIGINS);
  });
});

describe('removeCustomOrigin', () => {
  it('retire l’entrée demandée et laisse les autres', () => {
    const entries = [
      normalizeCustomOrigin('https://a.fr').entry,
      normalizeCustomOrigin('https://b.fr').entry
    ];
    expect(removeCustomOrigin(entries, 'https://a.fr')).toEqual([entries[1]]);
  });

  it('tolère une liste absente', () => {
    expect(removeCustomOrigin(undefined, 'https://a.fr')).toEqual([]);
  });
});

describe('sanitizeStoredOrigins', () => {
  it('écarte tout ce qui n’est pas une origine acceptable', () => {
    const entries = sanitizeStoredOrigins([
      { origin: 'https://bon.fr' },
      { origin: 'http://192.168.1.9' },
      { origin: 'https://*.joker.fr' },
      null,
      'https://pas-un-objet.fr',
      { pasDOrigine: true }
    ]);
    expect(entries.map((item) => item.origin)).toEqual(['https://bon.fr']);
  });

  it('recalcule les motifs plutôt que de faire confiance à ce qui est stocké', () => {
    // Une valeur stockée peut avoir été écrite par une version antérieure —
    // ou trafiquée. Seule l'origine sert de source, les motifs sont dérivés.
    const entries = sanitizeStoredOrigins([
      { origin: 'https://mon-nas.local:8443', hostPattern: '*://*/*', runtimePattern: '*://*/*' }
    ]);
    expect(entries[0].hostPattern).toBe('https://mon-nas.local/*');
    expect(entries[0].runtimePattern).toBe('https://mon-nas.local:8443/*');
  });

  it('déduplique et plafonne', () => {
    const many = Array.from({ length: MAX_CUSTOM_ORIGINS + 3 }, (_, index) => ({ origin: `https://h${index}.fr` }));
    expect(sanitizeStoredOrigins([...many, { origin: 'https://h0.fr' }])).toHaveLength(MAX_CUSTOM_ORIGINS);
  });

  it('renvoie une liste vide pour une valeur absente ou d’un autre type', () => {
    expect(sanitizeStoredOrigins(undefined)).toEqual([]);
    expect(sanitizeStoredOrigins({ origin: 'https://a.fr' })).toEqual([]);
  });
});

describe('conversions en motifs', () => {
  const stored = [{ origin: 'https://mon-nas.local:8443' }, { origin: 'https://autre.fr' }];

  it('produit des motifs sans port pour Firefox', () => {
    expect(toHostPatterns(stored)).toEqual(['https://mon-nas.local/*', 'https://autre.fr/*']);
  });

  it('produit des motifs avec port pour la vérification à l’exécution', () => {
    expect(toRuntimePatterns(stored)).toEqual(['https://mon-nas.local:8443/*', 'https://autre.fr:443/*']);
  });
});

// Régressions issues de l'audit sécurité du 08/09/2026 : chacun de ces cas
// faisait accorder par Firefox une autorisation plus large que l'adresse
// réellement déclarée par l'utilisateur.
describe('normalizeCustomOrigin — contournements du refus des jokers', () => {
  it('refuse un joker écrit sous forme encodée', () => {
    // %2A est l'écriture encodée de « * » : le refus appliqué au texte saisi
    // le laissait passer, et l'analyse d'URL le redécodait ensuite dans le nom
    // d'hôte — le motif demandé à Firefox devenait https://*.com/*.
    for (const input of ['https://%2A.com', 'https://%2A', '%2A.com', 'https://%2a.example.com']) {
      const result = normalizeCustomOrigin(input);
      expect(result.ok, input).toBe(false);
    }
  });

  it('refuse les noms de serveur aux caractères inattendus', () => {
    for (const input of ['https://mon_serveur.fr', 'https://serveur..fr', 'https://-serveur.fr']) {
      expect(normalizeCustomOrigin(input).ok, input).toBe(false);
    }
  });

  it('refuse une adresse IPv6 littérale, que Firefox ne sait pas autoriser', () => {
    const result = normalizeCustomOrigin('http://[::1]:5173');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('IPv6');
  });

  it('fixe le port implicite pour ne pas autoriser tous les ports du serveur', () => {
    // Sans port dans le motif d'exécution, `originMatchesPattern` n'en
    // comparait aucun : une autre application hébergée sur la même machine,
    // à un autre port, héritait du pont.
    expect(normalizeCustomOrigin('https://mon-nas.local').entry.runtimePattern).toBe('https://mon-nas.local:443/*');
    expect(normalizeCustomOrigin('http://localhost').entry.runtimePattern).toBe('http://localhost:80/*');
  });
});
