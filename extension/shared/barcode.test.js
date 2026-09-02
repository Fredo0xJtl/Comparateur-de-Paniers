import { describe, expect, it } from 'vitest';
import { findEanInText, isValidEan, normalizeEan } from './barcode.js';

describe('normalizeEan', () => {
  it('accepte les GTIN réels rencontrés en conditions réelles', () => {
    // EAN-13 relevés lors des diagnostics du 2026-08-28 (fiches coursesu.com).
    expect(normalizeEan('3256224234494')).toBe('3256224234494');
    expect(normalizeEan('3228022120040')).toBe('3228022120040');
    // Références publiques classiques : Coca-Cola (EAN-13), EAN-8, UPC-A, GTIN-14.
    expect(normalizeEan('5449000000996')).toBe('5449000000996');
    expect(normalizeEan('73513537')).toBe('73513537');
    expect(normalizeEan('012345678905')).toBe('012345678905');
    expect(normalizeEan('01234567890128')).toBe('01234567890128');
  });

  it('tolère espaces et tirets de mise en forme', () => {
    expect(normalizeEan('3256224 234494')).toBe('3256224234494');
    expect(normalizeEan('5449-0000-00996')).toBe('5449000000996');
  });

  it('rejette une clé de contrôle incorrecte', () => {
    // Même code que ci-dessus, dernier chiffre modifié.
    expect(normalizeEan('3256224234495')).toBeUndefined();
    expect(normalizeEan('5449000000997')).toBeUndefined();
  });

  it('rejette les longueurs non normalisées', () => {
    expect(normalizeEan('123456789')).toBeUndefined();
    expect(normalizeEan('1234567890')).toBeUndefined();
    expect(normalizeEan('12345678901')).toBeUndefined();
    expect(normalizeEan('1234567')).toBeUndefined();
    expect(normalizeEan('123456789012345')).toBeUndefined();
  });

  it('rejette les valeurs non numériques ou vides', () => {
    expect(normalizeEan('')).toBeUndefined();
    expect(normalizeEan(null)).toBeUndefined();
    expect(normalizeEan(undefined)).toBeUndefined();
    expect(normalizeEan('unknown')).toBeUndefined();
    expect(normalizeEan('EAN 3256224234494')).toBeUndefined();
  });

  it('isValidEan est la variante booléenne', () => {
    expect(isValidEan('3256224234494')).toBe(true);
    expect(isValidEan('3256224234495')).toBe(false);
  });
});

describe('findEanInText', () => {
  it('extrait le premier GTIN valide du texte', () => {
    expect(findEanInText('Lait demi-écrémé 6x1L — EAN 3256224234494 — 5,64 €')).toBe('3256224234494');
  });

  it('ignore les suites de chiffres qui ne sont pas des codes-barres', () => {
    // Cas réel visé : numéro de téléphone du pied de page, référence interne,
    // identifiant de commande — tous captés par l'ancien /\b\d{8,14}\b/.
    expect(findEanInText('Service client 0980980990 — réf. interne 20260828')).toBeUndefined();
  });

  it('saute un faux positif pour retenir le vrai EAN plus loin', () => {
    expect(findEanInText('Commande 20260828 — code-barres 5449000000996')).toBe('5449000000996');
  });

  it('renvoie undefined sur un texte sans chiffres exploitables', () => {
    expect(findEanInText('Aucun code ici')).toBeUndefined();
    expect(findEanInText('')).toBeUndefined();
    expect(findEanInText(null)).toBeUndefined();
  });
});
