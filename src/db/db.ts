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
import { DB_NAME, DB_VERSION, dbSchema, type SyncCursorEntry } from './schema';
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
  syncCursors!: Table<SyncCursorEntry, string>;

  constructor() {
    super(DB_NAME);
    this.version(DB_VERSION).stores(dbSchema);
  }
}

export const db = new DrivePriceSplitterDb();
