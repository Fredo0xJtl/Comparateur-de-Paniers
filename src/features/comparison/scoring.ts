import { type CandidateMatchType, type Product } from '../../types/domain';

type CandidateForScoring = {
  productId?: string;
  barcode?: string;
  brand?: string;
  variant?: string;
  quantity?: number;
  matchType: CandidateMatchType;
  confidenceScore: number;
  isRejected?: boolean;
};

export function getCandidateConfidence(product: Product, candidate: CandidateForScoring) {
  if (candidate.isRejected) {
    return 0;
  }

  // 100% réservé à un rapprochement EAN réellement confirmé (les deux codes-
  // barres coïncident) — jamais à un `matchType: 'exact_barcode'` affirmé par
  // le collecteur sans preuve (ex. un score de recouvrement de noms qui
  // atteint 1.0 par coïncidence, sans code-barres observé du tout).
  if (product.barcode && candidate.barcode && product.barcode === candidate.barcode) {
    return 100;
  }

  // Un clic humain explicite sur la fiche réelle (page produit Hyper U ou
  // carte tapée en direct sur Leclerc, voir CandidateMatchType dans
  // domain.ts) est la preuve la plus forte que peut avoir le système —
  // supérieure à tout score automatique, jamais rétrogradée par une
  // recherche automatique ultérieure. Le `confidenceScore` déjà stocké sur
  // le candidat reflète un simple recouvrement de noms côté extension (peut
  // être bas, voire 0) : il est ici volontairement ignoré, pas plafonné.
  if (candidate.matchType === 'manual_override') {
    return 100;
  }

  if (candidate.matchType === 'same_brand_different_format') {
    // Pas de plancher artificiel : un score faible reste faible. Le
    // plafond dépend de la préférence explicite de l'utilisateur pour ce
    // produit — sans son accord, un format différent ne doit jamais
    // s'auto-sélectionner au-dessus d'un format qui correspond réellement.
    let score = candidate.confidenceScore;
    if (sameText(product.brand, candidate.brand)) {
      score += 3;
    }
    if (sameText(product.variant, candidate.variant)) {
      score += 5;
    }
    return clampScore(score, 0, product.allowDifferentFormat === true ? 89 : 84);
  }

  if (candidate.matchType === 'private_label') {
    // L'utilisateur peut refuser explicitement les marques de distributeur
    // pour ce produit — dans ce cas le candidat ne doit jamais concurrencer
    // un vrai match, quel que soit son score de recouvrement.
    if (product.allowPrivateLabel !== true) {
      return 0;
    }
    return clampScore(candidate.confidenceScore, 0, 89);
  }

  if (candidate.matchType === 'equivalent_brand') {
    let score = candidate.confidenceScore;
    if (sameText(product.variant, candidate.variant)) {
      score += 3;
    }
    return clampScore(score, 0, 89);
  }

  if (candidate.matchType === 'uncertain') {
    return clampScore(candidate.confidenceScore, 0, 64);
  }

  // `exact_barcode` affirmé par le collecteur mais non prouvé ci-dessus (pas
  // de code-barres produit connu, ou codes différents), ou tout autre
  // matchType imprévu : jamais au-dessus de 89% sans preuve EAN réelle.
  return clampScore(candidate.confidenceScore, 0, 89);
}

// Formats dont la correspondance de conditionnement n'est jamais garantie
// (contrairement à exact_barcode ou manual_override) — leur score peut
// dépasser le seuil de confiance réglable (scoring.ts, getCandidateConfidence
// les plafonne à 84-89%) et être auto-sélectionné malgré ça.
export const FORMAT_NOT_GUARANTEED_MATCH_TYPES: ReadonlySet<CandidateMatchType> = new Set([
  'same_brand_different_format',
  'equivalent_brand',
  'private_label'
]);

export function requiresValidation(
  candidate: Pick<CandidateForScoring, 'confidenceScore' | 'matchType' | 'isRejected'>,
  autoDecisionMinConfidence: number,
  wantedQuantity = 1
) {
  return Boolean(
    candidate.isRejected ||
      candidate.matchType === 'uncertain' ||
      candidate.confidenceScore < autoDecisionMinConfidence ||
      // À quantité 1, ajouter le candidat trouvé (quel que soit son
      // conditionnement) n'introduit aucune erreur de comptage — l'utilisateur
      // voit le produit exact affiché et le valide lui-même. Le risque ne
      // naît qu'en multipliant : si le candidat retenu est un lot différent
      // du conditionnement demandé, `quantity` envoyée au panier (= la
      // quantité désirée telle quelle, jamais recalculée) peut correspondre à
      // un nombre d'unités totalement différent de l'intention réelle.
      // Bloquer systématiquement (même à quantité 1) viderait l'app de sa
      // valeur : private_label/equivalent_brand sont le cœur du comparateur.
      (wantedQuantity > 1 && FORMAT_NOT_GUARANTEED_MATCH_TYPES.has(candidate.matchType))
  );
}

function sameText(left: string | undefined, right: string | undefined) {
  return Boolean(left && right && left.trim().toLocaleLowerCase('fr') === right.trim().toLocaleLowerCase('fr'));
}

function clampScore(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}
