import {
  type CandidateMatchType,
  type PriceSnapshot,
  type ProductCandidate,
  type ShoppingListItem,
  type StoreKey
} from '../../types/domain';
import { type ShoppingListRow } from '../shopping-list/shoppingListService';
import { FORMAT_NOT_GUARANTEED_MATCH_TYPES, getCandidateConfidence, requiresValidation } from './scoring';
import {
  calculateLineTotal,
  formatsDiffer,
  normalizeToComparableFormat,
  roundMoney,
  type NormalizedFormat
} from './unitNormalization';
import {
  formatUnitPriceLabel,
  isUnitPriceBasisReliable,
  resolveUnitPriceBasis,
  unitPriceBasesComparable,
  unitPriceGapIsSignificant,
  type UnitPriceBasis
} from './unitPriceArbitration';
import { assessComparisonTrust, type ComparisonTrustReport } from './trustAssessment';

export type ComparisonInput = {
  rows: ShoppingListRow[];
  candidates: ProductCandidate[];
  priceSnapshots: PriceSnapshot[];
  savingThresholdEuro: number;
  autoDecisionMinConfidence: number;
  // Au-delà de cet âge (en jours), un prix `available` n'est plus considéré
  // assez frais pour être utilisé automatiquement — le magasin a pu changer
  // son prix depuis sans qu'une collecte l'ait revérifié.
  maxPriceAgeDays: number;
};

export type ComparisonDecision = {
  itemId: string;
  productId: string;
  selectedCandidateId?: string;
  selectedStoreKey?: StoreKey;
  confidenceScore: number;
  price?: number;
  unitPrice?: number;
  quantityToBuy: number;
  reason: string;
  warnings: string[];
  signals: ComparisonSignal[];
  requiresValidation: boolean;
  alternates: ComparisonAlternate[];
  // Best available candidate per store for this row, independent of which
  // store ended up selected/cheapest — lets the UI offer a direct "voir chez
  // Leclerc" / "voir chez Hyper U" link without forcing the user through the
  // "magasin forcé" override just to look at the other store's product page.
  storeCandidateIds: Partial<Record<StoreKey, string>>;
};

export type ComparisonSignalCode =
  | 'REQUIRES_VALIDATION'
  | 'STALE_PRICE'
  | 'MISSING_PRICE'
  | 'PRICE_MISMATCH'
  | 'FORMAT_CONFIRMATION_REQUIRED'
  | 'CONFIRMED_ABSENT_BOTH'
  | 'PROMOTION_NOT_OPTIMIZED';

export type ComparisonSignal = { code: ComparisonSignalCode; severity: 'blocking' | 'warning' };

export type ComparisonAlternate = {
  candidateId: string;
  storeKey: StoreKey;
  name: string;
  price?: number;
  matchType: CandidateMatchType;
  productUrl?: string;
};

export type ComparisonResult = {
  decisions: ComparisonDecision[];
  productsToValidate: ComparisonDecision[];
  totals: Record<StoreKey, number | null> & { optimized: number | null };
  // "Tout acheter chez X" only sums rows that HAVE a valid price at that
  // store — a product missing there (search failed, blocked, filtered as
  // already-known-unavailable) is silently left out rather than making the
  // whole total null. Without this, a near-empty basket (1-2 products found)
  // can show a lower total than the cross-store "panier réparti", which
  // picks from whichever store has ANY price and so naturally covers more
  // rows — reading as a paradox ("répartir coûte plus cher que tout prendre
  // au moins cher") when it's really just two totals over different subsets
  // of the list. Exposing coverage lets the UI make that visible instead of
  // presenting both totals as directly comparable.
  coverage: Record<StoreKey, StoreCoverage>;
  savingsVsBestSingleStore: number | null;
  trustReport: ComparisonTrustReport;
  excludedLines: Array<{ itemId: string; productId: string; reason: 'absent_both' }>;
  recommendation:
    | { kind: 'split'; reason: string }
    | { kind: 'single_store'; storeKey: StoreKey; reason: string }
    | { kind: 'needs_validation'; reason: string };
};

// Statut d'une ligne dans le détail exhaustif par magasin (voir
// `calculateStoreTotal`) :
// - 'priced' : candidat au prix ferme, compté dans `totals.<magasin>`.
// - 'requiresValidation' : un candidat existe mais pas assez fiable pour une
//   sélection automatique (confiance faible, format incertain, prix de démo,
//   prix trop vieux, ou aucun prix relevé du tout — candidat proposé mais
//   jamais encore vérifié en magasin) — PAS compté dans le total.
// - 'unavailable' : un candidat existe ET a été effectivement vérifié sur le
//   site, qui a explicitement indiqué une rupture de stock — jamais utilisé
//   pour un candidat simplement pas encore relevé (voir 'requiresValidation'
//   ci-dessus, qui couvre aussi ce cas depuis le correctif du 01/09 : avant,
//   un candidat proposé mais jamais encore priced tombait ici et s'affichait
//   « Indisponible chez ce magasin », ce qui laissait croire qu'il n'y avait
//   rien à faire alors qu'une proposition existait bel et bien à valider).
// - 'notFound' : aucun candidat du tout pour ce magasin sur cette ligne.
export type StoreCoverageLineStatus = 'priced' | 'requiresValidation' | 'unavailable' | 'notFound';

export type StoreCoverageLine = {
  itemId: string;
  productId: string;
  status: StoreCoverageLineStatus;
  // Uniquement présent pour 'priced' et 'requiresValidation'.
  price?: number;
  // Absent seulement pour 'notFound' (aucun candidat à référencer).
  candidateId?: string;
};

export type StoreCoverage = {
  covered: number;
  total: number;
  lines: StoreCoverageLine[];
};

type CandidateOption = {
  candidate: ProductCandidate;
  confidenceScore: number;
  snapshot?: PriceSnapshot;
  lineTotal?: number;
  warnings: string[];
  signals: ComparisonSignal[];
  requiresValidation: boolean;
};

const STORE_KEYS: StoreKey[] = ['leclerc', 'hyperu'];

// Un prix `available` reste dans la base tant qu'une collecte ultérieure ne
// l'a pas remplacé ou explicitement invalidé — mais rien ne garantit que le
// prix en magasin n'a pas changé depuis `checkedAt`. Au-delà du seuil réglé
// par l'utilisateur (`maxPriceAgeDays`, 7 jours par défaut), on ne le
// considère plus assez frais pour une sélection automatique.
function isPriceSnapshotStale(snapshot: PriceSnapshot, maxPriceAgeDays: number): boolean {
  const ageMs = Date.now() - Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(ageMs)) return false;
  return ageMs > maxPriceAgeDays * 24 * 60 * 60 * 1000;
}

