import { createDriveJobRunner, recoverInterruptedJob } from './job-runner.js';
import { createListImportRunner } from './list-import-runner.js';
import {
  validateDriveRefreshJob,
  validateDriveAddToCartJob,
  validateDriveLivePickJob,
  validateDriveListImportJob
} from '../shared/drive-protocol.js';
import { collectLeclercStore, addToCartLeclercStore, livePickLeclercProduct } from '../adapters/leclerc/leclerc-collector.js';
import { collectCoursesUStore, addToCartCoursesUStore, livePickCoursesUProduct } from '../adapters/courses-u/courses-u-collector.js';
import { isAllowedOrigin } from '../shared/origin-allowlist.js';
import { BRIDGE_ORIGIN_PATTERNS } from '../shared/bridge-origins.js';
import { CUSTOM_ORIGINS_STORAGE_KEY, readCustomOrigins } from '../shared/custom-origins.js';
import { loadVerboseDiagnosticsFlag } from '../shared/verbose-diagnostics.js';

// Firefox exposes a promise-based `browser` namespace; Chrome/Chromium only has
// the callback-style `chrome` namespace (which also supports promises when no
// callback is passed). Using the same wrapper on both keeps one source tree.
const runtime = globalThis.browser ?? globalThis.chrome;

const EXPECTED_STORE_HOSTS = {
  leclerc: /(^|\.)leclercdrive\.fr$/i,
  hyperu: /(^|\.)coursesu\.com$/i
};

// Le rapport final d'un job d'ajout au panier n'existait que dans la réponse
// asynchrone à `DRIVE_ADD_TO_CART_START` — si la page PWA recharge pendant
// l'attente (Android déchargeant l'onglet, observé en conditions réelles
// pendant une double authentification), ce canal de réponse est perdu et le
// panier reste bloqué sur "en cours" pour toujours, alors même que le
// remplissage a bien terminé côté site. On sauvegarde donc aussi le rapport
// ici, par jobId, pour que la PWA puisse le redemander via
// DRIVE_FETCH_CART_REPORT après un rechargement.
const CART_REPORT_KEY_PREFIX = 'cartReport:';
const CART_REPORT_TTL_MS = 30 * 60 * 1000;

// Audit sécurité du 30/08 (LOW #9) : le rapport est lié à l'onglet PWA qui a
// démarré le job (callerTabId), pas seulement au jobId. Sans ça, n'importe
// quelle page ouverte dans une origine autorisée (ex. un autre onglet de dev
// sur localhost) pouvait redemander le rapport d'un job démarré par un autre
// onglet simplement en connaissant/devinant son jobId. Un rechargement de
// l'onglet PWA garde le même tabId (voir le commentaire au-dessus sur la
// raison d'être de ce cache), donc ça ne casse pas le cas d'usage réel.
async function storeCartReport(session, jobId, response, callerTabId) {
  try {
    await session.set({
      [`${CART_REPORT_KEY_PREFIX}${jobId}`]: { ...response, storedAt: Date.now(), callerTabId }
    });
  } catch {
    // Best-effort uniquement : ne jamais faire échouer la réponse normale
    // (sendResponse) à cause d'un souci de stockage.
  }
}

function isValidJobId(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 128;
}

// Audit sécurité du 30/08 : dérive la liste blanche directement du manifest
// ACTIF (jamais une liste dupliquée à la main) pour vérifier que le message
// vient bien d'une page où le bridge (extension/bridge/pwa-bridge.js) a
// réellement été injecté par ce build — pas d'une page tierce qui imite
// juste la balise <meta> attendue. Voir extension/shared/origin-allowlist.js.
function getAllowedOrigins() {
  // La liste produite à la construction (extension/shared/bridge-origins.js)
  // fait foi quand elle existe : elle seule peut restreindre un paquet
  // --dev-port au port demandé, ce que le manifest est incapable
  // d'exprimer — un match pattern WebExtension n'accepte aucun numéro de
  // port, et Firefox rejette les motifs qui en portent un (bugs Mozilla
  // 1362809 / 1468162) : le bridge cesse alors d'être injecté et la PWA
  // affiche "Extension Drive indisponible". Liste vide dans les sources
  // non construites : on retombe sur les matches du manifest actif.
  if (BRIDGE_ORIGIN_PATTERNS.length > 0) return BRIDGE_ORIGIN_PATTERNS;
  const contentScripts = runtime.runtime.getManifest().content_scripts ?? [];
  return contentScripts.flatMap((entry) => entry.matches ?? []);
}

