import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { resetDemoData } from '../../db/seed';
import {
  addProductToActiveList,
  getActiveShoppingListWithItems
} from '../shopping-list/shoppingListService';
import { hyperUAdapter } from '../stores/hyperUAdapter.mock';
import { leclercAdapter } from '../stores/leclercAdapter.mock';
import {
  refreshActiveComparisonPrices,
  refreshPricesForRows
} from './priceRefreshService';

const oldCheckedAt = '2020-01-01T00:00:00.000Z';

describe('priceRefreshService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await resetDemoData();
    await db.priceSnapshots.toCollection().modify((snapshot) => {
      snapshot.checkedAt = oldCheckedAt;
    });
  });

  it('refreshes only candidates attached to the active shopping list', async () => {
    await addProductToActiveList('prod-ice-tea-peche');

    const report = await refreshActiveComparisonPrices();
    const refreshedIceTea = await db.priceSnapshots
      .where('candidateId')
      .anyOf([
        'cand-ice-tea-leclerc-exact',
        'cand-ice-tea-hyperu-format',
        'cand-ice-tea-hyperu-mdd'
      ])
      .toArray();
    const untouchedMilk = await db.priceSnapshots.get('price-lait-leclerc');

    expect(report.attempted).toBe(3);
    expect(report.updated).toBe(3);
    expect(refreshedIceTea.every((snapshot) => snapshot.checkedAt !== oldCheckedAt)).toBe(true);
    expect(untouchedMilk?.checkedAt).toBe(oldCheckedAt);
  });

  it('keeps old prices and reports an adapter failure without breaking other stores', async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    const activeList = await getActiveShoppingListWithItems();

    const report = await refreshPricesForRows(activeList.rows, {
      leclerc: {
        ...leclercAdapter,
        async refreshCandidatePrice() {
          throw new Error('adapter failed');
        }
      },
      hyperu: hyperUAdapter
    });
    const leclercSnapshot = await db.priceSnapshots.get('price-ice-tea-leclerc');
    const hyperUSnapshot = await db.priceSnapshots.get('price-ice-tea-hyperu-format');

    expect(report.failed).toBe(1);
    expect(report.errors).toContain('Leclerc Drive : prix non actualisé.');
    expect(leclercSnapshot?.checkedAt).toBe(oldCheckedAt);
    expect(hyperUSnapshot?.checkedAt).not.toBe(oldCheckedAt);
  });
});