export function compareShoppingList(input: ComparisonInput): ComparisonResult {
  // Doublon inter-lignes : deux lignes du panier (ex. deux conditionnements
  // différents de la même marque) peuvent chacune, indépendamment, retenir
  // le MÊME produit physique chez le même magasin — typiquement quand la
  // recherche n'a pas trouvé le format demandé pour l'une des deux lignes et
  // est retombée sur le candidat le plus proche, qui se trouve être déjà
  // sélectionné par l'autre ligne. Chaque ligne est résolue indépendamment
  // (voir selectAllDecisions/selectOptimizedDecision) : rien ne détectait ce
  // cas avant, alors qu'il produit une vraie commande en double (retour
  // utilisateur réel, 01/09 — deux formats de riz basmati tous deux résolus
  // vers la même fiche Leclerc, matchScore 1 pour l'un, 0.9 pour l'autre).
  // Décision explicite de l'utilisateur (01/09) : un simple avertissement ne
  // suffit pas, il ne faut PAS sélectionner automatiquement ce magasin pour
  // la ligne perdante — comme si aucun résultat n'y avait été trouvé pour ce
  // conditionnement précis — et laisser l'autre magasin prendre le relais.
  // Implémenté en amont de la sélection (pas en post-traitement) : le
  // candidat perdant est rétrogradé en `isAlternate` (même mécanisme que les
  // "format différent du format demandé" existants) — jamais choisi
  // automatiquement, mais toujours visible et sélectionnable manuellement si
  // l'utilisateur préfère quand même ce produit. Le candidat gagnant est
  // celui au score de confiance le plus élevé.
  const { candidates: dedupedCandidates, warningsByItemId: duplicateWarnings } = demoteDuplicateStoreCandidates(
    input.candidates,
    input.rows
  );
  const effectiveInput: ComparisonInput =
    dedupedCandidates === input.candidates ? input : { ...input, candidates: dedupedCandidates };
  const rawDecisions = selectAllDecisions(effectiveInput.rows, effectiveInput);
  const decisions =
    duplicateWarnings.size === 0
      ? rawDecisions
      : rawDecisions.map((decision) => {
          const extra = duplicateWarnings.get(decision.itemId);
          return extra ? { ...decision, warnings: [...decision.warnings, ...extra] } : decision;
        });
  const excludedLines = decisions
    .filter((decision) => decision.signals.some((signal) => signal.code === 'CONFIRMED_ABSENT_BOTH'))
    .map((decision) => ({ itemId: decision.itemId, productId: decision.productId, reason: 'absent_both' as const }));
  const productsToValidate = decisions.filter((decision) => decision.requiresValidation);
  const optimized = sumDecisionTotals(decisions);
  const leclercTotal = calculateStoreTotal('leclerc', effectiveInput);
  const hyperuTotal = calculateStoreTotal('hyperu', effectiveInput);
  const leclerc = leclercTotal.total;
  const hyperu = hyperuTotal.total;
  const coverage = {
    leclerc: { covered: leclercTotal.coveredCount, total: input.rows.length, lines: leclercTotal.lines },
    hyperu: { covered: hyperuTotal.coveredCount, total: input.rows.length, lines: hyperuTotal.lines }
  };
  const comparableItemCount = input.rows.length - excludedLines.length;
  const bestSingle = chooseBestSingleStore({ leclerc, hyperu }, coverage, comparableItemCount);
  const savingsVsBestSingleStore =
    optimized !== null && bestSingle.total !== null ? roundMoney(bestSingle.total - optimized) : null;
  const trustReport = assessComparisonTrust({ decisions, coverage });
  const recommendation = trustReport.status === 'blocked'
    ? { kind: 'needs_validation' as const, reason: `${trustReport.blockingIssueCount} anomalie(s) critique(s) empêchent une recommandation fiable.` }
    : buildRecommendation({
        bestSingleStore: bestSingle.storeKey,
        hasValidation: productsToValidate.length > 0,
        savingsVsBestSingleStore,
        savingThresholdEuro: input.savingThresholdEuro
      });

  return {
    decisions,
    productsToValidate,
    totals: {
      leclerc,
      hyperu,
      optimized
    },
    coverage,
    savingsVsBestSingleStore,
    trustReport,
    excludedLines,
    recommendation
  };
}

// Résout les décisions ligne par ligne en 2 passes. Passe 1 : toutes les
// lignes où un seul magasin est le moins cher sont tranchées normalement —
// ça établit combien d'articles sont déjà chez chaque magasin. Passe 2 : les
// lignes où Leclerc et Hyper U affichent EXACTEMENT le même prix total sont
// tranchées ensuite, en faveur du magasin déjà majoritaire dans le reste du
// panier (compteur mis à jour au fur et à mesure, donc les ex æquo
// s'entraînent entre eux) — minimise le nombre de magasins à visiter plutôt
// que de départager arbitrairement par confiance. Demande explicite de
// l'utilisateur (2026-08-27) : un article à prix strictement identique entre
// les deux magasins doit rejoindre le magasin où se trouve déjà le reste du
// panier ("si tout le panier avait été chez Leclerc, il aurait fallu le
// mettre aussi chez Leclerc").
function selectAllDecisions(rows: ShoppingListRow[], input: ComparisonInput): ComparisonDecision[] {
  const decisions = new Array<ComparisonDecision>(rows.length);
  const storeCounts: Record<StoreKey, number> = { leclerc: 0, hyperu: 0 };
  const tieIndexes: number[] = [];

  rows.forEach((row, index) => {
    if (hasCrossStoreTie(row, input)) {
      tieIndexes.push(index);
      return;
    }
    const decision = selectOptimizedDecision(row, input, null);
    decisions[index] = decision;
    if (decision.selectedStoreKey) {
      storeCounts[decision.selectedStoreKey] += 1;
    }
  });

  tieIndexes.forEach((index) => {
    const storeBias =
      storeCounts.leclerc === storeCounts.hyperu
        ? null
        : storeCounts.leclerc > storeCounts.hyperu
          ? 'leclerc'
          : 'hyperu';
    const decision = selectOptimizedDecision(rows[index], input, storeBias);
    decisions[index] = decision;
    if (decision.selectedStoreKey) {
      storeCounts[decision.selectedStoreKey] += 1;
    }
  });

  return decisions;
}

// Vrai uniquement si le prix le plus bas pour cette ligne est atteint par
// AU MOINS deux magasins différents (pas juste deux candidats du même
// magasin) — c'est ce cas précis, et lui seul, que la répartition doit
// trancher par cohérence avec le reste du panier plutôt que par confiance.
// Un magasin forcé manuellement (forcedCandidateId/forcedStoreKey) ne peut
// jamais être un ex æquo entre magasins : il n'y a alors qu'un seul magasin
// éligible.
function hasCrossStoreTie(row: ShoppingListRow, input: ComparisonInput): boolean {
  if (row.item.forcedCandidateId || row.item.forcedStoreKey) {
    return false;
  }

  const validOptions = buildOptionsForRow(row, input).filter(
    (option) => !option.candidate.isAlternate && !option.requiresValidation && option.lineTotal !== undefined
  );
  if (validOptions.length === 0) {
    return false;
  }

  const minTotal = Math.min(...validOptions.map((option) => option.lineTotal!));
  const storesAtMin = new Set(
    validOptions.filter((option) => option.lineTotal === minTotal).map((option) => option.candidate.storeKey)
  );

  return storesAtMin.size > 1;
}

