import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armCoursesUFloatingPickButtonOnPage,
  clickAddToCartOnCoursesUProductPageOnPage,
  clickAddToCartOnMatchedCoursesUCardOnPage,
  readCoursesUChoices,
  readCoursesUProductPageOnPage,
  readCoursesUProducts,
  readCoursesUSessionStateOnPage,
  clickCoursesUChoice
} from './courses-u-collector.js';

// Trimmed extracts of the real DOM captured live from coursesu.com (mobile
// viewport, 2026-07-19). They pin down two regressions found that session:
// the "Choisir ce magasin" button's own class contains "store" (stores-button)
// which short-circuited .closest('[class*="store"]'), and product tiles carry
// the real name/EAN in a data-tc-product-tile JSON blob that must be
// preferred over a promo ribbon sharing the same heading tag.

let dom;

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

function installGlobals(html, url = 'https://www.coursesu.com/rechercher?q=coca+cola') {
  dom = new JSDOM(html, { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.Event = dom.window.Event;
}

// JSDOM ne fait aucun layout réel : `offsetParent`/`getClientRects()` valent
// toujours null/vide, donc `isVisible()` (utilisé partout dans le code réel)
// ne peut jamais être vrai sans aide. On simule "affiché à l'écran" en
// définissant `offsetParent` sur l'élément — même signal que le code lit
// (voir aussi leclerc-search-input.test.js / leclerc-real-dom.test.js).
function makeVisible(element) {
  if (element) {
    Object.defineProperty(element, 'offsetParent', { value: dom.window.document.body, configurable: true });
  }
  return element;
}

describe('Courses U real-DOM regression', () => {
  it('reads the store name and postal code instead of stopping at the button\'s own "store" class', () => {
    installGlobals(`
      <div class="stores-slider-store-container">
        <span>Super U - Auneau-bleury-st-symphorien</span>
        <span>Zac du pays alnelois, Auneau, 28700 Auneau-bleury-st-symphorien</span>
        <a class="stores-button su-btn su-btn-medium su-btn-primary-default" href="#">Choisir ce magasin</a>
      </div>
      <div class="stores-slider-store-container">
        <span>Hyper U - Hanches</span>
        <span>Route de gallardon, Centre commercial le loreau, 28130 Hanches</span>
        <a class="stores-button su-btn su-btn-medium su-btn-primary-default" href="#">Choisir ce magasin</a>
      </div>
    `);

    const choices = readCoursesUChoices();

    expect(choices).toHaveLength(2);
    expect(choices[0].text).toContain('28700');
    expect(choices[0].text).toContain('Auneau-bleury-st-symphorien');
    expect(choices[1].text).toContain('28130');
    // The old bug: both entries would collapse to the literal button label.
    expect(choices[0].text).not.toBe('Choisir ce magasin');
  });

  it('prefers the data-tc-product-tile JSON name over a promo ribbon sharing the h2 tag', () => {
    installGlobals(`
      <li data-product-id="1483597" data-tc-product-tile='{"name":"Coca Cola 4x50cl","brand":"COCA COLA","EAN":"5903111528669","price":"unknown"}'>
        <div class="product-tile">
          <h2 class="promo-ribbon">Promotion</h2>
          <a class="product-tile-link" href="/p/coca-cola-4x50cl/1483597.html">
            <h2 class="product-name">Coca Cola 4x50cl</h2>
          </a>
          <span>7,56 €</span>
        </div>
      </li>
    `);

    const products = readCoursesUProducts();

    // The link-climbing pass and the [data-product-id] pass both surface this
    // tile as distinct DOM references (pre-existing, unrelated to this fix);
    // what matters here is that every entry gets the correct name/EAN.
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      expect(product.name).toBe('Coca Cola 4x50cl');
      expect(product.barcode).toBe('5903111528669');
      expect(product.priceEuro).toBeCloseTo(7.56);
    }
  });

  it('falls back to heading text when no data-tc-product-tile is present', () => {
    installGlobals(`
      <article data-product-id="42">
        <h3>Simple product name</h3>
        <a href="/p/simple-product/42.html">link</a>
        <span>2,10 €</span>
      </article>
    `);

    const products = readCoursesUProducts();
    expect(products[0].name).toBe('Simple product name');
  });
});

// readCoursesUProductPageOnPage tourne sur une vraie fiche produit
// (coursesu.com/p/...) atteinte via une URL confirmée manuellement par
// l'utilisateur (voir DriveManualOverrideEntry) — jamais via la recherche.
describe('readCoursesUProductPageOnPage (correction manuelle Hyper U)', () => {
  it('préfère le schéma JSON-LD Product quand il est présent', () => {
    installGlobals(`
      <script type="application/ld+json">
        {"@context":"https://schema.org/","@type":"Product","name":"Lait demi écrémé UHT LAIT D'ICI, 6x1l","gtin13":"3564700000014","offers":{"@type":"Offer","price":"5.64","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}
      </script>
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <div>5,64 €</div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.name).toBe("Lait demi écrémé UHT LAIT D'ICI, 6x1l");
    expect(result.priceEuro).toBeCloseTo(5.64);
    expect(result.barcode).toBe('3564700000014');
    expect(result.available).toBe(true);
  });

  it('retombe sur les heuristiques DOM (h1 + regex prix) sans JSON-LD', () => {
    installGlobals(`
      <h1 itemprop="name">Coca Cola 4x50cl</h1>
      <span>7,56 €</span>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.name).toBe('Coca Cola 4x50cl');
    expect(result.priceEuro).toBeCloseTo(7.56);
  });

  it('signale une fiche hors stock via schema.org/OutOfStock', () => {
    installGlobals(`
      <script type="application/ld+json">
        {"@type":"Product","name":"Produit épuisé","offers":{"price":"2.00","availability":"https://schema.org/OutOfStock"}}
      </script>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
  });

  it('retourne SITE_BLOCKED sur un captcha au lieu de mal lire la page', () => {
    installGlobals('<div>Veuillez confirmer que vous êtes humain (captcha)</div>');

    expect(readCoursesUProductPageOnPage()).toEqual({ ok: false, code: 'SITE_BLOCKED' });
  });

  // Régression réelle (2026-08-26, confirmée en conditions réelles sur une
  // vraie fiche produit coursesu.com) : `document.body.textContent` remonte
  // aussi le contenu des <script> enfants, pas seulement le texte affiché.
  // Une vraie fiche produit embarque `window.SessionAttributes =
  // {"SHOW_CAPTCHA":null}` en <script> inline — la sous-chaîne "CAPTCHA"
  // déclenchait à tort SITE_BLOCKED sur un produit parfaitement valide.
  it("ne confond pas un <script> de config contenant \"CAPTCHA\" avec un vrai blocage anti-bot", () => {
    installGlobals(`
      <script>window.SessionAttributes = {"SHOW_CAPTCHA":null};</script>
      <h1 itemprop="name">Lait UHT demi écrémé - 6 briques de 1L</h1>
      <div>5,94 €</div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.name).toBe('Lait UHT demi écrémé - 6 briques de 1L');
    expect(result.priceEuro).toBeCloseTo(5.94);
  });

  // Régression réelle (2026-08-27, signalée par l'utilisateur après une
  // correction manuelle) : une vraie fiche produit affiche le prix total ET
  // un prix de référence au litre/kg ("Soit 1,90 €/L"), et le JSON-LD Product
  // réel de coursesu.com n'a pas de champ "offers"/prix (constaté en direct) —
  // donc c'est toujours le repli DOM qui joue, et sans filtre il prenait le
  // premier montant du texte, qui peut être le prix au litre plutôt que le
  // prix réel de l'article.
  it("ignore le prix au litre/kg affiché avant le prix total de l'article", () => {
    installGlobals(`
      <h1 itemprop="name">Lait UHT demi écrémé - 6 briques de 1L</h1>
      <div>Soit 1,90 €/L</div>
      <div>11,40 €</div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.priceEuro).toBeCloseTo(11.4);
  });

  it('ignore un prix au litre/kg accolé au symbole € ("16,14 €/kg") apparaissant avant le prix total', () => {
    installGlobals(`
      <h1 itemprop="name">Emmental râpé réduit en sel PRESIDENT - 150g</h1>
      <div>16,14 €/kg</div>
      <div>2,42 €</div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.priceEuro).toBeCloseTo(2.42);
  });

  // Régression réelle (2026-08-27, capture DOM live sur une vraie fiche
  // Hyper U - Hanches, coursesu.com) : une bulle promo "Soit 2,12€
  // d'économie." contient un montant plausible SANS suffixe /L ou /kg — le
  // filtre regex isUnitPriceContext ne l'exclut pas, donc un simple filtre
  // textuel ne suffit pas à 100%. Le prix total réel (3,52 €) est isolé de
  // façon déterministe via l'attribut data-item-price du bloc prix officiel
  // du magasin sélectionné (.actions-container-price .sale-price), qui doit
  // toujours l'emporter sur le repli DOM par regex.
  it("utilise l'attribut data-item-price plutôt qu'une bulle promo au montant plausible", () => {
    installGlobals(`
      <h1 itemprop="name">Bledina Bledidej - Lait et céréales bébé croissance vanille des 12 mois, brique 4x250ml</h1>
      <div class="actions-container-price store-selected">
        <div class="product-price sales-price">
          <span class="price-sales standard">
            <span data-item-price="3.52" class="sale-price">3,52 €</span>
            <span class="pdp-standard-price hidden">au lieu de <span>5,64 €</span></span>
            <span class="unit-info-container"><span class="unit-info">3,52 €/l</span></span>
          </span>
        </div>
      </div>
      <div class="promo-tooltip">Soit 2,12€ d'économie.</div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.priceEuro).toBeCloseTo(3.52);
    expect(result.unitPriceEuro).toBeCloseTo(3.52);
    expect(result.unitPriceUnit).toBe('L');
  });

  it('retourne MANUAL_URL_PAGE_NOT_FOUND sur une 404 confirmée', () => {
    installGlobals('<h1>Page introuvable</h1><p>Ce produit n\'existe plus.</p>');

    expect(readCoursesUProductPageOnPage()).toEqual({ ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' });
  });

  // Régression réelle (2026-08-27, capture live sur coursesu.com, magasin
  // Hyper U - Hanches, "Lait UHT demi écrémé - 6 briques de 1L") : un avis
  // client tout en bas de page mentionnait "beaucoup trop d'articles
  // manquants car en rupture de stock" à propos du service de livraison en
  // général — le repli textuel global scannait tout le body et marquait à
  // tort ce produit (pourtant bien en stock) comme indisponible, ce qui
  // cassait silencieusement le regroupement par magasin majoritaire.
  it("n'est pas trompé par une mention \"rupture de stock\" dans un avis client hors du bloc prix", () => {
    installGlobals(`
      <h1 itemprop="name">Lait UHT demi écrémé - 6 briques de 1L</h1>
      <div class="actions-container-price store-selected">
        <span data-item-price="5.94" class="sale-price">5,94 €</span>
      </div>
      <div class="reviews-section">
        <p>Globalement satisfait de l'ensemble mais beaucoup trop d'articles
        manquants car en rupture de stock alors qu'ils sont indiqués
        disponibles le jour de la commande.</p>
      </div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.priceEuro).toBeCloseTo(5.94);
    expect(result.available).toBe(true);
  });

  // Régression réelle (2026-08-28, capture RDP live sur coursesu.com, fiche
  // "Lait UHT demi écrémé - 6 briques de 1L") : la page contenait 46
  // [data-tc-product-tile], le premier étant un article du mini-panier
  // (Emmental, EAN différent), le vrai produit affiché étant plus loin dans
  // le DOM (ancêtre du bouton .pdp-add-to-cart). Lire le premier tile du DOM
  // renvoyait un EAN totalement étranger au produit affiché, ce qui
  // déclenchait un faux mismatch côté ajout au panier (voir
  // tryAddToCartCoursesUViaProductUrl) et un ajout du mauvais produit après
  // repli sur la recherche par nom.
  it('ignore les tuiles du mini-panier et du carrousel de suggestions pour trouver le bon EAN/nom', () => {
    installGlobals(`
      <div class="mini-cart" data-tc-product-tile='{"name":"Emmental râpé PRESIDENT - 150g","EAN":"3228022120040"}'></div>
      <div class="mini-cart" data-tc-product-tile='{"name":"Riz basmati LUSTUCRU 900g","EAN":"3760341070335"}'></div>
      <div class="actions-container" data-tc-product-tile='{"name":"Lait UHT demi écrémé - 6 briques de 1L","EAN":"3256224234494"}'>
        <h1 itemprop="name">Lait UHT demi écrémé - 6 briques de 1L</h1>
        <div class="actions-container-price store-selected">
          <span data-item-price="5.94" class="sale-price">5,94 €</span>
        </div>
        <button class="pdp-add-to-cart" aria-label="Bouton ajouter le produit Lait UHT demi écrémé - 6 briques de 1L au panier"></button>
      </div>
      <div class="recommendation-tile" data-tc-product-tile='{"name":"Huile d\\'olive TRAMIER 50cl","EAN":"8410179013459"}'></div>
    `);

    const result = readCoursesUProductPageOnPage();

    expect(result.ok).toBe(true);
    expect(result.name).toBe('Lait UHT demi écrémé - 6 briques de 1L');
    expect(result.barcode).toBe('3256224234494');
  });
});

describe('clickAddToCartOnMatchedCoursesUCardOnPage', () => {
  function twoTilesHtml() {
    return `
      <div class="tile">
        <a href="/p/lait-lactel/1.html">Lait demi-écrémé Lactel 6x1L</a>
        <span>5,99 €</span>
        <button aria-label="Ajouter au panier"></button>
      </div>
      <div class="tile">
        <a href="/p/jus-andros/2.html">Jus de pomme Andros 1L</a>
        <span>1,80 €</span>
        <button aria-label="Ajouter au panier"></button>
      </div>
    `;
  }

  it('clique le bouton "ajouter au panier" de la carte appariée, jamais celui d’une carte voisine', async () => {
    installGlobals(twoTilesHtml());
    const [matchedButton, otherButton] = [...document.querySelectorAll('button')].map(makeVisible);
    const clicksOnMatched = [];
    const clicksOnOther = [];
    matchedButton.addEventListener('click', () => {
      clicksOnMatched.push('click');
      matchedButton.textContent = 'Ajouté';
    });
    otherButton.addEventListener('click', () => clicksOnOther.push('click'));

    const result = await clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);

    expect(result.added).toBe(true);
    expect(clicksOnMatched).toEqual(['click']);
    expect(clicksOnOther).toEqual([]);
  });

  it('renvoie CART_CARD_NOT_FOUND quand aucune carte ne correspond au produit attendu', async () => {
    installGlobals(twoTilesHtml());

    const result = await clickAddToCartOnMatchedCoursesUCardOnPage('Produit totalement inconnu 9999', NaN, 1);

    expect(result).toEqual({ added: false, code: 'CART_CARD_NOT_FOUND' });
  });

  // Contrairement à Leclerc, la sélection de carte côté Hyper U exige déjà la
  // présence d'un bouton "ajouter au panier" visible dans le container avant
  // même de le retenir comme candidat (voir la remontée de container dans
  // courses-u-collector.js) : une carte sans bouton n'est donc jamais choisie
  // comme "meilleure carte" et ressort en CART_CARD_NOT_FOUND, pas en
  // ADD_TO_CART_CONTROL_NOT_FOUND (ce second code reste défensif, pour le cas
  // où le bouton disparaîtrait entre la sélection et le clic).
  it('renvoie CART_CARD_NOT_FOUND quand la carte n’a aucun contrôle "ajouter au panier" visible', async () => {
    installGlobals(`
      <div class="tile">
        <a href="/p/lait-lactel/1.html">Lait demi-écrémé Lactel 6x1L</a>
        <span>5,99 €</span>
      </div>
    `);

    const result = await clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);

    expect(result).toEqual({ added: false, code: 'CART_CARD_NOT_FOUND' });
  });

  it('renvoie CART_ADD_NOT_CONFIRMED quand le clic ne change ni le bouton ni ne fait apparaître de stepper', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoTilesHtml());
      [...document.querySelectorAll('button')].forEach(makeVisible);
      const promise = clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: false, code: 'CART_ADD_NOT_CONFIRMED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirme l’ajout via l’apparition d’un stepper "+" même si le texte du bouton "ajouter" ne change pas', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoTilesHtml());
      const [matchedButton] = [...document.querySelectorAll('button')].map(makeVisible);
      const card = matchedButton.closest('.tile');
      matchedButton.addEventListener('click', () => {
        const stepper = document.createElement('button');
        stepper.textContent = '+';
        card.appendChild(stepper);
        makeVisible(stepper);
      });

      const promise = clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.added).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('quantity: 3 déclenche exactement 2 clics supplémentaires sur le stepper', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoTilesHtml());
      const [matchedButton] = [...document.querySelectorAll('button')].map(makeVisible);
      const card = matchedButton.closest('.tile');
      const stepper = makeVisible(document.createElement('button'));
      stepper.textContent = '+';
      let stepperClicks = 0;
      stepper.addEventListener('click', () => {
        stepperClicks += 1;
      });
      matchedButton.addEventListener('click', () => card.appendChild(stepper));

      const promise = clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.added).toBe(true);
      expect(stepperClicks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Point mort corrigé le 2026-08-27 (voir leclerc-real-dom.test.js) : un
  // produit déjà dans le panier n'affiche plus de bouton "Ajouter au panier"
  // sur sa carte, seulement le stepper +/-. Avant ce correctif, ce cas
  // ressortait à tort en ADD_TO_CART_CONTROL_NOT_FOUND — un succès déguisé en
  // échec.
  it('traite un produit déjà présent (stepper visible, pas de bouton "ajouter") comme un succès direct, sans tenter de clic', async () => {
    installGlobals(`
      <div class="tile">
        <a href="/p/lait-lactel/1.html">Lait demi-écrémé Lactel 6x1L</a>
        <span>5,99 €</span>
        <button aria-label="Augmenter la quantité">+</button>
      </div>
    `);
    const stepper = makeVisible(document.querySelector('button'));
    const stepperClicks = [];
    stepper.addEventListener('click', () => stepperClicks.push('click'));

    const result = await clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);

    expect(result.added).toBe(true);
    expect(stepperClicks).toEqual([]);
  });

  it('un produit déjà présent avec quantity: 3 déclenche exactement 2 clics sur le stepper existant', async () => {
    installGlobals(`
      <div class="tile">
        <a href="/p/lait-lactel/1.html">Lait demi-écrémé Lactel 6x1L</a>
        <span>5,99 €</span>
        <button aria-label="Augmenter la quantité">+</button>
      </div>
    `);
    const stepper = makeVisible(document.querySelector('button'));
    let stepperClicks = 0;
    stepper.addEventListener('click', () => {
      stepperClicks += 1;
    });

    const result = await clickAddToCartOnMatchedCoursesUCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 3);

    expect(result.added).toBe(true);
    expect(stepperClicks).toBe(2);
  });

  // Point mort réel diagnostiqué sur le tel (Hyper U, 2026-08-28) :
  // coursesu.com n'utilise ni <button> ni [role="button"] pour son contrôle
  // "Ajouter au panier" — c'est un <div aria-label="Ajouter au panier ...">
  // nu, et son stepper est un <div role="button" data-quantity="increase">
  // dont l'aria-label ne contient ni "+" ni "augmenter"/"increment". Avant
  // le correctif, TOUTE carte Hyper U réelle ressortait en
  // CART_CARD_NOT_FOUND malgré un produit visiblement présent — reproduit
  // ici avec la structure DOM exacte observée en diagnostic (simplifiée).
  it('reconnaît le contrôle "ajouter au panier" réel de coursesu.com (div sans role, aria-label seul)', async () => {
    installGlobals(`
      <div class="product-tile">
        <a href="/p/lipton-ice-tea/1.html">Boisson Thé Glacé Pêche - LIPTON ICE TEA - Bouteille 1,25L</a>
        <span>1,49 €</span>
        <div class="product-button__bag" aria-label="Ajouter au panier Boisson Thé Glacé Pêche - LIPTON ICE TEA - Bouteille 1,25L" tabindex="0"></div>
      </div>
    `);
    const addControl = makeVisible(document.querySelector('.product-button__bag'));
    const clicks = [];
    addControl.addEventListener('click', () => {
      clicks.push('click');
      const stepper = document.createElement('div');
      stepper.setAttribute('role', 'button');
      stepper.setAttribute('data-quantity', 'increase');
      stepper.setAttribute('aria-label', 'Ajouter une quantité de Boisson Thé Glacé Pêche');
      addControl.closest('.product-tile').appendChild(stepper);
      makeVisible(stepper);
    });

    const result = await clickAddToCartOnMatchedCoursesUCardOnPage(
      'Boisson Thé Glacé Pêche - LIPTON ICE TEA - Bouteille 1,25L',
      1.49,
      1
    );

    expect(result.added).toBe(true);
    expect(clicks).toEqual(['click']);
  });

  it('détecte le stepper réel via data-quantity="increase" même sans texte "+" ni "augmenter"', async () => {
    installGlobals(`
      <div class="product-tile">
        <a href="/p/lipton-ice-tea/1.html">Boisson Thé Glacé Pêche - LIPTON ICE TEA - Bouteille 1,25L</a>
        <span>1,49 €</span>
        <div role="button" data-quantity="increase" aria-label="Ajouter une quantité de Boisson Thé Glacé Pêche"></div>
      </div>
    `);
    const stepper = makeVisible(document.querySelector('[data-quantity="increase"]'));
    const stepperClicks = [];
    stepper.addEventListener('click', () => stepperClicks.push('click'));

    // Déjà dans le panier : seul le stepper est présent, aucun contrôle
    // "ajouter" — doit être traité comme un succès direct (même logique que
    // le cas générique déjà couvert plus haut, avec la vraie structure DOM).
    const result = await clickAddToCartOnMatchedCoursesUCardOnPage(
      'Boisson Thé Glacé Pêche - LIPTON ICE TEA - Bouteille 1,25L',
      1.49,
      1
    );

    expect(result.added).toBe(true);
    expect(stepperClicks).toEqual([]);
  });
});

describe('clickAddToCartOnCoursesUProductPageOnPage', () => {
  // Diagnostic réel (Hyper U, fiche "Riz basmati 10 min LUSTUCRU 5x180g
  // 900g", 2026-08-28) : le bouton "Ajouter au panier" PRINCIPAL de la fiche
  // a un aria-label préfixé "Bouton ajouter le produit <nom> au panier",
  // distinct des boutons de carrousel de suggestions présents sur la même
  // page ("Ajouter au panier <nom du carrousel>", sans ce préfixe).
  function productPageHtml() {
    return `
      <h1>Riz basmati 10 min LUSTUCRU 5x180g 900g</h1>
      <div class="product-button__bag icon-bag" aria-label="Bouton ajouter le produit Riz basmati 10 min LUSTUCRU 5x180g 900g au panier"></div>
      <section class="carousel">
        <div class="tile">
          <span>Emmental râpé Président 150g</span>
          <div class="product-button__bag" aria-label="Ajouter au panier Emmental râpé Président 150g"></div>
        </div>
      </section>
    `;
  }

  it('clique le bouton principal de la fiche, jamais un bouton de carrousel voisin', async () => {
    installGlobals(productPageHtml());
    const [mainButton, carouselButton] = [...document.querySelectorAll('[aria-label]')]
      .filter((el) => /panier/i.test(el.getAttribute('aria-label')))
      .map(makeVisible);
    const mainClicks = [];
    const carouselClicks = [];
    mainButton.addEventListener('click', () => {
      mainClicks.push('click');
      mainButton.textContent = 'Ajouté';
    });
    carouselButton.addEventListener('click', () => carouselClicks.push('click'));

    const result = await clickAddToCartOnCoursesUProductPageOnPage(1);

    expect(result.added).toBe(true);
    expect(mainClicks).toEqual(['click']);
    expect(carouselClicks).toEqual([]);
  });

  // Régression réelle (2026-08-28, RDP live, fiche "Lait UHT demi écrémé -
  // 6 briques de 1L") : 3 éléments distincts partageaient EXACTEMENT le même
  // préfixe d'aria-label "Bouton ajouter le produit" sur la même page — un
  // seul portant la classe pdp-add-to-cart, propre au bouton principal. Le
  // premier élément trouvé dans le DOM n'est pas garanti être celui-là.
  it('priorise le bouton pdp-add-to-cart même s\'il n\'est pas le premier des boutons candidats', async () => {
    installGlobals(`
      <h1>Lait UHT demi écrémé - 6 briques de 1L</h1>
      <div aria-label="Bouton ajouter le produit Lait UHT demi écrémé - 6 briques de 1L au panier" class="product-button__bag icon-bag"></div>
      <div aria-label="Bouton ajouter le produit Lait UHT demi écrémé - 6 briques de 1L au panier" class="product-button__bag icon-bag pdp-add-to-cart"></div>
      <div aria-label="Bouton ajouter le produit Lait UHT demi écrémé - 6 briques de 1L au panier" class="product-button__bag icon-bag"></div>
    `);
    const [decoyBefore, mainButton, decoyAfter] = [...document.querySelectorAll('[aria-label]')].map(makeVisible);
    const clicks = [];
    decoyBefore.addEventListener('click', () => clicks.push('decoyBefore'));
    mainButton.addEventListener('click', () => {
      clicks.push('main');
      mainButton.textContent = 'Ajouté';
    });
    decoyAfter.addEventListener('click', () => clicks.push('decoyAfter'));

    const result = await clickAddToCartOnCoursesUProductPageOnPage(1);

    expect(result.added).toBe(true);
    expect(clicks).toEqual(['main']);
  });

  it('renvoie ADD_TO_CART_CONTROL_NOT_FOUND quand seul un bouton de carrousel est présent', async () => {
    installGlobals(`
      <section class="carousel">
        <div class="tile">
          <span>Emmental râpé Président 150g</span>
          <div class="product-button__bag" aria-label="Ajouter au panier Emmental râpé Président 150g"></div>
        </div>
      </section>
    `);
    makeVisible(document.querySelector('[aria-label]'));

    const result = await clickAddToCartOnCoursesUProductPageOnPage(1);

    expect(result).toEqual({ added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' });
  });

  it('traite un produit déjà présent (stepper visible, pas de bouton principal) comme un succès direct', async () => {
    installGlobals(`
      <h1>Riz basmati 10 min LUSTUCRU 5x180g 900g</h1>
      <div role="button" data-quantity="increase" aria-label="Ajouter une quantité de Riz basmati"></div>
    `);
    const stepper = makeVisible(document.querySelector('[data-quantity="increase"]'));
    const stepperClicks = [];
    stepper.addEventListener('click', () => stepperClicks.push('click'));

    const result = await clickAddToCartOnCoursesUProductPageOnPage(1);

    expect(result.added).toBe(true);
    expect(stepperClicks).toEqual([]);
  });

  it('quantity: 3 déclenche exactement 2 clics supplémentaires sur le stepper', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(productPageHtml());
      const mainButton = makeVisible(
        [...document.querySelectorAll('[aria-label]')].find((el) => /^bouton ajouter le produit/i.test(el.getAttribute('aria-label')))
      );
      const stepper = makeVisible(document.createElement('div'));
      stepper.setAttribute('role', 'button');
      stepper.setAttribute('data-quantity', 'increase');
      let stepperClicks = 0;
      stepper.addEventListener('click', () => {
        stepperClicks += 1;
      });
      mainButton.addEventListener('click', () => document.body.appendChild(stepper));

      const promise = clickAddToCartOnCoursesUProductPageOnPage(3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.added).toBe(true);
      expect(stepperClicks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renvoie CART_ADD_NOT_CONFIRMED quand le clic ne change ni le bouton ni ne fait apparaître de stepper', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(productPageHtml());
      [...document.querySelectorAll('[aria-label]')].forEach(makeVisible);

      const promise = clickAddToCartOnCoursesUProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: false, code: 'CART_ADD_NOT_CONFIRMED' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('readCoursesUSessionStateOnPage', () => {
  // evidence est un code de motif détecté, jamais le texte réel du DOM
  // (audit sécurité du 30/08 — voir readCoursesUSessionStateOnPage).
  it('détecte un état connecté ("Mon compte")', () => {
    installGlobals(`<header><a href="/compte">Mon compte</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readCoursesUSessionStateOnPage()).toEqual({ signedIn: true, evidence: 'mon_compte' });
  });

  // L'evidence retenue ici est 'href_points_to_login' (pas le code texte
  // 'se_connecter') : le href "/connexion" est un signal plus fort et
  // testé en premier, cf. pointsToLogin ci-dessous.
  it('détecte un état déconnecté ("Se connecter")', () => {
    installGlobals(`<header><a href="/connexion">Se connecter</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readCoursesUSessionStateOnPage()).toEqual({ signedIn: false, evidence: 'href_points_to_login' });
  });

  it("ne reproduit jamais un prénom présent dans le signal \"Bonjour\" (audit sécurité 30/08)", () => {
    installGlobals(`<header><a href="/compte">Bonjour Frédéric</a></header>`);
    makeVisible(document.querySelector('a'));
    const result = readCoursesUSessionStateOnPage();
    expect(result).toEqual({ signedIn: true, evidence: 'bonjour' });
    expect(result.evidence).not.toContain('Frédéric');
  });

  // Le cas le plus important à couvrir : sans signal net, on ne bloque
  // jamais le remplissage — un faux "pas connecté" serait pire que
  // l'absence de détection.
  it('renvoie un état indéterminé (signedIn: null) quand ni l’un ni l’autre signal n’est présent', () => {
    installGlobals(`<header><a href="/promos">Nos promotions</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readCoursesUSessionStateOnPage()).toEqual({ signedIn: null, evidence: null });
  });

  // Piège réel diagnostiqué sur le tel (Hyper U, 2026-08-28) : coursesu.com
  // affiche un lien texté "Mon compte" qui mène en fait à la page de
  // connexion (href="/connexion?hasorigin=true"), y compris pour un
  // visiteur non connecté. Avant ce correctif, le texte seul suffisait à
  // conclure signedIn:true — un faux positif qui aurait laissé
  // addToCartCoursesUStore tenter des ajouts alors que l'utilisateur n'est
  // pas connecté, sans jamais afficher CART_LOGIN_REQUIRED.
  it('ne se laisse pas tromper par un lien "Mon compte" qui mène en réalité à la connexion', () => {
    installGlobals(`<header><a href="https://www.coursesu.com/connexion?hasorigin=true">Mon compte</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readCoursesUSessionStateOnPage()).toEqual({ signedIn: false, evidence: 'href_points_to_login' });
  });

  // Garde symétrique : un lien de DÉconnexion contient le sous-mot
  // "connexion" dans son href ("/deconnexion") — sans le garde négatif
  // explicite, il serait à tort classé comme "mène à la connexion" et
  // ferait conclure signedIn:false alors que c'est l'inverse.
  it('ne confond pas un lien de déconnexion avec un lien de connexion (sous-mot "connexion")', () => {
    installGlobals(`<header><a href="/mon-compte/deconnexion">Se déconnecter</a></header>`);
    makeVisible(document.querySelector('a'));
    // strongSignedInLink (href /deconnexion, sans filtre de visibilité)
    // matche en premier ici, avant même le contrôle textuel.
    expect(readCoursesUSessionStateOnPage()).toEqual({ signedIn: true, evidence: 'href_deconnexion' });
  });

  // Bug réel confirmé sur le tel (Hyper U, 2026-08-28) : l'utilisateur était
  // bien connecté (menu "Mon compte" du header confirmé par inspection DOM
  // en direct, contenant "Déconnexion") mais l'extension affichait quand
  // même "tu n'es pas connecté" — le lien de déconnexion existe bien dans le
  // DOM mais reste dans un menu FERMÉ par défaut (jamais "visible" au sens
  // offsetParent/getClientRects), et aucun autre signal net n'apparaît
  // ailleurs sur la page. Sans `makeVisible` ici : reproduit exactement ce
  // menu fermé.
  it('détecte connecté même quand le lien de déconnexion est dans un menu fermé (non visible)', () => {
    installGlobals(`
      <a class="cu-header-wishlist-link" href="/mon-compte/mes-listes">Mes produits</a>
      <div class="account-dropdown-ark hidden">
        <ul>
          <li><a class="account-link" href="https://www.coursesu.com/mon-compte">Mes informations</a></li>
          <li><a class="account-link" href="https://www.coursesu.com/deconnexion">Déconnexion</a></li>
        </ul>
      </div>
      <footer>
        <a class="footer-sitemap-link" href="https://www.coursesu.com/connexion?hasorigin=true">Mon compte</a>
      </footer>
    `);
    makeVisible(document.querySelector('.cu-header-wishlist-link'));
    expect(readCoursesUSessionStateOnPage()).toEqual({ signedIn: true, evidence: 'href_deconnexion' });
  });
});

// Cause racine confirmée le 2026-08-27 (voir leclerc-real-dom.test.js) :
// `chrome.scripting.executeScript({ func })` sérialise UNIQUEMENT le code
// source de la fonction ciblée — aucune closure ni référence vers une autre
// fonction du module ne survit. Ce bloc reconstruit chaque fonction à partir
// de sa propre source pour attraper toute ReferenceError vers un identifiant
// hors de la fonction.
describe('Injection isolation (chrome.scripting.executeScript ne sérialise que le code source de la fonction)', () => {
  function rebuildFromSource(fn) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fn.toString()});`)();
  }

  it('clickAddToCartOnMatchedCoursesUCardOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(`
      <div class="tile">
        <a href="/p/lait-lactel/1.html">Lait demi-écrémé Lactel 6x1L</a>
        <span>5,99 €</span>
        <button aria-label="Ajouter au panier"></button>
      </div>
    `);
    makeVisible(document.querySelector('button'));
    const rebuilt = rebuildFromSource(clickAddToCartOnMatchedCoursesUCardOnPage);
    const result = await rebuilt('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
    expect(result).toBeDefined();
  });

  it('readCoursesUSessionStateOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`<a href="/compte">Mon compte</a>`);
    makeVisible(document.querySelector('a'));
    const rebuilt = rebuildFromSource(readCoursesUSessionStateOnPage);
    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt().signedIn).toBe(true);
  });

  it('clickAddToCartOnCoursesUProductPageOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(`
      <div class="product-button__bag" aria-label="Bouton ajouter le produit Riz basmati au panier"></div>
    `);
    makeVisible(document.querySelector('[aria-label]'));
    const rebuilt = rebuildFromSource(clickAddToCartOnCoursesUProductPageOnPage);
    const result = await rebuilt(1);
    expect(result).toBeDefined();
  });
});

describe('Validation du code-barres (clé de contrôle GS1)', () => {
  it("n'invente pas un EAN à partir d'un numéro quelconque du texte de la carte", () => {
    // Cas visé : le pied de page / bloc service client d'une carte produit
    // contient une suite de chiffres qui n'est pas un code-barres. L'ancien
    // `text.match(/\b\d{8,14}\b/)` la retenait telle quelle, et
    // chooseCoursesUProduct traitait ensuite l'égalité de cet EAN inventé
    // comme une correspondance PARFAITE (matchScore 1).
    installGlobals(`
      <article>
        <a href="/p/lait-dici/1.html">Lait demi écrémé UHT LAIT D'ICI, 6x1l</a>
        <h3>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h3>
        <span>5,64 €</span>
        <p>Réf. commande 20260828120000 — service client 0980980990</p>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.barcode).toBeUndefined();
  });

  it('retient bien un EAN-13 valide présent dans le texte de la carte', () => {
    installGlobals(`
      <article>
        <a href="/p/lait-dici/1.html">Lait demi écrémé UHT LAIT D'ICI, 6x1l</a>
        <h3>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h3>
        <span>5,64 €</span>
        <p>Code-barres 3256224234494</p>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.barcode).toBe('3256224234494');
  });

  it("rejette un EAN de tuile dont la clé de contrôle est fausse plutôt que de le propager", () => {
    const tile = JSON.stringify({ name: "Lait demi écrémé UHT LAIT D'ICI, 6x1l", EAN: '3256224234495' });
    installGlobals(`
      <article data-tc-product-tile='${tile}'>
        <a href="/p/lait-dici/1.html">Lait demi écrémé UHT LAIT D'ICI, 6x1l</a>
        <span>5,64 €</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.name).toBe("Lait demi écrémé UHT LAIT D'ICI, 6x1l");
    expect(candidate.barcode).toBeUndefined();
  });

  it("ne lit pas d'EAN sur une fiche produit dont le seul nombre est une date/référence", () => {
    installGlobals(`
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <div class="actions-container-price">
        <span class="sale-price" data-item-price="5.64">5,64 €</span>
      </div>
      <footer>Commande n° 20260828 — mise à jour 20260827090000</footer>
    `);
    const result = readCoursesUProductPageOnPage();
    expect(result.ok).toBe(true);
    expect(result.barcode).toBeUndefined();
  });
});

describe('clickCoursesUChoice — index de magasin périmé', () => {
  const html = `
    <div class="stores-slider-store-container">
      <span>Hyper U - Hanches</span>
      <a class="stores-button" href="#">Choisir Hyper U - Hanches</a>
    </div>
    <div class="stores-slider-store-container">
      <span>Super U - Auneau</span>
      <a class="stores-button" href="#">Choisir Super U - Auneau</a>
    </div>
  `;

  it('clique quand le contrôle à cet index porte toujours le libellé attendu', () => {
    installGlobals(html);
    const outcome = clickCoursesUChoice(0, 'Choisir Hyper U - Hanches');
    expect(outcome).toEqual({ clicked: true });
  });

  it('refuse de cliquer quand la liste a été re-rendue et que le libellé a changé', () => {
    // Sans cette garde, l'index 0 capturé sur la liste précédente ferait
    // valider silencieusement un AUTRE magasin — donc tous les prix comparés
    // ensuite viendraient du mauvais drive.
    installGlobals(html);
    const outcome = clickCoursesUChoice(0, 'Choisir Hyper U - Chartres');
    expect(outcome).toEqual({ clicked: false, code: 'STORE_RESULT_STALE' });
  });

  it('signale un index devenu hors limites au lieu de renvoyer un échec muet', () => {
    installGlobals(html);
    expect(clickCoursesUChoice(9, 'Choisir Hyper U - Hanches')).toEqual({
      clicked: false,
      code: 'STORE_RESULT_STALE'
    });
  });
});

// Le handler du bouton flottant "✓ Valider ce produit" embarque une COPIE
// manuelle du corps de readCoursesUProductPageOnPage : une fonction injectée
// via scripting.executeScript ne peut appeler aucune autre fonction du module
// (voir le commentaire au-dessus de armCoursesUFloatingPickButtonOnPage). Rien
// n'empêchait jusqu'ici les deux copies de diverger silencieusement — un
// correctif appliqué à l'une seule (prix, EAN, disponibilité, détection de
// captcha) laissait le pick manuel se comporter différemment du scraping
// automatique, sans qu'aucun test ne le signale. Ces tests comparent les deux
// lectures sur le MÊME DOM et échouent dès qu'elles divergent.
describe('Parité bouton flottant ↔ readCoursesUProductPageOnPage', () => {
  function pickViaFloatingButton() {
    armCoursesUFloatingPickButtonOnPage();
    const button = document.getElementById('drive-price-splitter-float-pick');
    expect(button).not.toBeNull();
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return dom.window.__drivePriceSplitterPick ?? null;
  }

  const cases = [
    [
      'fiche produit standard (data-item-price + tuile)',
      `
        <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
        <div data-tc-product-tile='{"name":"Lait demi écrémé UHT LAIT D&apos;ICI, 6x1l","EAN":"3256224234494"}'>
          <button class="pdp-add-to-cart" aria-label="Bouton ajouter le produit au panier"></button>
        </div>
        <div class="actions-container-price">
          <span class="sale-price" data-item-price="5.64">5,64 €</span>
          <span class="unit-info">0,94 €/l</span>
        </div>
      `
    ],
    [
      'fiche sans tuile ni JSON-LD (repli DOM)',
      `
        <h1>Emmental râpé U, 200g</h1>
        <div class="actions-container-price"><span>2,45 €</span></div>
      `
    ],
    [
      'fiche en rupture de stock',
      `
        <h1>Beurre doux U, 250g</h1>
        <div class="actions-container-price">
          <span class="sale-price" data-item-price="2.10">2,10 €</span>
          <span>Produit indisponible</span>
        </div>
      `
    ],
    [
      'fiche dont le texte contient un montant trompeur avant le prix réel',
      // Fixture discriminante : le premier montant du texte (bulle promo)
      // n'est PAS le prix de l'article. Seul le palier data-item-price donne
      // la bonne valeur — si une des deux copies perd ce palier, les deux
      // lectures divergent et ce test le voit.
      `
        <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
        <p>Soit 2,12 € d'économie sur ce lot.</p>
        <div class="actions-container-price">
          <span class="sale-price" data-item-price="5.64">5,64 €</span>
        </div>
      `
    ],
    ['page bloquée par un captcha', `<h1>Vérification</h1><p>Merci de résoudre ce captcha.</p>`],
    ['page 404', `<h1>Page introuvable</h1><p>Erreur 404</p>`],
    [
      'fiche sans prix affiché',
      `<h1>Yaourt nature U, 8x125g</h1><p>Prix indisponible pour ce magasin.</p>`
    ]
  ];

  for (const [label, html] of cases) {
    it(`donne le même résultat que la lecture canonique — ${label}`, () => {
      installGlobals(html, 'https://www.coursesu.com/p/produit/1.html');
      const canonical = readCoursesUProductPageOnPage();
      const viaButton = pickViaFloatingButton();
      if (canonical.ok) {
        expect(viaButton).toEqual(canonical);
      } else {
        // Le handler n'expose rien quand la lecture échoue (il affiche
        // "✗ Produit non détecté" à la place) : l'absence de pick EST la
        // traduction attendue d'un `ok: false` côté canonique.
        expect(viaButton).toBeNull();
      }
    });
  }
});

// Signalé par l'utilisateur (2026-08-29) : le bouton de pick manuel restait
// affiché quelle que soit la page (grille de résultats comprise), avec le
// risque de silencieusement lire la première tuile produit de la page au
// lieu du produit voulu. Corrigé en restreignant l'affichage à une vraie
// fiche produit standalone (URL contenant "/p/").
describe('armCoursesUFloatingPickButtonOnPage — garde-fou de page', () => {
  const html = `
    <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
    <div class="actions-container-price"><span class="sale-price" data-item-price="5.64">5,64 €</span></div>
  `;
  const ID = 'drive-price-splitter-float-pick';

  it("n'affiche PAS le bouton sur une page de résultats de recherche", () => {
    installGlobals(html, 'https://www.coursesu.com/rechercher?q=lait');
    armCoursesUFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).toBeNull();
  });

  it('affiche le bouton sur une vraie fiche produit standalone', () => {
    installGlobals(html, 'https://www.coursesu.com/p/lait-dici/1.html');
    armCoursesUFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).not.toBeNull();
  });

  it("retire le bouton si l'utilisateur quitte la fiche produit pour une page de liste", () => {
    installGlobals(html, 'https://www.coursesu.com/p/lait-dici/1.html');
    armCoursesUFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).not.toBeNull();
    dom.reconfigure({ url: 'https://www.coursesu.com/rechercher?q=lait' });
    armCoursesUFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).toBeNull();
  });
});

describe('Injection isolation — lecteurs Courses U', () => {
  function rebuildFromSource(fn) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fn.toString()});`)();
  }

  it('readCoursesUProducts() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`
      <article>
        <a href="/p/lait-dici/1.html">Lait demi écrémé UHT LAIT D'ICI, 6x1l</a>
        <span>5,64 €</span>
      </article>
    `);
    const rebuilt = rebuildFromSource(readCoursesUProducts);
    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt().some((candidate) => /Lait demi/.test(candidate.name))).toBe(true);
  });

  it('readCoursesUProductPageOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <div class="actions-container-price"><span class="sale-price" data-item-price="5.64">5,64 €</span></div>
    `);
    const rebuilt = rebuildFromSource(readCoursesUProductPageOnPage);
    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt().priceEuro).toBeCloseTo(5.64);
  });

  it('armCoursesUFloatingPickButtonOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(
      `
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <div class="actions-container-price"><span class="sale-price" data-item-price="5.64">5,64 €</span></div>
    `,
      'https://www.coursesu.com/p/lait-dici/1.html'
    );
    const rebuilt = rebuildFromSource(armCoursesUFloatingPickButtonOnPage);
    expect(() => rebuilt()).not.toThrow();
    const button = document.getElementById('drive-price-splitter-float-pick');
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(dom.window.__drivePriceSplitterPick?.priceEuro).toBeCloseTo(5.64);
  });
});

