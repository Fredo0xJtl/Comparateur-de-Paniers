// Liste blanche d'origines EXACTES (numéro de port compris) autorisées à
// piloter CE paquet. Réécrite à la construction par
// tools/build-firefox-extension.mjs ; vide dans les sources, auquel cas le
// service worker retombe sur les `content_scripts.matches` du manifest actif
// (comportement historique).
//
// Pourquoi ce fichier existe plutôt qu'un port dans le manifest : un match
// pattern WebExtension NE PEUT PAS contenir de numéro de port. Firefox refuse
// un motif du genre "http://localhost:5174/*" (bugs Mozilla 1362809 et
// 1468162), rejette l'entrée content_scripts correspondante, et le bridge
// (extension/bridge/pwa-bridge.js) n'est alors JAMAIS injecté : la PWA
// affiche "Extension Drive indisponible" alors que l'extension est bien
// installée. C'est exactement la régression du 01/09 introduite avec
// --dev-port. La restriction au port exact appartient donc à l'exécution —
// ici — et jamais au manifest.
export const BRIDGE_ORIGIN_PATTERNS = [];
