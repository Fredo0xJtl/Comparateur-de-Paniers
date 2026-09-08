// Adresses supplémentaires autorisées par l'utilisateur lui-même, depuis la
// page d'options de l'extension.
//
// POURQUOI CE FICHIER EXISTE
//
// Le paquet publié n'injecte le pont (extension/bridge/pwa-bridge.js) que sur
// l'adresse publique du Comparateur de Paniers, inscrite en dur dans
// `content_scripts.matches`. C'est le cas de la quasi-totalité des
// utilisateurs : ils installent l'extension, ouvrent le site public, tout
// fonctionne sans aucun réglage réseau.
//
// Reste ceux qui hébergent l'application eux-mêmes — sur leur ordinateur, un
// NAS, un Raspberry Pi ou leur propre nom de domaine. Leur adresse ne peut
// par définition pas figurer dans un paquet distribué : elle n'existe que
// chez eux, et y inscrire des adresses locales génériques
// (`localhost`, une IP privée, un nom `.local`) reviendrait à autoriser
// n'importe quelle page de la machine ou du réseau de N'IMPORTE QUEL
// utilisateur à piloter l'extension — c'est précisément ce que
// DEV_ORIGIN_PATTERN (tools/validate-extension.mjs) interdit depuis
// l'audit du 05/09.
//
// La seule voie correcte est donc que chaque utilisateur déclare SON adresse,
// et que Firefox lui demande son accord explicite pour celle-là uniquement
// (`permissions.request`, déclaré en `optional_host_permissions`). Le pont
// est ensuite enregistré à l'exécution sur cette adresse
// (`scripting.registerContentScripts`), et le service worker vérifie une
// seconde fois l'origine avant d'accepter le moindre message.
//
// DEUX MOTIFS DIFFÉRENTS POUR UNE MÊME ADRESSE
//
// Un match pattern WebExtension NE PEUT PAS contenir de numéro de port :
// Firefox rejette « https://mon-nas.local:8443/* » (bugs Mozilla 1362809 /
// 1468162) et cesse alors d'injecter le script — panne déjà vécue le 01/09,
// invisible autrement qu'en « Extension Drive indisponible ». On produit donc
// deux motifs :
//   - `hostPattern`    : sans port, pour Firefox (permission + injection) ;
//   - `runtimePattern` : avec le port s'il a été saisi, pour la vérification
//                        d'origine du service worker, qui, elle, sait
//                        comparer un port (voir shared/origin-allowlist.js).

export const CUSTOM_ORIGINS_STORAGE_KEY = 'customBridgeOrigins';

// Limite volontairement basse : ce réglage sert à déclarer SON installation,
// pas à constituer une liste. Une liste blanche courte reste vérifiable d'un
// coup d'œil dans la page d'options.
export const MAX_CUSTOM_ORIGINS = 5;

// `http://` n'est accepté que sur la boucle locale. Ailleurs, la page serait
// transmise en clair sur le réseau : n'importe qui capable de s'interposer
// (Wi-Fi partagé, DNS ou ARP détourné sur un réseau local) pourrait alors se
// faire passer pour l'application et piloter l'extension dans la session
// authentifiée de l'utilisateur sur les sites des enseignes. Le pont est
// exactement la capacité qu'il ne faut pas offrir à une origine non
// authentifiée.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname ?? '').toLowerCase());
}

// Forme admise pour un nom de serveur : des étiquettes alphanumériques
// séparées par des points, tirets autorisés à l'intérieur seulement. Couvre
// les noms de domaine, les noms locaux (`mon-nas.local`), les IPv4 et les
// domaines internationaux (déjà convertis en punycode `xn--...` par l'analyse
// de l'URL).
//
// Audit sécurité du 08/09 : ce contrôle porte sur le nom d'hôte APRÈS analyse
// de l'adresse, et c'est essentiel. Un refus appliqué au texte saisi se
// contourne par encodage — `%2A` est l'écriture encodée de `*`, que l'analyse
// d'URL décode ensuite dans le nom d'hôte. `https://%2A.com` produisait ainsi
// le motif `https://*.com/*`, et Firefox demandait à l'utilisateur une
// autorisation sur la totalité des sites en .com. L'entrée n'était jamais
// enregistrée (sanitizeStoredOrigins la rejetait), mais l'autorisation, elle,
// restait accordée sans plus aucun moyen de la retirer depuis l'extension.
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Transforme ce que l'utilisateur a tapé en une entrée exploitable, ou
 * explique en français pourquoi c'est refusé.
 *
 * Tolérant sur la forme (une adresse collée depuis la barre du navigateur
 * porte un chemin, parfois pas de schéma), strict sur le fond : seuls le
 * schéma et l'hôte sont retenus, tout le reste est ignoré.
 *
 * @returns {{ok: true, entry: {origin: string, hostPattern: string, runtimePattern: string}}
 *          | {ok: false, error: string}}
 */
