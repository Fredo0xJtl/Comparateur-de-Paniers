import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { demoProducts, ensureDemoData, resetDemoData } from '../../db/seed';
import { addProductToActiveList } from '../shopping-list/shoppingListService';
import { loadActiveComparison } from './comparisonService';

// Étape 5 : rend les snapshots de démo utilisables comme de "vrais" prix
// confirmés récemment — sert uniquement à vérifier que le moteur calcule
// correctement une fois qu'un vrai refresh a eu lieu ; la donnée de
// démo brute (source 'mock', jamais vérifiée) est volontairement testée
// séparément ci-dessous, sans ce passage.
async function markPriceSnapshotsAsFreshRealPrices() {
  await db.priceSnapshots.toCollection().modify((snapshot) => {
    snapshot.source = 'adapter';
    snapshot.checkedAt = new Date().toISOString();
  });
}

describe('comparisonService', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    await resetDemoData();
  });

  it('loads the active list data and runs the comparison engine', async () => {
    await markPriceSnapshotsAsFreshRealPrices();
    await addProductToActiveList('prod-ice-tea-peche');
    await addProductToActiveList('prod-lait-demi-ecreme');

    const comparison = await loadActiveComparison();

    expect(comparison.rows).toHaveLength(2);
    expect(comparison.candidates.length).toBeGreaterThanOrEqual(5);
    expect(comparison.priceSnapshots.length).toBeGreaterThanOrEqual(5);
    expect(comparison.settings.savingThresholdEuro).toBe(3);
    expect(comparison.result?.totals.leclerc).toBe(7.83);
    expect(comparison.result?.totals.hyperu).toBe(7.9);
    expect(comparison.result?.recommendation.kind).toBe('single_store');
  });

  // Étape 5 : les données de démo ('mock', jamais vérifiées en magasin) ne
  // doivent jamais produire un total présenté comme fiable — sans refresh
  // réel, tout doit rester "à valider" plutôt que de faire croire à un
  // comparatif opérationnel dès l'installation.
  it("les prix de démonstration ('mock') n'alimentent jamais un total sans validation manuelle", async () => {
    await addProductToActiveList('prod-ice-tea-peche');
    await addProductToActiveList('prod-lait-demi-ecreme');

    const comparison = await loadActiveComparison();

    expect(comparison.result?.totals.leclerc).toBeNull();
    expect(comparison.result?.totals.hyperu).toBeNull();
    expect(comparison.result?.recommendation.kind).toBe('needs_validation');
    expect(comparison.result?.productsToValidate).toHaveLength(2);
  });

  it('returns no result when the active list is empty', async () => {
    const comparison = await loadActiveComparison();

    expect(comparison.rows).toHaveLength(0);
    expect(comparison.result).toBeNull();
  });

  it('backfills missing mock comparison data before loading an older active list', async () => {
    await db.delete();
    await db.open();
    await db.products.bulkPut(demoProducts);
    await addProductToActiveList('prod-ice-tea-peche');

    // Déclenche explicitement le même backfill que loadActiveComparison
    // appelle en interne, pour pouvoir vérifier son effet (tables vides →
    // repeuplées) avant de rendre les prix "réels" pour la suite du test.
    await ensureDemoData();
    expect(await db.productCandidates.count()).toBeGreaterThanOrEqual(3);
    expect(await db.priceSnapshots.count()).toBeGreaterThanOrEqual(3);
    await markPriceSnapshotsAsFreshRealPrices();

    const comparison = await loadActiveComparison();

    expect(comparison.result?.totals.leclerc).toBe(1.89);
  });

  it('can refresh active prices before returning comparison data', async () => {
    await db.priceSnapshots.toCollection().modify((snapshot) => {
      snapshot.checkedAt = '2020-01-01T00:00:00.000Z';
    });
    await addProductToActiveList('prod-ice-tea-peche');

    const comparison = await loadActiveComparison({ refreshPrices: true });
    const refreshedSnapshot = comparison.priceSnapshots.find(
      (snapshot) => snapshot.id === 'price-ice-tea-leclerc'
    );
    const untouchedSnapshot = comparison.priceSnapshots.find(
      (snapshot) => snapshot.id === 'price-lait-leclerc'
    );

    expect(comparison.refreshReport?.updated).toBe(3);
    expect(refreshedSnapshot?.checkedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(untouchedSnapshot?.checkedAt).toBe('2020-01-01T00:00:00.000Z');
  });
});