function senderOrigin(sender) {
  const origin = sender?.origin ?? null;
  if (origin) return origin;
  if (!sender?.url) return null;
  try {
    return new URL(sender.url).origin;
  } catch {
    return null;
  }
}

// Origines livrées dans le paquet : l'adresse publique du Comparateur de
// Paniers, plus les origines de développement d'un build `--dev`. C'est le
// chemin de la quasi-totalité des messages, et il reste strictement
// synchrone — donc sans le moindre changement de comportement pour ceux qui
// utilisent le site public.
function isAllowedSenderSync(sender) {
  return isAllowedOrigin(senderOrigin(sender), getAllowedOrigins());
}

// Adresse déclarée par l'utilisateur lui-même dans la page d'options, pour
// une installation qu'il héberge (ordinateur, NAS, Raspberry Pi, domaine
// personnel). Deux conditions cumulatives, et non une seule :
//   1. l'origine figure dans la liste enregistrée (storage.local) ;
//   2. Firefox confirme que la permission d'hôte correspondante est
//      RÉELLEMENT accordée.
// La seconde rattrape le cas où l'utilisateur retire la permission depuis
// « Gérer les extensions » sans passer par notre page d'options : le
// stockage, lui, n'en saurait rien.
async function isAllowedSenderCustom(sender) {
  const origin = senderOrigin(sender);
  if (!origin) return false;
  const entries = await readCustomOrigins(runtime.storage.local);
  const entry = entries.find((item) => isAllowedOrigin(origin, [item.runtimePattern]));
  if (!entry) return false;
  try {
    return await runtime.permissions.contains({ origins: [entry.hostPattern] });
  } catch {
    return false;
  }
}

// Enregistre le pont sur les adresses déclarées par l'utilisateur. Rejoué à
// chaque démarrage du service worker : les scripts enregistrés à l'exécution
// ne survivent pas forcément à un redémarrage du navigateur, alors que les
// permissions accordées, elles, sont persistantes — sans ce rejeu, la PWA
// auto-hébergée afficherait « Extension Drive indisponible » après chaque
// redémarrage, de façon parfaitement silencieuse.
const CUSTOM_BRIDGE_SCRIPT_ID = 'custom-origin-bridge';

async function syncCustomOriginContentScripts() {
  const entries = await readCustomOrigins(runtime.storage.local);
  const granted = [];
  for (const entry of entries) {
    try {
      if (await runtime.permissions.contains({ origins: [entry.hostPattern] })) granted.push(entry.hostPattern);
    } catch {
      // Permission illisible : on n'enregistre rien pour cette adresse.
      // Défaut sûr — le pont manquant se voit et se corrige, un pont de trop
      // ne se voit pas.
    }
  }
  const unique = [...new Set(granted)];
  try {
    await runtime.scripting.unregisterContentScripts({ ids: [CUSTOM_BRIDGE_SCRIPT_ID] });
  } catch {
    // Rien d'enregistré (premier démarrage, ou liste devenue vide) : c'est le
    // cas normal, pas une erreur.
  }
  if (unique.length === 0) return;
  try {
    await runtime.scripting.registerContentScripts([
      {
        id: CUSTOM_BRIDGE_SCRIPT_ID,
        matches: unique,
        js: ['bridge/pwa-bridge.js'],
        runAt: 'document_start'
      }
    ]);
  } catch {
    // Un motif refusé ne doit pas empêcher l'extension de fonctionner sur
    // l'adresse publique, qui reste déclarée dans le manifest.
  }
}

// Ce worker peut être déchargé à tout moment entre deux messages (MV3). S'il
// l'a été en pleine collecte, les onglets Drive ouverts et le badge sont
// restés en l'état : on les nettoie dès le rechargement, avant qu'un nouveau
// job ne démarre.
recoverInterruptedJob({
  tabs: runtime.tabs,
  session: runtime.storage.session,
  action: runtime.action
}).catch(() => undefined);

// Rechargé à chaque réveil du service worker (MV3 le décharge entre deux
// messages) — reste OFF par défaut tant qu'il n'a jamais été activé
// explicitement. Voir extension/shared/verbose-diagnostics.js.
loadVerboseDiagnosticsFlag(runtime.storage.local).catch(() => undefined);