function selectOptimizedDecision(
  row: ShoppingListRow,
  input: ComparisonInput,
  storeBias: StoreKey | null
): ComparisonDecision {
  const options = buildOptionsForRow(row, input);
  const alternates = buildAlternates(options);
  const bestByStore = bestOptionPerStore(options);
  const storeCandidateIds = buildStoreCandidateIds(bestByStore);
  // Base plus permissive, réservée à la COMPARAISON (jamais à la sélection
  // automatique) — voir bestComparableOptionPerStore juste plus bas.
  const comparableByStore = bestComparableOptionPerStore(options);
  const unitPriceArbitration = buildUnitPriceArbitration(comparableByStore);
  const formatMismatchWarnings = buildFormatMismatchWarnings(comparableByStore, unitPriceArbitration);
  const unitPriceEvidenceWarnings = buildUnitPriceEvidenceWarnings(bestByStore);
  const forcedCandidateId = row.item.forcedCandidateId;

  if (forcedCandidateId) {
    const forced = options.find((option) => option.candidate.id === forcedCandidateId);
    if (forced && forced.lineTotal !== undefined) {
      const betterFormatWarning = buildBetterFormatWarning(options, forced);
      return {
        itemId: row.item.id,
        productId: row.product.id,
        selectedCandidateId: forced.candidate.id,
        selectedStoreKey: forced.candidate.storeKey,
        confidenceScore: forced.confidenceScore,
        price: forced.lineTotal,
        unitPrice: forced.snapshot?.unitPrice,
        quantityToBuy: row.item.wantedQuantity,
        reason: `Format choisi manuellement. ${buildDecisionReason(forced)}`,
        warnings: betterFormatWarning
          ? [...forced.warnings, ...formatMismatchWarnings, betterFormatWarning]
          : [...forced.warnings, ...formatMismatchWarnings],
        signals: applyWarningAcknowledgement(forced.signals, row.item),
        requiresValidation: false,
        alternates,
        storeCandidateIds
      };
    }
  }

  const forcedStoreKey = row.item.forcedStoreKey;
  // Alternates (different pack size) are surfaced for manual choice only —
  // never let them enter automatic optimization on their own.
  const autoEligibleOptions = options.filter((option) => !option.candidate.isAlternate);
  const eligibleOptions = forcedStoreKey
    ? autoEligibleOptions.filter((option) => option.candidate.storeKey === forcedStoreKey)
    : autoEligibleOptions;
  const validOptions = eligibleOptions.filter(
    (option) => !option.requiresValidation && option.lineTotal !== undefined
  );
  const pricedBest = pickBestOption(validOptions, storeBias);
  // Formats différents entre les deux magasins : c'est le prix au kilo/litre
  // qui tranche, pas le prix du paquet (voir buildUnitPriceArbitration). Un
  // choix explicite de l'utilisateur (magasin forcé) reste prioritaire, et
  // l'arbitrage ne s'applique que si son gagnant fait bien partie des options
  // retenues — sinon on garde le comportement habituel.
  const arbitrated =
    !forcedStoreKey && unitPriceArbitration
      ? validOptions.find((option) => option.candidate.id === unitPriceArbitration.winner.candidate.id)
      : undefined;
  const selected = arbitrated ?? pricedBest;

  if (!selected) {
    const warnings = collectValidationWarnings(eligibleOptions.length > 0 ? eligibleOptions : autoEligibleOptions);
    const absenceConfirmed = autoEligibleOptions.length === 0 || autoEligibleOptions.every(
      (option) => option.snapshot?.available === false
    );
    return {
      itemId: row.item.id,
      productId: row.product.id,
      confidenceScore: 0,
      quantityToBuy: row.item.wantedQuantity,
      reason: forcedStoreKey
        ? `${row.product.name} : aucun prix fiable chez ${storeLabel(forcedStoreKey)} (magasin forcé).`
        : `${row.product.name} doit être vérifié manuellement.`,
      warnings: [...warnings, ...formatMismatchWarnings],
      signals: absenceConfirmed
        ? [{ code: 'CONFIRMED_ABSENT_BOTH', severity: 'warning' }]
        : applyWarningAcknowledgement(
            uniqueSignals([
              ...autoEligibleOptions.flatMap((option) => option.signals),
              { code: 'REQUIRES_VALIDATION', severity: 'blocking' }
            ]),
            row.item
          ),
      requiresValidation: !absenceConfirmed,
      alternates,
      storeCandidateIds
    };
  }

  const betterFormatWarning = buildBetterFormatWarning(options, selected);

  return {
    itemId: row.item.id,
    productId: row.product.id,
    selectedCandidateId: selected.candidate.id,
    selectedStoreKey: selected.candidate.storeKey,
    confidenceScore: selected.confidenceScore,
    price: selected.lineTotal,
    unitPrice: selected.snapshot?.unitPrice,
    quantityToBuy: row.item.wantedQuantity,
    reason: forcedStoreKey
      ? `Magasin forcé manuellement. ${buildDecisionReason(selected)}`
      : arbitrated && unitPriceArbitration
        ? `${unitPriceArbitration.formatMismatchKnown ? 'Formats différents' : 'Format de paquet incomplet'} : départagé sur le prix ${unitPriceArbitration.unitLabel} (` +
          `${formatUnitPriceLabel(unitPriceArbitration.byStore.leclerc)} chez Leclerc contre ` +
          `${formatUnitPriceLabel(unitPriceArbitration.byStore.hyperu)} chez Hyper U). ${buildDecisionReason(selected)}`
        : buildDecisionReason(selected),
    warnings: [
      ...new Set([
        ...selected.warnings,
        ...formatMismatchWarnings,
        ...unitPriceEvidenceWarnings,
        ...(betterFormatWarning ? [betterFormatWarning] : [])
      ])
    ],
    signals: uniqueSignals([
      ...selected.signals,
      ...(formatMismatchWarnings.some((warning) => warning.includes('à vérifier'))
        ? [{ code: 'FORMAT_CONFIRMATION_REQUIRED' as const, severity: 'blocking' as const }]
        : []),
      ...(unitPriceEvidenceWarnings.length > 0
        ? [{ code: 'PRICE_MISMATCH' as const, severity: 'blocking' as const }]
        : [])
    ]),
    requiresValidation: false,
    alternates,
    storeCandidateIds
  };
}

function buildAlternates(options: CandidateOption[]): ComparisonAlternate[] {
  // Deux origines pour un "alternate" affiché en validation : soit le
  // collecteur l'a explicitement marqué comme tel (format différent proposé
  // en plus du meilleur candidat), soit c'est simplement LE candidat retenu
  // pour ce produit/magasin mais dont la confiance est trop faible pour une
  // sélection automatique (requiresValidation) — sans ce second cas, un
  // produit avec un seul candidat incertain (le cas le plus courant) n'avait
  // aucun moyen d'être montré à l'utilisateur : le panneau de validation
  // affichait juste un avertissement générique, jamais le nom/prix/lien du
  // produit trouvé ni de bouton pour l'accepter ou le rejeter.
  return options
    .filter((option) => (option.candidate.isAlternate || option.requiresValidation) && option.lineTotal !== undefined)
    .map((option) => ({
      candidateId: option.candidate.id,
      storeKey: option.candidate.storeKey,
      name: option.candidate.name,
      price: option.lineTotal,
      matchType: option.candidate.matchType,
      productUrl: option.candidate.productUrl
    }));
}

// Meilleur candidat FIABLE (prix ferme, pas à valider) par magasin,
// indépendamment de celui finalement sélectionné — base commune pour
// `buildStoreCandidateIds` (liens "voir chez X") et
// `buildFormatMismatchWarnings` (comparaison de format cross-store).
function bestOptionPerStore(options: CandidateOption[]): Partial<Record<StoreKey, CandidateOption>> {
  const result: Partial<Record<StoreKey, CandidateOption>> = {};

  for (const storeKey of STORE_KEYS) {
    const best = options
      .filter(
        (option) =>
          option.candidate.storeKey === storeKey &&
          !option.candidate.isAlternate &&
          !option.requiresValidation &&
          option.lineTotal !== undefined
      )
      .sort(compareOptions)[0];
    if (best) {
      result[storeKey] = best;
    }
  }

  return result;
}

