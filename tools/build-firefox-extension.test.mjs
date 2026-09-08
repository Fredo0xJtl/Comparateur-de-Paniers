import { describe, expect, it } from 'vitest';
import { computeBridgeOriginPatterns, configureBridgeOrigins } from './build-firefox-extension.mjs';
import { findPortedContentScriptMatches } from './validate-extension.mjs';

const manifest = {
  name: 'Drive Price Splitter Connector',
  host_permissions: ['https://*.leclercdrive.fr/*'],
  browser_specific_settings: {
    gecko: {
      id: 'drive-price-splitter@fredo0xjtl.github.io'
    }
  },
  content_scripts: [{ matches: ['https://fredo0xjtl.github.io/Comparateur-de-Paniers/*'], js: ['bridge/pwa-bridge.js'] }]
};

describe('configureBridgeOrigins', () => {
  it('garde la source de production sans origine locale', () => {
    expect(configureBridgeOrigins(manifest, { dev: false, lanAddresses: ['192.168.99.18'] }))
      .toEqual(manifest);
  });

  it('génère les origines de test depuis la machine au lieu de figer une IP personnelle', () => {
    const configured = configureBridgeOrigins(manifest, { dev: true, lanAddresses: ['192.168.99.18'] });
    expect(configured.name).toBe('Drive Price Splitter Connector (dev)');
    expect(configured.browser_specific_settings.gecko.id).toBe('drive-price-splitter-localtest@fredo0xjtl.github.io');
    expect(configured.host_permissions).toEqual(expect.arrayContaining([
      'https://*.leclercdrive.fr/*',
      'https://192.168.99.18/*'
    ]));
    expect(configured.content_scripts[0].matches).toEqual(expect.arrayContaining([
      'https://fredo0xjtl.github.io/Comparateur-de-Paniers/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
      'https://192.168.99.18/*'
    ]));
  });

  // Régression du 01/09 : --dev-port écrivait le port dans
  // content_scripts.matches. Firefox n'accepte aucun port dans un match
  // pattern (bugs Mozilla 1362809 / 1468162), rejette le motif, et le
  // bridge n'est alors JAMAIS injecté : la PWA affiche "Extension Drive
  // indisponible" alors que l'extension est bien installée.
  it('ne met jamais de numéro de port dans les match patterns du manifest', () => {
    const configured = configureBridgeOrigins(manifest, {
      dev: true,
      port: '5174',
      lanAddresses: ['192.168.99.18']
    });

    expect(configured.name).toBe('Drive Price Splitter Connector (dev :5174)');
    expect(findPortedContentScriptMatches(configured)).toEqual([]);
    expect(configured.content_scripts[0].matches).toContain('https://192.168.99.18/*');
    expect(configured.content_scripts[0].matches).toContain('http://localhost/*');
  });

  // Bug réel : `web-ext lint` (donc AMO) rejette tout `name` de plus de 45
  // caractères. Le vrai nom du manifest (41) ne laissait quasiment aucune
  // marge pour le suffixe "(dev :<port>)" — un build --dev-port avec le nom
  // réel du projet ne pouvait plus être soumis. Vérifié avec un port à 4
  // chiffres, le cas le plus large déjà rencontré.
  it('ne dépasse jamais la limite de 45 caractères du champ name', () => {
    const realNameManifest = { ...manifest, name: 'Comparateur de Paniers — Connecteur Drive' };
    const configured = configureBridgeOrigins(realNameManifest, {
      dev: true,
      port: '8443',
      lanAddresses: []
    });

    expect(configured.name.length).toBeLessThanOrEqual(45);
    expect(configured.name.endsWith('(dev :8443)')).toBe(true);
  });

  it('garde les host permissions dev sans port', () => {
    const configured = configureBridgeOrigins(manifest, {
      dev: true,
      port: '5174',
      lanAddresses: ['192.168.99.18']
    });

    expect(configured.host_permissions).toContain('https://192.168.99.18/*');
    expect(configured.host_permissions).not.toContain('https://192.168.99.18:5174/*');
  });
});

