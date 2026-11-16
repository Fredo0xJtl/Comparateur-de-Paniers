import { type ComparisonDecision, type ComparisonResult } from '../../features/comparison/comparisonEngine';
import { type CandidateMatchType, type ProductCandidate, type StoreKey, type ValidatedBasketItem } from '../../types/domain';
import { type DriveRefreshDiagnostic } from '../../features/drive-bridge/driveRefreshService';
import { type DriveRefreshProgressEvent } from '../../features/drive-bridge/extensionBridge';
import { storeLabels } from '../../features/stores/storeLabels';
import { formatEuro } from '../../utils/formatMoney';

// Les motifs d'échec viennent de deux sources : des libellés courts
// (DRIVE_ERROR_LABELS) et des messages déjà rédigés en phrases complètes, comme
// EXTENSION_UNAVAILABLE_MESSAGE. Ajouter un point sans regarder produisait
// « ...autorise cette adresse.. » sur les seconds.
export function withFinalPeriod(text: string) {
  return /[.!?…]$/.test(text.trimEnd()) ? text : `${text}.`;
}

export function isManuallyConfirmedCandidate(
  candidateId: string | undefined,
  candidateById: Map<string, ProductCandidate>
) {
  return Boolean(candidateId && candidateById.get(candidateId)?.matchType === 'manual_override');
}

export function sumDecisionPrices(decisions: ComparisonDecision[]) {
  return decisions.reduce((sum, decision) => sum + (decision.price ?? 0), 0);
}

export function urlsPointToSameProduct(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return left === right;
  }
}

export function groupDecisionsByStore(result: ComparisonResult | null): Record<StoreKey, ComparisonDecision[]> {
  const grouped: Record<StoreKey, ComparisonDecision[]> = {
    leclerc: [],
    hyperu: []
  };

  result?.decisions.forEach((decision) => {
    if (!decision.requiresValidation && decision.selectedStoreKey) {
      grouped[decision.selectedStoreKey].push(decision);
    }
  });

  return grouped;
}

export function getStoreGap(result: ComparisonResult | null) {
  if (!result || result.totals.leclerc === null || result.totals.hyperu === null) {
    return null;
  }

  return Math.round(Math.abs(result.totals.leclerc - result.totals.hyperu) * 100) / 100;
}

export function formatRecommendation(result: ComparisonResult, savingThresholdEuro: number) {
  const { recommendation, savingsVsBestSingleStore: savings } = result;
  if (recommendation.kind === 'split') {
    return savings !== null
      ? `Partage tes courses entre les deux magasins : tu économises ${formatEuro(savings)}.`
      : 'Partage tes courses entre les deux magasins.';
  }

  if (recommendation.kind === 'single_store') {
    const store = storeLabels[recommendation.storeKey];
    return savings !== null && savings > 0
      ? `Fais toutes tes courses chez ${store}. Partager entre les deux magasins ne te ferait gagner que ${formatEuro(savings)}, moins que ton minimum de ${formatEuro(savingThresholdEuro)}.`
      : `Fais toutes tes courses chez ${store} : c’est le moins cher pour ta liste.`;
  }

  return 'Quelques produits sont à vérifier avant de pouvoir te conseiller.';
}

export function formatLastSync(isoDate: string | undefined) {
  if (!isoDate) {
    return 'jamais';
  }
  const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutesAgo < 1) return "à l'instant";
  if (minutesAgo < 60) return `il y a ${minutesAgo} min`;
  const hoursAgo = Math.round(minutesAgo / 60);
  if (hoursAgo < 24) return `il y a ${hoursAgo} h`;
  const daysAgo = Math.round(hoursAgo / 24);
  return `il y a ${daysAgo} j`;
}

