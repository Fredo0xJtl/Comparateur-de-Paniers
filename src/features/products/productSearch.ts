import type { Product } from '../../types/domain';

export type ProductSearchResult = {
  product: Product;
  score: number;
};

// Recherche par nom dans la base locale — 100 % hors ligne, par construction :
// elle ne lit que la table Dexie déjà présente sur l'appareil. Aucun mot tapé
// ne quitte le téléphone (tools/privacy-check.mjs n'autorise la sortie que du
// code-barres scanné, vers Open Food Facts). C'est le premier des trois
// chemins d'ajout de la page Scan : base locale → catalogue du magasin
// (sélection en direct) → scan.
//
// Règle de correspondance retenue : chaque mot tapé doit OUVRIR un mot du
// produit (nom, marque, variante, catégorie). Volontairement du « commence
// par » et non du « contient n'importe où » : « lai » doit trouver « Lait
// demi-écrémé », mais « ait » ne doit rien trouver, sinon trois lettres
// ramènent la moitié de la base sur un écran de téléphone. Les mots peuvent
// être tapés dans n'importe quel ordre et sans accents (« demi sel beur »
// trouve « Beurre demi-sel »), parce que personne ne retape le libellé exact
// d'un produit qu'il a lui-même enregistré des semaines plus tôt.
const DEFAULT_LIMIT = 8;

export function searchProducts(
  products: Product[],
  query: string,
  limit: number = DEFAULT_LIMIT
): ProductSearchResult[] {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return [];
  }

  // Requête entièrement numérique : c'est un code-barres (ou son début) tapé
  // à la main, pas un nom. On compare alors sur le code, en « contient » car
  // l'utilisateur lit souvent les derniers chiffres de l'étiquette.
  const digits = query.replace(/\D/g, '');
  const barcodeQuery = digits.length >= 3 && !/[a-z]/i.test(query) ? digits : undefined;

  const results: ProductSearchResult[] = [];
  for (const product of products) {
    const score = barcodeQuery
      ? scoreBarcode(product, barcodeQuery)
      : scoreProduct(product, terms);
    if (score > 0) {
      results.push({ product, score });
    }
  }

  return results.sort(compareResults).slice(0, limit);
}

// Un produit déjà présent doit être signalé AVANT la création, sinon on
// accumule des doublons ("Beurre demi-sel" / "beurre demi sel") qui font
// ensuite deux lignes distinctes dans le comparatif. Bien plus strict que la
// recherche : on ne veut alerter que sur une quasi-identité.
export function findExistingProduct(products: Product[], name: string, brand?: string) {
  const targetName = normalize(name);
  if (!targetName) {
    return undefined;
  }
  const targetBrand = normalize(brand ?? '');
  return products.find((product) => {
    if (normalize(product.name) !== targetName) {
      return false;
    }
    // Marque non renseignée d'un côté : on considère quand même que c'est le
    // même produit — c'est le cas le plus fréquent des doublons réels.
    if (!targetBrand || !product.brand) {
      return true;
    }
    return normalize(product.brand) === targetBrand;
  });
}

function scoreProduct(product: Product, terms: string[]) {
  const nameWords = tokenize(product.name);
  const brandWords = tokenize(product.brand ?? '');
  const otherWords = [...tokenize(product.variant ?? ''), ...tokenize(product.category ?? '')];

  let total = 0;
  for (const term of terms) {
    const termScore = Math.max(
      scoreAgainstWords(term, nameWords, 3, 2),
      scoreAgainstWords(term, brandWords, 2.5, 1.5),
      scoreAgainstWords(term, otherWords, 1, 0.5)
    );
    // Un seul mot tapé qui ne correspond à rien élimine le produit : sans
    // cette règle, taper « beurre président » listerait tous les beurres.
    if (termScore === 0) {
      return 0;
    }
    total += termScore;
  }

  // Bonus quand le nom démarre par ce qui a été tapé : « lait » doit placer
  // « Lait demi-écrémé » avant « Chocolat au lait ».
  if (nameWords[0] && nameWords[0].startsWith(terms[0])) {
    total += 1;
  }
  return total;
}

function scoreAgainstWords(term: string, words: string[], exactScore: number, prefixScore: number) {
  let best = 0;
  for (const word of words) {
    if (word === term) {
      return exactScore;
    }
    if (word.startsWith(term)) {
      best = Math.max(best, prefixScore);
    }
  }
  return best;
}

function scoreBarcode(product: Product, digits: string) {
  const barcode = product.barcode;
  if (!barcode) {
    return 0;
  }
  if (barcode === digits) {
    return 10;
  }
  if (barcode.startsWith(digits)) {
    return 4;
  }
  return barcode.includes(digits) ? 2 : 0;
}

function compareResults(left: ProductSearchResult, right: ProductSearchResult) {
  if (right.score !== left.score) {
    return right.score - left.score;
  }
  // À pertinence égale, ce qui a servi récemment remonte : on rachète
  // beaucoup plus souvent les mêmes produits qu'on n'en découvre.
  const leftUsed = left.product.lastUsedAt ?? '';
  const rightUsed = right.product.lastUsedAt ?? '';
  if (leftUsed !== rightUsed) {
    return rightUsed.localeCompare(leftUsed);
  }
  return left.product.name.localeCompare(right.product.name, 'fr');
}

// Accents retirés (NFD isole le diacritique, la plage U+0300-U+036F le
// supprime) : « crème » saisi sans accent sur un clavier de téléphone doit
// trouver « Crème fraîche ». Tirets, apostrophes et ponctuation deviennent
// des séparateurs, donc « demi-sel » se cherche aussi bien en « demi » qu'en
// « sel ».
function tokenize(value: string) {
  return normalize(value).split(' ').filter(Boolean);
}

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