// Meilleur candidat UTILISABLE POUR COMPARAISON (jamais pour la sélection
// automatique) par magasin — plus permissif que bestOptionPerStore : quand un
// magasin n'a AUCUN candidat fiable, retient quand même son unique candidat
// "à valider" (confiance insuffisante, marque équivalente, format différent
// non garanti...) s'il n'y en a qu'un SEUL. Jamais un isAlternate : ce
// marqueur couvre à la fois les vrais "autre conditionnement du même
// produit" (jamais choisis automatiquement, voir plus haut) ET les
// candidats démontrés en doublon inter-lignes (demoteDuplicateStoreCandidates)
// — l'exclure ici élimine donc tout risque de comparer un candidat qui sert
// déjà une autre ligne du panier.
//
// Demande explicite de l'utilisateur (01/09, cas réel Tropicana/Andros) :
// sans le même conditionnement disponible chez Leclerc (Andros 1,5L contre
// Tropicana 1L chez Hyper U, marque différente donc confiance insuffisante
// pour une sélection automatique), le seul candidat Leclerc disparaissait
// purement et simplement du comparatif au lieu d'être comparé au prix au
// litre/kilo contre Hyper U — aucune information sur une éventuelle
// meilleure offre, alors qu'elle était sous les yeux du connecteur.
//
// Reste SANS EFFET sur la sélection automatique : `selectOptimizedDecision`
// ne retient un candidat gagnant de l'arbitrage (`arbitrated`) que s'il fait
// aussi partie de `validOptions`, qui exclut toujours les candidats
// `requiresValidation` — ce candidat ne sert donc qu'à afficher la
// comparaison et un avertissement à valider, jamais à déclencher un achat
// automatique sur un match encore incertain.
function bestComparableOptionPerStore(options: CandidateOption[]): Partial<Record<StoreKey, CandidateOption>> {
  const result: Partial<Record<StoreKey, CandidateOption>> = {};

  for (const storeKey of STORE_KEYS) {
    const storeOptions = options.filter(
      (option) =>
        option.candidate.storeKey === storeKey && !option.candidate.isAlternate && option.lineTotal !== undefined
    );
    const reliable = storeOptions.filter((option) => !option.requiresValidation).sort(compareOptions)[0];
    if (reliable) {
      result[storeKey] = reliable;
      continue;
    }
    // Aucun candidat fiable : ne retient le seul candidat "à valider" que
    // s'il n'y en a qu'UN — dès qu'il y en a plusieurs concurrents pour ce
    // magasin, on ne devine pas lequel comparer, la validation manuelle
    // habituelle reste seule à trancher.
    if (storeOptions.length === 1) {
      result[storeKey] = storeOptions[0];
    }
  }

  return result;
}

function buildStoreCandidateIds(bestByStore: Partial<Record<StoreKey, CandidateOption>>): Partial<Record<StoreKey, string>> {
  const result: Partial<Record<StoreKey, string>> = {};

  for (const storeKey of STORE_KEYS) {
    const best = bestByStore[storeKey];
    if (best) {
      result[storeKey] = best.candidate.id;
    }
  }

  return result;
}

// Avertit quand les DEUX magasins ont chacun un candidat fiable pour cette
// ligne, mais dans des formats différents (ex. Purée Mousline 375g chez
// Leclerc vs 1040g chez Hyper U, cas réel 31/08) — chaque candidat peut
// légitimement bien matcher le NOM du produit demandé sans jamais avoir été
// comparé à l'autre magasin. Silencieux (pas de faux avertissement) dès que
// l'un des deux formats est inconnu ou non comparable (ex. compté à la
// pièce) — le signalement ne porte que sur les cas où on est vraiment sûr
// de la divergence, jamais sur un doute d'extraction.
function buildFormatMismatchWarnings(
  bestByStore: Partial<Record<StoreKey, CandidateOption>>,
  arbitration: UnitPriceArbitration | null
): string[] {
  const leclerc = bestByStore.leclerc;
  const hyperu = bestByStore.hyperu;
  if (!leclerc || !hyperu) return [];

  const leclercFormat = normalizeToComparableFormat(leclerc.candidate.quantity, leclerc.candidate.unit);
  const hyperuFormat = normalizeToComparableFormat(hyperu.candidate.quantity, hyperu.candidate.unit);
  if (!formatsDiffer(leclercFormat, hyperuFormat)) return [];

  // `bestByStore` vient désormais de bestComparableOptionPerStore, plus
  // permissif que bestOptionPerStore : un côté peut être le seul candidat
  // disponible pour ce magasin, encore non confirmé (requiresValidation).
  // Le dire explicitement évite de laisser croire à une comparaison entre
  // deux choix déjà fiables — voir bestComparableOptionPerStore ci-dessus.
  const unconfirmedNote =
    leclerc.requiresValidation || hyperu.requiresValidation
      ? ` (${[
          leclerc.requiresValidation ? 'le produit chez Leclerc' : null,
          hyperu.requiresValidation ? 'le produit chez Hyper U' : null
        ]
          .filter(Boolean)
          .join(' et ')} n'est pas encore confirmé — à valider avant d'ajuster ta commande)`
      : '';

  // Les formats diffèrent, mais les deux magasins affichent un prix au
  // kilo/litre comparable : la ligne a été tranchée sur cette base commune,
  // il faut le dire plutôt que de laisser croire à une comparaison de prix
  // paquet à paquet. Reste un avertissement (jamais un blocage) : la
  // comparaison au kilo ne vaut que si c'est bien le même produit à une
  // quantité près, ce que seul l'utilisateur peut confirmer.
  if (arbitration) {
    return [
      `Le paquet trouvé n'est pas le même format dans les deux magasins : ${formatLabel(leclercFormat!)} chez Leclerc contre ${formatLabel(hyperuFormat!)} chez Hyper U. ` +
        `Le prix comparé est donc le prix ${arbitration.unitLabel}, pas le prix du paquet — ` +
        `${formatUnitPriceLabel(arbitration.byStore.leclerc)} chez Leclerc, ${formatUnitPriceLabel(arbitration.byStore.hyperu)} chez Hyper U${unconfirmedNote}. ` +
        `À vérifier : ce n'est un comparatif juste que si c'est vraiment le même produit, juste en quantité différente.`
    ];
  }

  return [
    `Le paquet trouvé n'est pas le même format dans les deux magasins : ${formatLabel(leclercFormat!)} chez Leclerc contre ${formatLabel(hyperuFormat!)} chez Hyper U${unconfirmedNote}. ` +
      `Le prix affiché n'est donc pas directement comparable entre les deux — à vérifier.`
  ];
}

export type UnitPriceArbitration = {
  winner: CandidateOption;
  byStore: Record<StoreKey, UnitPriceBasis>;
  unitLabel: 'au kilo' | 'au litre';
  formatMismatchKnown: boolean;
};

