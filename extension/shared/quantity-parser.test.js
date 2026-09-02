import { describe, expect, it } from 'vitest';
import { parseQuantityFromName, normalizeQuantity, quantitiesMatch } from './quantity-parser.js';

describe('parseQuantityFromName', () => {
  it('extrait un poids simple en grammes', () => {
    expect(parseQuantityFromName('Purée Mousline nature 1040g')).toEqual({ quantity: 1040, unit: 'g' });
  });

  it('extrait un poids en kilogrammes et le normalise en grammes', () => {
    expect(parseQuantityFromName('Riz basmati 1 kg')).toEqual({ quantity: 1000, unit: 'g' });
  });

  it('extrait un volume en litres et le normalise en ml', () => {
    expect(parseQuantityFromName('Lait demi-écrémé 1L')).toEqual({ quantity: 1000, unit: 'ml' });
  });

  it('extrait un volume en centilitres et le normalise en ml', () => {
    expect(parseQuantityFromName('Coca-Cola 33cl')).toEqual({ quantity: 330, unit: 'ml' });
  });

  it('extrait un format multiplicateur et calcule le total', () => {
    expect(parseQuantityFromName('Riz basmati Lustucru 10min - 5x180g')).toEqual({ quantity: 900, unit: 'g' });
  });

  it('extrait un format multiplicateur en litres', () => {
    expect(parseQuantityFromName('Eau minérale 6x1.5L')).toEqual({ quantity: 9000, unit: 'ml' });
  });

  it('gère la virgule décimale', () => {
    expect(parseQuantityFromName('Huile olive 1,5L')).toEqual({ quantity: 1500, unit: 'ml' });
  });

  it('retourne null quand aucun format reconnaissable', () => {
    expect(parseQuantityFromName('Purée Mousline nature 4 personnes')).toBeNull();
  });

  it('retourne null pour un nom vide', () => {
    expect(parseQuantityFromName('')).toBeNull();
    expect(parseQuantityFromName(undefined)).toBeNull();
  });
});

describe('normalizeQuantity', () => {
  it('normalise un format déjà séparé (kg -> g)', () => {
    expect(normalizeQuantity(1, 'kg')).toEqual({ quantity: 1000, unit: 'g' });
  });

  it('normalise un format déjà séparé (L -> ml)', () => {
    expect(normalizeQuantity(1.5, 'L')).toEqual({ quantity: 1500, unit: 'ml' });
  });

  it("retourne null pour l'unité 'unit' (pas de format cible comparable)", () => {
    expect(normalizeQuantity(1, 'unit')).toBeNull();
  });

  it('retourne null pour une quantité invalide', () => {
    expect(normalizeQuantity(0, 'g')).toBeNull();
    expect(normalizeQuantity(-5, 'g')).toBeNull();
  });
});

describe('quantitiesMatch', () => {
  it('vrai pour deux formats identiques', () => {
    expect(quantitiesMatch({ quantity: 1000, unit: 'g' }, { quantity: 1000, unit: 'g' })).toBe(true);
  });

  it('vrai dans la tolérance de 5% (arrondi OFF vs site marchand)', () => {
    expect(quantitiesMatch({ quantity: 1000, unit: 'g' }, { quantity: 1030, unit: 'g' })).toBe(true);
  });

  it('faux hors tolérance (cas réel Mousline 375g vs 1040g)', () => {
    expect(quantitiesMatch({ quantity: 375, unit: 'g' }, { quantity: 1040, unit: 'g' })).toBe(false);
  });

  it('faux entre deux unités différentes (poids vs volume)', () => {
    expect(quantitiesMatch({ quantity: 1000, unit: 'g' }, { quantity: 1000, unit: 'ml' })).toBe(false);
  });

  it('faux si un des deux formats est absent', () => {
    expect(quantitiesMatch(null, { quantity: 1000, unit: 'g' })).toBe(false);
    expect(quantitiesMatch({ quantity: 1000, unit: 'g' }, undefined)).toBe(false);
  });
});

describe('Lots écrits en toutes lettres ("6 briques de 1L")', () => {
  // Bug relevé en conditions réelles le 31/08/2026 sur une collecte Hyper U :
  // "Lait UHT demi écrémé - 6 briques de 1L" était lu 1 L au lieu de 6 L. La
  // quantité se trouvait divisée par la taille du lot, donc le prix au litre
  // calculé multiplié d'autant — le comparateur voyait 5,94 €/L au lieu de
  // 0,99 €/L et désignait l'autre magasin comme moins cher alors qu'il
  // l'était moins. C'est le contrôle croisé prix / prix au litre qui l'a
  // révélé (src/features/comparison/priceCoherence.ts).
  it('multiplie par le nombre de contenants', () => {
    expect(parseQuantityFromName('Lait UHT demi écrémé - 6 briques de 1L')).toEqual({
      quantity: 6000,
      unit: 'ml'
    });
    expect(parseQuantityFromName('Eau de source 6 bouteilles de 1,5L')).toEqual({
      quantity: 9000,
      unit: 'ml'
    });
    expect(parseQuantityFromName('Yaourt nature 4 pots de 125g')).toEqual({
      quantity: 500,
      unit: 'g'
    });
    expect(parseQuantityFromName('Sauce tomate 3 boîtes de 400g')).toEqual({
      quantity: 1200,
      unit: 'g'
    });
    expect(parseQuantityFromName('Soda pack de 6 canettes de 33cl')).toEqual({
      quantity: 1980,
      unit: 'ml'
    });
  });

  it('ne multiplie pas quand "de" est absent : le poids est celui du lot', () => {
    // "6 tranches 200g" = 200 g au total, pas 200 g par tranche. Multiplier
    // au jugé produirait un format six fois trop grand, ce qui est pire que
    // pas de format du tout — le reste du module sait traiter l'absence.
    expect(parseQuantityFromName('Jambon 6 tranches 200g')).toEqual({ quantity: 200, unit: 'g' });
  });

  it('laisse inchangés les formats déjà correctement lus', () => {
    expect(parseQuantityFromName('Lait demi écrémé UHT 6x1l')).toEqual({ quantity: 6000, unit: 'ml' });
    expect(parseQuantityFromName('Lait bio 6 x 1 L')).toEqual({ quantity: 6000, unit: 'ml' });
    expect(parseQuantityFromName('Emmental râpé PRESIDENT - 200g')).toEqual({ quantity: 200, unit: 'g' });
    expect(parseQuantityFromName('Purée Mousline nature 4 personnes 1040g')).toEqual({
      quantity: 1040,
      unit: 'g'
    });
  });
});
