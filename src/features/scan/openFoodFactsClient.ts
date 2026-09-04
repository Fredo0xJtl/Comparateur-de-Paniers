import { type ProductBaseUnit } from '../../types/domain';

// Open Food Facts is a free, open, crowdsourced barcode database — no API
// key, no account. Used only as a fallback lookup (name/brand) when a
// scanned barcode isn't already in the local product database; nothing
// about the user is sent, just the barcode itself.
export type OpenFoodFactsProduct = {
  name: string;
  brand?: string;
  // Format annoncé par la fiche OFF (ex. 375 g, 1 L) — voir parseOffQuantity.
  // Absent quand OFF n'a pas cette info ou qu'elle n'a pas pu être comprise ;
  // dans ce cas le produit local reste sans format cible, comme avant.
  baseQuantity?: number;
  baseUnit?: ProductBaseUnit;
};

// Sans plafond, une requête qui reste pendante (réseau mobile qui décroche,
// service qui ne répond plus) laisse le scan bloqué indéfiniment sur son état
// « recherche en cours » — le fallback local n'a alors jamais lieu.
const LOOKUP_TIMEOUT_MS = 8_000;

export async function lookupOpenFoodFactsProduct(barcode: string): Promise<OpenFoodFactsProduct | null> {
  try {
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,product_name_fr,brands,quantity,product_quantity,product_quantity_unit`,
      { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) }
    );
    if (!response.ok) {
      return null;
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || data.status !== 1 || !isRecord(data.product)) {
      return null;
    }
    // `product_name` reflète la langue du contributeur d'origine (peut être
    // n'importe quelle langue — confirmé sur un cas réel : "Orangensaft" en
    // allemand pour un jus Tropicana). `product_name_fr` est la traduction
    // française spécifique, souvent renseignée même quand `product_name` ne
    // l'est pas dans cette langue. La recherche des drives ciblés (Leclerc,
    // Hyper U) n'a aucune chance de matcher un nom non-français — préférer
    // systématiquement le nom français quand il existe et diffère.
    const genericName = typeof data.product.product_name === 'string' ? data.product.product_name.trim() : '';
    const frenchName =
      typeof data.product.product_name_fr === 'string' ? data.product.product_name_fr.trim() : '';
    const name = frenchName || genericName;
    if (!name) {
      return null;
    }
    const rawBrands = typeof data.product.brands === 'string' ? data.product.brands : '';
    const brand = pickBestBrand(rawBrands, name);
    const format = parseOffQuantity(data.product);
    return {
      name,
      ...(brand ? { brand } : {}),
      ...(format ? format : {})
    };
  } catch {
    return null;
  }
}

// Résultat d'une recherche par nom : même contenu qu'une fiche scannée, plus
// le code-barres — c'est justement lui qu'on vient chercher. Sans code-barres,
// un produit ajouté par son nom ne peut jamais obtenir de correspondance
// certaine en magasin (voir classifyMatchType dans driveRefreshService) et
// reste indéfiniment en « correspondance probable » à valider à la main.
export type OpenFoodFactsSuggestion = OpenFoodFactsProduct & { barcode: string };

// La recherche par mots-clés passe par /cgi/search.pl, et NON par le service
// search.openfoodfacts.org (Search-a-licious) qu'Open Food Facts présente
// pourtant comme son remplaçant. Raison vérifiée le 03/09 : ce dernier ne
// renvoie aucun en-tête Access-Control-Allow-Origin, donc le navigateur
// refuse sa réponse (« blocked by CORS policy ») — il n'est utilisable qu'en
// dehors d'une page web. /cgi/search.pl répond au contraire avec
// `Access-Control-Allow-Origin: *`, en 0,4 à 0,9 s, et donne de bien
// meilleurs résultats français sur les mêmes mots (« beurre demi-sel » :
// Grand Fermage, Elle et Vire, Paysan Breton, Président — là où l'autre
// remontait des produits suisses et polonais).
//
// Deux limites assumées : ce point d'accès est annoncé comme déprécié et
// répond parfois 503 (constaté à l'essai) — l'échec rend simplement une
// liste vide, l'utilisateur gardant le chemin « chercher en magasin ». Et
// aucun filtre par pays n'est appliqué : celui de l'API a répondu 503 une
// fois sur deux, alors que les résultats non filtrés sont déjà pertinents.
const SEARCH_TIMEOUT_MS = 8_000;
const SEARCH_RESULT_LIMIT = 6;

// En dessous de trois lettres, la recherche ne rend que du bruit : autant ne
// pas envoyer la saisie sur le réseau du tout.
const SEARCH_MIN_QUERY_LENGTH = 3;

const BARCODE_PATTERN = /^\d{8,14}$/;

export async function searchOpenFoodFactsProducts(query: string): Promise<OpenFoodFactsSuggestion[]> {
  const terms = query.trim();
  if (terms.length < SEARCH_MIN_QUERY_LENGTH) {
    return [];
  }
  try {
    const url = new URL('https://world.openfoodfacts.org/cgi/search.pl');
    url.searchParams.set('search_terms', terms);
    url.searchParams.set('search_simple', '1');
    url.searchParams.set('json', '1');
    url.searchParams.set('page_size', String(SEARCH_RESULT_LIMIT));
    url.searchParams.set(
      'fields',
      'code,product_name,product_name_fr,brands,quantity,product_quantity,product_quantity_unit'
    );
    const response = await fetch(url, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!response.ok) {
      return [];
    }
    const data: unknown = await response.json();
    if (!isRecord(data) || !Array.isArray(data.products)) {
      return [];
    }
    return data.products.flatMap((hit) => {
      const suggestion = toSuggestion(hit);
      return suggestion ? [suggestion] : [];
    });
  } catch {
    return [];
  }
}

function toSuggestion(hit: unknown): OpenFoodFactsSuggestion | null {
  if (!isRecord(hit)) {
    return null;
  }
  // Un résultat sans code-barres exploitable n'apporte rien de plus que les
  // mots déjà tapés : tout l'intérêt de cette recherche est le code-barres.
  const barcode = typeof hit.code === 'string' ? hit.code.trim() : '';
  if (!BARCODE_PATTERN.test(barcode)) {
    return null;
  }
  const genericName = typeof hit.product_name === 'string' ? hit.product_name.trim() : '';
  const frenchName = typeof hit.product_name_fr === 'string' ? hit.product_name_fr.trim() : '';
  const name = frenchName || genericName;
  if (!name) {
    return null;
  }
  const brand = pickBestBrand(joinBrands(hit.brands), name);
  const format = parseOffQuantity(hit);
  return {
    barcode,
    name,
    ...(brand ? { brand } : {}),
    ...(format ? format : {})
  };
}

// `brands` arrive comme une chaîne ("Nestlé, La Laitière") sur ce point
// d'accès, mais comme un tableau (["Cora"]) sur search.openfoodfacts.org —
// divergence vérifiée le 03/09. Les deux formes sont ramenées à celle
// qu'attend pickBestBrand, pour que la marque survive à un éventuel
// changement de point d'accès.
function joinBrands(rawBrands: unknown): string {
  if (typeof rawBrands === 'string') {
    return rawBrands;
  }
  if (Array.isArray(rawBrands)) {
    return rawBrands.filter((entry): entry is string => typeof entry === 'string').join(', ');
  }
  return '';
}

// `brands` liste souvent plusieurs noms séparés par des virgules, du plus
// générique (le groupe/holding) au plus spécifique (la marque réellement
// imprimée sur l'emballage et affichée en rayon) — vérifié empiriquement sur
// l'API OFF le 01/09 : "Nestlé, La Laitière", "Danone, Centrale, Jebli"...
// Prendre systématiquement le premier élément (ancien comportement) donnait
// donc souvent le groupe, pas la marque utile pour chercher chez Leclerc/
// Hyper U — aucun des deux sites n'affiche jamais "Nestlé" sur une fiche La
// Laitière. Cas réel confirmé (diagnostic 01/09) : "Le Petit Pot de Crème au
// Chocolat" cherché comme "Nestlé" chez Leclerc → échec total, alors que
// Hyper U l'identifie sans ambiguïté comme "LA LAITIERE".
function pickBestBrand(rawBrands: string, productName: string): string | undefined {
  const candidates = rawBrands
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (candidates.length === 0) return undefined;

  // Preuve la plus forte : une des marques déclarées apparaît telle quelle
  // dans le nom du produit (ex. "Jebli" dans brands ET dans le nom) — c'est
  // alors très probablement celle imprimée sur l'emballage. Comparaison
  // insensible à la casse et aux accents (le nom OFF est saisi à la main,
  // pas toujours accentué correctement).
  const normalizedName = foldDiacritics(productName);
  const nameMatch = candidates.find((candidate) => normalizedName.includes(foldDiacritics(candidate)));
  if (nameMatch) return nameMatch;

  // Aucune marque de la liste ne se retrouve dans le nom (cas "Petit Pot de
  // Crème" : ni "Nestlé" ni "La Laitière" n'y figurent) : on retient la
  // dernière, la plus spécifique selon la convention OFF observée ci-dessus.
  return candidates[candidates.length - 1];
}

const DIACRITIC_MARKS_PATTERN = new RegExp('[̀-ͯ]', 'g');

function foldDiacritics(value: string): string {
  return value.toLocaleLowerCase('fr').normalize('NFD').replace(DIACRITIC_MARKS_PATTERN, '');
}

// Format cible (quantity/unit) transmis ensuite jusqu'aux collecteurs pour
// qu'ils privilégient le même conditionnement chez Leclerc et Hyper U (voir
// productService.createProduct et driveRefreshService.toDriveJobProduct) —
// sans ça, deux "meilleurs candidats" par magasin peuvent chacun bien
// correspondre au nom du produit sans jamais correspondre entre eux (cas
// réel 31/08 : Purée Mousline 375 g chez Leclerc vs 1040 g chez Hyper U).
function parseOffQuantity(product: Record<string, unknown>): { baseQuantity: number; baseUnit: ProductBaseUnit } | null {
  // `product_quantity`/`product_quantity_unit` sont la forme normalisée
  // qu'OFF calcule lui-même à partir du texte libre `quantity` — à préférer
  // quand présente. Vu sur le terrain : déjà exprimée en g/ml (pas kg/L).
  const normalizedQuantity = product.product_quantity;
  const normalizedUnit = product.product_quantity_unit;
  if (
    typeof normalizedQuantity === 'number' &&
    Number.isFinite(normalizedQuantity) &&
    normalizedQuantity > 0 &&
    typeof normalizedUnit === 'string'
  ) {
    const normalized = normalizeOffUnit(normalizedUnit);
    if (normalized) {
      return { baseQuantity: normalizedQuantity * normalized.scale, baseUnit: normalized.unit };
    }
  }

  const freeText = typeof product.quantity === 'string' ? product.quantity : '';
  return parseQuantityText(freeText);
}

// Normalise TOUJOURS vers l'unité "petite" (g pour le poids, ml pour le
// volume) — jamais kg/L — pour que deux formats extraits séparément (ici et
// dans extension/shared/quantity-parser.js) se comparent par une simple
// soustraction numérique en aval, sans reconversion d'unité à chaque usage.
function normalizeOffUnit(rawUnit: string): { unit: ProductBaseUnit; scale: number } | null {
  const unit = rawUnit.trim().toLowerCase();
  if (unit === 'g') return { unit: 'g', scale: 1 };
  if (unit === 'kg') return { unit: 'g', scale: 1000 };
  if (unit === 'ml') return { unit: 'ml', scale: 1 };
  if (unit === 'l') return { unit: 'ml', scale: 1000 };
  if (unit === 'cl') return { unit: 'ml', scale: 10 };
  return null;
}

// Repli quand OFF n'a que le texte libre ("375 g", "6 x 1.5 L", "1kg"...).
// Volontairement limité aux unités de poids/volume comparables entre
// magasins — un format comme "4 personnes" ne dit rien du grammage réel et
// est ignoré plutôt que de produire un faux repère.
const QUANTITY_MULTIPLIER_PATTERN = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/i;

// Même multiplication écrite en toutes lettres ("6 briques de 1L") : le
// champ `quantity` d'Open Food Facts est saisi à la main et n'est pas
// toujours normalisé. Doit rester le miroir exact de
// extension/shared/quantity-parser.js : les deux formats sont confrontés
// l'un à l'autre par quantitiesMatch pour trier les candidats par format
// cible, donc une divergence entre les deux parseurs ferait silencieusement
// passer le bon format pour un format différent.
const PACK_CONTAINERS =
  'briques?|bouteilles?|pots?|bo[iî]tes?|sachets?|packs?|canettes?|barquettes?|tubes?|flacons?|berlingots?|paquets?|bidons?|conserves?';
const QUANTITY_PACK_PATTERN = new RegExp(
  `(\\d+)\\s*(?:${PACK_CONTAINERS})\\s*(?:de|d')\\s*(\\d+(?:[.,]\\d+)?)\\s*(kg|g|cl|ml|l)\\b`,
  'i'
);

const QUANTITY_SIMPLE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/i;

function parseQuantityText(text: string): { baseQuantity: number; baseUnit: ProductBaseUnit } | null {
  if (!text) return null;
  const normalized = text.toLowerCase();

  const multiplierMatch = normalized.match(QUANTITY_MULTIPLIER_PATTERN);
  if (multiplierMatch) {
    const count = Number.parseInt(multiplierMatch[1], 10);
    const unitQuantity = Number.parseFloat(multiplierMatch[2].replace(',', '.'));
    const mapped = normalizeOffUnit(multiplierMatch[3]);
    if (mapped && Number.isFinite(count) && Number.isFinite(unitQuantity)) {
      return { baseQuantity: count * unitQuantity * mapped.scale, baseUnit: mapped.unit };
    }
  }

  const packMatch = normalized.match(QUANTITY_PACK_PATTERN);
  if (packMatch) {
    const count = Number.parseInt(packMatch[1], 10);
    const unitQuantity = Number.parseFloat(packMatch[2].replace(',', '.'));
    const mapped = normalizeOffUnit(packMatch[3]);
    if (mapped && Number.isFinite(count) && count > 0 && Number.isFinite(unitQuantity)) {
      return { baseQuantity: count * unitQuantity * mapped.scale, baseUnit: mapped.unit };
    }
  }

  const simpleMatch = normalized.match(QUANTITY_SIMPLE_PATTERN);
  if (simpleMatch) {
    const quantity = Number.parseFloat(simpleMatch[1].replace(',', '.'));
    const mapped = normalizeOffUnit(simpleMatch[2]);
    if (mapped && Number.isFinite(quantity)) {
      return { baseQuantity: quantity * mapped.scale, baseUnit: mapped.unit };
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