// Explique la raison du plafond à 89% (getCandidateConfidence, scoring.ts) en
// termes compréhensibles pour quelqu'un qui ne connaît pas cette règle
// interne. Sans ce texte, un produit correctement identifié (bon nom, bon
// prix) affiche quand même "89% — à vérifier", ce qui peut faire craindre à
// tort une erreur alors qu'il n'y a simplement pas de code-barres pour le
// confirmer formellement.
export const APPROXIMATE_MATCH_EXPLANATIONS: Partial<Record<CandidateMatchType, string>> = {
  equivalent_brand: "Pas de code-barres confirmé, mais le nom du produit correspond bien à ce qui est demandé.",
  private_label: "Marque de distributeur proposée à la place de la marque demandée — vérifie que c'est bien ce que tu veux.",
  same_brand_different_format: "Même marque, mais le conditionnement trouvé n'est pas garanti identique à celui demandé.",
  uncertain: "Correspondance incertaine entre plusieurs produits possibles — un contrôle avant achat est recommandé."
};

export const DRIVE_ERROR_LABELS: Record<string, string> = {
  PRODUCT_NOT_FOUND: 'produit introuvable sur le site',
  ADAPTER_NOT_READY: 'magasin non pris en charge',
  TAB_CREATION_FAILED: "impossible d'ouvrir l'onglet",
  STORE_COLLECTION_FAILED: 'collecte interrompue (onglet fermé ou site indisponible)',
  DRIVE_SETUP_REQUIRED: 'magasin Drive non configuré sur le site',
  DRIVE_PAGE_TIMEOUT: 'page trop lente à charger',
  CATALOG_NOT_READY: 'catalogue non accessible',
  CATALOG_NOT_READY_AFTER_ENTRY: 'catalogue non accessible après ouverture',
  PRODUCT_SEARCH_INPUT_NOT_FOUND: 'champ de recherche introuvable sur la page',
  PRODUCT_SEARCH_NOT_STARTED: "recherche produit n'a pas pu démarrer",
  PRODUCT_SEARCH_FAILED: 'recherche produit a échoué',
  // Timeout ponctuel du site (pas un "produit introuvable" : la recherche
  // n'a pas eu le temps d'aboutir) — à distinguer clairement de
  // PRODUCT_NOT_FOUND pour ne pas laisser croire à un défaut de recherche.
  PRODUCT_SEARCH_TIMEOUT: 'site trop lent à répondre (relancer suffit en général)',
  STORE_TAB_HIDDEN: 'recherche impossible pendant que Firefox n’est pas à l’écran (relancer en le gardant ouvert)',
  SITE_BLOCKED: 'accès au site bloqué',
  COURSESU_CATALOG_NOT_READY: 'catalogue Hyper U non accessible',
  CIRCUIT_BREAKER_OPEN: 'magasin mis en pause (trop d’échecs récents, nouvelle tentative plus tard)',
  CAPTCHA_DETECTED: 'vérification anti-robot détectée sur le site',
  SCRIPT_EXECUTION_TIMEOUT: 'la page est restée bloquée trop longtemps (nouvelle tentative automatique)',
  CART_NAVIGATION_FAILED: "impossible d'ouvrir la page du produit",
  CART_REDIRECTED_TO_HOME: 'le site a refusé le lien produit et est revenu à sa page d’accueil',
  ADD_TO_CART_CONTROL_NOT_FOUND: 'bouton "ajouter au panier" introuvable sur la page',
  ADD_TO_CART_FAILED: "l'ajout au panier a échoué",
  CART_LOGIN_REQUIRED: "tu n'es pas connecté(e) à ton compte sur le site",
  CART_SEARCH_NOT_STARTED: 'la recherche n’a pas pu démarrer sur le site',
  CART_PRODUCT_NOT_FOUND: 'produit introuvable dans le catalogue du magasin',
  CART_CARD_NOT_FOUND: 'produit trouvé mais impossible de l’ajouter depuis la page',
  CART_ADD_NOT_CONFIRMED: 'le site n’a pas confirmé l’ajout (rupture de stock possible, ou déconnexion en cours de route)',
  // Codes émis par les collecteurs mais qui n’avaient aucun libellé ici : ils
  // ressortaient tels quels (en majuscules techniques) dans le résumé affiché
  // sous le bouton de rafraîchissement.
  STORE_SELECTION_FAILED: 'la sélection du magasin a échoué sur le site',
  STORE_RESULT_NOT_FOUND: 'magasin introuvable dans les résultats du site',
  STORE_RESULT_AMBIGUOUS: 'plusieurs magasins possibles, aucun choix évident',
  STORE_RESULT_NOT_CLICKABLE: 'magasin trouvé mais impossible de le sélectionner',
  STORE_RESULT_STALE: 'la liste des magasins a changé pendant la sélection (nouvelle tentative nécessaire)',
  DRIVE_RESULT_NOT_FOUND: 'drive introuvable dans les résultats du site',
  DRIVE_RESULT_AMBIGUOUS: 'plusieurs drives possibles, aucun choix évident',
  DRIVE_RESULT_NOT_CLICKABLE: 'drive trouvé mais impossible de le sélectionner',
  DRIVE_RESULT_STALE: 'la liste des drives a changé pendant la sélection (nouvelle tentative nécessaire)',
  DRIVE_SELECTION_FAILED: 'la sélection du drive a échoué sur le site',
  DRIVE_SELECTION_REQUIRED: 'il faut d’abord choisir un drive sur le site',
  DRIVE_START_CONTROL_NOT_FOUND: 'bouton "commencer mes courses" introuvable après le choix du drive',
  LOCATION_INPUT_NOT_FOUND: 'champ ville / code postal introuvable sur la page',
  POSTAL_INPUT_NOT_FOUND: 'champ code postal introuvable sur la page',
  POSTAL_AUTOCOMPLETE_NOT_FOUND: 'aucune suggestion proposée pour ce code postal',
  CATALOG_ENTRY_NOT_FOUND: 'entrée du catalogue introuvable sur la page',
  LECLERC_CATALOG_NAVIGATION_FAILED: 'navigation vers le catalogue Leclerc impossible',
  LECLERC_FARM_NOT_RESOLVED: 'serveur du drive Leclerc non identifié',
  MANUAL_URL_NAVIGATION_FAILED: 'impossible d’ouvrir l’adresse corrigée à la main',
  MANUAL_URL_PAGE_NOT_FOUND: 'l’adresse corrigée à la main ne mène à aucune fiche produit',
  MANUAL_URL_PAGE_NOT_READY: 'la fiche de l’adresse corrigée n’a pas fini de s’afficher',
  MANUAL_URL_PAGE_INVALID: 'l’adresse corrigée à la main n’est pas exploitable',
  MANUAL_URL_PRICE_NOT_FOUND: 'aucun prix lisible sur la fiche de l’adresse corrigée',
  CART_DIRECT_URL_NAVIGATION_FAILED: 'impossible d’ouvrir la fiche du produit choisi',
  CART_DIRECT_URL_PAGE_NOT_FOUND: 'la fiche du produit choisi n’existe plus sur le site',
  CART_DIRECT_URL_PAGE_NOT_READY: 'la fiche du produit choisi n’a pas fini de s’afficher',
  CART_DIRECT_URL_MISMATCH: 'la fiche atteinte ne correspond pas au produit choisi (lien périmé)',
  PICK_TIMEOUT: 'aucun produit validé à la main dans le temps imparti',
  DRIVE_PICK_TAB_CLOSED: 'onglet fermé avant la validation manuelle',
  CAPTCHA_REQUIRED: 'vérification anti-robot à faire à la main sur le site',
  LECLERC_SITE_ERROR: 'le site Leclerc Drive est momentanément indisponible (panne côté site, pas le connecteur)',
  DRIVE_JOB_CANCELLED: 'opération annulée',
  UNEXPECTED_HOST: 'le site a redirigé vers une adresse inattendue',
  UNSUPPORTED_PAGE: 'page non reconnue par le connecteur'
};

