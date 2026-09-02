import { describe, expect, it } from 'vitest';
import {
  formatUnitPriceLabel,
  isUnitPriceBasisReliable,
  resolveUnitPriceBasis,
  unitPriceBasesComparable,
  unitPriceGapIsSignificant
} from './unitPriceArbitration';

describe('resolveUnitPriceBasis', () => {
  it('retient le prix au kilo affiché par le magasin quand il existe', () => {
    // Cas réel Hyper U (31/08) : la fiche affiche 4,39 €/kg pour 1 040 g à
    // 4,56 € — le calcul donnerait 4,38 €/kg. On garde la valeur du magasin.
    const basis = resolveUnitPriceBasis({
      priceEuro: 4.56,
      unitPriceEuro: 4.39,
      comparisonUnit: 'kilogram',
      quantity: 1040,
      unit: 'g'
    });

    expect(basis).toEqual({ unitPriceEuro: 4.39, comparisonUnit: 'kilogram', source: 'displayed' });
  });

  it('recalcule le prix au kilo depuis le format quand la fiche ne l’affiche pas', () => {
    const basis = resolveUnitPriceBasis({ priceEuro: 2.56, quantity: 375, unit: 'g' });

    expect(basis).toEqual({ unitPriceEuro: 6.83, comparisonUnit: 'kilogram', source: 'computed' });
  });

  it('recalcule un prix au litre depuis un volume', () => {
    const basis = resolveUnitPriceBasis({ priceEuro: 5.94, quantity: 6, unit: 'L' });

    expect(basis).toEqual({ unitPriceEuro: 0.99, comparisonUnit: 'liter', source: 'computed' });
  });

  it('ignore un prix au kilo affiché sans son unité — il serait indistinguable d’un prix au litre', () => {
    const basis = resolveUnitPriceBasis({ priceEuro: 2.56, unitPriceEuro: 6.83, quantity: 375, unit: 'g' });

    expect(basis?.source).toBe('computed');
  });

  it('ne rend aucune base pour un produit compté à la pièce', () => {
    expect(resolveUnitPriceBasis({ priceEuro: 2.5, quantity: 4, unit: 'unit' })).toBeNull();
  });

  it('ne rend aucune base quand le format est inconnu', () => {
    expect(resolveUnitPriceBasis({ priceEuro: 2.5 })).toBeNull();
  });

  it('ne rend aucune base pour un prix nul ou négatif', () => {
    expect(resolveUnitPriceBasis({ priceEuro: 0, quantity: 500, unit: 'g' })).toBeNull();
  });
});

describe('unitPriceBasesComparable', () => {
  it('refuse de comparer un prix au kilo à un prix au litre', () => {
    const poids = resolveUnitPriceBasis({ priceEuro: 2, quantity: 500, unit: 'g' });
    const volume = resolveUnitPriceBasis({ priceEuro: 2, quantity: 500, unit: 'ml' });

    expect(unitPriceBasesComparable(poids, volume)).toBe(false);
  });

  it('accepte deux prix au kilo', () => {
    const a = resolveUnitPriceBasis({ priceEuro: 2, quantity: 500, unit: 'g' });
    const b = resolveUnitPriceBasis({ priceEuro: 5, quantity: 1, unit: 'kg' });

    expect(unitPriceBasesComparable(a, b)).toBe(true);
  });

  it('refuse quand une seule base est connue', () => {
    const a = resolveUnitPriceBasis({ priceEuro: 2, quantity: 500, unit: 'g' });

    expect(unitPriceBasesComparable(a, null)).toBe(false);
  });
});

describe('isUnitPriceBasisReliable', () => {
  const displayed = { unitPriceEuro: 4.39, comparisonUnit: 'kilogram', source: 'displayed' } as const;
  const computed = { unitPriceEuro: 6.83, comparisonUnit: 'kilogram', source: 'computed' } as const;

  it.each([
    ['prix affiché sans format candidat', displayed, false, 'unknown', true],
    ['prix affiché avec format candidat', displayed, true, 'ok', true],
    ['prix calculé depuis un format connu', computed, true, 'unknown', true],
    ['prix calculé sans format prouvable', computed, false, 'unknown', false],
    ['prix affiché contradictoire', displayed, true, 'mismatch', false],
    ['prix calculé contradictoire', computed, true, 'mismatch', false]
  ] as const)('%s', (_label, basis, formatKnown, coherence, expected) => {
    expect(isUnitPriceBasisReliable(basis, formatKnown, coherence)).toBe(expected);
  });
});

describe('unitPriceGapIsSignificant', () => {
  const basis = (unitPriceEuro: number) =>
    ({ unitPriceEuro, comparisonUnit: 'kilogram', source: 'displayed' }) as const;

  it('retient un écart réel', () => {
    expect(unitPriceGapIsSignificant(basis(6.83), basis(4.39))).toBe(true);
  });

  it('ignore un écart qui tient à l’arrondi au centime', () => {
    expect(unitPriceGapIsSignificant(basis(4.39), basis(4.4))).toBe(false);
  });
});

describe('formatUnitPriceLabel', () => {
  it('écrit l’unité telle que les enseignes l’affichent', () => {
    expect(formatUnitPriceLabel(resolveUnitPriceBasis({ priceEuro: 5.94, quantity: 6, unit: 'L' })!)).toBe('0.99 €/L');
    expect(formatUnitPriceLabel(resolveUnitPriceBasis({ priceEuro: 2.56, quantity: 375, unit: 'g' })!)).toBe(
      '6.83 €/kg'
    );
  });
});
