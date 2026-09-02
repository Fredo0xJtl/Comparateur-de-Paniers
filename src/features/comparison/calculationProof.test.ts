import { describe, expect, it } from 'vitest';
import { demoProducts } from '../../db/seed';
import { mockPriceSnapshots, mockProductCandidates } from '../stores/mockStoreData';
import { compareShoppingList } from './comparisonEngine';
import { buildCalculationProof } from './calculationProof';

it('exporte pour chaque ligne la provenance et les données du calcul', () => {
  const rows = [{ product: demoProducts[0], item: { id: 'item-1', shoppingListId: 'list-active', productId: demoProducts[0].id, wantedQuantity: 1, createdAt: '2026-01-01' } }];
  const snapshots = mockPriceSnapshots.map((snapshot) => ({ ...snapshot, source: 'adapter' as const, checkedAt: new Date().toISOString() }));
  const result = compareShoppingList({ rows, candidates: mockProductCandidates, priceSnapshots: snapshots, savingThresholdEuro: 3, autoDecisionMinConfidence: 75, maxPriceAgeDays: 7 });
  const proof = buildCalculationProof({ result, rows, candidates: mockProductCandidates, snapshots, createdAt: '2026-09-01T00:00:00.000Z' });
  expect(proof.formatVersion).toBe(1);
  expect(proof.engineVersion).toBe(1);
  expect(proof.trustStatus).toBe(result.trustReport.status);
  expect(proof.excludedLines).toEqual(result.excludedLines);
  expect(proof.lines[0]).toMatchObject({ productName: demoProducts[0].name, wantedQuantity: 1, reason: expect.any(String) });
  expect(proof.trustReport).toEqual(result.trustReport);
});
