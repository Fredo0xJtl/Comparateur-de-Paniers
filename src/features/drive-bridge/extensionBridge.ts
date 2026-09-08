const PWA_SOURCE = 'drive-price-splitter-pwa';
const EXTENSION_SOURCE = 'drive-price-splitter-extension';
const DEFAULT_TIMEOUT_MS = 2_000;
const DRIVE_REFRESH_TIMEOUT_MS = 10 * 60 * 1_000;
const PWA_DEBUG_BADGE_ID = 'drive-price-splitter-pwa-debug-badge';

import {
  type DriveAddToCartJobV1,
  type DriveAddToCartResultV1,
  type DriveLivePickJobV1,
  type DriveListImportJobV1,
  type DriveListImportReportV1,
  type DrivePriceObservationV1,
  type DriveRefreshJobV1
} from './driveProtocol';
import { isVerboseDiagnosticsEnabled } from './verboseDiagnostics';

// Message unique pour « l'extension n'a pas répondu », partagé par tous les
// services qui peuvent le constater — sans quoi la même situation
// s'expliquerait différemment selon l'écran où on la rencontre.
//
// Rédigé pour le cas de loin le plus fréquent, et le seul qui concerne un
// débutant : le connecteur n'est pas installé. Une version antérieure ouvrait
// sur le cas de l'auto-hébergement (« si tu héberges cette application
// toi-même... ») — vrai, mais adressé à une poignée de personnes, et
// déroutant pour toutes les autres, qui y lisaient une manipulation à faire
// alors qu'il leur suffisait d'installer le connecteur. Le cas de
// l'auto-hébergement reste couvert, en fin de message : celui qui héberge
// l'application sait qu'il le fait, il se reconnaîtra ; l'inverse n'est pas
// vrai. Voir extension/shared/custom-origins.js pour ce que recouvre cette
// seconde phrase.
export const EXTENSION_UNAVAILABLE_MESSAGE =
  'Le connecteur Firefox ne répond pas. Ouvrez « Aide » en haut de l’écran pour l’installer, ' +
  'puis rechargez cette page. (Si vous hébergez cette application vous-même, autorisez plutôt son adresse dans les réglages du connecteur.)';

export type BridgeMessageEvent = {
  data: unknown;
  origin: string;
  source: unknown;
};

export interface BridgeMessageTarget {
  postMessage(message: unknown, targetOrigin?: string): void;
  addEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: BridgeMessageEvent) => void): void;
}

export type DriveExtensionStatus = {
  available: true;
  protocolVersion: 1;
  extensionVersion?: string;
};

export type DriveRefreshExtensionResponse = {
  accepted: boolean;
  extensionVersion?: string;
  reason?: string;
  report?: {
    jobId: string;
    status: 'completed' | 'partial' | 'failed' | 'cancelled';
    observations: DrivePriceObservationV1[];
    errors: Array<{
      storeKey: string;
      productId?: string;
      code: string;
      pageState?: string;
      details?: {
        candidateCount?: number;
        topScores?: number[];
        inputCount?: number;
        pathKind?: string;
        hasSearchControl?: boolean;
        browserKind?: string;
        resultCardCount?: number;
        euroNodeCount?: number;
        productClassElementCount?: number;
        productHrefLinkCount?: number;
        hasCaptcha?: boolean;
        inspectionFailed?: boolean;
        reason?: string;
        pageTitle?: string;
        bodyTextSnippet?: string;
        totalElementCount?: number;
        botProtectionHint?: string | null;
        documentReadyState?: string;
        searchDiag?: {
          inputId: string | null;
          valueAfterSet: string;
          submitControlFound: boolean;
          submitControlClass: string | null;
        } | null;
        sampleCards?: Array<{
          tag: string;
          className: string;
          hasHref: boolean;
          hasProductClassChild: boolean;
          textSnippet: string;
        }>;
        // Meilleurs candidats trouvés mais jugés trop incertains pour être
        // acceptés automatiquement — proposés à l'utilisateur comme piste
        // manuelle plutôt que de laisser un PRODUCT_NOT_FOUND sans issue.
        nearMisses?: Array<{
          name: string;
          brand?: string;
          barcode?: string;
          priceEuro?: number;
          productUrl?: string;
          matchScore?: number;
        }>;
      };
    }>;
    // Products already marked "not_found" for a store within the memory TTL
    // are filtered out before the collector ever runs — they get no
    // observation and no error. Without this, the diagnostic's attempted
    // count (products × stores) looked like most of them silently failed.
    skipped?: Array<{ storeKey: string; count: number }>;
  };
};

