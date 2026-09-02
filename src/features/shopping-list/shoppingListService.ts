import { db } from '../../db/db';
import { type Product, type ShoppingList, type ShoppingListItem, type StoreKey } from '../../types/domain';

export type ShoppingListRow = {
  item: ShoppingListItem;
  product: Product;
};

export type ActiveShoppingList = {
  list: ShoppingList;
  rows: ShoppingListRow[];
};

const ACTIVE_LIST_NAME = 'Liste active';

export async function getOrCreateActiveShoppingList() {
  const existing = await db.shoppingLists.where('status').equals('draft').first();
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const list: ShoppingList = {
    id: createId('list'),
    name: ACTIVE_LIST_NAME,
    status: 'draft',
    createdAt: now,
    updatedAt: now
  };

  await db.shoppingLists.add(list);
  return list;
}

export async function getActiveShoppingListWithItems(): Promise<ActiveShoppingList> {
  const list = await getOrCreateActiveShoppingList();
  const items = await db.shoppingListItems.where('shoppingListId').equals(list.id).toArray();
  const products = await db.products.bulkGet(items.map((item) => item.productId));
  const productById = new Map(
    products.filter((product): product is Product => Boolean(product)).map((product) => [product.id, product])
  );

  const rows = items
    .map((item) => {
      const product = productById.get(item.productId);
      return product ? { item, product } : null;
    })
    .filter((row): row is ShoppingListRow => Boolean(row))
    .sort((a, b) => a.product.name.localeCompare(b.product.name, 'fr'));

  return { list, rows };
}

export async function addProductToActiveList(productId: string) {
  const list = await getOrCreateActiveShoppingList();
  const existing = await db.shoppingListItems
    .where('[shoppingListId+productId]')
    .equals([list.id, productId])
    .first();

  if (existing) {
    await db.shoppingListItems.update(existing.id, {
      wantedQuantity: existing.wantedQuantity + 1
    });
    await touchList(list.id);
    return;
  }

  await db.shoppingListItems.add({
    id: createId('item'),
    shoppingListId: list.id,
    productId,
    wantedQuantity: 1,
    createdAt: new Date().toISOString()
  });
  await touchList(list.id);
}

export async function updateShoppingListItemQuantity(itemId: string, wantedQuantity: number) {
  const safeQuantity = Math.max(1, Math.trunc(wantedQuantity));
  const item = await db.shoppingListItems.get(itemId);
  if (!item) {
    return;
  }

  await db.shoppingListItems.update(itemId, { wantedQuantity: safeQuantity });
  await touchList(item.shoppingListId);
}

export async function setShoppingListItemStoreOverride(itemId: string, storeKey: StoreKey | null) {
  const item = await db.shoppingListItems.get(itemId);
  if (!item) {
    return;
  }

  if (storeKey === null) {
    const { forcedStoreKey: _removed, ...rest } = item;
    await db.shoppingListItems.put(rest);
  } else {
    await db.shoppingListItems.update(itemId, { forcedStoreKey: storeKey });
  }
  await touchList(item.shoppingListId);
}

export async function setShoppingListItemCandidateOverride(itemId: string, candidateId: string | null) {
  const item = await db.shoppingListItems.get(itemId);
  if (!item) {
    return;
  }

  if (candidateId === null) {
    const { forcedCandidateId: _removed, ...rest } = item;
    await db.shoppingListItems.put(rest);
  } else {
    await db.shoppingListItems.update(itemId, { forcedCandidateId: candidateId });
  }
  await touchList(item.shoppingListId);
}

// Levée (ou retrait de la levée) des alertes bloquantes « prix incohérent »
// et « format à confirmer » pour cette ligne — voir
// ShoppingListItem.checkedDespiteWarningsAt. Même forme que les deux
// overrides ci-dessus : le champ est retiré de l'enregistrement plutôt que
// mis à undefined, pour qu'une ligne jamais levée reste identique à ce
// qu'elle était avant l'ajout de ce champ.
export async function setShoppingListItemWarningsAcknowledged(itemId: string, acknowledged: boolean) {
  const item = await db.shoppingListItems.get(itemId);
  if (!item) {
    return;
  }

  if (!acknowledged) {
    const { checkedDespiteWarningsAt: _removed, ...rest } = item;
    await db.shoppingListItems.put(rest);
  } else {
    await db.shoppingListItems.update(itemId, { checkedDespiteWarningsAt: new Date().toISOString() });
  }
  await touchList(item.shoppingListId);
}

export async function removeShoppingListItem(itemId: string) {
  const item = await db.shoppingListItems.get(itemId);
  if (!item) {
    return;
  }

  await db.shoppingListItems.delete(itemId);
  await touchList(item.shoppingListId);
}

export async function clearActiveShoppingList() {
  const list = await getOrCreateActiveShoppingList();
  await db.shoppingListItems.where('shoppingListId').equals(list.id).delete();
  await touchList(list.id);
}

export async function archiveActiveShoppingList() {
  const list = await getOrCreateActiveShoppingList();
  await db.shoppingLists.update(list.id, {
    status: 'archived',
    updatedAt: new Date().toISOString()
  });
}

export function buildShoppingListText(rows: ShoppingListRow[]) {
  if (rows.length === 0) {
    return 'Liste de courses vide';
  }

  return rows
    .map(({ item, product }) => {
      const brand = product.brand ? ` - ${product.brand}` : '';
      return `- ${item.wantedQuantity} x ${product.name}${brand}`;
    })
    .join('\n');
}

async function touchList(listId: string) {
  await db.shoppingLists.update(listId, {
    updatedAt: new Date().toISOString()
  });
}

function createId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
