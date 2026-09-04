import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import {
  adoptStorePick,
  confirmProductFromText,
  createProductFromText,
  discardProductFromText
} from './quickAddService';
import { type Product } from '../../types/domain';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-test',
    name: 'beurre demi-sel',
    comparisonUnit: 'unit',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    ...overrides
  };
}

describe('createProductFromText', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('crée le produit avec les seuls mots tapés, sans l ajouter à la liste', async () => {
    const product = await createProductFromText('  beurre demi-sel  ');

    expect(product?.name).toBe('beurre demi-sel');
    const stored = await db.products.get(product!.id);
    expect(stored?.name).toBe('beurre demi-sel');
    // Tant qu aucune fiche magasin n est validée, la liste ne bouge pas :
    // une ligne sans prix ni format n aurait servi à rien au comparatif.
    expect(await db.shoppingListItems.count()).toBe(0);
  });

  it('refuse une saisie vide sans rien écrire en base', async () => {
    expect(await createProductFromText('   ')).toBeNull();
    expect(await db.products.count()).toBe(0);
  });
});

describe('confirmProductFromText', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('ajoute à la liste active une fois la fiche validée', async () => {
    const product = await createProductFromText('beurre demi-sel');

    await confirmProductFromText(product!);

    const rows = await db.shoppingListItems.toArray();
    expect(rows.some((row) => row.productId === product!.id)).toBe(true);
  });
});

describe('discardProductFromText', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('efface le produit créé quand aucune fiche n a été validée', async () => {
    const product = await createProductFromText('beurre demi-sel');

    await discardProductFromText(product!);

    expect(await db.products.get(product!.id)).toBeUndefined();
    expect(await db.shoppingListItems.count()).toBe(0);
  });
});

describe('adoptStorePick', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('adopte le nom du catalogue et le format lu sur la fiche', async () => {
    const product = makeProduct();
    await db.products.put(product);

    const updated = await adoptStorePick(product, {
      observedName: 'Beurre Président demi-sel 250 g',
      observedQuantity: 250,
      observedUnit: 'g'
    });

    expect(updated.name).toBe('Beurre Président demi-sel 250 g');
    expect(updated.baseQuantity).toBe(250);
    expect(updated.baseUnit).toBe('g');
    // Sans cette correction, deux formats différents resteraient comparés
    // paquet contre paquet au lieu du prix au kilo.
    expect(updated.comparisonUnit).toBe('kilogram');
    expect((await db.products.get(product.id))?.name).toBe('Beurre Président demi-sel 250 g');
  });

  it('déduit une comparaison au litre sur un volume', async () => {
    const product = makeProduct({ name: 'jus orange' });
    await db.products.put(product);

    const updated = await adoptStorePick(product, {
      observedName: 'Jus Tropicana Orange sans pulpe 90 cl',
      observedQuantity: 900,
      observedUnit: 'ml'
    });

    expect(updated.comparisonUnit).toBe('liter');
    expect(updated.baseQuantity).toBe(900);
  });

  it('garde l unité de comparaison existante quand la fiche n annonce aucun format', async () => {
    const product = makeProduct({ name: 'papier toilette', comparisonUnit: 'roll' });
    await db.products.put(product);

    const updated = await adoptStorePick(product, { observedName: 'Papier toilette 12 rouleaux' });

    expect(updated.comparisonUnit).toBe('roll');
    expect(updated.name).toBe('Papier toilette 12 rouleaux');
    expect(updated.baseQuantity).toBeUndefined();
  });

  it('conserve le nom tapé si la fiche ne remonte aucun nom exploitable', async () => {
    const product = makeProduct();
    await db.products.put(product);

    const updated = await adoptStorePick(product, { observedName: '   ' });

    expect(updated.name).toBe('beurre demi-sel');
  });
});
