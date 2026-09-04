import { describe, expect, it } from 'vitest';
import { findExistingProduct, searchProducts } from './productSearch';
import type { Product } from '../../types/domain';

function makeProduct(overrides: Partial<Product> & { name: string }): Product {
  return {
    id: `prod-${overrides.name}`,
    comparisonUnit: 'unit',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

const beurre = makeProduct({ name: 'Beurre demi-sel', brand: 'Président' });
const lait = makeProduct({ name: 'Lait demi-écrémé', brand: 'Candia' });
const chocolat = makeProduct({ name: 'Chocolat au lait', brand: 'Milka' });
const creme = makeProduct({ name: 'Crème fraîche épaisse', brand: 'Elle & Vire' });
const jus = makeProduct({ name: 'Jus d orange sans pulpe', brand: 'Tropicana', barcode: '3800020411810' });

const base = [beurre, lait, chocolat, creme, jus];

describe('searchProducts', () => {
  it('ne renvoie rien tant que rien n a été tapé', () => {
    expect(searchProducts(base, '')).toEqual([]);
    expect(searchProducts(base, '   ')).toEqual([]);
  });

  it('trouve un produit sur le début d un mot', () => {
    const names = searchProducts(base, 'beur').map((entry) => entry.product.name);
    expect(names).toEqual(['Beurre demi-sel']);
  });

  it('accepte les mots dans le désordre', () => {
    const names = searchProducts(base, 'sel beurre').map((entry) => entry.product.name);
    expect(names).toEqual(['Beurre demi-sel']);
  });

  it('ignore les accents et la casse', () => {
    const names = searchProducts(base, 'CREME fraiche').map((entry) => entry.product.name);
    expect(names).toEqual(['Crème fraîche épaisse']);
  });

  it('traite le tiret comme un séparateur de mots', () => {
    const names = searchProducts(base, 'ecreme').map((entry) => entry.product.name);
    expect(names).toEqual(['Lait demi-écrémé']);
  });

  it('cherche aussi dans la marque', () => {
    const names = searchProducts(base, 'president').map((entry) => entry.product.name);
    expect(names).toEqual(['Beurre demi-sel']);
  });

  it('combine un mot du nom et un mot de la marque', () => {
    const names = searchProducts(base, 'lait candia').map((entry) => entry.product.name);
    expect(names).toEqual(['Lait demi-écrémé']);
  });

  it('exclut un produit dès qu un mot tapé ne correspond à rien', () => {
    expect(searchProducts(base, 'beurre bio')).toEqual([]);
  });

  it('ne correspond pas au milieu d un mot, pour ne pas noyer l écran', () => {
    expect(searchProducts(base, 'eurre')).toEqual([]);
  });

  it('place en tête le produit dont le nom commence par ce qui est tapé', () => {
    const names = searchProducts(base, 'lait').map((entry) => entry.product.name);
    expect(names[0]).toBe('Lait demi-écrémé');
    expect(names).toContain('Chocolat au lait');
  });

  it('à pertinence égale, remonte le produit utilisé le plus récemment', () => {
    const ancien = makeProduct({ name: 'Yaourt nature', lastUsedAt: '2026-01-05T00:00:00.000Z' });
    const recent = makeProduct({ name: 'Yaourt vanille', lastUsedAt: '2026-08-30T00:00:00.000Z' });
    const names = searchProducts([ancien, recent], 'yaourt').map((entry) => entry.product.name);
    expect(names).toEqual(['Yaourt vanille', 'Yaourt nature']);
  });

  it('cherche sur le code-barres quand la saisie est numérique', () => {
    const names = searchProducts(base, '3800020411810').map((entry) => entry.product.name);
    expect(names).toEqual(['Jus d orange sans pulpe']);
  });

  it('accepte les derniers chiffres du code-barres lus sur l étiquette', () => {
    const names = searchProducts(base, '411810').map((entry) => entry.product.name);
    expect(names).toEqual(['Jus d orange sans pulpe']);
  });

  it('limite le nombre de propositions affichées', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      makeProduct({ id: `p-${index}`, name: `Pâtes numéro ${index}` })
    );
    expect(searchProducts(many, 'pates')).toHaveLength(8);
    expect(searchProducts(many, 'pates', 3)).toHaveLength(3);
  });
});

describe('findExistingProduct', () => {
  it('repère un doublon malgré la casse, les accents et la ponctuation', () => {
    expect(findExistingProduct(base, 'BEURRE demi sel')?.id).toBe(beurre.id);
  });

  it('ne confond pas deux produits de marques différentes', () => {
    expect(findExistingProduct(base, 'Beurre demi-sel', 'Elle & Vire')).toBeUndefined();
  });

  it('considère le produit comme déjà connu quand la marque est absente', () => {
    expect(findExistingProduct(base, 'Beurre demi-sel')?.id).toBe(beurre.id);
  });

  it('ne signale rien sur un nom réellement nouveau', () => {
    expect(findExistingProduct(base, 'Beurre doux')).toBeUndefined();
  });
});