export type DriveRefreshProgressEvent = {
  storeKey: string;
  // 'awaiting_pick': the live-pick job is waiting for the user to tap the
  // right card directly on the Leclerc results page (see startLivePick).
  state: 'store_started' | 'store_retry' | 'product_search' | 'awaiting_pick';
  productIndex?: number;
  productTotal?: number;
  productName?: string;
  // Which query is currently running for this product (Leclerc only, for
  // now). Surfacing this distinguishes "EAN search came back empty, trying
  // another way" from a silent/stuck collection — otherwise indistinguishable
  // from the PWA side.
  searchStage?: 'ean' | 'name' | 'simplified_name' | 'name_only' | 'brand_only';
};

export type DriveLivePickExtensionResponse = {
  accepted: boolean;
  extensionVersion?: string;
  reason?: string;
  report?: {
    jobId: string;
    status: 'completed' | 'partial' | 'failed' | 'cancelled';
    observations: DrivePriceObservationV1[];
    errors: Array<{ storeKey: string; productId?: string; code: string }>;
  };
};

export type DriveAddToCartExtensionResponse = {
  accepted: boolean;
  extensionVersion?: string;
  reason?: string;
  report?: {
    jobId: string;
    status: 'completed' | 'partial' | 'failed' | 'cancelled';
    observations: DriveAddToCartResultV1[];
    errors: Array<{ storeKey: string; productId?: string; code: string }>;
  };
};

// Réponse à une redemande de rapport déjà terminé (voir cartFillJobRecovery) —
// `found: false` couvre aussi bien "jobId inconnu" que "expiré" (TTL côté
// service worker), sans distinction utile côté appelant : dans les deux cas
// il n'y a rien à récupérer.
export type DriveListImportProgressEvent = {
  storeKey: string;
  state: 'opening_page' | 'reading_list' | 'reading_department';
  departmentIndex?: number;
  departmentTotal?: number;
  departmentLabel?: string;
};

export type DriveListImportExtensionResponse = {
  accepted: boolean;
  extensionVersion?: string;
  reason?: string;
  report?: DriveListImportReportV1;
};

export type DriveFetchCartReportResponse =
  | ({ found: true } & DriveAddToCartExtensionResponse)
  | { found: false };

