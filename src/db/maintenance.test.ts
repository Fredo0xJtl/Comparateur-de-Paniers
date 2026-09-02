import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { purgeExpiredCaches, wipeAllLocalData } from './maintenance';
import { resetDemoData } from './seed';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

describe('purgeExpiredCaches', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('drops store searches past their 24h TTL and keeps the fresh ones', async () => {
    await db.storeSearchCache.bulkPut([
      { queryKey: 'leclerc:nantes', results: [], createdAt: daysAgo(3) },
      { queryKey: 'hyperu:rennes', results: [], createdAt: daysAgo(0) }
    ]);

    const report = await purgeExpiredCaches(NOW);

    expect(report.storeSearchCache).toBe(1);
    expect((await db.storeSearchCache.toArray()).map((entry) => entry.queryKey)).toEqual([
      'hyperu:rennes'
    ]);
  });

  it('preserves the Nominatim rate-limit marker regardless of its age', async () => {
    // Cette clé partage la table mais n'est pas un résultat de recherche :
    // la supprimer relâcherait la limite d'une requête par seconde.
    await db.storeSearchCache.put({
      queryKey: '__nominatim_last_request__',
      results: [],
      createdAt: daysAgo(30)
    });

    const report = await purgeExpiredCaches(NOW);

    expect(report.storeSearchCache).toBe(0);
    expect(await db.storeSearchCache.get('__nominatim_last_request__')).toBeTruthy();
  });

  it('drops drive search memory past its 14 day TTL', async () => {
    await db.products.put({
      id: 'prod-1',
      name: 'Lait',
      createdAt: daysAgo(60),
      updatedAt: daysAgo(60)
    });
    await db.driveSearchMemory.bulkPut([
      { productId: 'prod-1', storeKey: 'leclerc', outcome: 'not_found', updatedAt: daysAgo(20) },
      { productId: 'prod-1', storeKey: 'hyperu', outcome: 'not_found', updatedAt: daysAgo(2) }
    ]);

    const report = await purgeExpiredCaches(NOW);

    expect(report.driveSearchMemory).toBe(1);
    expect((await db.driveSearchMemory.toArray()).map((entry) => entry.storeKey)).toEqual([
      'hyperu'
    ]);
  });

  it('drops drive search memory left orphaned by a deleted product', async () => {
    // Entrée récente, donc dans son TTL, mais son produit n'existe plus :
    // plus rien ne la lira jamais.
    await db.driveSearchMemory.put({
      productId: 'prod-supprime',
      storeKey: 'leclerc',
      outcome: 'not_found',
      updatedAt: daysAgo(1)
    });

    const report = await purgeExpiredCaches(NOW);

    expect(report.driveSearchMemory).toBe(1);
    expect(await db.driveSearchMemory.count()).toBe(0);
  });

  it('keeps a recent entry whose product still exists', async () => {
    await db.products.put({
      id: 'prod-1',
      name: 'Lait',
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3)
    });
    await db.driveSearchMemory.put({
      productId: 'prod-1',
      storeKey: 'leclerc',
      outcome: 'matched',
      updatedAt: daysAgo(1)
    });

    const report = await purgeExpiredCaches(NOW);

    expect(report.driveSearchMemory).toBe(0);
    expect(await db.driveSearchMemory.count()).toBe(1);
  });
});

describe('wipeAllLocalData', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('vide toutes les tables, y compris celles hors du périmètre de backupService', async () => {
    await resetDemoData();
    await db.storeSearchCache.put({ queryKey: 'leclerc:nantes', results: [], createdAt: daysAgo(0) });
    await db.driveSearchMemory.put({
      productId: 'prod-ice-tea-peche',
      storeKey: 'leclerc',
      outcome: 'matched',
      updatedAt: daysAgo(0)
    });

    expect(await db.products.count()).toBeGreaterThan(0);

    await wipeAllLocalData();

    const counts = await Promise.all([
      db.products.count(),
      db.userStores.count(),
      db.productCandidates.count(),
      db.priceSnapshots.count(),
      db.shoppingLists.count(),
      db.shoppingListItems.count(),
      db.settings.count(),
      db.storeSearchCache.count(),
      db.driveSearchMemory.count(),
      db.validatedBaskets.count(),
      db.productCache.count(),
      db.driveManualOverrides.count()
    ]);
    expect(counts).toEqual(counts.map(() => 0));
  });
});
