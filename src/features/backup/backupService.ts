import { db } from '../../db/db';
import { DB_VERSION } from '../../db/schema';
import {
  type PriceSnapshot,
  type Product,
  type ProductCandidate,
  type ShoppingList,
  type ShoppingListItem,
  type UserSettings,
  type UserStore,
  type ValidatedBasket
} from '../../types/domain';

// v3 (01/09) : export sélectif par table (`includedTables`), voir plus bas.
// Un backup v2 (téléchargé avant ce changement) reste importable : son
// absence d'`includedTables` est traitée comme "toutes les tables incluses",
// exactement son comportement d'origine.
export const EXPORT_SCHEMA_VERSION = 3;
const SUPPORTED_IMPORT_SCHEMA_VERSIONS = new Set<number>([2, EXPORT_SCHEMA_VERSION]);
const MAX_BACKUP_TEXT_LENGTH = 5_000_000;
const MAX_ROWS_PER_TABLE = 20_000;

export const BACKUP_TABLE_KEYS = [
  'products',
  'userStores',
  'productCandidates',
  'priceSnapshots',
  'shoppingLists',
  'shoppingListItems',
  'settings',
  'validatedBaskets'
] as const;
export type BackupTableKey = (typeof BACKUP_TABLE_KEYS)[number];

export type LocalBackupData = {
  products: Product[];
  userStores: UserStore[];
  productCandidates: ProductCandidate[];
  priceSnapshots: PriceSnapshot[];
  shoppingLists: ShoppingList[];
  shoppingListItems: ShoppingListItem[];
  settings: UserSettings[];
  validatedBaskets: ValidatedBasket[];
};

export type LocalBackup = {
  app: 'drive-price-splitter';
  exportSchemaVersion: number;
  dbVersion: number;
  exportedAt: string;
  // Tables réellement exportées (voir exportLocalBackup) : les autres clés de
  // `data` valent [] par construction, sans que ça signifie "vide chez
  // l'utilisateur" — cette liste seule fait la différence à l'import.
  includedTables: BackupTableKey[];
  data: LocalBackupData;
};

export type ImportReport = {
  products: number;
  userStores: number;
  productCandidates: number;
  priceSnapshots: number;
  shoppingLists: number;
  shoppingListItems: number;
  settings: number;
  validatedBaskets: number;
};

export type LocalBackupSummary = {
  products: number;
  shoppingListItems: number;
  shoppingLists: number;
  stores: number;
  priceSnapshots: number;
  settings: number;
  validatedBaskets: number;
};

// `selectedTables` omis (ou vide) : exporte tout, comportement historique
// inchangé — c'est ce qu'utilisent encore les tests et tout appelant qui n'a
// pas besoin de choisir. Seules les tables demandées sont réellement lues en
// base (pas de lecture inutile pour un export ciblé).
export async function exportLocalBackup(selectedTables?: readonly BackupTableKey[]): Promise<LocalBackup> {
  const included = new Set<BackupTableKey>(
    selectedTables && selectedTables.length > 0 ? selectedTables : BACKUP_TABLE_KEYS
  );

  const [products, userStores, productCandidates, priceSnapshots, shoppingLists, shoppingListItems, settings, validatedBaskets] =
    await Promise.all([
      included.has('products') ? db.products.toArray() : Promise.resolve([]),
      included.has('userStores') ? db.userStores.toArray() : Promise.resolve([]),
      included.has('productCandidates') ? db.productCandidates.toArray() : Promise.resolve([]),
      included.has('priceSnapshots') ? db.priceSnapshots.toArray() : Promise.resolve([]),
      included.has('shoppingLists') ? db.shoppingLists.toArray() : Promise.resolve([]),
      included.has('shoppingListItems') ? db.shoppingListItems.toArray() : Promise.resolve([]),
      included.has('settings') ? db.settings.toArray() : Promise.resolve([]),
      included.has('validatedBaskets') ? db.validatedBaskets.toArray() : Promise.resolve([])
    ]);

  return {
    app: 'drive-price-splitter',
    exportSchemaVersion: EXPORT_SCHEMA_VERSION,
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    includedTables: BACKUP_TABLE_KEYS.filter((key) => included.has(key)),
    data: {
      products,
      userStores,
      productCandidates,
      priceSnapshots,
      shoppingLists,
      shoppingListItems,
      settings,
      validatedBaskets
    }
  };
}

