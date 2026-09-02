import { describe, expect, it } from 'vitest';
import { demoProducts } from '../../db/seed';
import { getCandidateConfidence, requiresValidation } from './scoring';

const product = demoProducts[0];

describe('scoring', () => {
  it('scores an exact barcode match at 100', () => {
    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        barcode: product.barcode,
        matchType: 'exact_barcode',
        confidenceScore: 80
      })
    ).toBe(100);
  });

  it('keeps same-brand different-format candidates high but below exact matches', () => {
    const score = getCandidateConfidence(product, {
      productId: product.id,
      brand: product.brand,
      variant: product.variant,
      quantity: 2,
      matchType: 'same_brand_different_format',
      confidenceScore: 85
    });

    expect(score).toBeGreaterThanOrEqual(85);
    expect(score).toBeLessThan(100);
  });

  it('requires validation below the confidence threshold', () => {
    expect(requiresValidation({ confidenceScore: 72, matchType: 'private_label' }, 75)).toBe(true);
  });

  it("donne 100% à un candidat confirmé manuellement (manual_override), quel que soit son recouvrement de noms", () => {
    // Le confidenceScore stocké sur un candidat manual_override reflète un
    // simple recouvrement de noms côté extension (peut être bas, voire 0) —
    // il doit être ignoré, pas juste plafonné (clampScore aurait renvoyé 12).
    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        matchType: 'manual_override',
        confidenceScore: 12
      })
    ).toBe(100);
  });

  it('un candidat confirmé manuellement ne demande plus de validation, même avec un seuil élevé et un recouvrement de noms faible', () => {
    // Reproduit le pipeline réel de buildOptionsForRow : confidenceScore
    // brut bas (12, comme un pick manuel sur une carte au nom différent),
    // passé d'abord par getCandidateConfidence (→ 100), puis requiresValidation.
    const candidate = { matchType: 'manual_override' as const, confidenceScore: 12 };
    const confidence = getCandidateConfidence(product, { productId: product.id, ...candidate });
    expect(requiresValidation({ ...candidate, confidenceScore: confidence }, 90)).toBe(false);
  });

  it('keeps private-label candidates conservative until manually validated', () => {
    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        brand: 'Marque distributeur',
        variant: product.variant,
        matchType: 'private_label',
        confidenceScore: 72
      })
    ).toBe(72);
  });

  it('requires validation for uncertain candidates', () => {
    expect(requiresValidation({ confidenceScore: 80, matchType: 'uncertain' }, 75)).toBe(true);
  });

  it("ne renvoie jamais 100% pour un matchType 'exact_barcode' sans code-barres produit réellement identique", () => {
    // Le collecteur peut affirmer `exact_barcode` sans preuve (score de
    // recouvrement de noms qui atteint 1.0 par coïncidence) — la confiance
    // ne doit monter à 100 que si les deux codes-barres coïncident vraiment.
    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        // Pas de barcode observé du tout sur la fiche candidate.
        matchType: 'exact_barcode',
        confidenceScore: 100
      })
    ).toBeLessThanOrEqual(89);

    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        barcode: '0000000000000', // différent du vrai code-barres du produit
        matchType: 'exact_barcode',
        confidenceScore: 100
      })
    ).toBeLessThanOrEqual(89);
  });

  it('ne remonte jamais artificiellement un score faible (plus de plancher à 50/85)', () => {
    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        brand: 'Une autre marque',
        matchType: 'private_label',
        confidenceScore: 12
      })
    ).toBe(12);

    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        matchType: 'equivalent_brand',
        confidenceScore: 20
      })
    ).toBe(20);

    expect(
      getCandidateConfidence(product, {
        productId: product.id,
        matchType: 'same_brand_different_format',
        confidenceScore: 10
      })
    ).toBe(10);
  });

  it('respecte allowPrivateLabel=false en ramenant la confiance à 0', () => {
    const strictProduct = { ...product, allowPrivateLabel: false };
    expect(
      getCandidateConfidence(strictProduct, {
        productId: product.id,
        matchType: 'private_label',
        confidenceScore: 89
      })
    ).toBe(0);
  });

  it('respecte allowDifferentFormat=false en plafonnant à 84 (jamais au-dessus du bon format)', () => {
    const strictProduct = { ...product, allowDifferentFormat: false };
    expect(
      getCandidateConfidence(strictProduct, {
        productId: product.id,
        brand: product.brand,
        variant: product.variant,
        matchType: 'same_brand_different_format',
        confidenceScore: 95
      })
    ).toBeLessThanOrEqual(84);
  });

  // Étape 4 du plan de fiabilisation : une quantité désirée > 1 sur un
  // candidat au format non garanti (lot différent, MDD, marque équivalente)
  // doit être bloquée en validation manuelle, même à haute confiance — sinon
  // la quantité envoyée au panier peut correspondre à un nombre d'unités
  // réel totalement différent de l'intention de l'utilisateur.
  describe('requiresValidation — blocage sur quantité > 1 à format non garanti', () => {
    it('bloque un candidat same_brand_different_format à haute confiance dès que wantedQuantity > 1', () => {
      expect(requiresValidation({ confidenceScore: 95, matchType: 'same_brand_different_format' }, 75, 2)).toBe(true);
    });

    it('bloque un candidat private_label à haute confiance dès que wantedQuantity > 1', () => {
      expect(requiresValidation({ confidenceScore: 95, matchType: 'private_label' }, 75, 3)).toBe(true);
    });

    it('bloque un candidat equivalent_brand à haute confiance dès que wantedQuantity > 1', () => {
      expect(requiresValidation({ confidenceScore: 95, matchType: 'equivalent_brand' }, 75, 2)).toBe(true);
    });

    it('ne bloque pas ces mêmes candidats à wantedQuantity 1 (comportement inchangé)', () => {
      expect(requiresValidation({ confidenceScore: 95, matchType: 'same_brand_different_format' }, 75, 1)).toBe(false);
      expect(requiresValidation({ confidenceScore: 95, matchType: 'private_label' }, 75, 1)).toBe(false);
      expect(requiresValidation({ confidenceScore: 95, matchType: 'equivalent_brand' }, 75, 1)).toBe(false);
    });

    it('ne bloque pas non plus quand wantedQuantity n’est pas fourni du tout (valeur par défaut = 1, aucun appel existant cassé)', () => {
      expect(requiresValidation({ confidenceScore: 95, matchType: 'private_label' }, 75)).toBe(false);
    });

    it('ne bloque jamais un exact_barcode prouvé, même avec wantedQuantity > 1 (format garanti identique)', () => {
      expect(requiresValidation({ confidenceScore: 95, matchType: 'exact_barcode' }, 75, 5)).toBe(false);
    });
  });
});
