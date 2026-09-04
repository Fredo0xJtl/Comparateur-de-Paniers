import { type StoreKey } from '../../types/domain';

export const DRIVE_PROTOCOL_VERSION = 1 as const;
export const DRIVE_JOB_MAX_AGE_MS = 10 * 60 * 1000;
export const DRIVE_MAX_PRODUCTS = 200;
export const DRIVE_MAX_STORES = 10;

export type DriveProductUnit = 'L' | 'ml' | 'kg' | 'g' | 'unit';

export type DriveJobStoreV1 = {
  storeKey: StoreKey;
  localStoreId: string;
  displayName: string;
  address?: string;
  city?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  driveUrl?: string;
};

export type DriveJobProductV1 = {
  productId: string;
  name: string;
  brand?: string;
  barcode?: string;
  baseQuantity?: number;
  baseUnit?: DriveProductUnit;
  // Sélection en direct uniquement (DriveLivePickJobV1) : les mots que
  // l'utilisateur vient de taper dans l'écran d'ajout pour un produit qui
  // n'existe encore nulle part. Sa propre formulation est envoyée telle
  // quelle dans le champ de recherche du site — contrairement à `name`,
  // hérité d'Open Food Facts et souvent trop bruité pour un moteur qui
  // applique un ET strict sur tous les mots. Ignoré par le rafraîchissement
  // automatique, qui garde sa cascade.
  searchQuery?: string;
};

// Per-store lists of productIds already confirmed absent from that store's
// catalog in a recent prior refresh — the collector skips searching for
// these entirely instead of redoing a doomed search every time.
export type DriveKnownUnavailableV1 = Partial<Record<StoreKey, string[]>>;

// Per-store, per-product hint of which search stage last found a match
// (Leclerc's name→simplified_name→name_only→brand_only cascade) — lets the
// collector jump straight to that stage instead of redoing the whole
// cascade on every refresh.
export type DriveSearchHintsV1 = Partial<Record<StoreKey, Record<string, DriveSearchStageV1>>>;

// 'manual' covers both manual-override mechanisms: a user-supplied product
// URL (Hyper U, which has stable per-product permalinks) and a live on-page
// pick (Leclerc, which doesn't — see manualUrlOverrides below and
// DriveLivePickJobV1).
// `ean` reste accepté uniquement pour compatibilité avec les données V1
// historiques ; il ne fait plus partie de la cascade Leclerc active.
// `known_url` (02/09/2026) : la fiche a été relue directement via un
// permalien déjà connu pour ce produit (voir knownProductUrls), sans passer
// par la cascade de recherche. À la différence de 'manual', ce n'est PAS une
// preuve humaine : le collecteur revérifie que la fiche atteinte correspond
// toujours au produit attendu, et l'observation reste traitée comme un
// résultat automatique ordinaire (aucune montée en confiance).
export type DriveSearchStageV1 =
  | 'ean'
  | 'name'
  | 'simplified_name'
  | 'name_only'
  | 'brand_only'
  | 'manual'
  | 'known_url';

// Per-store, per-product URL the user has manually confirmed as the correct
// product — the collector skips the search cascade entirely for these and
// navigates straight there instead. Only meaningful for stores with stable
// per-product permalinks (Hyper U); Leclerc's search-result cards have none
// (see the comment on readProductCandidatesOnPage's href fallback in
// leclerc-collector.js), so Leclerc corrections go through the live on-page
// picker (DriveLivePickJobV1) instead of this field.
export type DriveManualUrlOverridesV1 = Partial<Record<StoreKey, Record<string, string>>>;

// Permaliens APPRIS (02/09/2026) : l'adresse de la fiche déjà retenue pour ce
// produit lors d'un rafraîchissement précédent. Sert de raccourci — le
// collecteur relit cette fiche au lieu de rejouer toute la cascade de
// recherche, ce qui économise du temps ET supprime le risque de retomber sur
// un autre produit quand le catalogue du magasin bouge.
//
// Canal VOLONTAIREMENT séparé de manualUrlOverrides ci-dessus, qui n'a pas la
// même valeur de preuve : une URL manuelle vaut choix humain explicite et
// confère au candidat un matchType 'manual_override' (confiance 100 %, jamais
// écrasé par une recherche automatique). Un permalien appris n'est qu'une
// mémoire de ce que la machine avait retenu : le collecteur revérifie que la
// fiche atteinte correspond toujours au produit demandé, l'observation
// produite porte le score de correspondance RÉELLEMENT mesuré, et un lien
// périmé ou devenu faux retombe simplement sur la recherche normale. Les
// mélanger accorderait 100 % de confiance à des correspondances que personne
// n'a jamais validées.
export type DriveKnownProductUrlsV1 = Partial<Record<StoreKey, Record<string, string>>>;