// Arbitrage au prix au kilo / au litre.
//
// Ne s'applique QUE lorsque les quatre conditions sont réunies :
//  1. les deux magasins ont chacun un candidat COMPARABLE — au sens de
//     bestComparableOptionPerStore : un candidat fiable, ou à défaut le
//     candidat "à valider" unique de ce magasin (jamais choisi
//     automatiquement pour autant, voir le commentaire de cette fonction) ;
//  2. leurs formats diffèrent réellement, OU le format manque d'un côté mais
//     chaque prix unitaire reste prouvable (affiché, ou calculé depuis le
//     format connu du candidat concerné) ;
//  3. les deux prix au kilo/litre sont connus et dans la même dimension ;
//  4. l'écart dépasse l'arrondi (voir unitPriceGapIsSignificant).
//
// Hors de ces cas, la règle historique (le total de ligne le plus bas)
// s'applique inchangée.
function buildUnitPriceArbitration(
  bestByStore: Partial<Record<StoreKey, CandidateOption>>
): UnitPriceArbitration | null {
  const leclerc = bestByStore.leclerc;
  const hyperu = bestByStore.hyperu;
  if (!leclerc || !hyperu) return null;

  const leclercFormat = normalizeToComparableFormat(leclerc.candidate.quantity, leclerc.candidate.unit);
  const hyperuFormat = normalizeToComparableFormat(hyperu.candidate.quantity, hyperu.candidate.unit);
  const formatMismatchKnown = formatsDiffer(leclercFormat, hyperuFormat);
  const formatKnowledgeIncomplete = !leclercFormat || !hyperuFormat;
  // Deux formats connus et équivalents restent comparés au prix du paquet :
  // le prix unitaire n'apporte alors aucune normalisation nécessaire.
  if (!formatMismatchKnown && !formatKnowledgeIncomplete) return null;

  const leclercBasis = resolveUnitPriceBasis({
    priceEuro: leclerc.snapshot?.price,
    unitPriceEuro: leclerc.snapshot?.unitPrice,
    comparisonUnit: leclerc.snapshot?.comparisonUnit,
    quantity: leclerc.candidate.quantity,
    unit: leclerc.candidate.unit
  });
  const hyperuBasis = resolveUnitPriceBasis({
    priceEuro: hyperu.snapshot?.price,
    unitPriceEuro: hyperu.snapshot?.unitPrice,
    comparisonUnit: hyperu.snapshot?.comparisonUnit,
    quantity: hyperu.candidate.quantity,
    unit: hyperu.candidate.unit
  });
  // Une preuve affichée reste utilisable sans format candidat. Une preuve
  // calculée exige le format qui a servi au calcul. Toute contradiction de
  // cohérence invalide seulement cet arbitrage, sans supprimer le prix total.
  if (
    !isUnitPriceBasisReliable(leclercBasis, Boolean(leclercFormat), leclerc.snapshot?.priceCoherence) ||
    !isUnitPriceBasisReliable(hyperuBasis, Boolean(hyperuFormat), hyperu.snapshot?.priceCoherence)
  ) {
    return null;
  }
  if (!unitPriceBasesComparable(leclercBasis, hyperuBasis)) return null;
  if (!unitPriceGapIsSignificant(leclercBasis!, hyperuBasis!)) return null;

  return {
    winner: leclercBasis!.unitPriceEuro < hyperuBasis!.unitPriceEuro ? leclerc : hyperu,
    byStore: { leclerc: leclercBasis!, hyperu: hyperuBasis! },
    unitLabel: leclercBasis!.comparisonUnit === 'liter' ? 'au litre' : 'au kilo',
    formatMismatchKnown
  };
}

function buildUnitPriceEvidenceWarnings(
  bestByStore: Partial<Record<StoreKey, CandidateOption>>
): string[] {
  const hasContradictoryUnitPrice = (['leclerc', 'hyperu'] as const).some(
    (storeKey) => bestByStore[storeKey]?.snapshot?.priceCoherence === 'mismatch'
  );

  return hasContradictoryUnitPrice
    ? ['Prix incohérent avec le prix au litre/kilo affiché — à vérifier.']
    : [];
}

// Détecte, parmi les candidats "conditionnement différent" du MÊME magasin
// que le format retenu (isAlternate + same_brand_different_format — jamais
// sélectionnés automatiquement, voir `ProductCandidate.isAlternate`), celui
// qui offre un meilleur prix au litre/kilo que le format choisi, alors même
// que ce conditionnement n'était pas demandé par l'utilisateur. Demande
// explicite (01/09) : plutôt que de rester muet sur une offre plus
// avantageuse simplement parce qu'elle est dans un autre conditionnement,
// signaler explicitement qu'un format non demandé revient moins cher au
// litre/kilo, pour que l'utilisateur puisse choisir de l'acheter à la place.
// Réutilise volontairement les mêmes garde-fous de fiabilité que l'arbitrage
// cross-magasin (`buildUnitPriceArbitration`) : preuve de prix unitaire
// fiable des deux côtés, même dimension (kg vs L), écart au-delà de l'arrondi
// (voir unitPriceArbitration.ts) — jamais de suggestion sur une simple
// hypothèse de format.
function findBetterFormatAlternate(
  options: CandidateOption[],
  selected: CandidateOption
): { alternate: CandidateOption; selectedBasis: UnitPriceBasis; alternateBasis: UnitPriceBasis } | null {
  const selectedFormatKnown = Boolean(
    normalizeToComparableFormat(selected.candidate.quantity, selected.candidate.unit)
  );
  const selectedBasis = resolveUnitPriceBasis({
    priceEuro: selected.snapshot?.price,
    unitPriceEuro: selected.snapshot?.unitPrice,
    comparisonUnit: selected.snapshot?.comparisonUnit,
    quantity: selected.candidate.quantity,
    unit: selected.candidate.unit
  });
  if (!isUnitPriceBasisReliable(selectedBasis, selectedFormatKnown, selected.snapshot?.priceCoherence)) {
    return null;
  }

  let best: { alternate: CandidateOption; basis: UnitPriceBasis } | null = null;

  for (const option of options) {
    if (
      option.candidate.id === selected.candidate.id ||
      option.candidate.storeKey !== selected.candidate.storeKey ||
      !option.candidate.isAlternate ||
      option.candidate.matchType !== 'same_brand_different_format' ||
      option.requiresValidation ||
      option.lineTotal === undefined
    ) {
      continue;
    }

    const formatKnown = Boolean(normalizeToComparableFormat(option.candidate.quantity, option.candidate.unit));
    const basis = resolveUnitPriceBasis({
      priceEuro: option.snapshot?.price,
      unitPriceEuro: option.snapshot?.unitPrice,
      comparisonUnit: option.snapshot?.comparisonUnit,
      quantity: option.candidate.quantity,
      unit: option.candidate.unit
    });
    if (!isUnitPriceBasisReliable(basis, formatKnown, option.snapshot?.priceCoherence)) continue;
    if (!unitPriceBasesComparable(selectedBasis, basis)) continue;
    if (!unitPriceGapIsSignificant(selectedBasis!, basis!)) continue;
    if (basis!.unitPriceEuro >= selectedBasis!.unitPriceEuro) continue;
    if (!best || basis!.unitPriceEuro < best.basis.unitPriceEuro) {
      best = { alternate: option, basis: basis! };
    }
  }

  return best ? { alternate: best.alternate, selectedBasis: selectedBasis!, alternateBasis: best.basis } : null;
}