export function parseLocalBackup(jsonText: string): LocalBackup {
  if (jsonText.length > MAX_BACKUP_TEXT_LENGTH) {
    throw new Error('Sauvegarde trop volumineuse');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error('JSON invalide');
  }

  return validateLocalBackup(parsed);
}

export function summarizeLocalBackup(backup: LocalBackup): LocalBackupSummary {
  const validatedBackup = validateLocalBackup(backup);
  return {
    products: validatedBackup.data.products.length,
    shoppingListItems: validatedBackup.data.shoppingListItems.length,
    shoppingLists: validatedBackup.data.shoppingLists.length,
    stores: validatedBackup.data.userStores.length,
    priceSnapshots: validatedBackup.data.priceSnapshots.length,
    settings: validatedBackup.data.settings.length,
    validatedBaskets: validatedBackup.data.validatedBaskets.length
  };
}

// Fusion sélective (décision explicite du 01/09) : seules les tables
// réellement incluses dans le backup sont vidées puis remplacées. Un backup
// v2 legacy (sans includedTables) reste "tout inclus", donc remplace tout
// comme avant. Objectif : pouvoir importer juste les produits de prod dans
// une base dev sans écraser les magasins/réglages locaux.
export async function importLocalBackup(backup: LocalBackup): Promise<ImportReport> {
  const validatedBackup = validateLocalBackup(backup);
  const { data, includedTables } = validatedBackup;
  const included = new Set(includedTables);

  await db.transaction(
    'rw',
    [
      db.products,
      db.userStores,
      db.productCandidates,
      db.priceSnapshots,
      db.shoppingLists,
      db.shoppingListItems,
      db.settings,
      db.validatedBaskets
    ],
    async () => {
      const clears: Promise<unknown>[] = [];
      const puts: Promise<unknown>[] = [];
      if (included.has('products')) {
        clears.push(db.products.clear());
        puts.push(db.products.bulkPut(data.products));
      }
      if (included.has('userStores')) {
        clears.push(db.userStores.clear());
        puts.push(db.userStores.bulkPut(data.userStores));
      }
      if (included.has('productCandidates')) {
        clears.push(db.productCandidates.clear());
        puts.push(db.productCandidates.bulkPut(data.productCandidates));
      }
      if (included.has('priceSnapshots')) {
        clears.push(db.priceSnapshots.clear());
        puts.push(db.priceSnapshots.bulkPut(data.priceSnapshots));
      }
      if (included.has('shoppingLists')) {
        clears.push(db.shoppingLists.clear());
        puts.push(db.shoppingLists.bulkPut(data.shoppingLists));
      }
      if (included.has('shoppingListItems')) {
        clears.push(db.shoppingListItems.clear());
        puts.push(db.shoppingListItems.bulkPut(data.shoppingListItems));
      }
      if (included.has('settings')) {
        clears.push(db.settings.clear());
        puts.push(db.settings.bulkPut(data.settings));
      }
      if (included.has('validatedBaskets')) {
        clears.push(db.validatedBaskets.clear());
        puts.push(db.validatedBaskets.bulkPut(data.validatedBaskets));
      }
      await Promise.all(clears);
      await Promise.all(puts);
    }
  );

  return {
    products: included.has('products') ? data.products.length : 0,
    userStores: included.has('userStores') ? data.userStores.length : 0,
    productCandidates: included.has('productCandidates') ? data.productCandidates.length : 0,
    priceSnapshots: included.has('priceSnapshots') ? data.priceSnapshots.length : 0,
    shoppingLists: included.has('shoppingLists') ? data.shoppingLists.length : 0,
    shoppingListItems: included.has('shoppingListItems') ? data.shoppingListItems.length : 0,
    settings: included.has('settings') ? data.settings.length : 0,
    validatedBaskets: included.has('validatedBaskets') ? data.validatedBaskets.length : 0
  };
}