export type DriveRefreshJobV1 = {
  protocolVersion: 1;
  jobId: string;
  requestedAt: string;
  stores: DriveJobStoreV1[];
  products: DriveJobProductV1[];
  knownUnavailable?: DriveKnownUnavailableV1;
  searchHints?: DriveSearchHintsV1;
  manualUrlOverrides?: DriveManualUrlOverridesV1;
  knownProductUrls?: DriveKnownProductUrlsV1;
};

export type DrivePriceObservationV1 = {
  protocolVersion: 1;
  jobId: string;
  productId: string;
  storeKey: StoreKey;
  localStoreId: string;
  externalStoreId: string;
  externalProductId?: string;
  observedName: string;
  observedBrand?: string;
  observedBarcode?: string;
  matchScore?: number;
  observedQuantity?: number;
  observedUnit?: DriveProductUnit;
  priceEuro: number;
  unitPriceEuro?: number;
  unitPriceUnit?: 'L' | 'kg';
  available: boolean;
  promotionLabel?: string;
  productUrl: string;
  observedAt: string;
  evidence: 'official_drive_page';
  alternates?: DriveAlternateV1[];
  // Which search stage actually found this match (Leclerc only) — persisted
  // by the caller as a hint for the next refresh.
  matchStage?: DriveSearchStageV1;
  // Détail de CHAQUE étage de la cascade réellement tenté (Leclerc
  // uniquement), y compris sur un succès — pas seulement `matchStage` qui ne
  // dit que l'étage gagnant. Auparavant cette trace n'existait que dans
  // `details.stageAttempts` des erreurs PRODUCT_NOT_FOUND ; un produit trouvé
  // après plusieurs étages ne laissait donc aucune preuve exploitable pour
  // vérifier si un étage antérieur avait déjà vu le bon candidat sans le
  // retenir (cas réel signalé : "Lipton Ice Tea" visible dès la recherche par
  // nom, cascade pourtant poursuivie jusqu'à la marque seule).
  stageAttempts?: DriveStageAttemptV1[];
};

export type DriveStageAttemptV1 = {
  stage: DriveSearchStageV1;
  candidateCount: number;
  topMatchName?: string;
  topMatchScore?: number;
  // Diagnostic seulement (jamais validé strictement — voir isStageAttempt,
  // qui ne rejette pas les champs additionnels). routeVerified (31/08) :
  // expose si waitForProductCandidates a pu confirmer, via l'URL, qu'une
  // NOUVELLE recherche a bien abouti pour cet étage — sans ça, un
  // candidateCount tombé à 0 malgré un exitReason "remaining_zero"
  // (candidats réellement lus) est inexplicable depuis l'export seul : le
  // garde anti-lecture-périmée (applyStaleReadGuard) a pu effacer un
  // résultat réel à tort, mais on ne pouvait jusqu'ici pas le distinguer
  // d'un vrai zéro. Voir extension/adapters/leclerc/leclerc-collector.js.
  timing?: {
    roundCount?: number;
    routeCheckElapsedMs?: number | null;
    elapsedMs?: number;
    lastRemainingPlaceholders?: number | null;
    routeVerified?: boolean;
    exitReason?: string;
  };
};

export type DriveAlternateV1 = {
  externalProductId?: string;
  observedName: string;
  observedBrand?: string;
  observedBarcode?: string;
  matchScore?: number;
  priceEuro: number;
  unitPriceEuro?: number;
  unitPriceUnit?: 'L' | 'kg';
  // Format lu sur le candidat, même échelle g/ml que l'observation
  // principale. Nécessaire pour que le contrôle croisé prix / prix au litre
  // (priceCoherence.ts) s'applique aussi aux alternates : sans lui, leur
  // prix unitaire était transmis mais restait invérifiable.
  observedQuantity?: number;
  observedUnit?: DriveProductUnit;
  productUrl: string;
  // true si ce candidat diffère seulement par le format (même produit,
  // quantité différente) — false/absent pour un candidat valide mais
  // distinct (autre marque, etc.) surfacé parce que `best` est incertain.
  quantityDiffers?: boolean;
};

