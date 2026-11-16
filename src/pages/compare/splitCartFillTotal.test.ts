import { describe, expect, it } from 'vitest';
import { splitCartFillTotal } from './compareFormat';

const item = (productId: string, lineTotal: number) => ({ productId, productName: productId, quantity: 1, lineTotal });

describe('splitCartFillTotal', () => {
  it('sépare le montant ajouté au panier de celui des produits non ajoutés', () => {
    const items = [item('a', 2.1), item('b', 3.35), item('c', 1.2), item('d', 4)];
    const results = [
      { productId: 'a', added: true },
      { productId: 'b', added: false },
      { productId: 'c', added: true },
      { productId: 'd', added: false }
    ];
    expect(splitCartFillTotal(items, results)).toEqual({ addedTotal: 3.3, missingTotal: 7.35 });
  });

  it('compte comme manquant un produit absent du rapport', () => {
    expect(splitCartFillTotal([item('a', 2), item('b', 5)], [{ productId: 'a', added: true }])).toEqual({
      addedTotal: 2,
      missingTotal: 5
    });
  });

  it('garde à ajouter un produit dont une ligne a échoué', () => {
    const results = [
      { productId: 'a', added: true },
      { productId: 'a', added: false }
    ];
    expect(splitCartFillTotal([item('a', 3)], results)).toEqual({ addedTotal: 0, missingTotal: 3 });
  });

  it('arrondit au centime et gère les cas tout ajouté / rien ajouté', () => {
    const items = [item('a', 0.1), item('b', 0.2)];
    expect(splitCartFillTotal(items, [{ productId: 'a', added: true }, { productId: 'b', added: true }])).toEqual({
      addedTotal: 0.3,
      missingTotal: 0
    });
    expect(splitCartFillTotal(items, [])).toEqual({ addedTotal: 0, missingTotal: 0.3 });
  });
});