// Même raison : le service worker est déchargé entre deux messages, et les
// scripts enregistrés à l'exécution peuvent avoir disparu. On les remet en
// place au réveil, puis à chaque fois que la page d'options modifie la liste
// ou que Firefox retire une permission (« Gérer les extensions »).
syncCustomOriginContentScripts().catch(() => undefined);

runtime.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(CUSTOM_ORIGINS_STORAGE_KEY in changes)) return;
  syncCustomOriginContentScripts().catch(() => undefined);
});

runtime.permissions.onAdded?.addListener(() => {
  syncCustomOriginContentScripts().catch(() => undefined);
});

runtime.permissions.onRemoved?.addListener(() => {
  syncCustomOriginContentScripts().catch(() => undefined);
});

const runner = createDriveJobRunner({
  tabs: runtime.tabs,
  scripting: runtime.scripting,
  action: runtime.action,
  session: runtime.storage.session,
  breakerStore: runtime.storage.local,
  canRunStore: (store) => store.storeKey === 'leclerc' || store.storeKey === 'hyperu',
  async runStore(context) {
    const { store, tabId, signal } = context;
    await waitForTabReady(tabId, signal, EXPECTED_STORE_HOSTS[store.storeKey]);
    // `tabs` sert aux deux collecteurs à naviguer droit sur une fiche produit
    // connue — URL confirmée par l'utilisateur (job.manualUrlOverrides) ou
    // permalien appris au rafraîchissement précédent (job.knownProductUrls) —
    // au lieu de rejouer la cascade de recherche.
    // Longtemps réservé à Hyper U, "Leclerc n'ayant aucune URL produit
    // stable" : ce n'est plus vrai depuis le 31/08 (buildLeclercFicheUrl). Ne
    // pas le lui passer laissait chaque relecture de fiche Leclerc partir en
    // ReferenceError silencieuse — corrigé le 02/09.
    return store.storeKey === 'leclerc'
      ? collectLeclercStore({
          ...context,
          scripting: runtime.scripting,
          tabs: runtime.tabs,
          // Table magasin -> ferme Leclerc apprise à l'usage, rangée
          // localement : voir leclerc-farm-resolver.js.
          farmStore: runtime.storage.local
        })
      : collectCoursesUStore({ ...context, scripting: runtime.scripting, tabs: runtime.tabs });
  }
});

// Separate runner instance for the add-to-cart job: same tab-management
// pipeline (one store tab, sequential items, retry-once-on-failure), but
// dispatches to the add-to-cart adapters instead of the price collectors.
const addToCartRunner = createDriveJobRunner({
  tabs: runtime.tabs,
  scripting: runtime.scripting,
  action: runtime.action,
  session: runtime.storage.session,
  breakerStore: runtime.storage.local,
  // "Valider le panier" est un geste explicite et surveillé par l'utilisateur
  // au moment même où il l'exécute — contrairement à un rafraîchissement de
  // fond, on ne saute pas le job juste parce qu'un précédent rafraîchissement
  // a récemment ouvert le disjoncteur sur ce magasin. Le disjoncteur reste
  // alimenté par ce runner (voir respectCircuitBreaker dans job-runner.js).
  respectCircuitBreaker: false,
  canRunStore: (store) => store.storeKey === 'leclerc' || store.storeKey === 'hyperu',
  async runStore(context) {
    const { store, tabId, signal } = context;
    await waitForTabReady(tabId, signal, EXPECTED_STORE_HOSTS[store.storeKey]);
    // job-runner's generic pipeline names the per-store payload `products` —
    // here it actually holds the add-to-cart items (see the job reshaping in
    // the DRIVE_ADD_TO_CART_START handler below). `tabs` est nécessaire côté
    // Hyper U pour naviguer directement vers la fiche produit confirmée
    // (item.productUrl) — voir tryAddToCartCoursesUViaProductUrl.
    const addToCartContext = {
      ...context,
      items: context.products,
      scripting: runtime.scripting,
      tabs: runtime.tabs,
      farmStore: runtime.storage.local
    };
    return store.storeKey === 'leclerc'
      ? addToCartLeclercStore(addToCartContext)
      : addToCartCoursesUStore(addToCartContext);
  }
});