describe('configureBridgeOrigins avec explicitOnly', () => {
  it('ne garde que les origines explicites, sans localhost ni IP LAN du poste', () => {
    const previous = process.env.DRIVE_DEV_ORIGINS;
    process.env.DRIVE_DEV_ORIGINS = 'https://raspberrypi.local:8443';
    try {
      const configured = configureBridgeOrigins(manifest, {
        dev: true,
        port: '8443',
        lanAddresses: ['192.168.99.18'],
        explicitOnly: true
      });
      const patterns = computeBridgeOriginPatterns(manifest, {
        dev: true,
        port: '8443',
        lanAddresses: ['192.168.99.18'],
        explicitOnly: true
      });

      expect(configured.host_permissions).toEqual(expect.arrayContaining(['https://raspberrypi.local/*']));
      expect(configured.host_permissions).not.toContain('http://localhost/*');
      expect(configured.host_permissions).not.toContain('https://192.168.99.18/*');
      expect(configured.content_scripts[0].matches).not.toContain('http://localhost/*');
      expect(configured.content_scripts[0].matches).not.toContain('https://192.168.99.18/*');
      expect(patterns).toContain('https://raspberrypi.local:8443/*');
      expect(patterns).not.toContain('http://localhost:8443/*');
      expect(patterns).not.toContain('https://192.168.99.18:8443/*');
    } finally {
      if (previous === undefined) delete process.env.DRIVE_DEV_ORIGINS;
      else process.env.DRIVE_DEV_ORIGINS = previous;
    }
  });
});

describe('computeBridgeOriginPatterns', () => {
  // C'est cette liste, appliquée à l'exécution par le service worker, qui
  // porte la restriction de port que le manifest ne peut pas exprimer.
  it('restreint les origines de dev au port demandé', () => {
    const patterns = computeBridgeOriginPatterns(manifest, {
      dev: true,
      port: '5174',
      lanAddresses: ['192.168.99.18']
    });

    expect(patterns).toContain('https://192.168.99.18:5174/*');
    expect(patterns).toContain('http://localhost:5174/*');
    expect(patterns).toContain('https://fredo0xjtl.github.io/Comparateur-de-Paniers/*');
    expect(patterns).not.toContain('http://localhost/*');
  });

  it('laisse tout port passer sur un build --dev sans port', () => {
    const patterns = computeBridgeOriginPatterns(manifest, { dev: true, lanAddresses: ['192.168.99.18'] });

    expect(patterns).toContain('http://localhost/*');
    expect(findPortedContentScriptMatches({ content_scripts: [{ matches: patterns }] })).toEqual([]);
  });

  it('ne laisse aucune origine de dev dans un build de production', () => {
    const patterns = computeBridgeOriginPatterns(manifest, { dev: false, lanAddresses: ['192.168.99.18'] });

    expect(patterns).toEqual(['https://fredo0xjtl.github.io/Comparateur-de-Paniers/*']);
  });

  // Piège subtil : DRIVE_DEV_ORIGINS est tapé à la main et contient
  // naturellement un port. Il doit finir sans port dans le manifest (sinon
  // Firefox rejette le motif et le bridge disparaît) mais avec son port dans
  // la liste d'exécution.
  it('retire le port des origines explicites côté manifest et le garde côté exécution', () => {
    const previous = process.env.DRIVE_DEV_ORIGINS;
    process.env.DRIVE_DEV_ORIGINS = 'https://192.168.99.15:5174';
    try {
      const configured = configureBridgeOrigins(manifest, { dev: true, port: '5174', lanAddresses: [] });
      const patterns = computeBridgeOriginPatterns(manifest, { dev: true, port: '5174', lanAddresses: [] });

      expect(findPortedContentScriptMatches(configured)).toEqual([]);
      expect(configured.content_scripts[0].matches).toContain('https://192.168.99.15/*');
      expect(patterns).toContain('https://192.168.99.15:5174/*');
    } finally {
      if (previous === undefined) delete process.env.DRIVE_DEV_ORIGINS;
      else process.env.DRIVE_DEV_ORIGINS = previous;
    }
  });
});
