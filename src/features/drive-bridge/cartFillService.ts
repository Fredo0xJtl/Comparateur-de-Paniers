import { type StoreKey, type UserStore, type ValidatedBasketItem } from '../../types/domain';
import { listSelectedStores } from '../stores/storeLocatorService';
import {
  getExtensionBridge,
  type DriveAddToCartExtensionResponse,
  type DriveFetchCartReportResponse,
  type DriveRefreshProgressEvent
} from './extensionBridge';
import { DRIVE_PROTOCOL_VERSION, type DriveAddToCartJobV1, type DriveJobStoreV1 } from './driveProtocol';

export type CartFillResultLine = {
  productId: string;
  added: boolean;
  code?: string;
  details?: Record<string, unknown>;
  matchedName?: string;
  matchedPriceEuro?: number;
};

export type CartFillOutcome =
  | {
      ran: true;
      addedCount: number;
      failedCount: number;
      failures: Array<{ productId: string; code?: string; details?: Record<string, unknown> }>;
      // Toutes les lignes (succès ET échecs), contrairement à `failures` --
      // gardé disponible même quand tout est vert (0 échec) pour permettre un
      // diagnostic exportable systématique : un ajout "réussi" côté extension
      // peut quand même avoir cliqué la mauvaise carte (voir matchedName) et
      // ne remonte alors jamais dans `failures`.
      results: CartFillResultLine[];
    }
  | { ran: false; reason: string; code?: string };

export async function isDriveExtensionAvailable() {
  try {
    await getExtensionBridge().detectDriveExtension();
    return true;
  } catch {
    return false;
  }
}

export async function runCartFill(
  storeKey: StoreKey,
  items: ValidatedBasketItem[],
  callbacks?: {
    onProgress?: (event: DriveRefreshProgressEvent) => void;
    // Appelé dès que le jobId est connu, AVANT d'attendre la fin du
    // remplissage (qui peut prendre plusieurs dizaines de secondes) — permet
    // à l'appelant de persister ce jobId immédiatement, pour pouvoir
    // redemander le rapport à l'extension si la page recharge en cours de
    // route (voir fetchCartReport plus bas).
    onJobStart?: (jobId: string) => void;
  }
): Promise<CartFillOutcome> {
  const onProgress = callbacks?.onProgress;
  const onJobStart = callbacks?.onJobStart;
  const stores = await listSelectedStores();
  const store = stores.find((candidate) => candidate.storeKey === storeKey);
  if (!store) {
    return { ran: false, reason: `Aucun magasin ${storeKey} configuré.` };
  }

  if (items.length === 0) {
    return { ran: false, reason: 'Aucun produit à ajouter au panier.' };
  }

  const bridge = getExtensionBridge();
  try {
    await bridge.detectDriveExtension();
  } catch {
    return { ran: false, reason: 'Extension Drive indisponible.' };
  }

  // `productUrl` reste optionnel : Leclerc n'a aucune fiche produit stable à
  // naviguer directement (cf. leclerc-collector.js, toujours une recherche
  // fraîche), et Hyper U s'en sert désormais en PREMIER recours (navigation
  // directe vérifiée par EAN, cf. tryAddToCartCoursesUViaProductUrl côté
  // extension) avec repli automatique sur la recherche par nom si l'URL est
  // absente, périmée ou ne correspond plus au produit attendu. Un item sans
  // URL connue (jamais scrapé avec succès) est donc envoyé quand même plutôt
  // que d'être retiré silencieusement du job — un ancien filtre ici pouvait
  // faire disparaître des lignes entières sans la moindre trace d'échec, ou
  // même vider le job en entier si tous les items en manquaient.
  const job: DriveAddToCartJobV1 = {
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    jobId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    store: toDriveJobStore(store),
    items: items.map((item) => ({
      productId: item.productId,
      name: item.productName,
      // Marque/EAN du candidat validé : permettent à l'adaptateur de
      // retrouver EXACTEMENT ce produit parmi les résultats de recherche
      // (matching EAN exact prioritaire) plutôt qu'un produit similaire mais
      // différent — voir le commentaire sur ValidatedBasketItem.
      ...(item.brand ? { brand: item.brand } : {}),
      ...(item.barcode ? { barcode: item.barcode } : {}),
      ...(item.productUrl ? { productUrl: item.productUrl } : {}),
      quantity: item.quantity
    }))
  };

  onJobStart?.(job.jobId);

  let response: DriveAddToCartExtensionResponse;
  try {
    response = await bridge.startAddToCart(job, onProgress);
  } catch (error) {
    return { ran: false, reason: error instanceof Error ? error.message : "L'ajout au panier a échoué." };
  }

  return translateAddToCartResponse(response);
}

