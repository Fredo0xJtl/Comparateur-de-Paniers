// Lecture des listes/favoris déjà enregistrés sur le compte Courses U
// (page « Mes Listes » : /mon-compte/mes-listes?listID=...&wishlistName=...).
//
// Fonctionnalité DISTINCTE des collecteurs de recherche : ici on ne cherche
// pas un produit du panier local dans le catalogue, on lit une liste que
// l'utilisateur a lui-même constituée sur son compte, pour l'importer dans la
// liste de courses locale sans la ressaisir produit par produit.
//
// Fichier séparé de courses-u-collector.js à dessein : ce dernier est
// stabilisé et engage le panier réel de l'utilisateur (voir
// docs/RAPPORT_PASSATION_IMPORT_LISTES.md §6). L'import n'a aucune raison de
// le modifier.
//
// ⚠ Contrainte absolue héritée du projet : aucune manipulation d'identifiant
// ou de mot de passe. L'utilisateur se connecte lui-même dans son navigateur ;
// ce code lit un DOM déjà authentifié, en lecture seule (aucun clic, aucune
// saisie, aucune soumission de formulaire simulés sur le site).

/**
 * Lit la page « Mes Listes » de coursesu.com et renvoie les produits qu'elle
 * affiche.
 *
 * ⚠ Isolation d'injection : cette fonction est passée en `func:` à
 * `chrome.scripting.executeScript`, qui ne sérialise QUE son propre code
 * source. Elle ne doit donc appeler aucune fonction ni constante définie hors
 * de son corps (d'où la copie locale de la validation EAN, jumelle de celles
 * de courses-u-collector.js et du module partagé extension/shared/barcode.js).
 *
 * @returns {{ ok: true, listName?: string, usedFallbackSelector: boolean, items: Array<object> }
 *         | { ok: false, code: string, details?: object }}
 */
