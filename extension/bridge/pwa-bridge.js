const BRIDGE_SOURCE = 'drive-price-splitter-pwa';
const EXTENSION_SOURCE = 'drive-price-splitter-extension';
const runtime = globalThis.browser ?? globalThis.chrome;

// Ce fichier est déclaré dans manifest.json content_scripts.js — chargé
// comme un script classique (les content scripts ne supportent pas
// `"type": "module"`), donc pas d'import ES ici : le même flag que
// extension/shared/verbose-diagnostics.js (clé 'verboseDiagnostics' dans
// runtime.storage.local) est relu indépendamment, en mémoire locale à ce
// fichier. Chargé en parallèle du reste (best-effort) — tant qu'il n'a pas
// résolu, le badge reste masqué (défaut sûr) plutôt que de s'afficher par
// erreur.
let verboseDiagnosticsEnabled = false;
runtime.storage.local
  .get('verboseDiagnostics')
  .then((stored) => {
    verboseDiagnosticsEnabled = stored?.verboseDiagnostics === true;
  })
  .catch(() => undefined);

// Manifest content_script match patterns can't be scoped to a port, so on
// localhost/127.0.0.1 this script gets injected into ANY page the user
// happens to be running there (any other dev server on the machine), not
// just the real PWA. origin/source checks alone don't help since they'd
// match too. Bail out before wiring the relay at all if this isn't actually
// our app.
//
// run_at is document_start, which fires before the parser has even reached
// <head> — checking for the marker <meta> synchronously here always found
// nothing and disabled the relay unconditionally, even on the real PWA
// (broke Drive refresh entirely: "Extension Drive indisponible"). Wait for
// the document to actually finish parsing before checking.
//
// En développement, web-ext (mode watch) réinjecte le content script dans un
// onglet déjà ouvert à chaque rebuild, sans recharger la page — ce script
// s'exécute donc plusieurs fois sur le même document. Sans ce garde, chaque
// exécution ajoute son propre listener 'message' sur `window`, et un seul
// clic sur "Actualiser les prix Drive" fait alors partir N requêtes
// identiques vers l'extension (observé : un rafraîchissement Leclerc
// répétant 3 fois d'affilée le même lot de produits). Le marqueur vit sur
// `window`, qui elle survit à une réinjection tant que la page n'est pas
// rechargée.
const ALREADY_WIRED_FLAG = '__drivePriceSplitterBridgeWired';

// Diagnostic visuel de la chaîne bridge (page ↔ content-script ↔
// background), ajouté à l'origine faute d'accès pratique à la console
// distante sur le téléphone de test. Désactivé par défaut depuis l'audit
// sécurité du 30/08 (LOW #8) : affiché sans garde sur CHAQUE chargement de
// la PWA, il exposait en permanence des détails internes (origin, état du
// pont) à l'écran. Reste disponible temporairement en cas de nouveau souci
// de connexion extension↔PWA : activer verboseDiagnostics (voir
// extension/shared/verbose-diagnostics.js) puis recharger la page.
function showDebugBadge(text, isError = false) {
  const existing = document.getElementById('drive-price-splitter-debug-badge');
  if (!verboseDiagnosticsEnabled) {
    existing?.remove();
    return;
  }
  let badge = existing;
  if (!badge) {
    if (!document.documentElement) return;
    badge = document.createElement('div');
    badge.id = 'drive-price-splitter-debug-badge';
    badge.style.cssText =
      'position:fixed;top:4px;left:4px;z-index:2147483647;padding:4px 8px;' +
      'font:11px monospace;border-radius:4px;color:#fff;max-width:92vw;word-break:break-word;';
    document.documentElement.appendChild(badge);
  }
  badge.textContent = text;
  badge.style.background = isError ? '#b3261e' : '#0a7d32';
}