const allowedProductHosts: Record<string, string[]> = {
  leclerc: ['leclercdrive.fr'],
  hyperu: ['www.coursesu.com', 'coursesu.com']
};

export function validateDriveRefreshJob(value: unknown, now = Date.now()): DriveRefreshJobV1 {
  if (
    !isRecord(value) ||
    value.protocolVersion !== DRIVE_PROTOCOL_VERSION ||
    !isIdentifier(value.jobId) ||
    !isIsoDate(value.requestedAt) ||
    !Array.isArray(value.stores) ||
    value.stores.length < 1 ||
    value.stores.length > DRIVE_MAX_STORES ||
    !value.stores.every(isJobStore) ||
    !Array.isArray(value.products) ||
    value.products.length < 1 ||
    value.products.length > DRIVE_MAX_PRODUCTS ||
    !value.products.every(isJobProduct) ||
    !isOptionalKnownUnavailable(value.knownUnavailable) ||
    !isOptionalSearchHints(value.searchHints) ||
    !isOptionalManualUrlOverrides(value.manualUrlOverrides) ||
    !isOptionalKnownProductUrls(value.knownProductUrls)
  ) {
    throw new Error('Tâche Drive invalide');
  }
  const age = now - Date.parse(value.requestedAt as string);
  if (age < -60_000 || age > DRIVE_JOB_MAX_AGE_MS) {
    throw new Error('Tâche Drive expirée');
  }
  return value as DriveRefreshJobV1;
}

export function validateDriveObservation(value: unknown): DrivePriceObservationV1 {
  if (!isRecord(value) || value.protocolVersion !== DRIVE_PROTOCOL_VERSION) {
    throw new Error('Observation Drive invalide');
  }
  const storeKey = value.storeKey;
  if (
    !isStoreKey(storeKey) ||
    !isIdentifier(value.jobId) ||
    !isIdentifier(value.productId) ||
    !isIdentifier(value.localStoreId) ||
    !isBoundedString(value.externalStoreId, 200) ||
    !isOptionalBoundedString(value.externalProductId, 200) ||
    !isBoundedString(value.observedName, 500) ||
    !isOptionalBoundedString(value.observedBrand, 200) ||
    !isOptionalBoundedString(value.observedBarcode, 32) ||
    !isOptionalConfidence(value.matchScore) ||
    !isOptionalPositiveNumber(value.observedQuantity) ||
    !isOptionalProductUnit(value.observedUnit) ||
    !isPrice(value.priceEuro) ||
    !isOptionalPrice(value.unitPriceEuro) ||
    !isOptionalUnitPriceUnit(value.unitPriceUnit) ||
    typeof value.available !== 'boolean' ||
    !isOptionalBoundedString(value.promotionLabel, 300) ||
    !isOfficialProductUrl(value.productUrl, storeKey) ||
    !isIsoDate(value.observedAt) ||
    value.evidence !== 'official_drive_page' ||
    !isOptionalAlternateList(value.alternates, storeKey) ||
    !isOptionalSearchStage(value.matchStage) ||
    !isOptionalStageAttemptList(value.stageAttempts)
  ) {
    throw new Error('Observation Drive invalide');
  }
  return value as DrivePriceObservationV1;
}

// Étages qu'une OBSERVATION a le droit de porter. 'known_url' en fait partie
// depuis le 02/09/2026 (relecture directe d'un permalien appris).
const OBSERVATION_STAGES = ['ean', 'name', 'simplified_name', 'name_only', 'brand_only', 'manual', 'known_url'];

// Étages qu'un HINT de recherche a le droit de porter — volontairement plus
// restreint : un hint sert à reprendre la cascade au bon étage, or ni 'manual'
// ni 'known_url' ne sont des étages de recherche. Les accepter ici ferait
// mémoriser un "étage gagnant" que la cascade ne sait pas reprendre.
const SEARCH_HINT_STAGES = ['ean', 'name', 'simplified_name', 'name_only', 'brand_only'];

function isOptionalSearchStage(value: unknown): boolean {
  return value === undefined || OBSERVATION_STAGES.includes(value as string);
}

function isOptionalSearchHintStage(value: unknown): boolean {
  return value === undefined || SEARCH_HINT_STAGES.includes(value as string);
}

function isOptionalStageAttemptList(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 5 && value.every(isStageAttempt);
}