describe('Repli DOM du prix — montants qui ne sont pas le prix de l’article', () => {
  // Ce repli ne sert que si data-item-price ET le JSON-LD ont échoué (site
  // modifié, ou magasin pas encore sélectionné). Il ne doit alors surtout pas
  // présenter un montant promotionnel comme s’il s’agissait du prix : un prix
  // faux est affiché comme certain et fausse la comparaison entre magasins.
  const cases = [
    ["bulle d'économie avant le prix", `Soit 2,12 € d'économie sur ce lot. Prix : 5,64 €`, 5.64],
    ['prix barré "au lieu de"', `Au lieu de 6,20 € — 5,64 €`, 5.64],
    ['seuil de livraison gratuite', `Livraison offerte dès 80,00 € d'achat. 5,64 €`, 5.64],
    ['prix au litre avant le prix total', `1,05 € / l 5,64 €`, 5.64],
    ['cagnotte fidélité', `Cagnotte 1,50 € créditée. 5,64 €`, 5.64]
  ];

  for (const [label, noise, expected] of cases) {
    it(`retient le prix de l'article et non le montant parasite — ${label}`, () => {
      installGlobals(`<h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1><p>${noise}</p>`);
      const result = readCoursesUProductPageOnPage();
      expect(result.ok).toBe(true);
      expect(result.priceEuro).toBeCloseTo(expected);
    });
  }
});

