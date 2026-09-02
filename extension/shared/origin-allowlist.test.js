import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, originMatchesPattern } from './origin-allowlist.js';

describe('originMatchesPattern', () => {
  it('accepte une origine exacte pour un motif https simple', () => {
    expect(originMatchesPattern('https://fredo0xjtl.github.io', 'https://fredo0xjtl.github.io/*')).toBe(true);
  });

  it("rejette une origine dont l'hôte diffère", () => {
    expect(originMatchesPattern('https://attaquant.example', 'https://fredo0xjtl.github.io/*')).toBe(false);
  });

  it("rejette une origine dont le schéma diffère (http vs https)", () => {
    expect(originMatchesPattern('http://fredo0xjtl.github.io', 'https://fredo0xjtl.github.io/*')).toBe(false);
  });

  it('accepte un sous-domaine avec un motif "*.exemple.com"', () => {
    expect(originMatchesPattern('https://app.exemple.com', 'https://*.exemple.com/*')).toBe(true);
    expect(originMatchesPattern('https://exemple.com', 'https://*.exemple.com/*')).toBe(true);
  });

  it("rejette un domaine non apparenté même s'il se termine pareil", () => {
    expect(originMatchesPattern('https://pas-exemple.com', 'https://*.exemple.com/*')).toBe(false);
  });

  it('ignore le port (non restreint par la syntaxe des motifs de match)', () => {
    expect(originMatchesPattern('http://localhost:5173', 'http://localhost/*')).toBe(true);
  });

  it('respecte un port explicite quand un build de diagnostic en déclare un', () => {
    expect(originMatchesPattern('https://192.168.99.15:5174', 'https://192.168.99.15:5174/*')).toBe(true);
    expect(originMatchesPattern('https://192.168.99.15:4174', 'https://192.168.99.15:5174/*')).toBe(false);
  });

  it('retourne false sur une origine invalide plutôt que de lever', () => {
    expect(originMatchesPattern('pas-une-url', 'https://fredo0xjtl.github.io/*')).toBe(false);
  });
});

describe('isAllowedOrigin', () => {
  const manifestPatterns = [
    'http://localhost/*',
    'http://127.0.0.1/*',
    'https://192.168.99.15/*',
    'https://fredo0xjtl.github.io/Comparateur-de-Paniers/*'
  ];

  it("autorise l'origine de production (GitHub Pages)", () => {
    expect(isAllowedOrigin('https://fredo0xjtl.github.io', manifestPatterns)).toBe(true);
  });

  it('autorise les origines de dev présentes dans le manifest actif', () => {
    expect(isAllowedOrigin('http://localhost:5173', manifestPatterns)).toBe(true);
    expect(isAllowedOrigin('https://192.168.99.15:5173', manifestPatterns)).toBe(true);
  });

  // Scénario réel visé par ce garde (audit du 30/08) : une page servie sur
  // une AUTRE IP privée / un autre port local, ou un domaine quelconque, ne
  // doit jamais pouvoir piloter le connecteur en imitant simplement la
  // balise <meta> attendue par le bridge.
  it("rejette une origine qui ne correspond à AUCUN motif du manifest (page tierce imitant la balise meta)", () => {
    expect(isAllowedOrigin('https://page-attaquante.example', manifestPatterns)).toBe(false);
    expect(isAllowedOrigin('http://192.168.99.99:8080', manifestPatterns)).toBe(false);
  });

  it('rejette une origine vide/absente', () => {
    expect(isAllowedOrigin('', manifestPatterns)).toBe(false);
    expect(isAllowedOrigin(null, manifestPatterns)).toBe(false);
    expect(isAllowedOrigin(undefined, manifestPatterns)).toBe(false);
  });

  // Build de production (extension:build:firefox, sans --dev) : les
  // origines de dev sont retirées du manifest embarqué — ce test vérifie
  // que la liste blanche suit bien cette réduction plutôt que d'autoriser
  // par défaut ce qui n'est plus déclaré.
  it("suit la réduction du manifest en build de production (origines de dev absentes)", () => {
    const productionPatterns = ['https://fredo0xjtl.github.io/Comparateur-de-Paniers/*'];
    expect(isAllowedOrigin('https://fredo0xjtl.github.io', productionPatterns)).toBe(true);
    expect(isAllowedOrigin('http://localhost:5173', productionPatterns)).toBe(false);
  });
});