function isStageAttempt(value: unknown): value is DriveStageAttemptV1 {
  return (
    isRecord(value) &&
    ['ean', 'name', 'simplified_name', 'name_only', 'brand_only'].includes(value.stage as string) &&
    Number.isInteger(value.candidateCount) &&
    (value.candidateCount as number) >= 0 &&
    (value.candidateCount as number) <= 1000 &&
    isOptionalBoundedString(value.topMatchName, 500) &&
    isOptionalConfidence(value.topMatchScore)
  );
}

function isOptionalManualUrlOverrides(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([storeKey, urlsByProductId]) =>
      isStoreKey(storeKey) &&
      isRecord(urlsByProductId) &&
      Object.entries(urlsByProductId).every(
        ([productId, url]) => isIdentifier(productId) && isOfficialProductUrl(url, storeKey)
      )
  );
}

function isOptionalKnownUnavailable(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([storeKey, productIds]) =>
      isStoreKey(storeKey) &&
      Array.isArray(productIds) &&
      productIds.length <= DRIVE_MAX_PRODUCTS &&
      productIds.every(isIdentifier)
  );
}

function isOptionalSearchHints(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([storeKey, hints]) =>
      isStoreKey(storeKey) &&
      isRecord(hints) &&
      Object.entries(hints).every(([productId, stage]) => isIdentifier(productId) && isOptionalSearchHintStage(stage))
  );
}

// Même forme que isOptionalManualUrlOverrides — la distinction entre les deux
// canaux est sémantique (voir DriveKnownProductUrlsV1), pas structurelle.
function isOptionalKnownProductUrls(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([storeKey, urlsByProductId]) =>
      isStoreKey(storeKey) &&
      isRecord(urlsByProductId) &&
      Object.entries(urlsByProductId).every(
        ([productId, url]) => isIdentifier(productId) && isOfficialProductUrl(url, storeKey)
      )
  );
}

function isOptionalAlternateList(value: unknown, storeKey: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 5 && value.every((alternate) => isAlternate(alternate, storeKey));
}

function isAlternate(value: unknown, storeKey: unknown): value is DriveAlternateV1 {
  return (
    isRecord(value) &&
    isOptionalBoundedString(value.externalProductId, 200) &&
    isBoundedString(value.observedName, 500) &&
    isOptionalBoundedString(value.observedBrand, 200) &&
    isOptionalBoundedString(value.observedBarcode, 32) &&
    isOptionalConfidence(value.matchScore) &&
    isPrice(value.priceEuro) &&
    isOptionalPrice(value.unitPriceEuro) &&
    isOptionalUnitPriceUnit(value.unitPriceUnit) &&
    isOptionalPositiveNumber(value.observedQuantity) &&
    isOptionalProductUnit(value.observedUnit) &&
    isOfficialProductUrl(value.productUrl, storeKey) &&
    isOptionalBoolean(value.quantityDiffers)
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isJobStore(value: unknown): value is DriveJobStoreV1 {
  return (
    isRecord(value) &&
    isStoreKey(value.storeKey) &&
    isIdentifier(value.localStoreId) &&
    isBoundedString(value.displayName, 200) &&
    isOptionalBoundedString(value.address, 500) &&
    isOptionalBoundedString(value.city, 100) &&
    isOptionalBoundedString(value.postalCode, 20) &&
    isOptionalCoordinate(value.latitude, -90, 90) &&
    isOptionalCoordinate(value.longitude, -180, 180) &&
    isOptionalStoreUrl(value.driveUrl, value.storeKey as StoreKey)
  );
}

export function isOptionalStoreUrl(value: unknown, storeKey: StoreKey): boolean {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    const allowedHost =
      storeKey === 'leclerc'
        ? url.hostname === 'leclercdrive.fr' || url.hostname.endsWith('.leclercdrive.fr')
        : url.hostname === 'coursesu.com' || url.hostname.endsWith('.coursesu.com');
    return url.protocol === 'https:' && allowedHost;
  } catch {
    return false;
  }
}

function isJobProduct(value: unknown): value is DriveJobProductV1 {
  return (
    isRecord(value) &&
    isIdentifier(value.productId) &&
    isBoundedString(value.name, 300) &&
    isOptionalBoundedString(value.brand, 200) &&
    isOptionalBoundedString(value.barcode, 32) &&
    isOptionalPositiveNumber(value.baseQuantity) &&
    isOptionalProductUnit(value.baseUnit)
  );
}

function isOfficialProductUrl(value: unknown, storeKey: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    const allowedHost =
      storeKey === 'leclerc'
        ? url.hostname === 'leclercdrive.fr' || url.hostname.endsWith('.leclercdrive.fr')
        : storeKey === 'hyperu'
          ? url.hostname === 'coursesu.com' || url.hostname.endsWith('.coursesu.com')
          : (allowedProductHosts[storeKey as string] ?? []).includes(url.hostname);
    return url.protocol === 'https:' && allowedHost;
  } catch {
    return false;
  }
}

