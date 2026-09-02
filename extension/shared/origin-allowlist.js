// Dérive une liste blanche d'origines autorisées à partir des `matches` de
// `content_scripts` du manifest actif, pour vérifier qu'un message reçu par
// le service worker vient bien d'une page où le bridge a réellement été
// injecté — pas d'une page qui se contente d'imiter la balise <meta>
// attendue par extension/bridge/pwa-bridge.js.
//
// Audit sécurité du 30/08 : sans ce contrôle, n'importe quelle page
// correspondant à une origine de content_scripts.matches — y compris les
// origines de dev (localhost, boucle locale, IP LAN) conservées par un
// build `--dev` — pouvait envoyer DRIVE_ADD_TO_CART_START /
// DRIVE_REFRESH_START au service worker et lui faire exécuter des scripts
// sur les sites des enseignes AVEC la session authentifiée réelle de
// l'utilisateur. Dérivé du manifest lui-même (jamais une liste dupliquée à
// la main) : ne peut donc jamais diverger de ce qui est réellement injecté
// par le build actif.

function parseMatchPatternHost(pattern) {
  const match = /^(\*|https?):\/\/([^/]+)(?:\/.*)?$/.exec(String(pattern || ''));
  if (!match) return null;
  const [, scheme, hostPart] = match;
  const matchSubdomains = hostPart.startsWith('*.');
  const normalizedHostPart = matchSubdomains ? hostPart.slice(2) : hostPart;
  const portMatch = /^(.+):(\d+)$/.exec(normalizedHostPart);
  const host = (portMatch ? portMatch[1] : normalizedHostPart).toLowerCase();
  const port = portMatch?.[2] ?? null;
  return { scheme, host, matchSubdomains, port };
}

// Le port n'est comparé que lorsque le motif en porte un, ce qui n'arrive
// JAMAIS pour un motif venu du manifest : un match pattern WebExtension
// n'accepte aucun numéro de port et Firefox rejette ceux qui en ont (bugs
// Mozilla 1362809 / 1468162), au point de ne plus injecter le bridge du
// tout — cause exacte du "Extension Drive indisponible" du 01/09. Les
// motifs à port viennent uniquement de la liste construite
// (extension/shared/bridge-origins.js), appliquée à l'exécution, qui sépare
// un paquet --dev-port=5174 d'un paquet --dev-port=4174.
export function originMatchesPattern(origin, pattern) {
  let originUrl;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const parsed = parseMatchPatternHost(pattern);
  if (!parsed) return false;
  if (parsed.scheme !== '*' && originUrl.protocol !== `${parsed.scheme}:`) return false;
  if (parsed.port && originUrl.port !== parsed.port) return false;
  const hostname = originUrl.hostname.toLowerCase();
  if (parsed.matchSubdomains) {
    return hostname === parsed.host || hostname.endsWith(`.${parsed.host}`);
  }
  return hostname === parsed.host;
}

export function isAllowedOrigin(origin, matchPatterns) {
  if (!origin) return false;
  return (matchPatterns ?? []).some((pattern) => originMatchesPattern(origin, pattern));
}
