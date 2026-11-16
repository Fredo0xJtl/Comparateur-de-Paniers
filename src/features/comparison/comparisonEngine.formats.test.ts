import { describe, expect, it } from 'vitest';
import { demoProducts } from '../../db/seed';
import type { ProductCandidate } from '../../types/domain';
import { mockPriceSnapshots, mockProductCandidates } from '../stores/mockStoreData';
import { compareShoppingList, formatLabel } from './comparisonEngine';

// Formats différents (16/11) : une ligne dont le paquet retenu n'a pas le
// format de la liste doit être signalée (avertissement + résumé formatNotices
// affiché avant le conseil), sans changer le prix compté ni bloquer le panier.
const freshSnapshots = mockPriceSnapshots.map((snapshot) => ({
  ...snapshot,
  source: 'adapter' as const,
  checkedAt: new Date().toISOString()
}));

const iceTeaRow = {
  product: demoProducts[0],
  item: {
    id: 'item-ice-tea',
    shoppingListId: 'list-active',
    productId: 'prod-ice-tea-peche',
    wantedQuantity: 1,
    createdAt: '2026-07-07T10:00:00.000Z'
  }
};

function compare(candidates: ProductCandidate[], product = demoProducts[0]) {
  return compareShoppingList({
    rows: [{ ...iceTeaRow, product }],
    candidates,
    priceSnapshots: freshSnapshots,
    savingThresholdEuro: 3,
    autoDecisionMinConfidence: 75,
    maxPriceAgeDays: 7
  });
}

describe('comparisonEngine — formats différents de la liste', () => {
  it('signale le paquet retenu qui n’a pas le format demandé, sans changer le prix compté', () => {
    // Liste : 1,5 L. Hyper U (2 L à 2,20 €) l'emporte au prix au litre.
    const result = compare(mockProductCandidates);
    const decision = result.decisions[0];

    expect(decision.selectedStoreKey).toBe('hyperu');
    expect(result.totals.optimized).toBe(2.2);
    expect(decision.warnings).toContain(
      'Format différent de ta liste : tu as demandé 1,5 L, le paquet retenu chez Hyper U fait 2 L. Le prix compté est celui de ce paquet.'
    );
    expect(decision.signals).toContainEqual({ code: 'FORMAT_DIFFERS_FROM_LIST', severity: 'warning' });
    // Pas de doublon avec le libellé court « Format différent ».
    expect(decision.warnings).not.toContain('Format différent');
    expect(result.formatNotices).toEqual([
      {
        itemId: 'item-ice-tea',
        productId: 'prod-ice-tea-peche',
        requested: '1,5 L',
        selectedStoreKey: 'hyperu',
        byStore: { leclerc: '1,5 L', hyperu: '2 L' },
        selectedDiffersFromList: true,
        storesDiffer: true
      }
    ]);
    // Avertissement seulement : le format peut être voulu, le panier reste validable.
    expect(result.trustReport.blockingIssueCount).toBe(0);
    expect(result.trustReport.canValidateBasket).toBe(true);
    expect(result.trustReport.issues.map((issue) => issue.code)).toContain('format_differs_from_list');
  });

  it('ne signale rien quand les deux magasins ont le format de la liste', () => {
    const sameFormat = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-hyperu-format' ? { ...candidate, quantity: 1.5 } : candidate
    );
    const result = compare(sameFormat);

    expect(result.formatNotices).toEqual([]);
    expect(result.decisions[0].signals.map((signal) => signal.code)).not.toContain('FORMAT_DIFFERS_FROM_LIST');
  });

  it('résume sans avertir la ligne quand seul l’autre magasin a un format différent', () => {
    // Hyper U à 2 L mais plus cher au litre : Leclerc (1,5 L, le format de la liste) est retenu.
    const pricierHyperU = freshSnapshots.map((snapshot) =>
      snapshot.candidateId === 'cand-ice-tea-hyperu-format' ? { ...snapshot, price: 9.99, unitPrice: 5 } : snapshot
    );
    const result = compareShoppingList({
      rows: [iceTeaRow],
      candidates: mockProductCandidates,
      priceSnapshots: pricierHyperU,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: 7
    });

    expect(result.decisions[0].selectedStoreKey).toBe('leclerc');
    expect(result.formatNotices).toHaveLength(1);
    expect(result.formatNotices[0]).toMatchObject({ selectedDiffersFromList: false, storesDiffer: true });
    expect(result.decisions[0].signals.map((signal) => signal.code)).not.toContain('FORMAT_DIFFERS_FROM_LIST');
  });

  it('ne devine rien quand ni la fiche ni son nom ne donnent de format', () => {
    const unknownFormats = mockProductCandidates.map((candidate) =>
      candidate.productId === 'prod-ice-tea-peche'
        ? { ...candidate, name: 'Thé glacé pêche', quantity: undefined, unit: undefined }
        : candidate
    );
    const result = compare(unknownFormats);

    expect(result.formatNotices).toEqual([]);
  });

  it('ne compare pas un poids à un volume (extraction ratée plutôt que vrai écart)', () => {
    const weightCandidates = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-hyperu-format' ? { ...candidate, quantity: 500, unit: 'g' as const } : candidate
    );
    const result = compare(weightCandidates);

    expect(result.formatNotices.every((notice) => !notice.selectedDiffersFromList || notice.selectedStoreKey !== 'hyperu')).toBe(true);
  });
});

describe('formatLabel', () => {
  it('écrit les volumes d’un litre ou plus en litres, comme les magasins', () => {
    expect(formatLabel({ quantity: 1500, unit: 'ml' })).toBe('1,5 L');
    expect(formatLabel({ quantity: 3000, unit: 'ml' })).toBe('3 L');
    expect(formatLabel({ quantity: 750, unit: 'ml' })).toBe('750 ml');
    expect(formatLabel({ quantity: 1040, unit: 'g' })).toBe('1040 g');
  });

  it('lit le format dans le nom d’une fiche sans format, pour l’avertissement seulement', () => {
    const noFormat = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-hyperu-format'
        ? { ...candidate, name: 'Thé glacé pêche 2x1,5L', quantity: undefined, unit: undefined }
        : candidate
    );
    const result = compare(noFormat as ProductCandidate[]);
    const notice = result.formatNotices.find((entry) => entry.itemId === 'item-ice-tea');
    expect(notice?.byStore.hyperu).toBe('3 L');
    // Le format déduit ne sert à aucun contrôle de prix : rien de bloquant.
    expect(result.trustReport.blockingIssueCount).toBe(0);
    expect(noFormat.find((c) => c.id === 'cand-ice-tea-hyperu-format')?.quantity).toBeUndefined();
  });
});
