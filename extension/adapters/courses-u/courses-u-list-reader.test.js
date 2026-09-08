import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { readCoursesUWishlistOnPage } from './courses-u-list-reader.js';

// Extraits réduits du DOM réel de la page « Mes Listes » de coursesu.com,
// relevé sur compte connecté (2026-09-05, voir
// docs/RAPPORT_PASSATION_IMPORT_LISTES.md §3). Ils figent le piège principal
// de cette page : chaque produit y apparaît deux fois, une fois dans le
// mini-panier récapitulatif du haut, une fois dans la grille de la liste.

const WISHLIST_URL = 'https://www.coursesu.com/mon-compte/mes-listes?listID=abc123&wishlistName=Favoris';

let dom;

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

function installGlobals(html, url = WISHLIST_URL) {
  dom = new JSDOM(html, { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
}

function tile(json) {
  return JSON.stringify(json).replace(/'/g, '&apos;');
}

describe('readCoursesUWishlistOnPage', () => {
  it('ne remonte chaque produit qu\'une fois malgré le doublon mini-panier / grille', () => {
    const lait = { id: '1483597', name: 'Lait demi écrémé UHT LAIT D\'ICI, 6x1l', brand: 'LAIT D\'ICI', EAN: '3256224234494', price: '5.64', quantity: '2', product_cat1: 'Crèmerie', product_cat3: 'Lait demi-écrémé' };
    const riz = { id: '990112', name: 'Riz basmati LUSTUCRU 900g', brand: 'LUSTUCRU', EAN: '3760341070335', price: '3.20', quantity: '1' };
    installGlobals(`
      <div class="mini-cart">
        <div class="mini-cart-product" data-tc-product-tile='${tile(lait)}'></div>
        <div class="mini-cart-product" data-tc-product-tile='${tile(riz)}'></div>
      </div>
      <div class="product-grid">
        <div class="grid-tile product-tile su-list-none" data-tc-product-tile='${tile(lait)}'>
          <a href="/p/lait-dici/1483597.html">Lait demi écrémé UHT LAIT D'ICI, 6x1l</a>
          <img src="https://media.coursesu.com/lait.jpg" alt="" />
        </div>
        <div class="grid-tile product-tile su-list-none" data-tc-product-tile='${tile(riz)}'>
          <a href="/p/riz-basmati/990112.html">Riz basmati LUSTUCRU 900g</a>
        </div>
      </div>
    `);

    const result = readCoursesUWishlistOnPage();

    expect(result.ok).toBe(true);
    expect(result.usedFallbackSelector).toBe(false);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.name)).toEqual([
      'Lait demi écrémé UHT LAIT D\'ICI, 6x1l',
      'Riz basmati LUSTUCRU 900g'
    ]);
    expect(result.items[0]).toMatchObject({
      barcode: '3256224234494',
      brand: 'LAIT D\'ICI',
      externalProductId: '1483597',
      priceEuro: 5.64,
      quantity: 2,
      category: 'Lait demi-écrémé'
    });
    expect(result.items[0].productUrl).toContain('/p/lait-dici/1483597.html');
    expect(result.items[0].imageUrl).toBe('https://media.coursesu.com/lait.jpg');
  });

  it('lit le nom de la liste depuis le paramètre d\'URL de la page', () => {
    installGlobals(`
      <div class="grid-tile product-tile su-list-none" data-tc-product-tile='${tile({ id: '1', name: 'Brioche', EAN: '5903111528669' })}'></div>
    `);

    expect(readCoursesUWishlistOnPage().listName).toBe('Favoris');
  });

  it('retombe sur l\'exclusion du mini-panier quand les classes de la grille ont changé', () => {
    // Scénario de refonte du site : `.grid-tile.product-tile` disparaît. Sans
    // le repli, l'import renverrait « liste vide » alors que la page affiche
    // bien les produits.
    const lait = { id: '1483597', name: 'Lait demi écrémé UHT LAIT D\'ICI, 6x1l', EAN: '3256224234494' };
    installGlobals(`
      <div class="mini-cart"><div class="mini-cart-product" data-tc-product-tile='${tile({ id: '777', name: 'Emmental râpé PRESIDENT - 150g', EAN: '3228022120040' })}'></div></div>
      <div class="tuile-produit-v2" data-tc-product-tile='${tile(lait)}'></div>
      <div class="recommendation-tile" data-tc-product-tile='${tile({ id: '888', name: 'Huile d\'olive TRAMIER 50cl', EAN: '8410179013459' })}'></div>
    `);

    const result = readCoursesUWishlistOnPage();

    expect(result.ok).toBe(true);
    expect(result.usedFallbackSelector).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].externalProductId).toBe('1483597');
  });

  it('rejette un EAN qui ne satisfait pas la clé de contrôle GS1', () => {
    installGlobals(`
      <div class="grid-tile product-tile" data-tc-product-tile='${tile({ id: '1', name: 'Pâtes', EAN: '1234567890123' })}'></div>
    `);

    const result = readCoursesUWishlistOnPage();

    expect(result.ok).toBe(true);
    expect(result.items[0].barcode).toBeUndefined();
  });

  it('traite un prix "unknown" et une quantité absente sans produire de valeurs bancales', () => {
    installGlobals(`
      <div class="grid-tile product-tile" data-tc-product-tile='${tile({ id: '1', name: 'Galettes', brand: 'unknown', price: 'unknown' })}'></div>
    `);

    const result = readCoursesUWishlistOnPage();

    expect(result.items[0].priceEuro).toBeUndefined();
    expect(result.items[0].brand).toBeUndefined();
    expect(result.items[0].quantity).toBe(1);
  });

  it('ignore une tuile au JSON illisible sans perdre les autres produits', () => {
    installGlobals(`
      <div class="grid-tile product-tile" data-tc-product-tile='{"name":"Cassé'></div>
      <div class="grid-tile product-tile" data-tc-product-tile='${tile({ id: '2', name: 'Jus d\'orange' })}'></div>
    `);

    const result = readCoursesUWishlistOnPage();

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Jus d\'orange');
  });

  it('signale une reconnexion nécessaire plutôt qu\'une liste vide', () => {
    installGlobals(
      `<form><label>Identifiez-vous</label><input type="password" /></form>`,
      'https://www.coursesu.com/s/login'
    );

    expect(readCoursesUWishlistOnPage()).toEqual({ ok: false, code: 'COURSESU_LOGIN_REQUIRED' });
  });

  it('distingue une liste réellement vide d\'une page bloquée', () => {
    installGlobals(`<div class="product-grid"><p>Votre liste ne contient aucun produit.</p></div>`);

    expect(readCoursesUWishlistOnPage()).toMatchObject({ ok: false, code: 'COURSESU_LIST_EMPTY' });
  });

  it('remonte SITE_BLOCKED sur une page de captcha', () => {
    installGlobals(`<div><h1>Vérification</h1><p>Prouvez que vous n'êtes pas un robot</p></div>`);

    expect(readCoursesUWishlistOnPage()).toEqual({ ok: false, code: 'SITE_BLOCKED' });
  });

  it('ne confond pas la config JS de la page avec un captcha', () => {
    // Régression déjà vécue sur readCoursesUProductPageOnPage : textContent
    // remonte aussi le contenu des <script>, dont "SHOW_CAPTCHA":null.
    installGlobals(`
      <script>window.SessionAttributes = {"SHOW_CAPTCHA":null};</script>
      <div class="grid-tile product-tile" data-tc-product-tile='${tile({ id: '1', name: 'Mousse aux fruits' })}'></div>
    `);

    const result = readCoursesUWishlistOnPage();

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
  });
});

describe('Injection isolation — lecteur de listes Courses U', () => {
  function rebuildFromSource(fn) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fn.toString()});`)();
  }

  it('readCoursesUWishlistOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`
      <div class="grid-tile product-tile su-list-none" data-tc-product-tile='${tile({ id: '1', name: 'Pâtée chat', EAN: '3256224234494' })}'></div>
    `);

    const rebuilt = rebuildFromSource(readCoursesUWishlistOnPage);

    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt().items[0]).toMatchObject({ name: 'Pâtée chat', barcode: '3256224234494' });
  });
});
