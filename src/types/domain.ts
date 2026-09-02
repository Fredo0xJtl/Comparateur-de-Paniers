export type StoreKey = 'leclerc' | 'hyperu';

// `ean` est une valeur historique conservée pour relire les données V1 ; la
// cascade Leclerc active commence désormais par `name`.
export type DriveSearchStage = 'ean' | 'name' | 'simplified_name' | 'name_only' | 'brand_only';

// Remembers, per product+store, either which search stage last found a match
// (so the next refresh can skip straight to it instead of redoing the whole
// name→simplified_name→name_only→brand_only cascade) or that the product was confirmed
// absent from that store's catalog (so future refreshes skip it there
// entirely until the entry goes stale).
export interface DriveSearchMemoryEntry {
  productId: string;
  storeKey: StoreKey;
  outcome: 'matched' | 'not_found';
  stage?: DriveSearchStage;
  updatedAt: string;
}

// URL produit collée manuellement par l'utilisateur pour corriger un
// candidat Hyper U incorrect ou introuvable — voir DriveManualUrlOverridesV1
// dans driveProtocol.ts. Leclerc n'a pas d'équivalent (pas d'URL produit
// stable) : sa correction manuelle passe par un choix direct sur la page.
export interface DriveManualOverrideEntry {
  productId: string;
  storeKey: StoreKey;
  productUrl: string;
  updatedAt: string;
}

export type ComparisonUnit = 'unit' | 'liter' | 'kilogram' | 'wash' | 'roll' | 'capsule';

export type ProductBaseUnit = 'L' | 'ml' | 'kg' | 'g' | 'unit';

export type CandidateMatchType =
  | 'exact_barcode'
  | 'same_brand_different_format'
  | 'equivalent_brand'
  | 'private_label'
  | 'uncertain'
  // The user confirmed this candidate themselves — either by pasting the
  // product's own URL (Hyper U) or by tapping it directly on the live
  // Leclerc results page (Leclerc, which has no stable per-product URL to
  // paste). Never downgraded by a subsequent automatic search.
  | 'manual_override';

export interface Product {
  id: string;
  barcode?: string;
  name: string;
  brand?: string;
  category?: string;
  variant?: string;
  baseQuantity?: number;
  baseUnit?: ProductBaseUnit;
  comparisonUnit: ComparisonUnit;
  allowDifferentFormat: boolean;
  allowPrivateLabel: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
}

export interface UserStore {
  id: string;
  storeKey: StoreKey;
  displayName: string;
  driveUrl?: string;
  address?: string;
  postalCode?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  osmType?: 'node' | 'way' | 'relation';
  osmId?: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoreLocatorResult {
  id: string;
  storeKey: StoreKey;
  displayName: string;
  address?: string;
  postalCode?: string;
  city?: string;
  latitude: number;
  longitude: number;
  osmType: 'node' | 'way' | 'relation';
  osmId: number;
}

export interface StoreSearchCacheEntry {
  queryKey: string;
  results: StoreLocatorResult[];
  createdAt: string;
}

export interface ProductCandidate {
  id: string;
  productId: string;
  storeKey: StoreKey;
  storeProductId?: string;
  name: string;
  brand?: string;
  barcode?: string;
  variant?: string;
  quantity?: number;
  unit?: ProductBaseUnit;
  productUrl?: string;
  searchUrl?: string;
  imageUrl?: string;
  matchType: CandidateMatchType;
  confidenceScore: number;
  confidenceReasons: string[];
  isRejected?: boolean;
  isValidated?: boolean;
  // A same-family candidate found in a different pack size than requested.
  // Never auto-selected by the comparison engine — only surfaced so the user
  // can manually pick it via ShoppingListItem.forcedCandidateId.
  isAlternate?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PriceSnapshot {
  id: string;
  candidateId: string;
  storeKey: StoreKey;
  price: number;
  currency: 'EUR';
  unitPrice?: number;
  comparisonUnit?: ComparisonUnit;
  priceCoherence?: 'ok' | 'mismatch' | 'unknown';
  available: boolean;
  promoLabel?: string;
  checkedAt: string;
  source: 'mock' | 'manual' | 'page' | 'adapter';
}

export interface ShoppingList {
  id: string;
  name: string;
  status: 'draft' | 'ready' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListItem {
  id: string;
  shoppingListId: string;
  productId: string;
  wantedQuantity: number;
  wantedComparisonQuantity?: number;
  notes?: string;
  createdAt: string;
  // Manual override: force this item into one store's basket regardless of
  // which one is cheapest. Undefined means "let the comparison decide".
  forcedStoreKey?: StoreKey;
  // Manual override: use this specific candidate (e.g. an alternate pack
  // size) instead of whichever one the comparison engine would auto-pick.
  forcedCandidateId?: string;
}

export type ValidatedBasketItem = {
  productId: string;
  productName: string;
  candidateId?: string;
  storeProductId?: string;
  // Marque et code-barres du candidat retenu au moment de la validation —
  // transmis jusqu'au remplissage du panier réel pour que l'ajout au panier
  // retrouve EXACTEMENT ce produit (matching par EAN exact prioritaire côté
  // extension) plutôt qu'une recherche par nom seul, qui peut remonter un
  // produit différent (même famille, format ou marque différents).
  brand?: string;
  barcode?: string;
  productUrl?: string;
  quantity: number;
  unitPrice?: number;
  lineTotal: number;
};

export interface ValidatedBasket {
  id: string;
  storeKey: StoreKey;
  total: number;
  savings: number;
  items: ValidatedBasketItem[];
  validatedAt: string;
  // Clé stable du calcul validé. Elle empêche un double clic ou une reprise
  // après rechargement d'enregistrer deux fois le même panier et ses gains.
  operationKey?: string;
  calculationProof?: {
    format: 'comparateur-panier-calculation-proof';
    formatVersion: 1;
    engineVersion: 1;
    createdAt: string;
    trustStatus: 'trusted' | 'attention' | 'blocked';
    excludedLines?: Array<{ itemId: string; productId: string; reason: 'absent_both' }>;
    lines: Array<{ itemId: string; productId: string; lineTotal?: number }>;
    [key: string]: unknown;
  };
  realizedAt?: string;
  realizationSource?: 'cart_fill_done' | 'manual_confirmation';
  cartFillStatus?: 'not_attempted' | 'in_progress' | 'done' | 'partial' | 'failed';
  cartFillMessage?: string;
  // jobId envoyé à l'extension pour le remplissage en cours — permet, si la
  // page recharge (Android déchargeant l'onglet pendant l'attente), de
  // redemander à l'extension le rapport final déjà terminé au lieu de rester
  // bloqué sur `not_attempted` pour toujours. Voir cartFillJobRecovery.ts.
  cartFillJobId?: string;
}

export interface UserSettings {
  id: 'default';
  savingThresholdEuro: number;
  autoDecisionMinConfidence: number;
  preferExactBarcode: boolean;
  allowPrivateLabelByDefault: boolean;
  experimentalAddToCart: boolean;
  cartAutomationConsentVersion?: number;
  cartAutomationConsentedAt?: string;
  // Au-delà de cet âge, un prix collecté (même toujours `available`) n'est
  // plus considéré assez frais pour être utilisé automatiquement — le
  // magasin a pu changer son prix depuis sans qu'on l'ait revérifié.
  maxPriceAgeDays: number;
  updatedAt: string;
  // All data is local-only IndexedDB — this powers a reminder to export a
  // backup, since there's no server copy to fall back on.
  lastBackupExportedAt?: string;
}
