export const DRIVE_PROTOCOL_VERSION = 1;
export const DRIVE_JOB_MAX_AGE_MS = 10 * 60 * 1000;
export const DRIVE_MAX_PRODUCTS = 200;
export const DRIVE_MAX_STORES = 10;

const allowedProductHosts = {
  leclerc: ['leclercdrive.fr'],
  hyperu: ['www.coursesu.com', 'coursesu.com']
};

export function validateDriveRefreshJob(value, now = Date.now()) {
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
  const age = now - Date.parse(value.requestedAt);
  if (age < -60_000 || age > DRIVE_JOB_MAX_AGE_MS) {
    throw new Error('Tâche Drive expirée');
  }
  return value;
}

export function validateDriveObservation(value) {
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
  return value;
}

// Miroir de driveProtocol.ts : 'known_url' (02/09/2026) désigne une fiche
// relue directement via un permalien appris (job.knownProductUrls), sans
// cascade de recherche. Autorisé sur une OBSERVATION uniquement — un hint de
// recherche, lui, ne peut porter qu'un vrai étage de cascade, sans quoi on
// mémoriserait un "étage gagnant" que la cascade ne sait pas reprendre.
const OBSERVATION_STAGES = ['ean', 'name', 'simplified_name', 'name_only', 'brand_only', 'manual', 'known_url'];
const SEARCH_HINT_STAGES = ['ean', 'name', 'simplified_name', 'name_only', 'brand_only'];

function isOptionalSearchStage(value) {
  return value === undefined || OBSERVATION_STAGES.includes(value);
}

function isOptionalSearchHintStage(value) {
  return value === undefined || SEARCH_HINT_STAGES.includes(value);
}

function isOptionalStageAttemptList(value) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 5 && value.every(isStageAttempt);
}

function isStageAttempt(value) {
  return (
    isRecord(value) &&
    ['ean', 'name', 'simplified_name', 'name_only', 'brand_only'].includes(value.stage) &&
    Number.isInteger(value.candidateCount) &&
    value.candidateCount >= 0 &&
    value.candidateCount <= 1000 &&
    isOptionalBoundedString(value.topMatchName, 500) &&
    isOptionalConfidence(value.topMatchScore)
  );
}

