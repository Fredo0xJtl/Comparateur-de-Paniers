import type { ProductCandidate, PriceSnapshot } from '../../types/domain';
import type { ShoppingListRow } from '../shopping-list/shoppingListService';
import type { ComparisonResult } from './comparisonEngine';

export function buildCalculationProof(input: {
  result: ComparisonResult;
  rows: ShoppingListRow[];
  candidates: ProductCandidate[];
  snapshots: PriceSnapshot[];
  createdAt?: string;
}) {
  const rowById = new Map(input.rows.map((row) => [row.item.id, row]));
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const snapshotByCandidateId = new Map(input.snapshots.map((snapshot) => [snapshot.candidateId, snapshot]));
  return {
    format: 'comparateur-panier-calculation-proof' as const,
    formatVersion: 1 as const,
    engineVersion: 1 as const,
    createdAt: input.createdAt ?? new Date().toISOString(),
    trustStatus: input.result.trustReport.status,
    excludedLines: input.result.excludedLines,
    trustReport: input.result.trustReport,
    totals: input.result.totals,
    coverage: input.result.coverage,
    savingsVsBestSingleStore: input.result.savingsVsBestSingleStore,
    recommendation: input.result.recommendation,
    lines: input.result.decisions.map((decision) => {
      const row = rowById.get(decision.itemId);
      const candidate = decision.selectedCandidateId ? candidateById.get(decision.selectedCandidateId) : undefined;
      const snapshot = decision.selectedCandidateId ? snapshotByCandidateId.get(decision.selectedCandidateId) : undefined;
      return {
        itemId: decision.itemId,
        productId: decision.productId,
        productName: row?.product.name,
        wantedQuantity: row?.item.wantedQuantity,
        selectedStoreKey: decision.selectedStoreKey,
        candidate: candidate && { id: candidate.id, name: candidate.name, barcode: candidate.barcode, matchType: candidate.matchType },
        priceEvidence: snapshot && { price: snapshot.price, unitPrice: snapshot.unitPrice, checkedAt: snapshot.checkedAt, source: snapshot.source, priceCoherence: snapshot.priceCoherence },
        quantityToBuy: decision.quantityToBuy,
        lineTotal: decision.price,
        confidenceScore: decision.confidenceScore,
        requiresValidation: decision.requiresValidation,
        reason: decision.reason,
        warnings: decision.warnings
      };
    })
  };
}
