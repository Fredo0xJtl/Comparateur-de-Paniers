import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import { demoProducts, ensureDemoData } from './seed';

describe('demoProducts', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('contains the five stable MVP demo products', () => {
    expect(demoProducts.map((product) => product.id)).toEqual([
      'prod-ice-tea-peche',
      'prod-lait-demi-ecreme',
      'prod-riz-basmati',
      'prod-lessive-liquide',
      'prod-papier-toilette'
    ]);
  });

  it('backfills mock store data when an older local database only has products', async () => {
    await db.products.bulkPut(demoProducts);

    await ensureDemoData();

    expect(await db.products.count()).toBe(5);
    // userStores must NOT be seeded — these are user data, not demo data.
    // Users add their own stores; seeding would revert saved URLs on restart.
    expect(await db.userStores.count()).toBe(0);
    expect(await db.productCandidates.count()).toBeGreaterThanOrEqual(5);
    expect(await db.priceSnapshots.count()).toBeGreaterThanOrEqual(5);
    expect(await db.settings.get('default')).toBeDefined();
  });
});
