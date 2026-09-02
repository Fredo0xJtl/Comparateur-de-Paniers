// Validation des codes-barres produits (EAN-8, UPC-A/EAN-12, EAN-13, GTIN-14).
//
// Pourquoi : les collecteurs extraient un EAN du texte brut d'une fiche ou
// d'une carte produit via `text.match(/\b\d{8,14}\b/)`. Ce filtre accepte
// n'importe quelle suite de 8 à 14 chiffres présente dans la page — un
// numéro de téléphone du pied de page, un identifiant interne, une référence
// fournisseur, un numéro de lot. Le faux EAN ainsi produit est ensuite
// utilisé pour des décisions qui engagent le panier réel de l'utilisateur :
//   - `chooseCoursesUProduct` / `chooseLeclercProductCandidate` traitent une
//     égalité d'EAN comme une correspondance PARFAITE (matchScore 1), qui
//     court-circuite tout le scoring par nom ;
//   - `tryAddToCartCoursesUViaProductUrl` / `tryAddToCartLeclercViaProductUrl`
//     refusent la fiche atteinte quand l'EAN lu diffère de l'EAN attendu.
// Un faux EAN peut donc faire retenir le mauvais produit, ou faire rejeter à
// tort la bonne fiche et retomber sur la recherche par nom (chemin qui avait
// justement ajouté de mauvais produits au panier réel, cf. le commentaire de
// `addToCartCoursesUStore`).
//
// La clé de contrôle GS1 (dernier chiffre) écarte l'immense majorité de ces
// faux positifs : une suite de chiffres arbitraire n'a qu'environ 1 chance
// sur 10 de la satisfaire, et les longueurs non normalisées (9, 10, 11) sont
// rejetées d'office.
//
// ⚠ Isolation d'injection : ce module N'EST PAS importable depuis une
// fonction passée en `func:` à `chrome.scripting.executeScript` (seul le code
// source de la fonction ciblée est sérialisé). Les collecteurs en contiennent
// donc une copie locale, volontairement identique, dont la cohérence est
// vérifiée par les tests d'isolation des adaptateurs.

const VALID_LENGTHS = new Set([8, 12, 13, 14]);

/** Longueurs GTIN normalisées acceptées (EAN-8, UPC-A, EAN-13, GTIN-14). */
export const EAN_VALID_LENGTHS = VALID_LENGTHS;

/**
 * Renvoie le code-barres normalisé (chiffres uniquement) s'il s'agit d'un
 * GTIN valide — longueur normalisée ET clé de contrôle correcte —, sinon
 * `undefined`.
 * @param {unknown} value
 * @returns {string | undefined}
 */
export function normalizeEan(value) {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) return undefined;
  if (!VALID_LENGTHS.has(digits.length)) return undefined;
  let sum = 0;
  for (let index = 0; index < digits.length - 1; index += 1) {
    // Poids GS1 : en partant du chiffre juste avant la clé, on alterne
    // 3, 1, 3, 1... quelle que soit la longueur du code.
    const weight = (digits.length - index) % 2 === 0 ? 3 : 1;
    sum += Number(digits[index]) * weight;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(digits[digits.length - 1]) ? digits : undefined;
}

/**
 * Variante booléenne de {@link normalizeEan}.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidEan(value) {
  return normalizeEan(value) !== undefined;
}

/**
 * Extrait le premier GTIN VALIDE d'un texte libre (fiche ou carte produit).
 * Remplace `text.match(/\b\d{8,14}\b/)?.[0]`, qui retenait la première suite
 * de chiffres venue sans jamais vérifier qu'il s'agissait d'un code-barres.
 *
 * Les EAN-8 sont volontairement EXCLUS de cette extraction en texte libre :
 * sur 8 chiffres, la clé de contrôle n'écarte qu'environ 9 faux positifs sur
 * 10, et une page produit est pleine de suites de 8 chiffres (dates au
 * format AAAAMMJJ, numéros de commande, références internes) — « 20260828 »
 * est par exemple un EAN-8 formellement valide. Un EAN-8 réellement présent
 * au catalogue arrive de toute façon par une source structurée (`data-ean`,
 * `data-tc-product-tile`, `gtin` JSON-LD), que {@link normalizeEan} accepte
 * toujours.
 * @param {unknown} text
 * @returns {string | undefined}
 */
export function findEanInText(text) {
  for (const match of String(text ?? '').matchAll(/\b\d{12,14}\b/g)) {
    const normalized = normalizeEan(match[0]);
    if (normalized) return normalized;
  }
  return undefined;
}