// Redemande à l'extension le rapport d'un job d'ajout au panier déjà terminé
// (voir DRIVE_FETCH_CART_REPORT / storeCartReport côté service-worker.js) —
// utilisé quand la page a perdu le fil d'un `runCartFill` en cours
// (rechargement Android pendant l'attente, cf. cartFillJobId sur
// ValidatedBasket). `null` signifie "rien à récupérer" (jobId inconnu,
// expiré, ou remplissage encore réellement en cours côté extension) — à
// distinguer d'un `CartFillOutcome` réel, y compris un `ran: false`.
export async function fetchCartReport(jobId: string): Promise<CartFillOutcome | null> {
  const bridge = getExtensionBridge();
  let response: DriveFetchCartReportResponse;
  try {
    await bridge.detectDriveExtension();
    response = await bridge.fetchCartReport(jobId);
  } catch {
    return null;
  }
  if (!response.found) return null;
  return translateAddToCartResponse(response);
}

function translateAddToCartResponse(response: DriveAddToCartExtensionResponse): CartFillOutcome {
  if (!response.accepted || !response.report) {
    return { ran: false, reason: response.reason ?? "L'ajout au panier a échoué." };
  }

  const addedCount = response.report.observations.filter((result) => result.added).length;
  const failures = response.report.observations
    .filter((result) => !result.added)
    .map((result) => ({ productId: result.productId, code: result.code, details: result.details }));
  const results: CartFillResultLine[] = response.report.observations.map((result) => ({
    productId: result.productId,
    added: result.added,
    code: result.code,
    details: result.details,
    matchedName: result.matchedName,
    matchedPriceEuro: result.matchedPriceEuro
  }));

  // Une panne au niveau du magasin entier (site bloqué, CAPTCHA, connexion
  // requise, catalogue inaccessible...) sort par `report.errors`, jamais par
  // `observations` — bug confirmé : ce champ n'était jamais lu ici, donc un
  // job qui échouait avant même de tenter un seul produit retournait un faux
  // succès à zéro ("0 ajouté(s), 0 échec(s)"), un message vide de sens qui
  // masquait la vraie cause (ex. utilisateur non connecté au site).
  if (addedCount === 0 && response.report.errors.length > 0) {
    const [firstError] = response.report.errors;
    return {
      ran: false,
      reason: `Le magasin a signalé un problème (${firstError.code}).`,
      code: firstError.code
    };
  }

  return { ran: true, addedCount, failedCount: failures.length, failures, results };
}

function toDriveJobStore(store: UserStore): DriveJobStoreV1 {
  return {
    storeKey: store.storeKey,
    localStoreId: store.id,
    displayName: store.displayName,
    ...(store.address ? { address: store.address } : {}),
    ...(store.city ? { city: store.city } : {}),
    ...(store.postalCode ? { postalCode: store.postalCode } : {}),
    ...(store.latitude !== undefined ? { latitude: store.latitude } : {}),
    ...(store.longitude !== undefined ? { longitude: store.longitude } : {}),
    ...(store.driveUrl ? { driveUrl: store.driveUrl } : {})
  };
}