function buildBetterFormatWarning(options: CandidateOption[], selected: CandidateOption): string | undefined {
  const found = findBetterFormatAlternate(options, selected);
  if (!found) return undefined;

  const { alternate, selectedBasis, alternateBasis } = found;
  const format = normalizeToComparableFormat(alternate.candidate.quantity, alternate.candidate.unit);
  const formatText = format ? formatLabel(format) : alternate.candidate.name;

  return (
    `Meilleure offre disponible dans un autre conditionnement (non demandé) chez ${storeLabel(alternate.candidate.storeKey)} : ` +
    `« ${alternate.candidate.name} » (${formatText}) à ${alternate.lineTotal!.toFixed(2)} €, soit ${formatUnitPriceLabel(alternateBasis)} ` +
    `contre ${formatUnitPriceLabel(selectedBasis)} pour le format retenu. À valider avant d'ajuster ta commande.`
  );
}

function formatLabel(format: NormalizedFormat): string {
  return `${Math.round(format.quantity)} ${format.unit}`;
}

function buildOptionsForRow(row: ShoppingListRow, input: ComparisonInput): CandidateOption[] {
  const pricesByCandidateId = new Map(
    input.priceSnapshots.map((snapshot) => [snapshot.candidateId, snapshot])
  );

  return input.candidates
    .filter((candidate) => candidate.productId === row.product.id && !candidate.isRejected)
    .map((candidate) => {
      const confidenceScore = getCandidateConfidence(row.product, candidate);
      const snapshot = pricesByCandidateId.get(candidate.id);
      const warnings: string[] = [];
      const signals: ComparisonSignal[] = [];
      // Une donnée de démo ('mock') n'a jamais été confirmée sur le site réel
      // — l'utilisateur ne doit jamais la voir comme un prix fiable, quel que
      // soit son âge.
      const isMockSnapshot = snapshot?.source === 'mock';
      const isStale =
        !isMockSnapshot &&
        Boolean(snapshot) &&
        snapshot!.available &&
        isPriceSnapshotStale(snapshot!, input.maxPriceAgeDays);

      if (!snapshot) {
        warnings.push('Prix absent');
        signals.push({ code: 'MISSING_PRICE', severity: 'blocking' });
      } else if (!snapshot.available) {
        warnings.push('Prix indisponible');
      } else if (isMockSnapshot) {
        warnings.push('Prix de démonstration (jamais vérifié en magasin)');
      } else if (isStale) {
        warnings.push(`Prix non revérifié depuis plus de ${input.maxPriceAgeDays} jours`);
        signals.push({ code: 'STALE_PRICE', severity: 'blocking' });
      }

      if (candidate.matchType === 'same_brand_different_format') {
        warnings.push('Format différent');
      }

      if (row.item.wantedQuantity > 1 && FORMAT_NOT_GUARANTEED_MATCH_TYPES.has(candidate.matchType)) {
        warnings.push(
          `Quantité ${row.item.wantedQuantity} demandée mais le format du produit trouvé n'est pas garanti identique — à confirmer avant ajout au panier`
        );
      }

      if (snapshot?.promoLabel) {
        warnings.push('Promotion non optimisée en V1');
        signals.push({ code: 'PROMOTION_NOT_OPTIMIZED', severity: 'warning' });
      }

      // Signalement uniquement : le verdict ne participe ni à la confiance
      // ni à requiresValidation. Le prix reste utilisable dans les totaux,
      // conformément à la règle « avertir, jamais bloquer ».
      if (snapshot?.priceCoherence === 'mismatch') {
        warnings.push('Prix incohérent avec le prix au litre/kilo affiché — à vérifier.');
        signals.push({ code: 'PRICE_MISMATCH', severity: 'blocking' });
      }

      const lineTotal =
        snapshot && snapshot.available
          ? calculateLineTotal({
              unitPrice: snapshot.price,
              wantedQuantity: row.item.wantedQuantity
            })
          : undefined;

      return {
        candidate,
        confidenceScore,
        snapshot,
        lineTotal,
        warnings,
        signals,
        requiresValidation:
          !snapshot ||
          !snapshot.available ||
          isMockSnapshot ||
          isStale ||
          requiresValidation(
            {
              confidenceScore,
              matchType: candidate.matchType,
              isRejected: candidate.isRejected
            },
            input.autoDecisionMinConfidence,
            row.item.wantedQuantity
          )
      };
    });
}

function calculateStoreTotal(
  storeKey: StoreKey,
  input: ComparisonInput
): { total: number | null; coveredCount: number; lines: StoreCoverageLine[] } {
  const lines: StoreCoverageLine[] = [];
  let sum = 0;
  let coveredCount = 0;

  input.rows.forEach((row) => {
    // Vue exhaustive : contrairement au calcul du total, on ne filtre PAS les
    // candidats "à valider" ici — chaque ligne de la liste de courses doit
    // apparaître avec un statut, même quand ce magasin n'a rien de fiable.
    const storeOptions = buildOptionsForRow(row, input).filter(
      (option) => option.candidate.storeKey === storeKey && !option.candidate.isAlternate
    );

    if (storeOptions.length === 0) {
      lines.push({ itemId: row.item.id, productId: row.product.id, status: 'notFound' });
      return;
    }

    // Prix ferme : mêmes critères qu'avant (compte dans le total).
    const pricedOptions = storeOptions.filter(
      (option) => !option.requiresValidation && option.lineTotal !== undefined
    );
    if (pricedOptions.length > 0) {
      const best = pricedOptions.sort(compareOptions)[0];
      lines.push({
        itemId: row.item.id,
        productId: row.product.id,
        status: 'priced',
        price: best.lineTotal,
        candidateId: best.candidate.id
      });
      sum += best.lineTotal!;
      coveredCount += 1;
      return;
    }

    // « À valider » : soit un prix existe mais n'est pas assez fiable pour
    // compter dans le total (confiance faible, format incertain, prix de
    // démo, prix trop vieux...), soit aucune observation ferme n'a encore été
    // faite pour ce candidat (jamais visité/relevé). Dans les deux cas
    // l'utilisateur a une vraie action possible (confirmer/rejeter via le
    // bouton de validation live) — ce n'est PAS un magasin sans rien à
    // proposer, donc jamais "indisponible".
    //
    // Bug réel corrigé le 01/09 : avant, seule la 1re moitié de cette
    // condition (lineTotal défini) était retenue ici. Un candidat proposé
    // sans snapshot du tout (`!option.snapshot`, prix jamais relevé) avait
    // donc `lineTotal === undefined` et tombait directement dans la branche
    // 'unavailable' plus bas, affichant "Indisponible chez ce magasin" —
    // alors qu'une vraie proposition à valider existait (cas signalé :
    // "Boisson soja nature" chez Leclerc).
    const validationOptions = storeOptions.filter((option) => !option.snapshot || option.snapshot.available);
    if (validationOptions.length > 0) {
      const best = validationOptions.sort(compareOptions)[0];
      lines.push({
        itemId: row.item.id,
        productId: row.product.id,
        status: 'requiresValidation',
        price: best.lineTotal,
        candidateId: best.candidate.id
      });
      return;
    }

    // Ici seulement : un candidat existe, une observation a bien été faite,
    // et le site a explicitement indiqué une rupture de stock
    // (snapshot.available === false pour tous les candidats de ce magasin).
    const best = storeOptions.sort(compareOptions)[0];
    lines.push({
      itemId: row.item.id,
      productId: row.product.id,
      status: 'unavailable',
      candidateId: best.candidate.id
    });
  });

  return {
    total: coveredCount === 0 ? null : roundMoney(sum),
    coveredCount,
    lines
  };
}