// Sélection manuelle en direct (Leclerc uniquement — voir le commentaire sur
// DriveLivePickJobV1 dans driveProtocol.ts) : même pipeline de gestion
// d'onglet que les deux runners ci-dessus, mais un seul produit, et
// l'adaptateur attend un vrai tap humain sur la page plutôt que de choisir
// automatiquement.
const livePickRunner = createDriveJobRunner({
  tabs: runtime.tabs,
  scripting: runtime.scripting,
  action: runtime.action,
  session: runtime.storage.session,
  breakerStore: runtime.storage.local,
  // Un choix manuel est un geste explicite et surveillé par l'utilisateur au
  // moment même où il l'exécute, tout comme "Valider le panier" ci-dessus : on
  // ne saute pas le job juste parce qu'un précédent rafraîchissement a
  // récemment ouvert le disjoncteur sur ce magasin (sinon un choix manuel côté
  // Leclerc peut être bloqué à tort juste après un pick Hyper U, alors que les
  // deux magasins ont des disjoncteurs indépendants). Le disjoncteur reste
  // alimenté par ce runner (voir respectCircuitBreaker dans job-runner.js).
  respectCircuitBreaker: false,
  canRunStore: (store) => store.storeKey === 'leclerc' || store.storeKey === 'hyperu',
  // 6 minutes : le prologue + la recherche + jusqu'à 4 minutes d'attente d'un
  // tap humain doivent tenir dans ce délai avant que le chien de garde
  // n'annule le job (voir DEFAULT_JOB_TIMEOUT_MS dans job-runner.js).
  jobTimeoutMs: 6 * 60 * 1000,
  async runStore(context) {
    const { store, tabId, signal } = context;
    await waitForTabReady(tabId, signal, EXPECTED_STORE_HOSTS[store.storeKey]);
    return store.storeKey === 'leclerc'
      ? livePickLeclercProduct({
          ...context,
          scripting: runtime.scripting,
          tabs: runtime.tabs,
          farmStore: runtime.storage.local
        })
      : livePickCoursesUProduct({ ...context, scripting: runtime.scripting, tabs: runtime.tabs });
  }
});

// Import des listes/favoris de compte : cycle de vie beaucoup plus court que
// les trois runners ci-dessus (un onglet, une lecture, un résultat), d'où un
// runner autonome plutôt qu'une quatrième instance du pipeline de collecte.
const listImportRunner = createListImportRunner({
  tabs: runtime.tabs,
  scripting: runtime.scripting
});

// On Android, a tab can briefly report status "complete" on an intermediate
// hop (e.g. a client-side redirect) before reaching the final store domain.
// Waiting for the URL to match the expected host too avoids racing
// scripting.executeScript against a page outside our host_permissions.
async function waitForTabReady(tabId, signal, expectedHost) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    const tab = await runtime.tabs.get(tabId);
    if (tab.status === 'complete' && (!expectedHost || matchesHost(tab.url, expectedHost))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('DRIVE_PAGE_TIMEOUT');
}

function matchesHost(url, expectedHost) {
  try {
    return expectedHost.test(new URL(url ?? '').hostname);
  } catch {
    return false;
  }
}

