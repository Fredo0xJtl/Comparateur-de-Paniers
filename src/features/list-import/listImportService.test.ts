import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { getActiveShoppingListWithItems } from '../shopping-list/shoppingListService';
import {
  applyListImport,
  inferComparisonUnitFromName,
  matchImportedItems,
  normalizeForMatching,
  type ImportCandidate
} from './listImportService';
import { type Product } from '../../types/domain';

function makeProduct(overrides: Partial<Product> & { name: string }): Product {
  const now = new Date().toISOString();
  return {
    id: `prod-${overrides.name.toLowerCase().replace(/\W+/g, '-')}`,
    comparisonUnit: 'unit',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('normalizeForMatching', () => {
  it('rapproche deux écritures du même produit', () => {
    expect(normalizeForMatching("Lait demi-écrémé UHT LAIT D'ICI, 6x1L")).toBe(
      normalizeForMatching('Lait demi écrémé UHT Lait d’Ici')
    );
  });

  it('ne confond pas deux produits réellement différents', () => {
    expect(normalizeForMatching('Lait demi-écrémé')).not.toBe(normalizeForMatching('Lait entier'));
  });
});

describe('inferComparisonUnitFromName', () => {
  it('déduit le litre et le kilo du format écrit dans le nom', () => {
    expect(inferComparisonUnitFromName("Lait demi écrémé 6x1L")).toBe('liter');
    expect(inferComparisonUnitFromName('Riz basmati LUSTUCRU 900g')).toBe('kilogram');
    expect(inferComparisonUnitFromName('Jus 50 cl')).toBe('liter');
  });

  it("retombe sur l'unité quand le nom ne dit rien du format", () => {
    expect(inferComparisonUnitFromName('Brioche tranchée')).toBe('unit');
  });
});

describe('matchImportedItems', () => {
  const existing = [
    makeProduct({ name: 'Lait demi écrémé', brand: "Lait d'Ici", barcode: '3256224234494' }),
    makeProduct({ name: 'Ricotta', brand: 'Galbani' })
  ];

  it('reconnaît un doublon par code-barres et le décoche', () => {
    const [candidate] = matchImportedItems(
      [{ name: 'Lait demi écrémé UHT LAIT D’ICI, 6x1l', barcode: '3256224234494' }],
      existing
    );

    expect(candidate.matchKind).toBe('barcode');
    expect(candidate.selected).toBe(false);
    expect(candidate.existingProduct?.id).toBe(existing[0].id);
  });

  it('reconnaît un doublon par nom et marque quand il n\'y a pas de code-barres', () => {
    // Cas Leclerc : la page « produits habituels » n'expose aucun EAN.
    const [candidate] = matchImportedItems([{ name: 'Ricotta', brand: 'Galbani' }], existing);

    expect(candidate.matchKind).toBe('name');
    expect(candidate.selected).toBe(false);
  });

  it('coche par défaut un produit inconnu', () => {
    const [candidate] = matchImportedItems([{ name: 'Mousse aux fruits' }], existing);

    expect(candidate.matchKind).toBe('none');
    expect(candidate.selected).toBe(true);
    expect(candidate.existingProduct).toBeUndefined();
  });

  it('décoche les deux occurrences quand un même produit local est visé deux fois', () => {
    const candidates = matchImportedItems(
      [
        { name: 'Ricotta', brand: 'Galbani' },
        { name: 'Ricotta', brand: 'Galbani', barcode: undefined }
      ],
      existing
    );

    expect(candidates.every((candidate) => candidate.selected === false)).toBe(true);
  });
});

describe('applyListImport', () => {
  it('crée les fiches manquantes et alimente la liste de courses', async () => {
    const candidates: ImportCandidate[] = [
      { item: { name: 'Brioche tranchée', brand: 'Pasquier' }, matchKind: 'none', selected: true },
      { item: { name: 'Jus d’orange 1L', quantity: 3 }, matchKind: 'none', selected: true }
    ];

    const outcome = await applyListImport(candidates);

    expect(outcome).toMatchObject({ createdProducts: 2, addedToList: 2, reusedProducts: 0 });
    const list = await getActiveShoppingListWithItems();
    expect(list.rows).toHaveLength(2);
    // La quantité enregistrée sur le compte du magasin est reprise telle quelle.
    const jus = list.rows.find((row) => row.product.name.startsWith('Jus'));
    expect(jus?.item.wantedQuantity).toBe(3);
    // Le format lu dans le nom donne l'unité de comparaison de la fiche créée.
    expect(jus?.product.comparisonUnit).toBe('liter');
  });

  it('n\'écrit rien pour un produit décoché', async () => {
    const outcome = await applyListImport([
      { item: { name: 'Pâtée chat' }, matchKind: 'none', selected: false }
    ]);

    expect(outcome).toMatchObject({ createdProducts: 0, addedToList: 0 });
    expect(await db.products.count()).toBe(0);
  });

  it('réutilise une fiche existante sans en créer de seconde ni toucher à ses réglages', async () => {
    // Cœur de la décision §13 : un doublon coché volontairement rejoint la
    // liste de courses, mais la fiche de l'utilisateur reste intacte.
    const existing = makeProduct({
      name: 'Ricotta',
      brand: 'Galbani',
      comparisonUnit: 'kilogram',
      allowPrivateLabel: false
    });
    await db.products.add(existing);

    const outcome = await applyListImport([
      {
        item: { name: 'Ricotta 250g', brand: 'Galbani' },
        existingProduct: existing,
        matchKind: 'name',
        selected: true
      }
    ]);

    expect(outcome).toMatchObject({ createdProducts: 0, reusedProducts: 1, addedToList: 1 });
    expect(await db.products.count()).toBe(1);
    const stored = await db.products.get(existing.id);
    expect(stored).toMatchObject({ comparisonUnit: 'kilogram', allowPrivateLabel: false });
  });

  it('signale un produit refusé sans interrompre les suivants', async () => {
    const outcome = await applyListImport([
      { item: { name: '   ' }, matchKind: 'none', selected: true },
      { item: { name: 'Galettes de riz' }, matchKind: 'none', selected: true }
    ]);

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.createdProducts).toBe(1);
    expect(outcome.addedToList).toBe(1);
  });
});
