import { db } from '../../db/db';
import { defaultSettings, ensureDemoData } from '../../db/seed';
import {
  type PriceSnapshot,
  type ProductCandidate,
  type UserSettings
} from '../../types/domain';
import {
  getActiveShoppingListWithItems,
  type ShoppingListRow
} from '../shopping-list/shoppingListService';
import { compareShoppingList, type ComparisonResult } from './comparisonEngine';
import { refreshPricesForRows, type PriceRefreshReport } from './priceRefreshService';

export type ActiveComparison = {
  rows: ShoppingListRow[];
  candidates: ProductCandidate[];
  priceSnapshots: PriceSnapshot[];
  settings: UserSettings;
  refreshReport?: PriceRefreshReport;
  result: ComparisonResult | null;
};

export type LoadActiveComparisonOptions = {
  refreshPrices?: boolean;
};

export async function loadActiveComparison(
  options: LoadActiveComparisonOptions = {}
): Promise<ActiveComparison> {
  await ensureDemoData();

  const activeList = await getActiveShoppingListWithItems();
  const refreshReport =
    options.refreshPrices && activeList.rows.length > 0
      ? await refreshPricesForRows(activeList.rows)
      : undefined;
  const [candidates, priceSnapshots, storedSettings] = await Promise.all([
    db.productCandidates.toArray(),
    db.priceSnapshots.toArray(),
    db.settings.get('default')
  ]);
  // Fusionner avec les valeurs par défaut : un enregistrement déjà en base
  // chez un utilisateur existant n'a pas les champs ajoutés après coup (ex.
  // `maxPriceAgeDays`) — sans ce merge, ils resteraient `undefined`.
  const settings = { ...defaultSettings, ...(storedSettings ?? {}) };

  return {
    rows: activeList.rows,
    candidates,
    priceSnapshots,
    settings,
    refreshReport,
    result:
      activeList.rows.length === 0
        ? null
        : compareShoppingList({
            rows: activeList.rows,
            candidates,
            priceSnapshots,
            savingThresholdEuro: settings.savingThresholdEuro,
            autoDecisionMinConfidence: settings.autoDecisionMinConfidence,
            maxPriceAgeDays: settings.maxPriceAgeDays
          })
  };
}

// Marque un candidat comme rejeté par l'utilisateur ("Aucun de ceux-là") — le
// champ `isRejected` existe dans le schéma depuis le début mais n'était
// jamais écrit : `getCandidateConfidence`/`requiresValidation` l'ignoraient
// silencieusement, et `buildOptionsForRow` exclut déjà tout candidat rejeté,
// donc un simple `put` suffit à le retirer de la comparaison. Réversible :
// repasser `isRejected` à `false` réintègre le candidat normalement.
export async function setProductCandidateRejected(candidateId: string, isRejected: boolean): Promise<void> {
  await db.productCandidates.update(candidateId, { isRejected, updatedAt: new Date().toISOString() });
}