// The downloadable JSON diagnostic stays the source of truth, but a short
// human-readable summary directly on the page means the user doesn't have
// to open a file just to know roughly what went wrong.
export function summarizeDriveErrors(diagnostic: DriveRefreshDiagnostic) {
  const counts = new Map<string, number>();
  for (const entry of diagnostic.diagnostics) {
    const storeName = storeLabels[entry.storeKey as StoreKey] ?? entry.storeKey;
    const key = `${storeName}|${entry.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [storeName, code] = key.split('|');
      const label = DRIVE_ERROR_LABELS[code] ?? code;
      // Nombre entre parenthèses : les libellés sont au singulier (ils servent
      // aussi pour une seule ligne), « 3 produit introuvable » faisait brouillon.
      return count > 1 ? `${storeName} : ${label} (${count})` : `${storeName} : ${label}`;
    });
}

const SEARCH_STAGE_LABELS: Record<NonNullable<DriveRefreshProgressEvent['searchStage']>, string> = {
  ean: 'recherche par code-barres',
  name: 'code-barres sans résultat, recherche par nom',
  simplified_name: 'nom sans résultat, nouvel essai simplifié',
  name_only: 'toujours rien avec la marque, nouvel essai sans la marque',
  brand_only: 'toujours rien, recherche par marque seule'
};

export function formatDriveProgress(progress: DriveRefreshProgressEvent | null) {
  if (!progress) {
    return 'Démarrage…';
  }
  const storeName = storeLabels[progress.storeKey as StoreKey] ?? progress.storeKey;
  if (progress.state === 'store_retry') {
    return `${storeName} : nouvel essai…`;
  }
  if (progress.state === 'product_search' && progress.productIndex && progress.productTotal) {
    const stageLabel = progress.searchStage ? SEARCH_STAGE_LABELS[progress.searchStage] : null;
    return `${storeName} : produit ${progress.productIndex}/${progress.productTotal}${
      progress.productName ? ` (${progress.productName})` : ''
    }${stageLabel ? ` — ${stageLabel}` : ''}`;
  }
  return `${storeName} : ouverture du site…`;
}

// « 1 produit », « 3 produits » : remplace les « produit(s) » qui faisaient
// brouillon sur la page la plus utilisée (16/11). En français, 0 et 1 restent
// au singulier.
export function countOf(count: number, singular: string, plural: string) {
  return `${count} ${count > 1 ? plural : singular}`;
}

export function formatCoverageDetail(storeLabel: string, coverage: { covered: number; total: number }) {
  const base = `Prix total si tu achètes toute ta liste chez ${storeLabel}.`;
  if (coverage.total === 0 || coverage.covered >= coverage.total) {
    return base;
  }
  const covered =
    coverage.covered === 0
      ? `aucun des ${coverage.total} produits n’a de prix`
      : coverage.covered === 1
        ? `seul 1 produit sur ${coverage.total} a un prix`
        : `seuls ${coverage.covered} produits sur ${coverage.total} ont un prix`;
  return `${base} Attention : ${covered} chez ${storeLabel}, ce total est donc incomplet.`;
}

export function formatMoney(value: number | null) {
  if (value === null) {
    return 'À vérifier';
  }

  return formatEuro(value);
}

// Après un remplissage partiel (16/11) : le montant affiché doit être celui
// que l'utilisateur retrouvera dans son panier réel, pour pouvoir le vérifier.
// Les lignes non ajoutées (indisponibles, introuvables) sont comptées à part.
// Prix de la comparaison validée, pas celui relu au moment de l'ajout.
export function splitCartFillTotal(
  items: ValidatedBasketItem[],
  results: Array<{ productId: string; added: boolean }>
): { addedTotal: number; missingTotal: number } {
  // Un produit compte comme ajouté seulement si aucune de ses lignes n'a
  // échoué : au moindre doute, son montant reste « à ajouter » (relecture).
  const failedIds = new Set(results.filter((line) => !line.added).map((line) => line.productId));
  const addedIds = new Set(
    results.filter((line) => line.added && !failedIds.has(line.productId)).map((line) => line.productId)
  );
  let addedTotal = 0;
  let missingTotal = 0;
  for (const item of items) {
    if (addedIds.has(item.productId)) addedTotal += item.lineTotal;
    else missingTotal += item.lineTotal;
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return { addedTotal: round(addedTotal), missingTotal: round(missingTotal) };
}