function compareOptions(left: CandidateOption, right: CandidateOption) {
  const totalDelta = (left.lineTotal ?? Number.POSITIVE_INFINITY) - (right.lineTotal ?? Number.POSITIVE_INFINITY);
  if (totalDelta !== 0) {
    return totalDelta;
  }

  return right.confidenceScore - left.confidenceScore;
}

// Trie par prix/confiance comme d'habitude, puis, seulement en cas d'ex
// æquo de prix entre magasins, privilégie `storeBias` (le magasin déjà
// majoritaire dans le panier — voir selectAllDecisions) au lieu du
// confidenceScore. `sorted` est déjà ordonné par confiance décroissante à
// prix égal, donc le premier élément biaisé trouvé est aussi le plus fiable
// parmi ceux de ce magasin.
function pickBestOption(validOptions: CandidateOption[], storeBias: StoreKey | null): CandidateOption | undefined {
  if (validOptions.length === 0) {
    return undefined;
  }

  const sorted = [...validOptions].sort(compareOptions);
  if (!storeBias) {
    return sorted[0];
  }

  const minTotal = sorted[0].lineTotal;
  const biasedAtMin = sorted.find(
    (option) => option.lineTotal === minTotal && option.candidate.storeKey === storeBias
  );

  return biasedAtMin ?? sorted[0];
}

function sumDecisionTotals(decisions: ComparisonDecision[]) {
  const knownPrices = decisions
    .map((decision) => decision.price)
    .filter((price): price is number => price !== undefined);
  if (knownPrices.length === 0) {
    return null;
  }

  return roundMoney(knownPrices.reduce((sum, price) => sum + price, 0));
}

function chooseBestSingleStore(
  totals: Record<StoreKey, number | null>,
  coverage: Record<StoreKey, StoreCoverage>,
  comparableItemCount: number
) {
  const availableTotals = STORE_KEYS.map((storeKey) => ({ storeKey, total: totals[storeKey] })).filter(
    (entry): entry is { storeKey: StoreKey; total: number } =>
      entry.total !== null && coverage[entry.storeKey].covered >= comparableItemCount
  );

  return availableTotals.sort((left, right) => left.total - right.total)[0] ?? { storeKey: 'leclerc' as const, total: null };
}

function uniqueSignals(signals: ComparisonSignal[]): ComparisonSignal[] {
  return [...new Map(signals.map((signal) => [signal.code, signal])).values()];
}

// Les deux seules alertes bloquantes qu'aucune action automatique ne peut
// résoudre : relancer une actualisation relit la même fiche et retrouve le
// même écart. Sans levée possible, elles rendaient le panier entier
// définitivement non validable (audit du 02/09, F-01/F-02). Les autres codes
// bloquants gardent leur blocage : ils ont tous une issue réelle (actualiser
// un prix absent ou périmé, valider un produit non identifié).
const ACKNOWLEDGEABLE_SIGNAL_CODES = new Set<ComparisonSignalCode>([
  'PRICE_MISMATCH',
  'FORMAT_CONFIRMATION_REQUIRED'
]);

// Rétrograde en simple avertissement les alertes que l'utilisateur a
// explicitement levées après vérification sur la fiche du magasin — voir
// ShoppingListItem.checkedDespiteWarningsAt. L'alerte reste affichée : on
// informe toujours, on cesse seulement de bloquer.
function applyWarningAcknowledgement(
  signals: ComparisonSignal[],
  item: ShoppingListItem
): ComparisonSignal[] {
  if (!item.checkedDespiteWarningsAt) return signals;
  return signals.map((signal) =>
    ACKNOWLEDGEABLE_SIGNAL_CODES.has(signal.code) ? { ...signal, severity: 'warning' as const } : signal
  );
}

function buildRecommendation(input: {
  bestSingleStore: StoreKey;
  hasValidation: boolean;
  savingsVsBestSingleStore: number | null;
  savingThresholdEuro: number;
}): ComparisonResult['recommendation'] {
  if (input.hasValidation || input.savingsVsBestSingleStore === null) {
    return {
      kind: 'needs_validation',
      reason: 'Certains produits doivent être validés avant recommandation.'
    };
  }

  if (input.savingsVsBestSingleStore >= input.savingThresholdEuro) {
    return {
      kind: 'split',
      reason: `Séparer le panier atteint le seuil d’économie de ${input.savingThresholdEuro.toFixed(2)} €.`
    };
  }

  return {
    kind: 'single_store',
    storeKey: input.bestSingleStore,
    reason: `L’économie optimisée reste sous le seuil de ${input.savingThresholdEuro.toFixed(2)} €.`
  };
}

function buildDecisionReason(option: CandidateOption) {
  const unitReason =
    option.snapshot?.unitPrice !== undefined ? `, ${option.snapshot.unitPrice.toFixed(2)} € par unité de comparaison` : '';

  return `Choisi chez ${storeLabel(option.candidate.storeKey)} : ${option.candidate.confidenceReasons.join(', ')}, confiance ${option.confidenceScore} %${unitReason}.`;
}

function collectValidationWarnings(options: CandidateOption[]) {
  const warnings = options.flatMap((option) => option.warnings);
  if (warnings.length === 0) {
    warnings.push('Aucun candidat fiable');
  }

  return [...new Set(warnings)];
}

function storeLabel(storeKey: StoreKey) {
  return storeKey === 'leclerc' ? 'Leclerc' : 'Hyper U';
}

// Regroupe TOUS les candidats (pas seulement ceux sélectionnés) par
// (magasin, identité produit réelle côté site) et, pour chaque groupe où au
// moins deux lignes (productId) différentes sont concernées, rétrograde en
// `isAlternate` tous les candidats sauf celui au score de confiance le plus
// élevé — l'empêchant ainsi d'entrer dans la sélection automatique pour ce
// magasin (voir `autoEligibleOptions` dans selectOptimizedDecision). Opère
// en amont de la sélection (pas en filtrant après coup les décisions) pour
// que la ligne perdante retombe naturellement sur l'autre magasin via le
// pipeline existant, sans dupliquer sa logique de repli.
//
// `storeProductId` (l'identifiant interne du site) est l'identité
// prioritaire — bien plus fiable qu'un nom, deux formats du même produit
// ayant souvent des noms quasi identiques ; repli sur `productUrl`
// seulement s'il manque, jamais sur le nom seul (faux positifs entre
// produits réellement distincts). Les candidats déjà `isAlternate`
// (ex. divergence de format déjà signalée ailleurs) sont ignorés : ils ne
// participent déjà pas à l'auto-sélection, rien à rétrograder.
// Identité produit robuste pour la détection de doublon : `storeProductId`
// en priorité, puis un identifiant extrait de l'URL — jamais l'URL brute
// telle quelle. Bug racine confirmé en conditions réelles (01/09, inspection
// directe de l'IndexedDB du téléphone via RDP) : un produit Leclerc validé
// manuellement (bouton "✓ Valider ce produit", voir
// livePickLeclercProduct/collectLeclercManualProduct dans
// extension/adapters/leclerc/leclerc-collector.js) ne remplit jamais
// `storeProductId`, et son URL diffère de celle trouvée par la recherche
// automatique pour le MÊME produit (slug tronqué, paramètre `?sProvenance=SM`
// en plus) — une comparaison de chaînes brutes ratait donc le doublon que ce
// module est censé détecter. Extraire l'identifiant numérique du chemin
// (stable, lui, entre les deux formes d'URL Leclerc) le retrouve.
function extractStoreProductIdentity(candidate: ProductCandidate): string | undefined {
  if (candidate.storeProductId) return candidate.storeProductId;
  const url = candidate.productUrl;
  if (!url) return undefined;
  // Leclerc : .../fiche-produits-<id>-<slug-quelconque>.aspx(?...)
  const leclercMatch = url.match(/fiche-produits-(\d+)-/);
  if (leclercMatch) return leclercMatch[1];
  // Hyper U : .../<slug>/<id>.html
  const hyperuMatch = url.match(/\/(\d+)\.html(?:$|\?)/);
  if (hyperuMatch) return hyperuMatch[1];
  // Pas de repli générique sur l'URL brute (même sans query string) : les URLs
  // de recherche (`/search?q=...`, `/recherche?text=...`) partagent le même
  // chemin pour des produits totalement différents — seule la query string les
  // distingue. Un repli générique conflaterait alors à tort des produits
  // différents. Sans motif connu, on ne peut pas établir l'identité de façon
  // fiable : mieux vaut ne pas détecter le doublon que d'en fabriquer un faux.
  return undefined;
}