export function readCoursesUWishlistOnPage() {
  // Copie locale de normalizeEan (extension/shared/barcode.js) : la clé de
  // contrôle GS1 écarte les suites de chiffres qui ne sont pas des EAN. Un
  // faux EAN importé deviendrait le code-barres d'une fiche produit locale,
  // et servirait ensuite de correspondance « parfaite » lors des ajouts au
  // panier réels — même risque que celui documenté dans barcode.js.
  const normalizeEanLocal = (value) => {
    const digits = String(value ?? '').replace(/[\s-]/g, '');
    if (!/^\d+$/.test(digits)) return undefined;
    if (![8, 12, 13, 14].includes(digits.length)) return undefined;
    let sum = 0;
    for (let index = 0; index < digits.length - 1; index += 1) {
      sum += Number(digits[index]) * ((digits.length - index) % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]) ? digits : undefined;
  };

  const trimmed = (value, max) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : undefined;
  };

  // textContent et non innerText (non implémenté par jsdom, cf.
  // courses-u-real-dom.test.js), sur un clone débarrassé des <script>/<style> :
  // une page Courses U embarque une config JS contenant "SHOW_CAPTCHA":null,
  // qui déclenchait à tort SITE_BLOCKED dans readCoursesUProductPageOnPage.
  const bodyClone = document.body?.cloneNode(true);
  bodyClone?.querySelectorAll('script, style, noscript').forEach((element) => element.remove());
  const pageText = (bodyClone?.textContent || '').replace(/\s+/g, ' ').trim();
  if (/captcha|pas un robot|accès refusé/i.test(pageText)) return { ok: false, code: 'SITE_BLOCKED' };

  // Sélection des tuiles, en cascade volontaire.
  //
  // Piège vérifié en conditions réelles (compte connecté, 2026-09-05) :
  // chaque produit de la liste apparaît DEUX fois dans le DOM — une fois dans
  // le mini-panier récapitulatif affiché en haut de page, une fois dans la
  // vraie grille de la liste. Le sélecteur précis relevé sur place est
  // `.grid-tile.product-tile.su-list-none`.
  //
  // On ne s'y fie pas seul pour autant : trois classes utilitaires enchaînées
  // sont exactement le genre de détail qu'une refonte du site change sans
  // prévenir, et le lecteur renverrait alors une liste vide sans rien dire.
  // D'où le repli par EXCLUSION (toutes les tuiles sauf mini-panier et
  // carrousels de suggestions), qui survit à un renommage de la grille, et le
  // dédoublonnage final qui rattrape les deux cas.
  const allTiles = [...document.querySelectorAll('[data-tc-product-tile]')];
  const gridTiles = allTiles.filter((tile) => tile.classList.contains('grid-tile') && tile.classList.contains('product-tile'));
  const usedFallbackSelector = gridTiles.length === 0;
  const tiles = usedFallbackSelector
    ? allTiles.filter(
        (tile) =>
          !tile.closest('.mini-cart, .mini-cart-product, [class*="mini-cart" i], [class*="minicart" i]') &&
          !tile.closest('.recommendation-tile, [class*="recommendation" i], [class*="carousel" i]')
      )
    : gridTiles;

  if (tiles.length === 0) {
    // Distinguer « pas connecté » de « liste vide » : sans ça, l'écran
    // d'import afficherait « aucun produit » à un utilisateur simplement
    // déconnecté, qui n'aurait aucune raison de deviner qu'il doit se
    // reconnecter lui-même sur le site.
    const looksLikeLogin =
      Boolean(document.querySelector('input[type="password"]')) ||
      /\/(login|connexion|s\/login)/i.test(location.pathname) ||
      /identifiez-vous|connectez-vous|mot de passe oublié/i.test(pageText);
    if (looksLikeLogin) return { ok: false, code: 'COURSESU_LOGIN_REQUIRED' };

    // Le compte peut porter PLUSIEURS listes : ouverte sans `listID`, la page
    // « Mes Listes » affiche alors leur sommaire, sans aucun produit. Plutôt
    // que d'en choisir une à la place de l'utilisateur (ou de conclure à tort
    // « liste vide »), on remonte les listes trouvées pour qu'il tranche
    // lui-même dans la PWA, qui relancera l'import sur l'URL choisie.
    const lists = [];
    const seenListUrls = new Set();
    for (const link of document.querySelectorAll('a[href*="listID="]')) {
      const href = link.href;
      if (!href || seenListUrls.has(href)) continue;
      seenListUrls.add(href);
      let nameFromUrl;
      try {
        nameFromUrl = new URL(href).searchParams.get('wishlistName');
      } catch {
        nameFromUrl = null;
      }
      const name = trimmed(nameFromUrl || link.textContent, 200);
      if (!name) continue;
      lists.push({ name, url: href });
      if (lists.length >= 30) break;
    }
    if (lists.length > 0) return { ok: false, code: 'COURSESU_PICK_LIST', details: { lists } };

    return { ok: false, code: 'COURSESU_LIST_EMPTY', details: { tileCount: allTiles.length } };
  }

  // Garde-fou volontaire contre un DOM inattendu (page de catalogue ouverte
  // par erreur, boucle de rendu) : au-delà, on tronque plutôt que de noyer
  // l'écran d'import et la base locale.
  const MAX_ITEMS = 500;

  const byIdentity = new Map();
  for (const tile of tiles) {
    let data;
    try {
      data = JSON.parse(tile.getAttribute('data-tc-product-tile') || 'null');
    } catch {
      // Tuile au JSON malformé : ignorée plutôt que de faire échouer tout
      // l'import pour un seul produit illisible.
      data = null;
    }
    if (!data || typeof data !== 'object') continue;

    const name = trimmed(data.name && data.name !== 'unknown' ? data.name : '', 500) || trimmed(tile.querySelector('h2, h3, h4, [itemprop="name"], .product-name')?.textContent, 500);
    if (!name) continue;

    const priceRaw = Number(String(data.price ?? '').replace(',', '.'));
    const quantityRaw = Math.trunc(Number(data.quantity));
    const link = tile.querySelector('a[href*="/p/"]');
    const image = tile.querySelector('img');

    const item = {
      name,
      brand: trimmed(data.brand && data.brand !== 'unknown' ? data.brand : '', 200),
      barcode: normalizeEanLocal(data.EAN ?? data.ean),
      externalProductId: trimmed(data.id ?? tile.getAttribute('data-product-id'), 100),
      // Le prix n'est pas l'objet de l'import (les prix restent l'affaire du
      // comparateur), mais il aide l'utilisateur à reconnaître ses produits
      // sur l'écran de validation. "unknown" est une valeur réellement
      // rencontrée dans cet attribut : elle donne NaN, donc `undefined` ici.
      priceEuro: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : undefined,
      // Quantité enregistrée dans la liste côté Courses U : sert de quantité
      // souhaitée par défaut à l'import. Repli sur 1 plutôt que 0, qui
      // créerait une ligne de liste de courses sans objet.
      quantity: Number.isFinite(quantityRaw) && quantityRaw > 0 ? Math.min(quantityRaw, 99) : 1,
      // La catégorie la plus fine disponible : elle alimente le champ
      // `category` de la fiche produit locale, facultatif côté modèle.
      category: trimmed(data.product_cat3 || data.product_cat2 || data.product_cat1, 200),
      imageUrl: trimmed(image?.getAttribute('src') || data.image, 1_000),
      productUrl: link?.href || undefined
    };

    // Dédoublonnage par identité, dans cet ordre de fiabilité : identifiant
    // catalogue, puis EAN, puis URL, puis nom. C'est la vraie protection
    // contre le doublon mini-panier / grille — elle tient même si les deux
    // sélecteurs ci-dessus ramènent les mêmes produits deux fois.
    const identity = item.externalProductId
      ? `id:${item.externalProductId}`
      : item.barcode
        ? `ean:${item.barcode}`
        : item.productUrl
          ? `url:${item.productUrl}`
          : `name:${item.name.toLowerCase()}`;

    const existing = byIdentity.get(identity);
    if (!existing) {
      if (byIdentity.size >= MAX_ITEMS) break;
      byIdentity.set(identity, item);
      continue;
    }
    // Même produit vu deux fois : on complète les champs manquants plutôt que
    // d'écraser, les deux emplacements n'exposant pas toujours les mêmes
    // informations (le mini-panier n'a ni image ni lien produit).
    for (const [field, value] of Object.entries(item)) {
      if (existing[field] === undefined && value !== undefined) existing[field] = value;
    }
  }

  const items = [...byIdentity.values()];
  if (items.length === 0) return { ok: false, code: 'COURSESU_LIST_EMPTY', details: { tileCount: tiles.length } };

  // Nom de la liste : d'abord le paramètre d'URL que la page porte elle-même
  // (?wishlistName=Favoris), puis un titre visible. Purement informatif —
  // il sert à nommer l'import côté PWA.
  let listName;
  try {
    listName = trimmed(new URLSearchParams(location.search).get('wishlistName'), 200);
  } catch {
    listName = undefined;
  }
  if (!listName) listName = trimmed(document.querySelector('h1, .wishlist-name, [class*="list-title" i]')?.textContent, 200);

  return { ok: true, listName, usedFallbackSelector, items };
}