function validateLocalBackup(value: unknown): LocalBackup {
  if (!isRecord(value)) {
    throw new Error('Sauvegarde invalide');
  }

  if (value.app !== 'drive-price-splitter') {
    throw new Error('Sauvegarde invalide');
  }

  if (!SUPPORTED_IMPORT_SCHEMA_VERSIONS.has(value.exportSchemaVersion as number)) {
    throw new Error('Version de sauvegarde incompatible');
  }

  if (!isIsoDateString(value.exportedAt) || !isRecord(value.data)) {
    throw new Error('Sauvegarde invalide');
  }

  const data = value.data;

  for (const key of BACKUP_TABLE_KEYS) {
    if (!Array.isArray(data[key])) {
      throw new Error('Sauvegarde invalide');
    }
    if (data[key].length > MAX_ROWS_PER_TABLE) {
      throw new Error(`Sauvegarde invalide : table ${key} trop volumineuse`);
    }
  }

  const includedTables = normalizeIncludedTables(value.includedTables);
  validateEntities(data as unknown as LocalBackupData, includedTables);

  return { ...value, includedTables: [...includedTables] } as LocalBackup;
}

// Absent (backup v2) ou vide : traité comme "tout est inclus", exactement le
// comportement d'origine avant l'export sélectif.
function normalizeIncludedTables(raw: unknown): Set<BackupTableKey> {
  if (!Array.isArray(raw)) return new Set(BACKUP_TABLE_KEYS);
  const valid = raw.filter((key): key is BackupTableKey => (BACKUP_TABLE_KEYS as readonly string[]).includes(key));
  return valid.length > 0 ? new Set(valid) : new Set(BACKUP_TABLE_KEYS);
}