function wireBridgeIfOwnApp() {
  const isOwnApp = Boolean(document.querySelector('meta[name="drive-price-splitter-app"]'));
  showDebugBadge(
    isOwnApp
      ? `DPS: content injecté | meta OK | origin=${window.location.origin}`
      : `DPS: content injecté | meta ABSENTE | origin=${window.location.origin}`,
    !isOwnApp
  );
  if (window[ALREADY_WIRED_FLAG]) return;
  if (!isOwnApp) return;
  window[ALREADY_WIRED_FLAG] = true;

  window.addEventListener('message', (event) => {
    // ⚠️ Traçage temporaire (même diagnostic que showDebugBadge plus haut) :
    // affiche pourquoi un message venant de la page est rejeté, pour savoir
    // si la panne est ici (page → content-script) plutôt que dans la moitié
    // déjà confirmée OK (content-script → background, voir le self-test
    // au-dessus).
    if (event.data?.type === 'DRIVE_CONNECTOR_STATUS' && event.data?.source !== EXTENSION_SOURCE) {
      showDebugBadge(
        `DPS: ping page reçu | sameWin=${event.source === window} sameOrigin=${event.origin === window.location.origin} ` +
          `origin=${event.origin} src=${event.data?.source} nonceOk=${isNonce(event.data?.nonce)}`
      );
    }
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== BRIDGE_SOURCE || !isNonce(event.data?.nonce)) return;
    if (JSON.stringify(event.data).length > 250_000) return;

    const allowedTypes = new Set([
      'DRIVE_CONNECTOR_STATUS',
      'DRIVE_REFRESH_START',
      'DRIVE_REFRESH_CANCEL',
      'DRIVE_ADD_TO_CART_START',
      'DRIVE_ADD_TO_CART_CANCEL',
      'DRIVE_FETCH_CART_REPORT',
      'DRIVE_LIVE_PICK_START',
      'DRIVE_LIVE_PICK_CANCEL',
      'DRIVE_IMPORT_LIST_START',
      'DRIVE_IMPORT_LIST_CANCEL'
    ]);
    if (!allowedTypes.has(event.data.type)) return;

    sendRuntimeMessageToBackground({ type: event.data.type, job: event.data.job, jobId: event.data.jobId }, (response, error) => {
      if (error) {
        showDebugBadge(`DPS: background KO | ${error.message}`, true);
      } else if (event.data.type === 'DRIVE_CONNECTOR_STATUS') {
        showDebugBadge(
          response?.available
            ? `DPS: page→background OK | v${response.extensionVersion ?? '?'} | proto=${response.protocolVersion ?? '?'}`
            : 'DPS: page→background réponse invalide',
          !response?.available
        );
      }
      window.postMessage(
        {
          source: EXTENSION_SOURCE,
          type: `${event.data.type}_RESULT`,
          nonce: event.data.nonce,
          response
        },
        window.location.origin
      );
    });
  });

  // Unsolicited pushes from the background script (progress updates during a
  // running collection, not a reply to a specific request) — relay them
  // straight to the page. No nonce here since there's no matching request to
  // tie it back to; the page correlates by jobId instead.
  const relayedProgressTypes = new Set([
    'DRIVE_REFRESH_PROGRESS',
    'DRIVE_ADD_TO_CART_PROGRESS',
    'DRIVE_LIVE_PICK_PROGRESS',
    'DRIVE_IMPORT_LIST_PROGRESS'
  ]);
  runtime.runtime.onMessage.addListener((message) => {
    if (message?.source !== EXTENSION_SOURCE || !relayedProgressTypes.has(message?.type)) return;
    window.postMessage(
      { source: EXTENSION_SOURCE, type: message.type, jobId: message.jobId, progress: message.progress },
      window.location.origin
    );
  });

  // Auto-test diagnostic (même canal que la vraie chaîne, mais parle
  // directement à runtime.sendMessage sans repasser par window.postMessage
  // — permet de savoir si la panne est content-script↔background ou
  // page↔content-script).
  showDebugBadge('DPS: relié, ping extension...');
  try {
    sendRuntimeMessageToBackground({ type: 'DRIVE_CONNECTOR_STATUS' }, (response, error) => {
      if (error) {
        showDebugBadge(`DPS: erreur sendMessage | ${error.message}`, true);
        return;
      }
      if (response?.available) {
        showDebugBadge(`DPS: OK v${response.extensionVersion} | proto=${response.protocolVersion ?? '?'}`);
      } else {
        showDebugBadge('DPS: réponse invalide de l’extension', true);
      }
    });
  } catch (error) {
    showDebugBadge(`DPS: sendMessage a levé — ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

function isNonce(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9-]{12,128}$/.test(value);
}

function sendRuntimeMessageToBackground(message, onSettled) {
  const api = runtime.runtime;
  if (globalThis.browser?.runtime?.sendMessage) {
    api
      .sendMessage(message)
      .then((response) => onSettled(response, null))
      .catch((error) => onSettled(undefined, normalizeError(error)));
    return;
  }

  api.sendMessage(message, (response) => {
    const lastError = api.lastError;
    onSettled(response, lastError ? normalizeError(lastError.message ?? lastError) : null);
  });
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireBridgeIfOwnApp, { once: true });
} else {
  wireBridgeIfOwnApp();
}