// Tout le protocole utile, une fois l'origine de l'appelant vérifiée. Séparé
// du listener parce que cette vérification a deux chemins : un synchrone (les
// origines livrées dans le paquet) et un asynchrone (l'adresse déclarée par
// l'utilisateur, qu'il faut lire dans le stockage et confirmer auprès de
// Firefox). Le corps, lui, est rigoureusement le même dans les deux cas.
function dispatchDriveMessage(message, sender, sendResponse) {
  if (message?.type === 'DRIVE_REFRESH_START') {
    try {
      validateDriveRefreshJob(message.job);
      const pwaTabId = sender.tab?.id;
      // Best-effort: the final report already carries the full result, so a
      // progress push that fails to reach the PWA tab (closed, backgrounded
      // and discarded, ...) must never interrupt the collection itself.
      const onProgress = (progress) => {
        if (!Number.isInteger(pwaTabId)) return;
        runtime.tabs
          .sendMessage(pwaTabId, {
            source: 'drive-price-splitter-extension',
            type: 'DRIVE_REFRESH_PROGRESS',
            jobId: message.job.jobId,
            progress
          })
          .catch(() => undefined);
      };
      runner.start(message.job, onProgress, { callerTabId: pwaTabId }).then(
        (report) =>
          sendResponse({
            accepted: true,
            extensionVersion: runtime.runtime.getManifest().version,
            report
          }),
        (error) =>
          sendResponse({
            accepted: false,
            reason:
              error instanceof Error ? error.message : "La collecte Drive n'a pas pu démarrer."
          })
      );
    } catch {
      sendResponse({ accepted: false, reason: 'Tâche Drive invalide.' });
      return false;
    }
    return true;
  }

  if (message?.type === 'DRIVE_REFRESH_CANCEL') {
    sendResponse({ cancelled: runner.cancel(message.jobId) });
    return false;
  }

  if (message?.type === 'DRIVE_ADD_TO_CART_START') {
    try {
      validateDriveAddToCartJob(message.job);
      const pwaTabId = sender.tab?.id;
      const onProgress = (progress) => {
        if (!Number.isInteger(pwaTabId)) return;
        runtime.tabs
          .sendMessage(pwaTabId, {
            source: 'drive-price-splitter-extension',
            type: 'DRIVE_ADD_TO_CART_PROGRESS',
            jobId: message.job.jobId,
            progress
          })
          .catch(() => undefined);
      };
      // Reshaped into job-runner's generic {stores, products} pipeline shape
      // — this job only ever targets one store, but the runner is written
      // for a list.
      const runnerJob = { ...message.job, stores: [message.job.store], products: message.job.items };
      addToCartRunner.start(runnerJob, onProgress, { callerTabId: pwaTabId }).then(
        (report) => {
          const response = { accepted: true, extensionVersion: runtime.runtime.getManifest().version, report };
          storeCartReport(runtime.storage.session, message.job.jobId, response, pwaTabId);
          sendResponse(response);
        },
        (error) => {
          const response = {
            accepted: false,
            reason: error instanceof Error ? error.message : "L'ajout au panier n'a pas pu démarrer."
          };
          storeCartReport(runtime.storage.session, message.job.jobId, response, pwaTabId);
          sendResponse(response);
        }
      );
    } catch {
      sendResponse({ accepted: false, reason: 'Tâche ajout panier invalide.' });
      return false;
    }
    return true;
  }

  if (message?.type === 'DRIVE_ADD_TO_CART_CANCEL') {
    sendResponse({ cancelled: addToCartRunner.cancel(message.jobId) });
    return false;
  }

  // Permet à la PWA de retrouver le rapport d'un job d'ajout au panier déjà
  // terminé après avoir perdu le fil (rechargement de page pendant l'attente)
  // — voir le commentaire sur storeCartReport plus haut.
  if (message?.type === 'DRIVE_FETCH_CART_REPORT') {
    (async () => {
      if (!isValidJobId(message.jobId)) {
        sendResponse({ found: false });
        return;
      }
      const key = `${CART_REPORT_KEY_PREFIX}${message.jobId}`;
      const stored = (await runtime.storage.session.get(key))?.[key];
      // Audit sécurité du 30/08 (LOW #9) : un jobId seul ne suffit pas — le
      // rapport n'est renvoyé qu'à l'onglet qui a réellement démarré le job
      // (voir storeCartReport). Réponse identique à "pas trouvé" dans les deux
      // cas pour ne rien révéler à un onglet qui ne devrait pas connaître ce
      // jobId.
      if (
        !stored ||
        Date.now() - stored.storedAt > CART_REPORT_TTL_MS ||
        !Number.isInteger(sender.tab?.id) ||
        sender.tab.id !== stored.callerTabId
      ) {
        sendResponse({ found: false });
        return;
      }
      const { storedAt: _storedAt, callerTabId: _callerTabId, ...response } = stored;
      sendResponse({ found: true, ...response });
    })();
    return true;
  }

  if (message?.type === 'DRIVE_LIVE_PICK_START') {
    try {
      validateDriveLivePickJob(message.job);
      const pwaTabId = sender.tab?.id;
      const onProgress = (progress) => {
        if (!Number.isInteger(pwaTabId)) return;
        runtime.tabs
          .sendMessage(pwaTabId, {
            source: 'drive-price-splitter-extension',
            type: 'DRIVE_LIVE_PICK_PROGRESS',
            jobId: message.job.jobId,
            progress
          })
          .catch(() => undefined);
      };
      // Reshaped into job-runner's generic {stores, products} pipeline shape,
      // same as DRIVE_ADD_TO_CART_START above.
      const runnerJob = { ...message.job, stores: [message.job.store], products: [message.job.product] };
      livePickRunner.start(runnerJob, onProgress, { callerTabId: pwaTabId }).then(
        (report) =>
          sendResponse({
            accepted: true,
            extensionVersion: runtime.runtime.getManifest().version,
            report
          }),
        (error) =>
          sendResponse({
            accepted: false,
            reason: error instanceof Error ? error.message : 'La sélection manuelle n’a pas pu démarrer.'
          })
      );
    } catch {
      sendResponse({ accepted: false, reason: 'Tâche de sélection manuelle invalide.' });
      return false;
    }
    return true;
  }

  if (message?.type === 'DRIVE_LIVE_PICK_CANCEL') {
    sendResponse({ cancelled: livePickRunner.cancel(message.jobId) });
    return false;
  }

  // Import des listes/favoris de compte. Runner distinct des trois ci-dessus
  // (voir list-import-runner.js) : aucune file de magasins, aucun disjoncteur,
  // aucun panier touché — un onglet, une lecture, un résultat.
  if (message?.type === 'DRIVE_IMPORT_LIST_START') {
    try {
      validateDriveListImportJob(message.job);
      const pwaTabId = sender.tab?.id;
      const onProgress = (progress) => {
        if (!Number.isInteger(pwaTabId)) return;
        runtime.tabs
          .sendMessage(pwaTabId, {
            source: 'drive-price-splitter-extension',
            type: 'DRIVE_IMPORT_LIST_PROGRESS',
            jobId: message.job.jobId,
            progress
          })
          .catch(() => undefined);
      };
      listImportRunner.start(message.job, onProgress).then(
        (report) =>
          sendResponse({
            accepted: true,
            extensionVersion: runtime.runtime.getManifest().version,
            report
          }),
        (error) =>
          sendResponse({
            accepted: false,
            reason: error instanceof Error ? error.message : "L'import de liste n'a pas pu démarrer."
          })
      );
    } catch {
      sendResponse({ accepted: false, reason: "Tâche d'import de liste invalide." });
      return false;
    }
    return true;
  }

  if (message?.type === 'DRIVE_IMPORT_LIST_CANCEL') {
    sendResponse({ cancelled: listImportRunner.cancel(message.jobId) });
    return false;
  }

  return false;
}