function demoteDuplicateStoreCandidates(
  candidates: ProductCandidate[],
  rows: ShoppingListRow[]
): { candidates: ProductCandidate[]; warningsByItemId: Map<string, string[]> } {
  const productNameById = new Map(rows.map((row) => [row.product.id, row.product.name]));
  const itemIdsByProductId = new Map<string, string[]>();
  for (const row of rows) {
    const list = itemIdsByProductId.get(row.product.id) ?? [];
    list.push(row.item.id);
    itemIdsByProductId.set(row.product.id, list);
  }

  const groups = new Map<string, ProductCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.isAlternate) continue;
    // Ignore tout candidat orphelin (produit supprimé/renommé depuis, resté en
    // base) : sans ligne active dans le panier courant, il ne peut pas y avoir
    // de doublon *inter-lignes* réel. Bug confirmé le 01/09 : un vieux
    // candidat Tropicana en base partageait l'URL Leclerc d'un autre produit
    // supprimé, déclenchant un faux warning alors qu'il n'y avait qu'une
    // seule ligne "jus d'orange" dans la liste.
    if (!itemIdsByProductId.has(candidate.productId)) continue;
    const identity = extractStoreProductIdentity(candidate);
    if (!identity) continue;
    const key = `${candidate.storeKey}::${identity}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(candidate);
    groups.set(key, bucket);
  }

  const demotedIds = new Set<string>();
  const warningsByItemId = new Map<string, string[]>();

  for (const bucket of groups.values()) {
    // Meilleur candidat par ligne (productId) au sein du groupe — une même
    // ligne peut légitimement avoir plusieurs candidats historiques pour le
    // même produit ; seul le meilleur par ligne compte pour le départage
    // inter-lignes ci-dessous.
    const bestByProduct = new Map<string, ProductCandidate>();
    for (const candidate of bucket) {
      const existing = bestByProduct.get(candidate.productId);
      if (!existing || candidate.confidenceScore > existing.confidenceScore) {
        bestByProduct.set(candidate.productId, candidate);
      }
    }
    if (bestByProduct.size < 2) continue; // une seule ligne concernée : pas un doublon inter-lignes

    const contenders = [...bestByProduct.values()];
    // Départage : ne pas se fier à la seule confiance du candidat (elle peut
    // être à tort de 100% des deux côtés, cas réel du 01/09 — Leclerc a
    // renvoyé le même paquet 900 g pour les deux lignes de riz, avec une
    // confiance de 100 sur les deux). On vérifie plutôt, pour chaque
    // candidat, si SON PROPRE format contredit le format déjà connu de sa
    // ligne dans l'AUTRE magasin (ex. la ligne "5x90g" a un candidat Hyper U
    // fiable en 450 g : un candidat Leclerc à 900 g pour cette même ligne est
    // donc démontrablement le mauvais paquet, pas juste "moins confiant").
    // Le candidat démontré incohérent perd, même à confiance égale.
    const confirmedMismatch = new Map<string, boolean>();
    for (const candidate of contenders) {
      const otherStoreKey: StoreKey = candidate.storeKey === 'leclerc' ? 'hyperu' : 'leclerc';
      const otherStoreReference = candidates
        .filter(
          (c) => c.productId === candidate.productId && c.storeKey === otherStoreKey && !c.isAlternate && !c.isRejected
        )
        .reduce<ProductCandidate | undefined>(
          (best, current) => (!best || current.confidenceScore > best.confidenceScore ? current : best),
          undefined
        );
      const candidateFormat = normalizeToComparableFormat(candidate.quantity, candidate.unit);
      const referenceFormat = otherStoreReference
        ? normalizeToComparableFormat(otherStoreReference.quantity, otherStoreReference.unit)
        : null;
      confirmedMismatch.set(candidate.id, formatsDiffer(candidateFormat, referenceFormat));
    }

    // On ne départage sur ce critère que s'il reste au moins un candidat non
    // démenti — sinon (tous incohérents, ou aucune preuve de format
    // disponible d'aucun côté) on retombe sur le simple écart de confiance,
    // comportement historique.
    const trustworthy = contenders.filter((candidate) => !confirmedMismatch.get(candidate.id));
    const pool = trustworthy.length > 0 ? trustworthy : contenders;
    const winner = pool.reduce((best, current) => (current.confidenceScore > best.confidenceScore ? current : best));
    const winnerName = productNameById.get(winner.productId) ?? winner.productId;

    for (const candidate of contenders) {
      if (candidate.id === winner.id) continue;
      demotedIds.add(candidate.id);
      const message = confirmedMismatch.get(candidate.id)
        ? `${storeLabel(candidate.storeKey)} n'a pas ce conditionnement pour ce produit : la fiche trouvée correspond en fait à « ${winnerName} » (un autre article de ta liste). ` +
          `Pour éviter d'acheter deux fois le même produit, ${storeLabel(candidate.storeKey)} n'est pas retenu pour cette ligne — le bon conditionnement reste disponible chez l'autre magasin.`
        : `${storeLabel(candidate.storeKey)} n'a pas de fiche propre pour ce conditionnement : le seul résultat trouvé est en fait « ${winnerName} », déjà utilisé pour une autre ligne de ta liste. ` +
          `Pour éviter d'acheter deux fois le même produit, ${storeLabel(candidate.storeKey)} n'est pas retenu ici — le bon conditionnement reste disponible chez l'autre magasin.`;
      for (const itemId of itemIdsByProductId.get(candidate.productId) ?? []) {
        const existing = warningsByItemId.get(itemId) ?? [];
        existing.push(message);
        warningsByItemId.set(itemId, existing);
      }
    }
  }

  if (demotedIds.size === 0) {
    return { candidates, warningsByItemId };
  }

  const nextCandidates = candidates.map((candidate) =>
    demotedIds.has(candidate.id) ? { ...candidate, isAlternate: true } : candidate
  );
  return { candidates: nextCandidates, warningsByItemId };
}