// Replis AJOUTÉS le 2026-08-28 : ils ne s’exécutent que si le chemin
// d’origine n’a rien donné. Ces tests simulent donc un coursesu.com dont la
// structure a changé (classes ou aria-label renommés) et vérifient que la
// lecture reste exacte au lieu de se dégrader silencieusement.
describe('Résistance à un changement de structure du site — replis', () => {
  it('lit le prix exact via data-item-price même si .actions-container-price a été renommée', () => {
    installGlobals(`
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <p>Prix conseillé 9,90 €</p>
      <div class="pdp-price-block"><span class="price-value" data-item-price="5.64">5,64 €</span></div>
    `);
    const result = readCoursesUProductPageOnPage();
    expect(result.ok).toBe(true);
    // Sans le repli, la lecture chutait jusqu’au parsing du texte affiché et
    // retenait le premier montant rencontré (9,90 €), soit un prix faux
    // présenté comme certain.
    expect(result.priceEuro).toBeCloseTo(5.64);
  });

  it('ignore un data-item-price appartenant à un carrousel de suggestions', () => {
    installGlobals(`
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <p>Prix : 5,64 €</p>
      <section class="product-carousel">
        <span class="sale-price" data-item-price="1.99">1,99 €</span>
      </section>
    `);
    const result = readCoursesUProductPageOnPage();
    expect(result.ok).toBe(true);
    expect(result.priceEuro).toBeCloseTo(5.64);
  });

  it('clique le bouton principal via .pdp-add-to-cart quand l’aria-label attendu a disparu', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <h1>Riz basmati 10 min LUSTUCRU 5x180g 900g</h1>
        <div class="product-button__bag pdp-add-to-cart" aria-label="Ajouter ce produit à mon panier"></div>
        <section class="carousel">
          <div class="product-button__bag" aria-label="Ajouter au panier Emmental râpé Président 150g"></div>
        </section>
      `);
      const [mainButton, carouselButton] = [...document.querySelectorAll('[aria-label]')].map(makeVisible);
      const clicks = [];
      mainButton.addEventListener('click', () => {
        clicks.push('main');
        mainButton.textContent = 'Ajouté';
      });
      carouselButton.addEventListener('click', () => clicks.push('carousel'));

      const promise = clickAddToCartOnCoursesUProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.added).toBe(true);
      expect(clicks).toEqual(['main']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ne clique rien plutôt que de deviner quand deux contrôles "ajouter au panier" cohabitent', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <h1>Riz basmati 10 min LUSTUCRU 5x180g 900g</h1>
        <div class="add-btn" aria-label="Ajouter au panier ce produit"></div>
        <div class="add-btn" aria-label="Ajouter au panier maintenant"></div>
      `);
      const clicks = [];
      [...document.querySelectorAll('[aria-label]')].map(makeVisible).forEach((element) => {
        element.addEventListener('click', () => clicks.push('click'));
      });

      const promise = clickAddToCartOnCoursesUProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      // Un ajout raté est rattrapable par l’utilisateur ; un mauvais produit
      // ajouté au panier réel ne l’est pas. En cas d’ambiguïté on échoue.
      expect(result).toEqual({ added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' });
      expect(clicks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Fiabilité de la quantité — stepper qui absorbe un clic', () => {
  function stepperPageHtml() {
    return `
      <h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
      <div class="quantity-selector">
        <input type="number" value="1" />
        <button aria-label="Augmenter la quantité">+</button>
      </div>
    `;
  }

  it('retente le clic tant que le compteur affiché n’a pas bougé', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(stepperPageHtml());
      const stepper = makeVisible(document.querySelector('button'));
      const field = document.querySelector('input');
      let clicks = 0;
      stepper.addEventListener('click', () => {
        clicks += 1;
        // Le site absorbe le tout premier clic (stepper re-rendu pendant la
        // mise à jour du panier) — comportement observé en conditions réelles.
        if (clicks === 1) return;
        field.value = String(Number(field.value) + 1);
      });

      const promise = clickAddToCartOnCoursesUProductPageOnPage(3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.added).toBe(true);
      expect(field.value).toBe('3');
      expect(clicks).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('n’ajoute aucune unité au-delà de la quantité demandée', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(stepperPageHtml());
      const stepper = makeVisible(document.querySelector('button'));
      const field = document.querySelector('input');
      field.value = '3';
      let clicks = 0;
      stepper.addEventListener('click', () => {
        clicks += 1;
        field.value = String(Number(field.value) + 1);
      });

      const promise = clickAddToCartOnCoursesUProductPageOnPage(3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.added).toBe(true);
      expect(field.value).toBe('3');
      expect(clicks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Canari de structure AJOUTÉ le 2026-08-28 : `priceSource` dit d'où vient le
// prix retenu. Il n'influence aucune décision — il sert à repérer que le site
// a changé pendant que la lecture fonctionne encore, au lieu de découvrir la
// dérive une fois qu'un prix faux est déjà affiché à l'utilisateur.
describe('Canari de structure — priceSource (Courses U)', () => {
  const cases = [
    [
      'bloc prix officiel intact',
      `<h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
       <div class="actions-container-price"><span class="sale-price" data-item-price="5.64">5,64 €</span></div>`,
      'item_price_attr'
    ],
    [
      'attribut présent mais bloc renommé',
      `<h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1>
       <div class="pdp-price-block"><span class="price-value" data-item-price="5.64">5,64 €</span></div>`,
      'item_price_attr_hors_bloc'
    ],
    [
      'plus aucun attribut ni JSON-LD',
      `<h1>Lait demi écrémé UHT LAIT D'ICI, 6x1l</h1><p>5,64 €</p>`,
      'texte_affiche'
    ]
  ];

  for (const [label, html, expected] of cases) {
    it(`signale la provenance du prix — ${label}`, () => {
      installGlobals(html);
      const result = readCoursesUProductPageOnPage();
      expect(result.ok).toBe(true);
      expect(result.priceEuro).toBeCloseTo(5.64);
      expect(result.priceSource).toBe(expected);
    });
  }
});

describe('Prix au litre/kilo sur les cartes de résultats (.unit-info)', () => {
  // Fixtures relevées sur une recherche réelle coursesu.com le 31/08/2026,
  // via inspection du DOM du téléphone : 24 blocs .unit-info sur une seule
  // page de résultats. Le collecteur ne les lisait pas, alors que la même
  // donnée était déjà exploitée sur la fiche produit — donc AUCUN prix
  // Hyper U collecté par recherche n'était vérifiable (9 snapshots sur 9 en
  // 'unknown' lors du test du 31/08).

  it('capture le prix au kilo affiché sur la carte', () => {
    installGlobals(`
      <article>
        <a href="/p/emmental-rape/1.html">Emmental râpé PRESIDENT 200g</a>
        <h3>Emmental râpé PRESIDENT 200g</h3>
        <span>2,50 €</span>
        <span class="unit-info su-font-open">4,99 €/kg</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.priceEuro).toBeCloseTo(2.5);
    expect(candidate.unitPriceEuro).toBeCloseTo(4.99);
    expect(candidate.unitPriceUnit).toBe('kg');
  });

  it('capture le prix au litre', () => {
    installGlobals(`
      <article>
        <a href="/p/lait/1.html">Lait demi écrémé 6x1L</a>
        <span>5,64 €</span>
        <span class="unit-info">0,94 €/l</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.unitPriceEuro).toBeCloseTo(0.94);
    expect(candidate.unitPriceUnit).toBe('L');
  });

  it('ramène un prix au centilitre à un prix au litre', () => {
    // Le prix de référence n'est pas toujours au litre : la conversion évite
    // de comparer un €/cl à un €/L, ce qui donnerait un écart de facteur 100
    // et donc un faux avertissement systématique.
    installGlobals(`
      <article>
        <a href="/p/sirop/1.html">Sirop de menthe 75cl</a>
        <span>2,25 €</span>
        <span class="unit-info">0,30 €/cl</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.unitPriceEuro).toBeCloseTo(30);
    expect(candidate.unitPriceUnit).toBe('L');
  });

  it('ignore la mention de poids estimé qui partage la classe .unit-info', () => {
    // Cas réel des produits pesés : la carte porte DEUX .unit-info, le prix
    // au kilo puis « Soit environ 216 g ». Retenir le premier bloc venu sans
    // vérifier qu'il contient un montant donnerait un prix unitaire absent
    // alors que la page l'affiche — ou pire, un nombre pris pour un prix.
    installGlobals(`
      <article>
        <a href="/p/jambon/1.html">Jambon à la coupe</a>
        <span>1,08 €</span>
        <span class="unit-info">Soit environ 216 g</span>
        <span class="unit-info">4,99 €/kg</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.priceEuro).toBeCloseTo(1.08);
    expect(candidate.unitPriceEuro).toBeCloseTo(4.99);
    expect(candidate.unitPriceUnit).toBe('kg');
  });

  it("ne retient pas un prix à la pièce comme prix au kilo", () => {
    // « 1,99 €/pce » est affiché dans le même bloc que les prix au kilo.
    // Le traiter comme un prix au kilo produirait un faux avertissement sur
    // tous les produits vendus à l'unité : une pièce ne dit rien du grammage.
    installGlobals(`
      <article>
        <a href="/p/salade/1.html">Salade batavia</a>
        <span>1,99 €</span>
        <span class="unit-info">1,99 €/pce</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.priceEuro).toBeCloseTo(1.99);
    expect(candidate.unitPriceEuro).toBeUndefined();
    expect(candidate.unitPriceUnit).toBeUndefined();
  });

  it("laisse le prix de l'article inchangé quand aucun prix unitaire n'est affiché", () => {
    // Non-régression stricte : l'ajout ne doit rien changer au prix retenu.
    installGlobals(`
      <article>
        <a href="/p/lait-dici/1.html">Lait demi écrémé UHT LAIT D'ICI, 6x1l</a>
        <span>5,64 €</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.priceEuro).toBeCloseTo(5.64);
    expect(candidate.unitPriceEuro).toBeUndefined();
  });

  it("n'attribue pas le prix au kilo comme prix de l'article", () => {
    // Le prix est extrait du texte ENTIER de la carte, prix au kilo compris,
    // et ne retient le bon montant que parce qu'il précède l'autre dans le
    // DOM (ordre vérifié en conditions réelles le 31/08). Ce test fige cette
    // dépendance : si elle se rompt, l'échec est ici et non en production.
    installGlobals(`
      <article>
        <a href="/p/emmental/1.html">Emmental râpé 200g</a>
        <span>2,50 €</span>
        <span class="unit-info">12,50 €/kg</span>
      </article>
    `);
    const [candidate] = readCoursesUProducts();
    expect(candidate.priceEuro).toBeCloseTo(2.5);
    expect(candidate.unitPriceEuro).toBeCloseTo(12.5);
  });
});

describe('Instantané complet d’une carte de grille Hyper U', () => {
  it('récupère en une lecture les identifiants structurés, la marque, la promotion et la disponibilité', () => {
    installGlobals(`
      <article data-product-id="2100474" data-tc-product-tile='{"name":"Riz basmati 10 min LUSTUCRU 5x180g 900g","brand":"LUSTUCRU","EAN":"3760341070335"}'>
        <a href="/p/riz-basmati-10-min-lustucru-5x180g-900g/2100474.html">Riz basmati</a>
        <span class="prix-produit">3,32 €</span>
        <span class="unit-info">3,69 €/kg</span>
        <span class="promotion-label">Prix Carte U : -20%</span>
        <button aria-label="Ajouter au panier" disabled>Indisponible</button>
      </article>
    `);

    const [candidate] = readCoursesUProducts();
    expect(candidate).toMatchObject({
      name: 'Riz basmati 10 min LUSTUCRU 5x180g 900g',
      brand: 'LUSTUCRU',
      barcode: '3760341070335',
      externalProductId: '2100474',
      priceEuro: 3.32,
      unitPriceEuro: 3.69,
      unitPriceUnit: 'kg',
      available: false,
      promotionLabel: 'Prix Carte U : -20%'
    });
  });

  it('déduplique les sélecteurs imbriqués qui décrivent le même produit', () => {
    installGlobals(`
      <article>
        <div data-product-id="2100474" data-tc-product-tile='{"name":"Riz basmati LUSTUCRU 900g","brand":"LUSTUCRU","EAN":"3760341070335"}'>
          <a href="/p/riz-basmati/2100474.html">Riz basmati LUSTUCRU 900g</a>
          <span>3,32 €</span><span class="unit-info">3,69 €/kg</span>
        </div>
      </article>
    `);
    const candidates = readCoursesUProducts();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ externalProductId: '2100474', barcode: '3760341070335' });
  });
});
