import type { ComparisonDecision, StoreCoverage } from './comparisonEngine';

export type TrustStatus = 'trusted' | 'attention' | 'blocked';
export type TrustIssueCode =
  | 'requires_validation' | 'incomplete_coverage' | 'stale_price' | 'missing_price'
  | 'price_mismatch' | 'unsupported_promotion' | 'different_format' | 'confirmed_absent_both';
export type TrustIssueAction = 'refresh_prices' | 'validate_candidate' | 'confirm_format' | 'review';

export type TrustIssue = {
  id: string;
  code: TrustIssueCode;
  severity: 'blocking' | 'warning';
  message: string;
  action: TrustIssueAction;
  itemId?: string;
  productId?: string;
};

export type ComparisonTrustReport = {
  status: TrustStatus;
  issues: TrustIssue[];
  blockingIssueCount: number;
  warningIssueCount: number;
  canValidateBasket: boolean;
  canAddToCart: boolean;
  summary: { itemCount: number; trustedDecisionCount: number; completeStoreCount: number };
};

const signalRules = {
  REQUIRES_VALIDATION: { code: 'requires_validation', message: 'Le produit doit être identifié ou confirmé avant de pouvoir faire confiance au calcul.', action: 'validate_candidate' },
  STALE_PRICE: { code: 'stale_price', message: 'Le prix doit être actualisé.', action: 'refresh_prices' },
  MISSING_PRICE: { code: 'missing_price', message: 'Le prix est absent.', action: 'refresh_prices' },
  PRICE_MISMATCH: { code: 'price_mismatch', message: 'Le prix est incohérent avec le prix au litre ou au kilo.', action: 'review' },
  FORMAT_CONFIRMATION_REQUIRED: { code: 'different_format', message: 'Le format doit être confirmé.', action: 'confirm_format' },
  CONFIRMED_ABSENT_BOTH: { code: 'confirmed_absent_both', message: 'Produit absent des deux magasins : ligne exclue du calcul.', action: 'review' },
  PROMOTION_NOT_OPTIMIZED: { code: 'unsupported_promotion', message: 'Promotion détectée mais non optimisée.', action: 'review' }
} as const;

export function assessComparisonTrust(input: {
  decisions: ComparisonDecision[];
  coverage: { leclerc: StoreCoverage; hyperu: StoreCoverage };
}): ComparisonTrustReport {
  const issues: TrustIssue[] = [];
  const seen = new Set<string>();
  const add = (issue: TrustIssue) => {
    if (!seen.has(issue.id)) { seen.add(issue.id); issues.push(issue); }
  };

  for (const decision of input.decisions) {
    for (const signal of decision.signals) {
      const rule = signalRules[signal.code];
      add({ id: `${rule.code}:${decision.itemId}`, code: rule.code, severity: signal.severity,
        message: rule.message, action: rule.action, itemId: decision.itemId, productId: decision.productId });
    }
  }

  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1));
  const blockingIssueCount = issues.filter((issue) => issue.severity === 'blocking').length;
  const warningIssueCount = issues.length - blockingIssueCount;
  const status: TrustStatus = blockingIssueCount > 0 ? 'blocked' : warningIssueCount > 0 ? 'attention' : 'trusted';
  return {
    status, issues, blockingIssueCount, warningIssueCount,
    canValidateBasket: blockingIssueCount === 0,
    canAddToCart: blockingIssueCount === 0,
    summary: {
      itemCount: input.decisions.length,
      trustedDecisionCount: input.decisions.filter((decision) => !decision.requiresValidation).length,
      completeStoreCount: (['leclerc', 'hyperu'] as const).filter((key) => input.coverage[key].covered === input.coverage[key].total).length
    }
  };
}