export function normalizeCustomOrigin(input) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return { ok: false, error: 'Indiquez l’adresse de votre Comparateur de Paniers.' };
  }
  if (raw.includes('*')) {
    return {
      ok: false,
      error: 'Les caractères « * » ne sont pas acceptés : indiquez l’adresse exacte de votre installation.'
    };
  }

  // Sans schéma, on suppose https:// — le cas courant, et le seul qui soit sûr
  // en dehors de la boucle locale.
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, error: 'Adresse illisible. Exemple attendu : https://mon-serveur.local:8443' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Seules les adresses commençant par https:// (ou http:// en local) sont acceptées.' };
  }
  if (!url.hostname) {
    return { ok: false, error: 'Adresse sans nom de serveur.' };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'Retirez l’identifiant et le mot de passe de l’adresse.' };
  }
  // Adresse IPv6 littérale : Firefox n'accepte pas les crochets dans une
  // demande d'autorisation, la demande échouerait sans explication.
  if (url.hostname.startsWith('[')) {
    return {
      ok: false,
      error: 'Les adresses IPv6 ne sont pas acceptées ici : utilisez localhost, 127.0.0.1 ou un nom de serveur.'
    };
  }
  if (!HOSTNAME_PATTERN.test(url.hostname.toLowerCase())) {
    return {
      ok: false,
      error: 'Nom de serveur invalide : seules les lettres, les chiffres, les tirets et les points sont acceptés.'
    };
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      error:
        'Une adresse en http:// n’est acceptée que sur cet ordinateur (localhost). ' +
        'Ailleurs, la page circule en clair et pourrait être imitée : utilisez https://.'
    };
  }

  const host = url.hostname.toLowerCase();
  const port = url.port;
  const origin = port ? `${url.protocol}//${host}:${port}` : `${url.protocol}//${host}`;
  // Port toujours explicite dans le motif d'exécution, y compris quand
  // l'utilisateur n'en a pas saisi : sans lui, `originMatchesPattern` ne
  // comparait aucun port et l'autorisation couvrait TOUT ce qui écoute sur ce
  // serveur. Un `https://mon-nas.local` déclaré ouvrait le pont à
  // `https://mon-nas.local:9443` — typiquement une autre application hébergée
  // sur la même machine, exactement le risque que la restriction d'origine
  // existe pour écarter.
  const effectivePort = port || (url.protocol === 'https:' ? '443' : '80');
  return {
    ok: true,
    entry: {
      origin,
      // Sans port : c'est ce que Firefox accepte (voir l'entête du fichier).
      hostPattern: `${url.protocol}//${host}/*`,
      // Avec le port exact : le service worker, lui, sait le comparer, et
      // restreint donc l'accès à la seule adresse réellement déclarée.
      runtimePattern: `${url.protocol}//${host}:${effectivePort}/*`
    }
  };
}

/**
 * Ajoute une entrée à la liste, sans doublon et sans dépasser la limite.
 * Fonction pure : le stockage est fait par l'appelant.
 */
export function addCustomOrigin(entries, entry) {
  const current = Array.isArray(entries) ? entries : [];
  if (current.some((item) => item?.origin === entry.origin)) {
    return { ok: false, error: 'Cette adresse est déjà autorisée.', entries: current };
  }
  if (current.length >= MAX_CUSTOM_ORIGINS) {
    return {
      ok: false,
      error: `Maximum ${MAX_CUSTOM_ORIGINS} adresses. Retirez-en une avant d’en ajouter une autre.`,
      entries: current
    };
  }
  return { ok: true, entries: [...current, entry] };
}

export function removeCustomOrigin(entries, origin) {
  return (Array.isArray(entries) ? entries : []).filter((item) => item?.origin !== origin);
}

// Une entrée relue du stockage peut dater d'une version antérieure, avoir été
// tronquée, ou avoir été écrite par autre chose que cette page : on ne garde
// que ce qui est complet et cohérent, plutôt que de faire confiance à la
// forme stockée.
export function sanitizeStoredOrigins(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (!item || typeof item.origin !== 'string') continue;
    const normalized = normalizeCustomOrigin(item.origin);
    if (!normalized.ok) continue;
    if (seen.has(normalized.entry.origin)) continue;
    seen.add(normalized.entry.origin);
    result.push(normalized.entry);
    if (result.length >= MAX_CUSTOM_ORIGINS) break;
  }
  return result;
}

export function toHostPatterns(entries) {
  return [...new Set(sanitizeStoredOrigins(entries).map((entry) => entry.hostPattern))];
}

export function toRuntimePatterns(entries) {
  return [...new Set(sanitizeStoredOrigins(entries).map((entry) => entry.runtimePattern))];
}

export async function readCustomOrigins(storageArea) {
  try {
    const stored = await storageArea.get(CUSTOM_ORIGINS_STORAGE_KEY);
    return sanitizeStoredOrigins(stored?.[CUSTOM_ORIGINS_STORAGE_KEY]);
  } catch {
    // Stockage indisponible : on retombe sur « aucune adresse
    // supplémentaire », jamais sur « tout autoriser ».
    return [];
  }
}

export async function writeCustomOrigins(storageArea, entries) {
  await storageArea.set({ [CUSTOM_ORIGINS_STORAGE_KEY]: sanitizeStoredOrigins(entries) });
}