runtime.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'DRIVE_CONNECTOR_STATUS') {
    sendResponse({
      available: true,
      protocolVersion: 1,
      extensionVersion: runtime.runtime.getManifest().version
    });
    return false;
  }

  // Tout le reste du protocole (démarrage/annulation de collecte, ajout au
  // panier, sélection manuelle, lecture d'un rapport déjà stocké) ne doit
  // jamais être déclenchable par une page qui n'est pas une origine où le
  // bridge a réellement été injecté — sinon n'importe quelle page ouverte
  // dans une origine autorisée pourrait faire agir l'extension avec la
  // session authentifiée réelle de l'utilisateur sur les sites des
  // enseignes. Échec silencieux (pas de sendResponse) : comportement
  // indiscernable d'un type de message inconnu, pour ne rien révéler à
  // l'appelant rejeté.
  if (isAllowedSenderSync(sender)) {
    return dispatchDriveMessage(message, sender, sendResponse);
  }

  // Hors des origines livrées dans le paquet, il reste une possibilité
  // légitime : une adresse que l'utilisateur a lui-même déclarée dans la page
  // d'options pour son installation auto-hébergée. La vérifier suppose de
  // lire le stockage et d'interroger Firefox, donc d'attendre — d'où le
  // `return true`, qui garde le canal de réponse ouvert le temps de trancher.
  // Ce chemin ne concerne que ces installations : celles qui utilisent
  // l'adresse publique passent par la branche synchrone ci-dessus et ne
  // subissent aucune attente.
  //
  // Le canal ouvert doit être refermé dans TOUS les cas, y compris au refus :
  // une promesse laissée en suspens côté page ne remonte aucune erreur, donc
  // l'interface resterait indéfiniment sur « en cours » au lieu d'afficher
  // « Extension Drive indisponible » — la panne la plus difficile à
  // diagnostiquer pour quelqu'un qui héberge l'application lui-même. Une
  // réponse vide ne révèle rien de plus qu'un silence à un appelant rejeté.
  isAllowedSenderCustom(sender)
    .then((allowed) => {
      if (!allowed) {
        sendResponse(undefined);
        return;
      }
      // `dispatchDriveMessage` renvoie `false` sur un type de message inconnu :
      // sa valeur de retour ne sert plus à rien ici (le listener a déjà rendu
      // `true`), c'est donc à nous de refermer le canal.
      if (!dispatchDriveMessage(message, sender, sendResponse)) sendResponse(undefined);
    })
    .catch(() => sendResponse(undefined));
  return true;
});
