import { describe, expect, it } from 'vitest';
import { assessComparisonTrust } from './trustAssessment';
import type { ComparisonDecision, StoreCoverage } from './comparisonEngine';

const decision = (overrides: Partial<ComparisonDecision> = {}): ComparisonDecision => ({
  itemId: 'item-1', productId: 'product-1', selectedCandidateId: 'candidate-1',
  selectedStoreKey: 'leclerc', confidenceScore: 100, price: 2, quantityToBuy: 1,
  reason: 'EAN exact', warnings: [], requiresValidation: false, alternates: [],
  signals: [],
  storeCandidateIds: { leclerc: 'candidate-1', hyperu: 'candidate-2' }, ...overrides
});

const coverage = (covered = 1): StoreCoverage => ({
  covered, total: 1, lines: [{ itemId: 'item-1', productId: 'product-1', status: covered ? 'priced' : 'notFound' }]
});

describe('assessComparisonTrust', () => {
  it('déclare fiable une comparaison complète sans anomalie', () => {
    const report = assessComparisonTrust({ decisions: [decision()], coverage: { leclerc: coverage(), hyperu: coverage() } });
    expect(report.status).toBe('trusted');
    expect(report.canValidateBasket).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('bloque et priorise validation et incohérence de prix sans bloquer une simple couverture magasin incomplète', () => {
    const report = assessComparisonTrust({
      decisions: [decision({ requiresValidation: true, signals: [
        { code: 'REQUIRES_VALIDATION', severity: 'blocking' },
        { code: 'PRICE_MISMATCH', severity: 'blocking' }
      ] })],
      coverage: { leclerc: coverage(), hyperu: coverage(0) }
    });
    expect(report.status).toBe('blocked');
    expect(report.canValidateBasket).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual([
      'requires_validation', 'price_mismatch'
    ]);
  });

  it('classe une promotion non optimisée comme avertissement non bloquant', () => {
    const report = assessComparisonTrust({
      decisions: [decision({ signals: [{ code: 'PROMOTION_NOT_OPTIMIZED', severity: 'warning' }] })],
      coverage: { leclerc: coverage(), hyperu: coverage() }
    });
    expect(report.status).toBe('attention');
    expect(report.canValidateBasket).toBe(true);
    expect(report.issues[0]?.code).toBe('unsupported_promotion');
  });

  it('signale un produit absent des deux magasins sans bloquer les autres lignes', () => {
    const absent = decision({
      itemId: 'item-absent', productId: 'product-absent', selectedCandidateId: undefined,
      selectedStoreKey: undefined, price: undefined, requiresValidation: true,
      signals: [{ code: 'CONFIRMED_ABSENT_BOTH', severity: 'warning' }]
    });
    const report = assessComparisonTrust({ decisions: [decision(), absent], coverage: { leclerc: coverage(), hyperu: coverage() } });
    expect(report.status).toBe('attention');
    expect(report.canValidateBasket).toBe(true);
    expect(report.issues.map((issue) => issue.code)).toContain('confirmed_absent_both');
  });
});
