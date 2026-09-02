// Journalisation verbeuse (URLs Drive personnelles, listes de produits...)
// désactivée par défaut — audit sécurité du 30/08 (MEDIUM #6). Ces logs
// n'étaient gardés par aucun flag : n'importe qui ouvrant la console du
// navigateur voyait en clair les URLs Drive de l'utilisateur et les produits
// recherchés. Jamais exposé dans l'UI ni persisté par défaut : activation
// explicite et temporaire uniquement, depuis la console —
// `localStorage.setItem('driveVerboseDiagnostics', '1')` puis recharger la
// page ; `localStorage.removeItem('driveVerboseDiagnostics')` pour désactiver.
const STORAGE_KEY = 'driveVerboseDiagnostics';

export function isVerboseDiagnosticsEnabled(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