function isOptionalManualUrlOverrides(value) {
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

function isOptionalKnownUnavailable(value) {
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

function isOptionalSearchHints(value) {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([storeKey, hints]) =>
      isStoreKey(storeKey) &&
      isRecord(hints) &&
      Object.entries(hints).every(([productId, stage]) => isIdentifier(productId) && isOptionalSearchHintStage(stage))
  );
}

// Permaliens appris (voir DriveKnownProductUrlsV1 dans driveProtocol.ts) :
// même forme que manualUrlOverrides, mais aucune valeur de preuve humaine —
// le collecteur revérifie la fiche atteinte et retombe sur la recherche si
// elle ne correspond plus.
function isOptionalKnownProductUrls(value) {
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

function isOptionalAlternateList(value, storeKey) {
  if (value === undefined) return true;
  return Array.isArray(value) && value.length <= 5 && value.every((alternate) => isAlternate(alternate, storeKey));
}

function isAlternate(value, storeKey) {
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

function isOptionalBoolean(value) {
  return value === undefined || typeof value === 'boolean';
}

function isJobStore(value) {
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
    isOptionalStoreUrl(value.driveUrl, value.storeKey)
  );
}

function isOptionalStoreUrl(value, storeKey) {
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

function isJobProduct(value) {
  return (
    isRecord(value) &&
    isIdentifier(value.productId) &&
    isBoundedString(value.name, 300) &&
    isOptionalBoundedString(value.brand, 200) &&
    isOptionalBoundedString(value.barcode, 32) &&
    isOptionalPositiveNumber(value.baseQuantity) &&
    isOptionalProductUnit(value.baseUnit) &&
    // Requête tapée par l'utilisateur pour une sélection en direct (voir
    // DriveJobProductV1.searchQuery) : bornée comme `name`, elle finit
    // saisie telle quelle dans le champ de recherche du site.
    isOptionalBoundedString(value.searchQuery, 300)
  );
}

function isOfficialProductUrl(value, storeKey) {
  if (typeof value !== 'string' || value.length > 2_000) return false;
  try {
    const url = new URL(value);
    const allowedHost =
      storeKey === 'leclerc'
        ? url.hostname === 'leclercdrive.fr' || url.hostname.endsWith('.leclercdrive.fr')
        : storeKey === 'hyperu'
          ? url.hostname === 'coursesu.com' || url.hostname.endsWith('.coursesu.com')
          : allowedProductHosts[storeKey].includes(url.hostname);
    return url.protocol === 'https:' && allowedHost;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoreKey(value) {
  return value === 'leclerc' || value === 'hyperu';
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(value);
}

function isBoundedString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isOptionalBoundedString(value, maxLength) {
  return value === undefined || isBoundedString(value, maxLength);
}

function isIsoDate(value) {
  return typeof value === 'string' && value.includes('T') && !Number.isNaN(Date.parse(value));
}

function isOptionalCoordinate(value, minimum, maximum) {
  return value === undefined || (typeof value === 'number' && value >= minimum && value <= maximum);
}

function isOptionalPositiveNumber(value) {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function isOptionalConfidence(value) {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
}

function isPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000;
}

function isOptionalPrice(value) {
  return value === undefined || isPrice(value);
}

function isOptionalUnitPriceUnit(value) {
  return value === undefined || value === 'L' || value === 'kg';
}

function isOptionalProductUnit(value) {
  return value === undefined || ['L', 'ml', 'kg', 'g', 'unit'].includes(value);
}

const DRIVE_MAX_CART_ITEMS = 100;

// Add-to-cart job: reuses the same job-runner tab-management pipeline as the
// price refresh job, but carries a single store plus items with a productUrl
// already known from a prior refresh (no search cascade needed).
export function validateDriveAddToCartJob(value, now = Date.now()) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== DRIVE_PROTOCOL_VERSION ||
    !isIdentifier(value.jobId) ||
    !isIsoDate(value.requestedAt) ||
    !isJobStore(value.store) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > DRIVE_MAX_CART_ITEMS ||
    !value.items.every((item) => isAddToCartItem(item, value.store.storeKey))
  ) {
    throw new Error('Tâche ajout panier invalide');
  }
  const age = now - Date.parse(value.requestedAt);
  if (age < -60_000 || age > DRIVE_JOB_MAX_AGE_MS) {
    throw new Error('Tâche ajout panier expirée');
  }
  return value;
}

// productUrl est optionnel : Leclerc n'a aucune fiche produit stable à
// naviguer (toujours une recherche fraîche par nom) ; Hyper U s'en sert en
// premier recours, vérifié par EAN, avec repli sur la recherche par nom en
// cas d'échec (voir tryAddToCartCoursesUViaProductUrl dans
// courses-u-collector.js). L'exiger transformait un item jamais scrapé avec
// succès en panne totale du job entier.
// brand/barcode : marque et EAN du candidat validé par l'utilisateur —
// permettent à l'adaptateur de retrouver EXACTEMENT ce produit parmi les
// résultats de recherche (matching EAN exact prioritaire, comme pour le
// scraping de prix) plutôt qu'un produit différent qui matcherait mieux sur
// le nom seul. Optionnels, même raison que productUrl.
function isAddToCartItem(value, storeKey) {
  return (
    isRecord(value) &&
    isIdentifier(value.productId) &&
    isBoundedString(value.name, 300) &&
    isOptionalBoundedString(value.brand, 200) &&
    isOptionalBoundedString(value.barcode, 32) &&
    (value.productUrl === undefined || isOfficialProductUrl(value.productUrl, storeKey)) &&
    typeof value.quantity === 'number' &&
    Number.isFinite(value.quantity) &&
    value.quantity > 0 &&
    value.quantity <= 99
  );
}

// Live pick job (Leclerc manual correction): opens the search results for
// ONE product and waits for the user to tap the right card directly on the
// real page — see the matching comment on DriveLivePickJobV1 in
// driveProtocol.ts for why this can't reuse manualUrlOverrides.
// startUrl (optionnel, retour explicite du 31/08) : quand un candidat est
// déjà connu (ex. le lien "Voir le produit" du détail par magasin), amène
// directement l'onglet sur CETTE page plutôt que sur l'accueil catalogue —
// l'utilisateur navigue depuis un point de départ pertinent (résultats de
// recherche déjà là) au lieu de repartir de zéro. Reste optionnel : sans
// candidat connu (aucun lien à proposer), le comportement d'origine
// (accueil catalogue, navigation entièrement libre) est inchangé.
export function validateDriveLivePickJob(value, now = Date.now()) {
  if (
    !isRecord(value) ||
    value.protocolVersion !== DRIVE_PROTOCOL_VERSION ||
    !isIdentifier(value.jobId) ||
    !isIsoDate(value.requestedAt) ||
    !isJobStore(value.store) ||
    !isJobProduct(value.product) ||
    (value.startUrl !== undefined && !isOfficialProductUrl(value.startUrl, value.store.storeKey))
  ) {
    throw new Error('Tâche de sélection manuelle invalide');
  }
  const age = now - Date.parse(value.requestedAt);
  if (age < -60_000 || age > DRIVE_JOB_MAX_AGE_MS) {
    throw new Error('Tâche de sélection manuelle expirée');
  }
  return value;
}
