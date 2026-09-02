import { describe, expect, it } from 'vitest';
import { checkPriceCoherence } from './priceCoherence';

describe('checkPriceCoherence', () => {
  describe('cas cohérents', () => {
    it('valide un prix au litre exact', () => {
      // 6 briques de 1 L à 5,64 € → 0,94 €/L, valeur affichée à l'identique.
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'L',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('ok');
    });

    it('valide un prix au kilo exact', () => {
      // Emmental râpé 150 g à 2,42 € → 16,13 €/kg, affiché 16,14 (arrondi).
      expect(
        checkPriceCoherence({
          priceEuro: 2.42,
          unitPriceEuro: 16.14,
          unitPriceUnit: 'kg',
          observedQuantity: 150,
          observedUnit: 'g'
        })
      ).toBe('ok');
    });

    it('accepte un écart sous la tolérance de 5 %', () => {
      // 1 kg à 3,00 € → 3,00 €/kg réels, affiché 3,10 (écart 3,3 %).
      expect(
        checkPriceCoherence({
          priceEuro: 3.0,
          unitPriceEuro: 3.1,
          unitPriceUnit: 'kg',
          observedQuantity: 1000,
          observedUnit: 'g'
        })
      ).toBe('ok');
    });

    it('accepte une quantité exprimée en unité large (kg) côté observation', () => {
      expect(
        checkPriceCoherence({
          priceEuro: 3.0,
          unitPriceEuro: 3.0,
          unitPriceUnit: 'kg',
          observedQuantity: 1,
          observedUnit: 'kg'
        })
      ).toBe('ok');
    });
  });

  describe('cas incohérents', () => {
    it("signale le prix au litre retenu à la place du prix de l'article", () => {
      // Régression réelle (26-27/08) : le collecteur retenait "1,05 € / l"
      // comme prix total d'un pack de 6 L. Le contrôle croisé le voit tout de
      // suite : 1,05 € ÷ 6 L = 0,175 €/L, très loin des 1,05 €/L affichés.
      expect(
        checkPriceCoherence({
          priceEuro: 1.05,
          unitPriceEuro: 1.05,
          unitPriceUnit: 'L',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('mismatch');
    });

    it("signale le prix d'un produit voisin capturé à la place du bon", () => {
      // Régression réelle (27/08) : 4,65 € capturés sur un carrousel de
      // substituts alors que la fiche affichait 5,94 € pour 6 L (0,99 €/L).
      expect(
        checkPriceCoherence({
          priceEuro: 4.65,
          unitPriceEuro: 0.99,
          unitPriceUnit: 'L',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('mismatch');
    });

    it('signale un écart juste au-dessus de la tolérance', () => {
      // 1 kg à 3,00 € → 3,00 €/kg, affiché 3,20 (écart 6,3 % > 5 %).
      expect(
        checkPriceCoherence({
          priceEuro: 3.0,
          unitPriceEuro: 3.2,
          unitPriceUnit: 'kg',
          observedQuantity: 1000,
          observedUnit: 'g'
        })
      ).toBe('mismatch');
    });
  });

  describe('garde-fou sur les prix unitaires faibles', () => {
    it("ne signale rien quand l'écart s'explique par l'arrondi d'affichage", () => {
      // 10 L à 0,50 € → 0,05 €/L exactement, affiché 0,054 €/L : 7,4 %
      // d'écart, donc au-dessus de la tolérance de base de 5 %. Mais à ce
      // niveau de prix l'arrondi au centime vaut à lui seul 9,3 % — l'écart
      // observé ne prouve donc aucune erreur d'extraction. Sans ce garde-fou,
      // tous les produits bon marché au litre seraient signalés à tort.
      expect(
        checkPriceCoherence({
          priceEuro: 0.5,
          unitPriceEuro: 0.054,
          unitPriceUnit: 'L',
          observedQuantity: 10000,
          observedUnit: 'ml'
        })
      ).toBe('ok');
    });

    it('signale malgré tout un écart qui dépasse largement la marge d’arrondi', () => {
      expect(
        checkPriceCoherence({
          priceEuro: 1.0,
          unitPriceEuro: 0.5,
          unitPriceUnit: 'L',
          observedQuantity: 10000,
          observedUnit: 'ml'
        })
      ).toBe('mismatch');
    });
  });

  describe('silence en cas de doute', () => {
    it('reste muet sans prix unitaire — le cas le plus fréquent', () => {
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
    });

    it("reste muet sans unité de référence : on ignore s'il faut diviser par des litres ou des kilos", () => {
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0.94,
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
    });

    it('reste muet sans format observé', () => {
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'L'
        })
      ).toBe('unknown');
    });

    it("reste muet sur un produit compté à la pièce, qui n'a pas de grammage", () => {
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'L',
          observedQuantity: 6,
          observedUnit: 'unit'
        })
      ).toBe('unknown');
    });

    it('reste muet quand un poids est confronté à un prix au litre', () => {
      // Signe d'une extraction ratée d'un côté ou de l'autre, pas d'un écart
      // de prix — accuser ici produirait un faux avertissement.
      expect(
        checkPriceCoherence({
          priceEuro: 2.42,
          unitPriceEuro: 16.14,
          unitPriceUnit: 'L',
          observedQuantity: 150,
          observedUnit: 'g'
        })
      ).toBe('unknown');
    });

    it('reste muet quand un volume est confronté à un prix au kilo', () => {
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'kg',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
    });

    it('reste muet sur des valeurs aberrantes', () => {
      expect(
        checkPriceCoherence({
          priceEuro: 0,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'L',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0,
          unitPriceUnit: 'L',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
      expect(
        checkPriceCoherence({
          priceEuro: Number.NaN,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'L',
          observedQuantity: 6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
      expect(
        checkPriceCoherence({
          priceEuro: 5.64,
          unitPriceEuro: 0.94,
          unitPriceUnit: 'L',
          observedQuantity: -6000,
          observedUnit: 'ml'
        })
      ).toBe('unknown');
    });
  });
});
