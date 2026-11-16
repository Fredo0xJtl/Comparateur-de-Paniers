import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { demoProducts } from '../../db/seed';
import {
  addProductToActiveList,
  archiveActiveShoppingList,
  getLastBasketOfActiveList,
  buildShoppingListText,
  getActiveShoppingListWithItems,
  updateShoppingListItemQuantity
} from './shoppingListService';

describe('shoppingListService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await db.products.bulkPut(demoProducts);
  });

  it('creates one active list and increments quantity for repeated products', async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    await addProductToActiveList('prod-ice-tea-peche');

    const activeList = await getActiveShoppingListWithItems();

    expect(activeList.list.status).toBe('draft');
    expect(activeList.rows).toHaveLength(1);
    expect(activeList.rows[0]?.item.productId).toBe('prod-ice-tea-peche');
    expect(activeList.rows[0]?.item.wantedQuantity).toBe(2);
  });

  it('garde une seule liste et une seule ligne quand deux ajouts partent en même temps', async () => {
    await Promise.all([
      addProductToActiveList('prod-ice-tea-peche'),
      addProductToActiveList('prod-ice-tea-peche')
    ]);

    expect(await db.shoppingLists.where('status').equals('draft').count()).toBe(1);
    const activeList = await getActiveShoppingListWithItems();
    expect(activeList.rows).toHaveLength(1);
    expect(activeList.rows[0]?.item.wantedQuantity).toBe(2);
  });

  it("n'enregistre jamais une quantité illisible (NaN)", async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    const itemId = (await getActiveShoppingListWithItems()).rows[0]!.item.id;

    await updateShoppingListItemQuantity(itemId, Number.NaN);

    expect((await getActiveShoppingListWithItems()).rows[0]?.item.wantedQuantity).toBe(1);
  });

  it('keeps the item when an edited quantity is temporarily empty or zero', async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    const activeList = await getActiveShoppingListWithItems();
    const itemId = activeList.rows[0]?.item.id;

    expect(itemId).toBeDefined();

    await updateShoppingListItemQuantity(itemId!, 0);

    const updatedList = await getActiveShoppingListWithItems();
    expect(updatedList.rows).toHaveLength(1);
    expect(updatedList.rows[0]?.item.wantedQuantity).toBe(1);
  });

  it('builds plain text without internal IDs', () => {
    const text = buildShoppingListText([
      {
        product: demoProducts[0],
        item: {
          id: 'item-secret-id',
          shoppingListId: 'list-secret-id',
          productId: 'prod-ice-tea-peche',
          wantedQuantity: 2,
          createdAt: '2026-07-07T10:00:00.000Z'
        }
      }
    ]);

    expect(text).toContain('- 2 x Thé glacé pêche');
    expect(text).not.toContain('item-secret-id');
    expect(text).not.toContain('list-secret-id');
  });

  it('signale un panier préparé avec la liste active, puis plus rien après une nouvelle liste', async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    expect(await getLastBasketOfActiveList()).toBeNull();

    await db.validatedBaskets.add({
      id: 'basket-1',
      storeKey: 'leclerc',
      total: 2,
      savings: 0,
      items: [],
      validatedAt: new Date(Date.now() + 1000).toISOString()
    });
    expect((await getLastBasketOfActiveList())?.id).toBe('basket-1');

    await archiveActiveShoppingList();
    // La nouvelle liste est créée après le panier : il ne la concerne plus.
    await db.validatedBaskets.update('basket-1', { validatedAt: new Date(Date.now() - 60000).toISOString() });
    expect(await getLastBasketOfActiveList()).toBeNull();
    expect(await db.products.count()).toBeGreaterThan(0);
  });
});
