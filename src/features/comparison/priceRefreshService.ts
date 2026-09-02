import { db } from '../../db/db';
import { ensureDemoData } from '../../db/seed';
import { type StoreKey } from '../../types/domain';
import { type ShoppingListRow, getActiveShoppingListWithItems } from '../shopping-list/shoppingListService';
import { hyperUAdapter } from '../stores/hyperUAdapter.mock';
import { leclercAdapter } from '../stores/leclercAdapter.mock';
import { type StoreAdapter } from '../stores/storeAdapter';

export type StoreAdapterMap = Record<StoreKey, StoreAdapter>;

export type PriceRefreshReport = {
  attempted: number;
  updated: number;
  unavailable: number;
  failed: number;
  errors: string[];
  refreshedAt: string | null;
};

export const defaultStoreAdapters: StoreAdapterMap = {
  leclerc: leclercAdapter,
  hyperu: hyperUAdapter
};

export async function refreshActiveComparisonPrices(adapters = defaultStoreAdapters) {
  await ensureDemoData();
  const activeList = await getActiveShoppingListWithItems();
  return refreshPricesForRows(activeList.rows, adapters);
}

export async function refreshPricesForRows(
  rows: ShoppingListRow[],
  adapters: StoreAdapterMap = defaultStoreAdapters
): Promise<PriceRefreshReport> {
  const productIds = [...new Set(rows.map((row) => row.product.id))];
  const report: PriceRefreshReport = {
    attempted: 0,
    updated: 0,
    unavailable: 0,
    failed: 0,
    errors: [],
    refreshedAt: null
  };

  if (productIds.length === 0) {
    return report;
  }

  const candidates = await db.productCandidates.where('productId').anyOf(productIds).toArray();

  for (const candidate of candidates) {
    const adapter = adapters[candidate.storeKey];
    if (!adapter) {
      report.unavailable += 1;
      continue;
    }

    report.attempted += 1;

    try {
      const snapshot = await adapter.refreshCandidatePrice(candidate);
      if (!snapshot) {
        report.unavailable += 1;
        continue;
      }

      await db.priceSnapshots.put(snapshot);
      report.updated += 1;
      report.refreshedAt = snapshot.checkedAt;
    } catch {
      report.failed += 1;
      report.errors.push(`${adapter.displayName} : prix non actualisé.`);
    }
  }

  report.errors = [...new Set(report.errors)];
  return report;
}