export function createExtensionBridge(options?: {
  messageTarget?: BridgeMessageTarget;
  origin?: string;
  timeoutMs?: number;
  createNonce?: () => string;
}) {
  const messageTarget = options?.messageTarget ?? (window as unknown as BridgeMessageTarget);
  const origin = options?.origin ?? window.location.origin;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const createNonce = options?.createNonce ?? (() => crypto.randomUUID());

  return {
    detectDriveExtension(): Promise<DriveExtensionStatus> {
      const nonce = createNonce();
      if (nonce.length < 12 || nonce.length > 128) {
        return Promise.reject(new Error('Nonce du bridge invalide.'));
      }

      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          messageTarget.removeEventListener('message', handleMessage);
        };

        const handleMessage = (event: BridgeMessageEvent) => {
          if (event.source !== messageTarget || event.origin !== origin || !isRecord(event.data)) {
            return;
          }
          if (
            event.data.source !== EXTENSION_SOURCE ||
            event.data.type !== 'DRIVE_CONNECTOR_STATUS_RESULT' ||
            event.data.nonce !== nonce ||
            !isRecord(event.data.response) ||
            event.data.response.available !== true ||
            event.data.response.protocolVersion !== 1
          ) {
            return;
          }

          cleanup();
          showPwaDebugBadge(
            `DPS PWA: extension OK | v${event.data.response.extensionVersion ?? '?'} | proto=${event.data.response.protocolVersion}`
          );
          resolve({
            available: true,
            protocolVersion: 1,
            ...(typeof event.data.response.extensionVersion === 'string'
              ? { extensionVersion: event.data.response.extensionVersion }
              : {})
          });
        };

        const timeout = setTimeout(() => {
          cleanup();
          showPwaDebugBadge(`DPS PWA: aucune réponse extension après ${timeoutMs}ms | origin=${origin}`, true);
          reject(new Error(EXTENSION_UNAVAILABLE_MESSAGE));
        }, timeoutMs);

        messageTarget.addEventListener('message', handleMessage);
        showPwaDebugBadge(`DPS PWA: ping envoyé | origin=${origin} | timeout=${timeoutMs}ms`);
        messageTarget.postMessage(
          { source: PWA_SOURCE, type: 'DRIVE_CONNECTOR_STATUS', nonce },
          origin
        );
      });
    },

    startDriveRefresh(
      job: DriveRefreshJobV1,
      onProgress?: (event: DriveRefreshProgressEvent) => void
    ): Promise<DriveRefreshExtensionResponse> {
      let progressListener: ((event: BridgeMessageEvent) => void) | null = null;
      if (onProgress) {
        // Progress pushes aren't replies to a specific request (no nonce to
        // match) — correlate by jobId instead, and listen for the whole
        // duration of the request rather than through sendBridgeRequest's
        // single-shot nonce matching.
        progressListener = (event: BridgeMessageEvent) => {
          if (
            event.source !== messageTarget ||
            event.origin !== origin ||
            !isRecord(event.data) ||
            event.data.source !== EXTENSION_SOURCE ||
            event.data.type !== 'DRIVE_REFRESH_PROGRESS' ||
            event.data.jobId !== job.jobId ||
            !isRecord(event.data.progress)
          ) {
            return;
          }
          onProgress(event.data.progress as DriveRefreshProgressEvent);
        };
        messageTarget.addEventListener('message', progressListener);
      }

      const result = sendBridgeRequest<DriveRefreshExtensionResponse>({
        messageTarget,
        origin,
        timeoutMs: Math.max(timeoutMs, DRIVE_REFRESH_TIMEOUT_MS),
        nonce: createNonce(),
        requestType: 'DRIVE_REFRESH_START',
        payload: { job }
      });

      if (progressListener) {
        const cleanup = () => messageTarget.removeEventListener('message', progressListener!);
        result.then(cleanup, cleanup);
      }

      return result;
    },

    startAddToCart(
      job: DriveAddToCartJobV1,
      onProgress?: (event: DriveRefreshProgressEvent) => void
    ): Promise<DriveAddToCartExtensionResponse> {
      let progressListener: ((event: BridgeMessageEvent) => void) | null = null;
      if (onProgress) {
        progressListener = (event: BridgeMessageEvent) => {
          if (
            event.source !== messageTarget ||
            event.origin !== origin ||
            !isRecord(event.data) ||
            event.data.source !== EXTENSION_SOURCE ||
            event.data.type !== 'DRIVE_ADD_TO_CART_PROGRESS' ||
            event.data.jobId !== job.jobId ||
            !isRecord(event.data.progress)
          ) {
            return;
          }
          onProgress(event.data.progress as DriveRefreshProgressEvent);
        };
        messageTarget.addEventListener('message', progressListener);
      }

      const result = sendBridgeRequest<DriveAddToCartExtensionResponse>({
        messageTarget,
        origin,
        timeoutMs: Math.max(timeoutMs, DRIVE_REFRESH_TIMEOUT_MS),
        nonce: createNonce(),
        requestType: 'DRIVE_ADD_TO_CART_START',
        payload: { job }
      });

      if (progressListener) {
        const cleanup = () => messageTarget.removeEventListener('message', progressListener!);
        result.then(cleanup, cleanup);
      }

      return result;
    },

    // Redemande le rapport d'un job d'ajout au panier déjà terminé (voir
    // storeCartReport côté service-worker.js) — utilisé quand la page a perdu
    // le fil (rechargement pendant l'attente) et veut savoir si le
    // remplissage a en fait déjà fini.
    fetchCartReport(jobId: string): Promise<DriveFetchCartReportResponse> {
      return sendBridgeRequest<DriveFetchCartReportResponse>({
        messageTarget,
        origin,
        timeoutMs,
        nonce: createNonce(),
        requestType: 'DRIVE_FETCH_CART_REPORT',
        payload: { jobId }
      });
    },

    // Sélection manuelle en direct (Leclerc) : ouvre les résultats de
    // recherche pour UN produit et attend que l'utilisateur tape la bonne
    // carte sur la vraie page — timeout généreux (voir DEFAULT wait côté
    // extension, jusqu'à ~4 min d'attente humaine en plus du prologue/de la
    // recherche), donc ce timeout local doit largement le couvrir.
    startLivePick(
      job: DriveLivePickJobV1,
      onProgress?: (event: DriveRefreshProgressEvent) => void
    ): Promise<DriveLivePickExtensionResponse> {
      let progressListener: ((event: BridgeMessageEvent) => void) | null = null;
      if (onProgress) {
        progressListener = (event: BridgeMessageEvent) => {
          if (
            event.source !== messageTarget ||
            event.origin !== origin ||
            !isRecord(event.data) ||
            event.data.source !== EXTENSION_SOURCE ||
            event.data.type !== 'DRIVE_LIVE_PICK_PROGRESS' ||
            event.data.jobId !== job.jobId ||
            !isRecord(event.data.progress)
          ) {
            return;
          }
          onProgress(event.data.progress as DriveRefreshProgressEvent);
        };
        messageTarget.addEventListener('message', progressListener);
      }

      const result = sendBridgeRequest<DriveLivePickExtensionResponse>({
        messageTarget,
        origin,
        timeoutMs: Math.max(timeoutMs, 6 * 60 * 1_000),
        nonce: createNonce(),
        requestType: 'DRIVE_LIVE_PICK_START',
        payload: { job }
      });

      if (progressListener) {
        const cleanup = () => messageTarget.removeEventListener('message', progressListener!);
        result.then(cleanup, cleanup);
      }

      return result;
    },

    // Import d'une liste/de favoris déjà enregistrés sur le compte de
    // l'utilisateur. Timeout local aligné sur le chien de garde de l'extension
    // (4 min) plus une marge : un import Leclerc parcourt tous les rayons avec
    // une pause humaine entre chacun, il est donc naturellement long.
    startListImport(
      job: DriveListImportJobV1,
      onProgress?: (event: DriveListImportProgressEvent) => void
    ): Promise<DriveListImportExtensionResponse> {
      let progressListener: ((event: BridgeMessageEvent) => void) | null = null;
      if (onProgress) {
        progressListener = (event: BridgeMessageEvent) => {
          if (
            event.source !== messageTarget ||
            event.origin !== origin ||
            !isRecord(event.data) ||
            event.data.source !== EXTENSION_SOURCE ||
            event.data.type !== 'DRIVE_IMPORT_LIST_PROGRESS' ||
            event.data.jobId !== job.jobId ||
            !isRecord(event.data.progress)
          ) {
            return;
          }
          onProgress(event.data.progress as DriveListImportProgressEvent);
        };
        messageTarget.addEventListener('message', progressListener);
      }

      const result = sendBridgeRequest<DriveListImportExtensionResponse>({
        messageTarget,
        origin,
        timeoutMs: Math.max(timeoutMs, 5 * 60 * 1_000),
        nonce: createNonce(),
        requestType: 'DRIVE_IMPORT_LIST_START',
        payload: { job }
      });

      if (progressListener) {
        const cleanup = () => messageTarget.removeEventListener('message', progressListener!);
        result.then(cleanup, cleanup);
      }

      return result;
    },

    cancelListImport(jobId: string): Promise<{ cancelled: boolean }> {
      return sendBridgeRequest<{ cancelled: boolean }>({
        messageTarget,
        origin,
        timeoutMs,
        nonce: createNonce(),
        requestType: 'DRIVE_IMPORT_LIST_CANCEL',
        payload: { jobId }
      });
    }
  };
}