function validateEntities(data: LocalBackupData, includedTables: Set<BackupTableKey>) {
  validateTable('products', data.products, (product) =>
    isNonEmptyString(product.id) && isNonEmptyString(product.name) &&
    isIsoDateString(product.createdAt) && isIsoDateString(product.updatedAt) &&
    (product.baseQuantity === undefined || isPositiveFinite(product.baseQuantity))
  );
  validateTable('userStores', data.userStores, (store) =>
    isNonEmptyString(store.id) && isStoreKey(store.storeKey) && isNonEmptyString(store.displayName) &&
    isIsoDateString(store.createdAt) && isIsoDateString(store.updatedAt) && isSafeOptionalUrl(store.driveUrl)
  );
  validateTable('productCandidates', data.productCandidates, (candidate) =>
    isNonEmptyString(candidate.id) && isNonEmptyString(candidate.productId) && isStoreKey(candidate.storeKey) &&
    isNonEmptyString(candidate.name) && isFiniteInRange(candidate.confidenceScore, 0, 100) &&
    Array.isArray(candidate.confidenceReasons) && isIsoDateString(candidate.createdAt) &&
    isIsoDateString(candidate.updatedAt) && isSafeOptionalUrl(candidate.productUrl) &&
    isSafeOptionalUrl(candidate.searchUrl) && isSafeOptionalUrl(candidate.imageUrl)
  );
  validateTable('priceSnapshots', data.priceSnapshots, (snapshot) =>
    isNonEmptyString(snapshot.id) && isNonEmptyString(snapshot.candidateId) && isStoreKey(snapshot.storeKey) &&
    isPositiveFinite(snapshot.price) && (snapshot.unitPrice === undefined || isPositiveFinite(snapshot.unitPrice)) &&
    snapshot.currency === 'EUR' && typeof snapshot.available === 'boolean' && isIsoDateString(snapshot.checkedAt)
  );
  validateTable('shoppingLists', data.shoppingLists, (list) =>
    isNonEmptyString(list.id) && isNonEmptyString(list.name) && isIsoDateString(list.createdAt) && isIsoDateString(list.updatedAt)
  );
  validateTable('shoppingListItems', data.shoppingListItems, (item) =>
    isNonEmptyString(item.id) && isNonEmptyString(item.shoppingListId) && isNonEmptyString(item.productId) &&
    isPositiveFinite(item.wantedQuantity) && isIsoDateString(item.createdAt)
  );
  validateTable('settings', data.settings, (settings) =>
    settings.id === 'default' && Number.isFinite(settings.savingThresholdEuro) &&
    isFiniteInRange(settings.autoDecisionMinConfidence, 0, 100) && typeof settings.experimentalAddToCart === 'boolean' &&
    isPositiveFinite(settings.maxPriceAgeDays) && isIsoDateString(settings.updatedAt)
  );
  validateTable('validatedBaskets', data.validatedBaskets, (basket) =>
    isNonEmptyString(basket.id) && isStoreKey(basket.storeKey) && isNonNegativeFinite(basket.total) &&
    isNonNegativeFinite(basket.savings) && isIsoDateString(basket.validatedAt) &&
    (basket.operationKey === undefined || isNonEmptyString(basket.operationKey)) &&
    Array.isArray(basket.items) && basket.items.every((item) =>
      isNonEmptyString(item.productId) && isNonEmptyString(item.productName) &&
      isPositiveFinite(item.quantity) && isNonNegativeFinite(item.lineTotal)
    )
  );

  // Une vérification croisée n'a de sens que si LES DEUX tables concernées
  // ont été exportées : un export ciblé "juste les prix" n'a par construction
  // aucun `products` à côté de `productCandidates`, ce n'est pas une
  // incohérence — voir includedTables.
  if (includedTables.has('productCandidates') && includedTables.has('products')) {
    assertReferences(data.productCandidates, 'productId', new Set(data.products.map(({ id }) => id)), 'productCandidates');
  }
  if (includedTables.has('priceSnapshots') && includedTables.has('productCandidates')) {
    assertReferences(data.priceSnapshots, 'candidateId', new Set(data.productCandidates.map(({ id }) => id)), 'priceSnapshots');
  }
  if (includedTables.has('shoppingListItems') && includedTables.has('shoppingLists')) {
    assertReferences(data.shoppingListItems, 'shoppingListId', new Set(data.shoppingLists.map(({ id }) => id)), 'shoppingListItems');
  }
  if (includedTables.has('shoppingListItems') && includedTables.has('products')) {
    assertReferences(data.shoppingListItems, 'productId', new Set(data.products.map(({ id }) => id)), 'shoppingListItems');
  }
}

function validateTable<T extends { id: string }>(name: string, rows: T[], predicate: (row: T) => boolean) {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (!isRecord(row) || !predicate(row)) throw new Error(`Sauvegarde invalide : ${name}[${index}]`);
    if (ids.has(row.id)) throw new Error(`Sauvegarde invalide : identifiant dupliqué dans ${name}`);
    ids.add(row.id);
  });
}

function assertReferences<T, K extends keyof T>(rows: T[], key: K, validIds: Set<string>, table: string) {
  for (const row of rows) {
    const reference = row[key];
    if (typeof reference !== 'string' || !validIds.has(reference)) {
      throw new Error(`Sauvegarde invalide : référence orpheline dans ${table}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && value.includes('T') && !Number.isNaN(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2_000;
}

function isStoreKey(value: unknown): value is 'leclerc' | 'hyperu' {
  return value === 'leclerc' || value === 'hyperu';
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isSafeOptionalUrl(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
