// Correspondance magasin -> "ferme" transactionnelle Leclerc (fd4, fd7, ...),
// utilisée uniquement en repli quand la page publique n'expose pas de lien
// vers son catalogue (voir findLeclercTransactionalLinkOnPage dans
// leclerc-collector.js, qui reste le chemin de résolution générique).
//
// L'identifiant de ferme est attribué par Leclerc magasin par magasin : il ne
// peut PAS être déduit de l'identifiant du magasin ni du chemin. Le deviner
// enverrait silencieusement l'extension sur le catalogue — et donc les prix —
// d'un autre magasin. Cette table n'est donc jamais remplie par heuristique :
// elle n'enregistre que des correspondances CONSTATÉES sur une page réelle.
//
// Ces correspondances vivaient auparavant en dur dans ce fichier, renseignées
// à la main pour le magasin de l'auteur. Deux raisons de les avoir sorties
// (02/09/2026) : elles révélaient le magasin — donc la ville — de l'auteur
// dans un dépôt destiné à être publié, et elles ne servaient qu'à lui. Elles
// sont désormais apprises à l'usage et rangées dans le stockage local de
// l'extension, ce qui rend le repli utile à tout le monde et ne fait sortir
// aucune donnée de l'appareil.
//
// Leclerc réattribue ces identifiants avec le temps (constaté le 18/07/2026 :
// un magasin a changé de ferme). Une correspondance apprise est donc
// réécrite dès qu'une page en montre une nouvelle, plutôt que conservée.

const FARM_STORAGE_KEY = 'leclercKnownFarms';
const STORE_PATH_PATTERN = /\/magasin-(\d{6})(?:-[^/?#]*)?\.aspx/i;
const FARM_HOST_PATTERN = /^(fd\d+)-courses\.leclercdrive\.fr$/i;

// `knownFarms` : objet { "123456": "fd7" }. Absent ou vide, la fonction rend
// null — c'est volontaire, mieux vaut échouer avec un code clair
// (LECLERC_FARM_NOT_RESOLVED) que naviguer vers un magasin inconnu.
export function resolveLeclercTransactionalUrl(pathname, knownFarms = {}) {
  const match = String(pathname || '').match(STORE_PATH_PATTERN);
  if (!match) return null;
  const farm = knownFarms?.[match[1]];
  if (!farm || !/^fd\d+$/i.test(farm)) return null;
  return `https://${farm}-courses.leclercdrive.fr${pathname}`;
}

// Extrait la correspondance d'une adresse de catalogue réellement atteinte.
// Les deux morceaux doivent venir de la MÊME adresse : c'est ce qui garantit
// que la ferme observée est bien celle de ce magasin.
export function extractLeclercFarmMapping(url) {
  let parsed = null;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    return null;
  }
  const host = parsed.hostname.match(FARM_HOST_PATTERN);
  if (!host) return null;
  const store = parsed.pathname.match(STORE_PATH_PATTERN);
  if (!store) return null;
  return { storeId: store[1], farm: host[1].toLowerCase() };
}

// `store` est un stockage compatible chrome.storage.local (get/set). Toute
// erreur de lecture rend une table vide : le repli devient simplement
// indisponible, il ne fait jamais échouer la collecte à lui seul.
export async function readKnownLeclercFarms(store) {
  if (!store?.get) return {};
  try {
    const stored = await store.get(FARM_STORAGE_KEY);
    const farms = stored?.[FARM_STORAGE_KEY];
    return farms && typeof farms === 'object' ? farms : {};
  } catch {
    return {};
  }
}

// Rend true seulement si quelque chose a été appris, pour que l'appelant
// puisse le journaliser sans avoir à relire le stockage.
export async function rememberLeclercFarm(store, url) {
  if (!store?.get || !store?.set) return false;
  const mapping = extractLeclercFarmMapping(url);
  if (!mapping) return false;
  const farms = await readKnownLeclercFarms(store);
  if (farms[mapping.storeId] === mapping.farm) return false;
  try {
    await store.set({ [FARM_STORAGE_KEY]: { ...farms, [mapping.storeId]: mapping.farm } });
    return true;
  } catch {
    return false;
  }
}

export const LECLERC_FARM_STORAGE_KEY = FARM_STORAGE_KEY;