// --- Add-to-cart job (real DOM automation on the store's own site) ---
// Deliberately reuses the same job/store shape as the price-refresh job so it
// can run through the identical extension tab-management pipeline. Each item
// carries the productUrl already collected by a prior price refresh — the
// add-to-cart adapters navigate straight there instead of re-running the
// search cascade.

export type DriveAddToCartItemV1 = {
  productId: string;
  name: string;
  // Marque/EAN du candidat validé par l'utilisateur — permettent à
  // l'adaptateur de retrouver EXACTEMENT ce produit parmi les résultats de
  // recherche (matching EAN exact prioritaire, comme pour le scraping de
  // prix) plutôt qu'un produit différent qui matcherait mieux sur le nom
  // seul. Optionnels : un item jamais scrapé avec un EAN connu reste géré
  // par le repli nom+marque déjà en place.
  brand?: string;
  barcode?: string;
  // Optionnel : Leclerc n'a aucune fiche produit stable à naviguer (toujours
  // une recherche fraîche par nom) ; Hyper U s'en sert en premier recours,
  // vérifié par EAN, avec repli sur la recherche par nom en cas d'échec — voir
  // tryAddToCartCoursesUViaProductUrl. L'exiger transformait un item jamais
  // scrapé avec succès en panne totale du job entier — cf. cartFillService.ts.
  productUrl?: string;
  quantity: number;
};

export type DriveAddToCartJobV1 = {
  protocolVersion: 1;
  jobId: string;
  requestedAt: string;
  store: DriveJobStoreV1;
  items: DriveAddToCartItemV1[];
};

export type DriveAddToCartResultV1 = {
  protocolVersion: 1;
  jobId: string;
  productId: string;
  storeKey: StoreKey;
  added: boolean;
  code?: string;
  details?: Record<string, unknown>;
  // Nom/prix RÉELLEMENT ajoutés au panier (même sur succès) — seul moyen de
  // repérer après coup, via le diagnostic téléchargeable, qu'un clic a
  // atterri sur la mauvaise fiche/carte malgré un statut "added" correct.
  matchedName?: string;
  matchedPriceEuro?: number;
};

// --- Live pick job (Leclerc manual correction) ---
// Leclerc's search-result cards have no stable per-product URL to paste
// (see the comment on readProductCandidatesOnPage's href fallback in
// leclerc-collector.js), so a manual correction there can't reuse the
// URL-based DriveManualUrlOverridesV1 mechanism above. Instead this job
// opens the store's search results for ONE product, injects a "C'est
// celui-ci" button onto each visible card, and waits for the user to tap
// the right one directly on the real page.

export type DriveLivePickJobV1 = {
  protocolVersion: 1;
  jobId: string;
  requestedAt: string;
  store: DriveJobStoreV1;
  product: DriveJobProductV1;
  // Optionnel (retour explicite du 31/08) : quand un candidat est déjà
  // connu (lien "Voir le produit" du détail par magasin), amène directement
  // l'onglet sur CETTE page plutôt que sur l'accueil catalogue. Voir le
  // commentaire jumeau dans drive-protocol.js.
  startUrl?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoreKey(value: unknown): value is StoreKey {
  return value === 'leclerc' || value === 'hyperu';
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.includes('T') && !Number.isNaN(Date.parse(value));
}

function isOptionalCoordinate(value: unknown, minimum: number, maximum: number): boolean {
  return value === undefined || (typeof value === 'number' && value >= minimum && value <= maximum);
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function isOptionalConfidence(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1)
  );
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

function isOptionalPrice(value: unknown): boolean {
  return value === undefined || isPrice(value);
}

function isOptionalUnitPriceUnit(value: unknown): boolean {
  return value === undefined || value === 'L' || value === 'kg';
}

function isOptionalProductUnit(value: unknown): boolean {
  return value === undefined || ['L', 'ml', 'kg', 'g', 'unit'].includes(value as string);
}
