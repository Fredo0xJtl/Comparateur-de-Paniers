// Journalisation verbeuse (noms de produits recherchés, requêtes...)
// désactivée par défaut — audit sécurité du 30/08 (MEDIUM #6). Ces logs
// n'étaient gardés par aucun flag : quiconque ouvre l'inspecteur du service
// worker (about:debugging) voyait en clair la liste de courses de
// l'utilisateur. Flag en mémoire (pas de lecture async dans les points
// d'appel synchrones existants comme debugLog) — chargé une fois depuis
// runtime.storage.local à chaque réveil du service worker (voir
// service-worker.js), donc reste OFF par défaut tant qu'il n'a pas été
// explicitement activé au moins une fois :
// `browser.storage.local.set({ verboseDiagnostics: true })` depuis la
// console de l'inspecteur du service worker, puis réveiller le worker
// (n'importe quel message suffit).
let verboseDiagnosticsEnabled = false;

export function isVerboseDiagnosticsEnabled() {
  return verboseDiagnosticsEnabled;
}

export function setVerboseDiagnosticsEnabled(enabled) {
  verboseDiagnosticsEnabled = enabled === true;
}

export async function loadVerboseDiagnosticsFlag(storageArea) {
  try {
    const stored = await storageArea.get('verboseDiagnostics');
    setVerboseDiagnosticsEnabled(stored?.verboseDiagnostics === true);
  } catch {
    // Best-effort : reste sur la valeur en mémoire actuelle (false par
    // défaut) plutôt que de faire échouer le démarrage du service worker.
  }
}
