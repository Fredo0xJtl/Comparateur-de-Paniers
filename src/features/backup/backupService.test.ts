import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { resetDemoData } from '../../db/seed';
import { addProductToActiveList } from '../shopping-list/shoppingListService';
import { recordValidatedBasket } from '../basket-history/basketHistoryService';
import {
  BACKUP_TABLE_KEYS,
  EXPORT_SCHEMA_VERSION,
  exportLocalBackup,
  importLocalBackup,
  parseLocalBackup,
  summarizeLocalBackup
} from './backupService';

describe('backupService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await resetDemoData();
  });

  it('exports all local tables with a schema version and no external session fields', async () => {
    await addProductToActiveList('prod-ice-tea-peche');

    const backup = await exportLocalBackup();
    const json = JSON.stringify(backup);

    expect(backup.exportSchemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(backup.exportedAt).toMatch(/T/);
    expect(backup.data.products).toHaveLength(5);
    expect(backup.data.userStores.length).toBeGreaterThanOrEqual(2);
    expect(backup.data.productCandidates.length).toBeGreaterThanOrEqual(5);
    expect(backup.data.priceSnapshots.length).toBeGreaterThanOrEqual(5);
    expect(backup.data.shoppingLists).toHaveLength(1);
    expect(backup.data.shoppingListItems).toHaveLength(1);
    expect(backup.data.settings[0]?.experimentalAddToCart).toBe(false);
    expect(json).not.toMatch(/cookie|token|password|session|payment/i);
  });

  it('summarizes a backup before export or import confirmation', async () => {
    await addProductToActiveList('prod-ice-tea-peche');

    const backup = await exportLocalBackup();

    expect(summarizeLocalBackup(backup)).toEqual({
      products: 5,
      shoppingListItems: 1,
      shoppingLists: 1,
      stores: 2,
      priceSnapshots: 5,
      settings: 1,
      validatedBaskets: 0
    });
  });

  it('rejects invalid JSON and unknown schema versions', () => {
    expect(() => parseLocalBackup('{bad json')).toThrow('JSON invalide');
    expect(() =>
      parseLocalBackup(
        JSON.stringify({
          app: 'drive-price-splitter',
          exportSchemaVersion: 999,
          exportedAt: '2026-07-08T10:00:00.000Z',
          data: {}
        })
      )
    ).toThrow('Version de sauvegarde incompatible');
  });

  it('rejects backups with invalid metadata or missing data tables', () => {
    expect(() =>
      parseLocalBackup(
        JSON.stringify({
          app: 'drive-price-splitter',
          exportSchemaVersion: EXPORT_SCHEMA_VERSION,
          exportedAt: 'not-a-date',
          data: {
            products: [],
            userStores: [],
            productCandidates: [],
            priceSnapshots: [],
            shoppingLists: [],
            shoppingListItems: [],
            settings: []
          }
        })
      )
    ).toThrow('Sauvegarde invalide');

    expect(() =>
      parseLocalBackup(
        JSON.stringify({
          app: 'drive-price-splitter',
          exportSchemaVersion: EXPORT_SCHEMA_VERSION,
          exportedAt: '2026-07-08T10:00:00.000Z',
          data: {
            products: []
          }
        })
      )
    ).toThrow('Sauvegarde invalide');
  });

  it('imports a valid backup by replacing the local backup-managed tables', async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    await recordValidatedBasket({
      storeKey: 'leclerc',
      items: [{ productId: 'prod-ice-tea-peche', productName: 'Thé', quantity: 1, lineTotal: 2 }],
      total: 2,
      savings: 0.5,
      operationKey: 'backup-proof'
    });
    const backup = await exportLocalBackup();
    await db.products.clear();
    await db.shoppingListItems.clear();
    await db.validatedBaskets.clear();

    const report = await importLocalBackup(backup);

    expect(report.products).toBe(5);
    expect(report.shoppingListItems).toBe(1);
    expect(await db.products.count()).toBe(5);
    expect(await db.shoppingListItems.count()).toBe(1);
    expect(await db.validatedBaskets.get('basket-inexistant')).toBeUndefined();
    expect(await db.validatedBaskets.where('operationKey').equals('backup-proof').count()).toBe(1);
  });

  it('rejette les entités mal formées, les identifiants dupliqués et les URLs non sûres', async () => {
    const malformed = await exportLocalBackup();
    malformed.data.products[0]!.baseQuantity = -1;
    expect(() => summarizeLocalBackup(malformed)).toThrow(/products/);

    const duplicate = await exportLocalBackup();
    duplicate.data.products.push({ ...duplicate.data.products[0]! });
    expect(() => summarizeLocalBackup(duplicate)).toThrow(/dupliqué/);

    const unsafeUrl = await exportLocalBackup();
    unsafeUrl.data.userStores[0]!.driveUrl = 'javascript:alert(1)';
    expect(() => summarizeLocalBackup(unsafeUrl)).toThrow(/userStores/);
  });

  it('rejette les références orphelines avant de modifier la base locale', async () => {
    const backup = await exportLocalBackup();
    backup.data.productCandidates[0]!.productId = 'produit-inexistant';
    const productCountBefore = await db.products.count();
    const firstProductBefore = await db.products.orderBy('id').first();

    await expect(importLocalBackup(backup)).rejects.toThrow(/orpheline/);
    expect(await db.products.count()).toBe(productCountBefore);
    expect(await db.products.orderBy('id').first()).toEqual(firstProductBefore);
  });

  it('refuse un fichier excessivement volumineux avant le parsing', () => {
    expect(() => parseLocalBackup(' '.repeat(5_000_001))).toThrow(/volumineuse/);
  });

  it("exporte seulement les tables sélectionnées, sans valider de référence croisée vers une table exclue", async () => {
    await addProductToActiveList('prod-ice-tea-peche');

    const backup = await exportLocalBackup(['priceSnapshots', 'productCandidates']);

    expect(backup.includedTables).toEqual(['productCandidates', 'priceSnapshots']);
    expect(backup.data.priceSnapshots.length).toBeGreaterThanOrEqual(5);
    expect(backup.data.productCandidates.length).toBeGreaterThanOrEqual(5);
    // Exclues : présentes mais vides, sans lever d'erreur d'incohérence
    // (productCandidates.productId ne pointe vers aucun `products` exporté).
    expect(backup.data.products).toEqual([]);
    expect(backup.data.shoppingListItems).toEqual([]);
    expect(() => summarizeLocalBackup(backup)).not.toThrow();
  });

  it("importe une sauvegarde partielle en fusion sélective : les tables non incluses restent intactes", async () => {
    const productsBefore = await db.products.toArray();
    const storesBefore = await db.userStores.toArray();

    const backup = await exportLocalBackup(['products']);
    backup.data.products = backup.data.products.map((product) => ({ ...product, name: `${product.name} (import)` }));

    const report = await importLocalBackup(backup);

    expect(report.products).toBe(productsBefore.length);
    expect(report.userStores).toBe(0);
    expect((await db.products.toArray()).every((product) => product.name.endsWith('(import)'))).toBe(true);
    // Les magasins n'étaient pas dans le backup : intacts.
    expect(await db.userStores.toArray()).toEqual(storesBefore);
  });

  it('reste compatible avec un backup v2 (sans includedTables) : tout est considéré inclus', async () => {
    const backup = await exportLocalBackup();
    const legacyBackup = { ...backup, exportSchemaVersion: 2 } as typeof backup & { includedTables?: unknown };
    delete legacyBackup.includedTables;

    const parsed = parseLocalBackup(JSON.stringify(legacyBackup));
    expect(parsed.includedTables.sort()).toEqual([...BACKUP_TABLE_KEYS].sort());

    await db.products.clear();
    await db.userStores.clear();
    const report = await importLocalBackup(parsed);
    expect(report.products).toBe(backup.data.products.length);
    expect(report.userStores).toBe(backup.data.userStores.length);
    expect(await db.userStores.count()).toBe(backup.data.userStores.length);
  });
});