function sendBridgeRequest<T>(input: {
  messageTarget: BridgeMessageTarget;
  origin: string;
  timeoutMs: number;
  nonce: string;
  requestType: string;
  payload?: Record<string, unknown>;
}): Promise<T> {
  if (input.nonce.length < 12 || input.nonce.length > 128) {
    return Promise.reject(new Error('Nonce du bridge invalide.'));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      input.messageTarget.removeEventListener('message', handleMessage);
    };
    const handleMessage = (event: BridgeMessageEvent) => {
      if (
        event.source !== input.messageTarget ||
        event.origin !== input.origin ||
        !isRecord(event.data) ||
        event.data.source !== EXTENSION_SOURCE ||
        event.data.type !== `${input.requestType}_RESULT` ||
        event.data.nonce !== input.nonce ||
        !isRecord(event.data.response)
      ) {
        return;
      }
      cleanup();
      resolve(event.data.response as T);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('La collecte Drive a expiré.'));
    }, input.timeoutMs);

    input.messageTarget.addEventListener('message', handleMessage);
    input.messageTarget.postMessage(
      {
        source: PWA_SOURCE,
        type: input.requestType,
        nonce: input.nonce,
        ...input.payload
      },
      input.origin
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function showPwaDebugBadge(text: string, isError = false) {
  // Diagnostic visuel réservé au développement : sans ce garde-fou, le badge
  // s'affichait par-dessus la PWA de production pour tout le monde. Toujours
  // visible en build de dev (repère au premier coup d'œil sur la version
  // testée) ; en production, activation temporaire uniquement, en console :
  // localStorage.setItem('driveVerboseDiagnostics', '1') puis recharger.
  if (!import.meta.env.DEV && !isVerboseDiagnosticsEnabled()) return;
  if (typeof document === 'undefined') return;
  let badge = document.getElementById(PWA_DEBUG_BADGE_ID);
  if (!badge) {
    const parent = document.documentElement ?? document.body;
    if (!parent) return;
    badge = document.createElement('div');
    badge.id = PWA_DEBUG_BADGE_ID;
    badge.style.cssText =
      'position:fixed;top:4px;right:4px;z-index:2147483647;padding:4px 8px;' +
      'font:11px monospace;border-radius:4px;color:#fff;max-width:92vw;word-break:break-word;';
    parent.appendChild(badge);
  }
  badge.textContent = text;
  badge.style.background = isError ? '#b3261e' : '#174ea6';
}

export function getExtensionBridge() {
  return createExtensionBridge();
}
