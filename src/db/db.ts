import Dexie, { type Table } from 'dexie';
import {
  type DriveManualOverrideEntry,
  type DriveSearchMemoryEntry,
  type PriceSnapshot,
  type Product,
  type ProductCandidate,
  type ShoppingList,
  type ShoppingListItem,
  type StoreSearchCacheEntry,
  type UserSettings,
  type UserStore,
  type ValidatedBasket
} from '../types/domain';
import { DB_NAME, DB_VERSION, dbSchema, removedTables } from './schema';
import type { CachedProductEntry } from '../features/scan/productCacheService';

export class DrivePriceSplitterDb extends Dexie {
  products!: Table<Product, string>;
  userStores!: Table<UserStore, string>;
  productCandidates!: Table<ProductCandidate, string>;
  priceSnapshots!: Table<PriceSnapshot, string>;
  shoppingLists!: Table<ShoppingList, string>;
  shoppingListItems!: Table<ShoppingListItem, string>;
  settings!: Table<UserSettings, string>;
  storeSearchCache!: Table<StoreSearchCacheEntry, string>;
  driveSearchMemory!: Table<DriveSearchMemoryEntry, string>;
  validatedBaskets!: Table<ValidatedBasket, string>;
  productCache!: Table<CachedProductEntry, string>;
  driveManualOverrides!: Table<DriveManualOverrideEntry, string>;

  constructor() {
    super(DB_NAME);
    this.version(DB_VERSION).stores({ ...dbSchema, ...removedTables });
  }
}

export const db = new DrivePriceSplitterDb();

// Un autre onglet ouvre une version plus récente de la base : on libère la
// connexion (sinon sa mise à jour reste bloquée) et on recharge pour repartir
// sur le nouveau code.
db.on('versionchange', () => {
  db.close();
  if (typeof location !== 'undefined') location.reload();
});

// Demande au navigateur de ne pas effacer la base quand le stockage vient à
// manquer. Par défaut IndexedDB est "au mieux" : listes et prix peuvent
// disparaître sans prévenir. Le navigateur peut refuser, d'où le booléen.
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}
