import { describe, expect, it } from 'vitest';
import { computeBasketSavings, findReferenceStore } from './basketSavings';
import { type ComparisonDecision, type ComparisonResult } from './comparisonEngine';

type Line = { itemId: string; leclerc?: number; hyperu?: number };

// Construit le minimum du résultat de comparaison dont le calcul a besoin.
function buildResult(lines: Line[]) {
  const coverageFor = (storeKey: 'leclerc' | 'hyperu') => {
    const storeLines = lines.map((line) =>
      line[storeKey] !== undefined
        ? { itemId: line.itemId, productId: `p-${line.itemId}`, status: 'priced' as const, price: line[storeKey] }
        : { itemId: line.itemId, productId: `p-${line.itemId}`, status: 'notFound' as const }
    );
    const priced = storeLines.filter((line) => line.status === 'priced');
    return {
      total: priced.length > 0 ? priced.reduce((sum, line) => sum + (line.price ?? 0), 0) : null,
      coverage: { covered: priced.length, total: lines.length, lines: storeLines }
    };
  };
  const leclerc = coverageFor('leclerc');
  const hyperu = coverageFor('hyperu');
  return {
    totals: { leclerc: leclerc.total, hyperu: hyperu.total, optimized: null },
    coverage: { leclerc: leclerc.coverage, hyperu: hyperu.coverage },
    excludedLines: []
  } as unknown as Pick<ComparisonResult, 'totals' | 'coverage' | 'excludedLines'>;
}

const decision = (itemId: string, price: number | undefined) => ({ itemId, price }) as ComparisonDecision;

describe('computeBasketSavings', () => {
  it('donne, sur les deux paniers réunis, exactement l’économie du panier réparti', () => {
    // A : 1 € de moins chez Leclerc. B : 1 € de moins chez Hyper U.
    // Tout chez Leclerc = 5 €, tout chez Hyper U = 5 €, réparti = 4 €.
    const result = buildResult([
      { itemId: 'a', leclerc: 2, hyperu: 3 },
      { itemId: 'b', leclerc: 3, hyperu: 2 }
    ]);
    const leclercBasket = computeBasketSavings(result, [decision('a', 2)]);
    const hyperuBasket = computeBasketSavings(result, [decision('b', 2)]);
    // L'ancienne formule enregistrait 1 € + 1 € = 2 €.
    expect(leclercBasket + hyperuBasket).toBe(1);
  });

  it('ne compte aucune économie quand tout est acheté dans le magasin de référence', () => {
    const result = buildResult([
      { itemId: 'a', leclerc: 2, hyperu: 3 },
      { itemId: 'b', leclerc: 3, hyperu: 3.5 }
    ]);
    expect(findReferenceStore(result)).toBe('leclerc');
    expect(computeBasketSavings(result, [decision('a', 2), decision('b', 3)])).toBe(0);
  });

  it('enregistre un surcoût quand le produit retenu coûte plus cher que dans le magasin de référence', () => {
    // Grand format retenu pour son prix au kilo : 5 € au lieu de 3 €.
    const result = buildResult([{ itemId: 'a', leclerc: 3, hyperu: 5 }]);
    expect(computeBasketSavings(result, [decision('a', 5)])).toBe(-2);
  });

  it('renvoie 0 quand aucun magasin ne couvre toute la liste', () => {
    const result = buildResult([
      { itemId: 'a', leclerc: 2 },
      { itemId: 'b', hyperu: 2 }
    ]);
    expect(findReferenceStore(result)).toBeNull();
    expect(computeBasketSavings(result, [decision('a', 2)])).toBe(0);
  });

  it('ignore les lignes sans prix et arrondit au centime', () => {
    const result = buildResult([
      { itemId: 'a', leclerc: 0.1, hyperu: 0.3 },
      { itemId: 'b', leclerc: 0.2, hyperu: 0.3 }
    ]);
    expect(computeBasketSavings(result, [decision('a', 0.1), decision('b', undefined)])).toBe(0);
    // Référence Leclerc (0,30 €) ; acheté chez Hyper U à 0,30 € : 0,1 − 0,3.
    expect(computeBasketSavings(result, [decision('a', 0.3)])).toBe(-0.2);
  });
});
