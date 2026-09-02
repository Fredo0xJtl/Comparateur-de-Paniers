import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  armLeclercFloatingPickButtonOnPage,
  chooseLeclercProductCandidate,
  clickAddToCartOnLeclercProductPageOnPage,
  clickAddToCartOnMatchedLeclercCardOnPage,
  clickDriveChoiceOnPage,
  collectLeclercStoreBlocks,
  inspectLeclercResultsOnPage,
  readDriveChoicesOnPage,
  readLeclercProductPageOnPage,
  readLeclercSessionStateOnPage,
  readProductCandidatesOnPage,
  startProductSearchOnPage,
  submitPostalOnPage
} from './leclerc-collector.js';

// These fixtures are trimmed extracts of the real DOM captured live from
// leclercdrive.fr (mobile viewport, 2026-07-19). They exist to catch the exact
// regressions found during that session: the site now renders store choices
// as clickable data-track-libelle divs (not <a> links), and the postal
// autocomplete is a React (HeadlessUI) combobox that ignores a bare .click().

let dom;

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

function installGlobals(html, url = 'https://www.leclercdrive.fr/') {
  dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
  globalThis.Event = dom.window.Event;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  // JSDOM doesn't implement CSS.escape; the production code (running in a
  // real browser) always has it, so a minimal polyfill is enough here.
  globalThis.CSS = { escape: (value) => String(value).replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`) };
}

// JSDOM ne fait aucun layout réel : `offsetParent`/`getClientRects()` valent
// toujours null/vide, donc `isVisible()` (utilisé partout dans le code réel)
// ne peut jamais être vrai sans aide. On simule "affiché à l'écran" en
// définissant `offsetParent` sur l'élément — c'est le même signal que le code
// de production lit (voir aussi leclerc-search-input.test.js).
function makeVisible(element) {
  if (element) {
    Object.defineProperty(element, 'offsetParent', { value: dom.window.document.body, configurable: true });
  }
  return element;
}

describe('Leclerc real-DOM regression (data-track-libelle store blocks)', () => {
  it('reads the current store blocks with their postal code, ignoring marketing cards', () => {
    installGlobals(`
      <div data-track-libelle="Clic bloc magasin Belleville - Les Bâtes (99000)" data-track-categorie="Drive">
        99000 Belleville - Les Bâtes Distance 1,4 km Drive Livraison à domicile
      </div>
      <div data-track-libelle="Clic bloc magasin Belleville - Le Parc (99000)" data-track-categorie="Drive">
        99000 Belleville - Le Parc Distance 2 km Drive Livraison à domicile
      </div>
      <div data-track-libelle="Filtre Drive" data-track-categorie="Drive">Drive</div>
      <a href="/conseils-drive/drive-faire-ses-courses-au-Drive.aspx">
        <h2>Drive</h2><p>Récupérez votre commande en voiture</p>
      </a>
    `);

    const choices = readDriveChoicesOnPage('99000');

    // Only the two real store blocks should surface — not the filter pill.
    expect(choices).toHaveLength(2);
    expect(choices[0].controlText).toBe('Belleville - Les Bâtes (99000)');
    expect(choices[0].postalMatch).toBe(true);
    expect(choices[1].controlText).toBe('Belleville - Le Parc (99000)');
  });

  it('falls back to legacy h2/h3 service cards when no store block exists', () => {
    installGlobals(`
      <a href="/conseils-drive/drive-faire-ses-courses-au-Drive.aspx">
        <h2>Drive</h2><p>Récupérez votre commande en voiture</p>
      </a>
      <a href="/conseils-drive/drive-retrait-pieton-leclerc-drive.aspx">
        <h2>Retrait piéton</h2><p>Récupérez votre commande à pied</p>
      </a>
    `);

    const blocks = collectLeclercStoreBlocks();
    expect(blocks).toHaveLength(2);
    expect(blocks[0].controlText).toBe('Drive');
  });

  it('clicking a store block dispatches a full pointer sequence and reports the resulting host', async () => {
    installGlobals(`
      <div data-track-libelle="Clic bloc magasin Belleville - Le Parc (99000)" data-track-categorie="Drive">
        99000 Belleville - Le Parc Distance 2 km
      </div>
    `);

    const clickedTypes = [];
    const block = document.querySelector('[data-track-libelle]');
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      block.addEventListener(type, () => clickedTypes.push(type));
    }

    // location.hostname stays www.leclercdrive.fr (JSDOM default for this
    // fixture's URL), matching the real site's behavior observed live: the
    // block click reveals a "Commencer mes courses" control rather than
    // navigating straight to the transactional host.
    const result = await clickDriveChoiceOnPage(0);

    expect(clickedTypes).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(result.clicked).toBe(false);
    expect(result.code).toBe('DRIVE_START_CONTROL_NOT_FOUND');
  });

  it('selects the highest-scored autocomplete option and dispatches a full pointer sequence (React combobox)', async () => {
    installGlobals(`
      <input id="wpad-recherche-magasin-input" placeholder="Où souhaitez-vous récupérer vos courses ?" />
      <div role="option">Belleville, Eure-et-Loir (99000)</div>
      <div role="option">Anet (28260)</div>
    `);

    const clickedTypes = [];
    const options = [...document.querySelectorAll('[role="option"]')];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      options[0].addEventListener(type, () => clickedTypes.push(type));
    }

    const result = await submitPostalOnPage({ postalCode: '99000', city: 'Belleville' });

    expect(result.started).toBe(true);
    expect(result.selectedLocation).toBe('Belleville, Eure-et-Loir (99000)');
    // A bare .click() alone would not exercise this path in the real HeadlessUI
    // combobox — the fix dispatches the full pointer sequence instead.
    expect(clickedTypes).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });
});

describe('Leclerc real-DOM regression (product search results, Angular 16 vignette-prix)', () => {
  // Trimmed extract of the real resultsContainerHtmlSnippet captured live
  // via the extension's own diagnostic export (2026-07-29, "Lait
  // demi-écrémé UHT" search, 28 résultats affichés). Reproduces the exact
  // mix of empty lazy-load placeholders ("-vide") and rendered cards that
  // real users hit — the diagnostic reported PRODUCT_NOT_FOUND despite this
  // page clearly showing a priced result, which this test is meant to catch.
  const realSearchResultsHtml = `
    <div cwcrs304_conteneurrechercheproduits class="ng-star-inserted">
      <cwcrs320_enteteliste ecran="recherche">
        <header class="en-tete-liste recherche ng-star-inserted">
          <p class="nombre-resultats ng-star-inserted"><strong>28</strong> résultats affichés pour <strong>"Lait demi-écrémé UHT"</strong></p>
        </header>
      </cwcrs320_enteteliste>
      <div cwcrs331_listeelementspresentation>
        <ul class="clearfix liste-produit ng-star-inserted">
          <li class="ng-star-inserted">
            <div class="liste-element-presentation-container">
              <div cwcrs331_listeelementspresentation class="liste-element-presentation ng-star-inserted">
                <ul class="clearfix liste-produit ng-star-inserted">
                  <li class="ng-star-inserted">
                    <div class="liste-produit-element-vide v-produit-2613 v-sousfamille-284377 ng-star-inserted"></div>
                  </li>
                  <li class="ng-star-inserted">
                    <div class="liste-produit-element-vide v-produit-2612 v-sousfamille-284377 ng-star-inserted"></div>
                  </li>
                  <li class="ng-star-inserted">
                    <div class="ng-star-inserted">
                      <div class="liste-produit-element v-produit-5823 v-sousfamille-284377 ng-star-inserted">
                        <div cwcrs306_vignetteproduit class="ng-star-inserted">
                          <div class="divCssActiveYesNo"></div>
                          <div class="vignette-produit">
                            <div class="vignette-descriptif">
                              <p>Lait demi-écrémé Lactel Vitamine D Bouteille - 6x50cl</p>
                            </div>
                            <img alt="" class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=2993403">
                            <div class="vignette-prix-ajout clearfix">
                              <div class="vignette-prix">
                                <p class="ng-star-inserted"> 5,99 €</p>
                                <p class="vignette-prix-unitaire vignette-prix-unitaire-block ng-star-inserted">
                                  <span class="ng-star-inserted">2,00 € / l</span>
                                </p>
                              </div>
                              <div class="vignette-mentions"></div>
                              <div cwcrs311_plusmoinscomponent class="ng-star-inserted">
                                <div class="ng-star-inserted"><a href="#" class="vignette-ajout"></a></div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                </ul>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </div>
  `;

  it('extracts price and name from a real Angular 16 result card (.vignette-prix)', () => {
    installGlobals(realSearchResultsHtml);

    const candidates = readProductCandidatesOnPage();

    const match = candidates.find((c) => /Lactel Vitamine D/.test(c.name));
    expect(match).toBeDefined();
    expect(match.priceEuro).toBe(5.99);
  });

  it('does not mistake an empty lazy-load placeholder for a real product', () => {
    installGlobals(realSearchResultsHtml);

    const candidates = readProductCandidatesOnPage();

    // Only the one fully-rendered card should surface — not the two
    // "-vide" placeholders that haven't scrolled into view yet.
    for (const candidate of candidates) {
      expect(candidate.name).not.toMatch(/^\s*$/);
    }
  });

  // Diagnostic terrain v0.5.73 : le sélecteur `[class*="liste-produit-element"]`
  // capturait aussi `liste-produit-element-presentation-container`, puis le
  // fallback générique reprenait les <li> parents. Le nom, le prix et l'URL de
  // plusieurs cartes se retrouvaient alors fusionnés dans un faux produit.
  it('ne remonte que les cartes produit feuilles, jamais leurs conteneurs multi-produits', () => {
    installGlobals(`
      <div class="liste-produit-element-presentation-container">
        <ul class="liste-produit">
          <li>
            <div class="liste-produit-element v-produit-1">
              <div class="vignette-descriptif"><p>Boisson soja nature Végé - 1L</p></div>
              <div class="vignette-prix"><p>1,55 €</p><p>1,55 € / l</p></div>
            </div>
          </li>
          <li>
            <div class="liste-produit-element v-produit-2">
              <div class="vignette-descriptif"><p>Dessert soja chocolat - 200g</p></div>
              <div class="vignette-prix"><p>0,85 €</p><p>4,25 € / kg</p></div>
            </div>
          </li>
        </ul>
      </div>
    `, 'https://fd7-courses.leclercdrive.fr/magasin-1/recherche/soja');

    const candidates = readProductCandidatesOnPage();

    expect(candidates.map(({ name, priceEuro }) => ({ name, priceEuro }))).toEqual([
      { name: 'Boisson soja nature Végé - 1L', priceEuro: 1.55 },
      { name: 'Dessert soja chocolat - 200g', priceEuro: 0.85 }
    ]);
  });

  it('ignore aussi un conteneur portant lui-même la classe de carte quand il contient une carte plus précise', () => {
    installGlobals(`
      <div class="liste-produit-element v-produit-999999">
        <div class="liste-produit-element v-produit-5870">
          <div class="vignette-descriptif">
            <p>Boisson soja nature Végé 1L</p>
            <p>Végé - 200g</p>
          </div>
          <img class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=5870&amp;cat=p">
          <div class="vignette-prix"><p>0,85 €</p><p>0,85 € / l</p></div>
        </div>
      </div>
    `, 'https://fd7-courses.leclercdrive.fr/magasin-1/recherche/soja');

    const candidates = readProductCandidatesOnPage();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      name: 'Boisson soja nature Végé 1L',
      priceEuro: 0.85,
      unitPriceEuro: 0.85,
      unitPriceUnit: 'L'
    });
    expect(candidates[0].productUrl).toContain('fiche-produits-5870-');
  });

  it('retire le suffixe de conditionnement contradictoire dupliqué par Leclerc', () => {
    installGlobals(`
      <div class="liste-produit-element v-produit-5870">
        <div class="vignette-descriptif"><p>Boisson soja nature Végé 1L Végé - 200g</p></div>
        <img class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=5870&amp;cat=p">
        <div class="vignette-prix"><p>0,85 €</p><p>0,85 € / l</p></div>
      </div>
    `, 'https://fd7-courses.leclercdrive.fr/magasin-1/recherche/soja');

    const [candidate] = readProductCandidatesOnPage();

    expect(candidate.name).toBe('Boisson soja nature Végé 1L');
    expect(candidate.priceEuro).toBe(0.85);
  });

  // Reproduit le bug racine confirmé par diagnostic réel (30/08, "Purée
  // instantanée" / "Boisson soja nature" sur une page Datadome dégradée) :
  // `.textContent` sur un élément inclut TOUJOURS le texte de n'importe quel
  // <script>/<style> descendant (spec DOM standard) — un script de challenge
  // injecté par Datadome pendant que la vraie liste de résultats n'a pas
  // encore chargé pouvait donc se retrouver capté comme "nom de produit" par
  // le repli price-leaf, ci-dessous, aussi bien que par les autres replis.
  // Sans garde, un tel candidat parasite (sans rapport avec un vrai produit)
  // empêchait aussi à tort la détection de page bloquée de se déclencher,
  // puisqu'il comptait comme "1 candidat trouvé" à chaque tour.
  it('ignore un candidat dont le texte provient d\'un <script> injecté (Datadome) plutôt que d\'une vraie carte produit', () => {
    installGlobals(`
      <body>
        <script>window.ddjskey = "8FE0CF7F8AB30EC588599D8046ED0E"; window.ddoptions = { ajaxListenerPath: "leclercdrive" };</script>
        <div class="panier-total">0,00 €</div>
      </body>
    `);

    const candidates = readProductCandidatesOnPage();

    for (const candidate of candidates) {
      expect(candidate.name).not.toMatch(/ddjskey|ddoptions|window\./);
    }
  });

  it('end-to-end: the real product this search was for actually gets chosen', () => {
    // Reproduces the exact real-world query reported as PRODUCT_NOT_FOUND
    // despite the page clearly showing a matching, priced card.
    installGlobals(realSearchResultsHtml);

    const candidates = readProductCandidatesOnPage();
    const chosen = chooseLeclercProductCandidate(
      { productId: 'prod-lait-demi-ecreme', name: 'Lait demi-écrémé UHT', brand: '' },
      candidates
    );

    expect(chosen).not.toBeNull();
    expect(chosen?.priceEuro).toBe(5.99);
  });

  // Capture DOM live (2026-08-27, magasin Belleville - Le Parc, recherche "lait
  // demi ecreme uht") : leclercdrive.fr sert aussi ce template classique
  // (pWCRS310_*, ids WRSL/WCRS façon ASP.NET WebForms) en plus du template
  // Angular 16 déjà couvert ci-dessus. Le prix total y est éclaté sur 3
  // éléments (partie entière / € / partie décimale) dans .divWCRS310_PrixUnitaire,
  // et le prix au litre/kg est un élément frère séparé (.pWCRS310_PrixUniteMesure,
  // "1,05 € / l") — vérifié qu'ils ne se confondent jamais.
  it('extrait le prix total (pas le prix au litre) du template classique pWCRS310_*', () => {
    installGlobals(`
      <ul>
        <li class="liWCRS310_Product" data-vignette="disponible">
          <div class="divWCRS310_Content">
            <p class="pWCRS310_Desc">
              <a class="aWCRS310_Product">Lait demi-écrémé UHT Délisse<br>Bouteille - 6x1L</a>
            </p>
            <div class="divWCRS310_PrixUnitaire">
              <p class="pWCRS310_PrixUnitairePartieEntiere">6</p>
              <p class="pWCRS310_SigleMonetaire">€</p>
              <p class="pWCRS310_PrixUnitairePartieDecimale">,30</p>
            </div>
            <div><p class="pWCRS310_PrixUniteMesure">1,05 € / l</p></div>
          </div>
        </li>
      </ul>
    `);

    const candidates = readProductCandidatesOnPage();

    const match = candidates.find((c) => /Lait demi-écrémé UHT Délisse/.test(c.name));
    expect(match).toBeDefined();
    expect(match.priceEuro).toBe(6.3);
    expect(match.unitPriceEuro).toBe(1.05);
    expect(match.unitPriceUnit).toBe('L');
  });

  // Régression réelle (2026-08-27, même bug que sur Hyper U) : quand aucun
  // sélecteur CSS dédié au prix (.vignette-prix, PrixUnitairePartieEntiere,
  // strong/em[class*=prix]) n'est présent sur la carte, le dernier recours
  // scannait le parcmier montant "X,XX €" du texte — qui peut être le prix
  // de référence au litre/kg plutôt que le prix réel de l'article.
  it("ignore le prix au litre/kg dans le filet de secours quand aucun sélecteur CSS dédié n'est présent", () => {
    installGlobals(`
      <li data-product-id="999">
        Lait UHT demi écrémé 6 briques de 1L Soit 1,90 €/L 11,40 €
      </li>
    `);

    const candidates = readProductCandidatesOnPage();

    const match = candidates.find((c) => /Lait UHT/.test(c.name));
    expect(match).toBeDefined();
    expect(match.priceEuro).toBe(11.4);
    expect(match.unitPriceEuro).toBe(1.9);
    expect(match.unitPriceUnit).toBe('L');
  });

  // Régression réelle (2026-08-28, ajout au panier Leclerc, "Boisson soja
  // nature") : le SPA m-courses.leclercdrive.fr pousse parfois une page de
  // résultats dont le pathname est encodé DEUX FOIS ("%2520" au lieu de
  // "%20") — la page atterrit sur un contenu générique sans aucune carte ni
  // bannière "Aucun résultat", faisant échouer la recherche en silence
  // jusqu'à épuisement du budget de temps. Sans correction, cette carte
  // (pourtant bien présente dans le HTML) n'était jamais lue.
  it('corrige un pathname doublement encodé et renvoie 0 candidat plutôt que de scanner une page cassée', () => {
    installGlobals(
      `
        <div class="liste-produit-element">
          <div class="vignette-descriptif">Boisson soja nature</div>
          <div class="vignette-prix"><p>2,10 €</p></div>
        </div>
      `,
      'https://m-courses.leclercdrive.fr/magasin-123456-123456/recherche/Boisson%2520soja%2520nature'
    );
    // jsdom ne permet pas de redéfinir location.assign (propriété non
    // configurable sur son prototype) — le comportement observable vérifié
    // ici est donc l'essentiel : ne jamais scanner cette page cassée comme
    // si elle contenait légitimement 0 résultat (ce qui produirait à tort
    // CART_PRODUCT_NOT_FOUND/PRODUCT_NOT_FOUND immédiat côté appelant, sans
    // laisser à waitForProductCandidates la chance de relire la page après
    // correction). jsdom logue un avertissement "Not implemented:
    // navigation" en console pour l'appel à location.assign déclenché par
    // le code testé — attendu, sans incidence sur ce test.
    const candidates = readProductCandidatesOnPage();

    expect(candidates).toEqual([]);
  });

  // Régression réelle (2026-08-28, ajout au panier Leclerc, "Boisson soja
  // nature") : sur la route mobile /magasin-.../recherche/<query>, les
  // cartes réelles étaient encore de simples placeholders vides
  // ("liste-produit-element-vide", lazy-load pas encore déclenché). Le
  // fallback "lien produit" scannait alors TOUT le document, remontait le
  // lien de pied de page "Rappel produit" (obligation légale, href contenant
  // "produit") jusqu'à un ancêtre commun englobant l'en-tête — qui affiche
  // toujours le total panier ("0,00 €") — et le retournait comme UNIQUE
  // candidat. waitForProductCandidates considérait alors la recherche
  // terminée dès ce premier candidat non vide, sans jamais laisser sa chance
  // au lazy-load des vraies cartes.
  it('ignore un lien de pied de page hors de la zone de résultats même s\'il contient "produit" et un total panier ailleurs sur la page', () => {
    installGlobals(`
      <header>Mon panier : 0,00 €</header>
      <ul class="liste-produit">
        <li class="liste-produit-element-vide v-produit-5870"></li>
        <li class="liste-produit-element-vide v-produit-51979"></li>
      </ul>
      <section class="liens-footer">
        <ul class="liens-liste">
          <li><a class="lien-footer" href="/rappel-produit">Rappel produit</a></li>
        </ul>
      </section>
    `);

    const candidates = readProductCandidatesOnPage();

    expect(candidates).toEqual([]);
  });
});

describe('clickAddToCartOnMatchedLeclercCardOnPage', () => {
  function twoCardsHtml() {
    return `
      <div class="liste-produit-element">
        <div class="vignette-descriptif">Lait demi-écrémé Lactel 6x1L</div>
        <div class="vignette-prix-ajout"><div class="vignette-prix"><p>5,99 €</p></div>
          <a class="vignette-ajout" aria-label="Ajouter au panier"></a>
        </div>
      </div>
      <div class="liste-produit-element">
        <div class="vignette-descriptif">Jus de pomme Andros 1L</div>
        <div class="vignette-prix-ajout"><div class="vignette-prix"><p>1,80 €</p></div>
          <a class="vignette-ajout" aria-label="Ajouter au panier"></a>
        </div>
      </div>
    `;
  }

  it('clique le bouton "ajouter" de la carte appariée, jamais celui d’une carte voisine', async () => {
    installGlobals(twoCardsHtml());
    const [matchedButton, otherButton] = [...document.querySelectorAll('.vignette-ajout')].map(makeVisible);
    const clicksOnMatched = [];
    const clicksOnOther = [];
    matchedButton.addEventListener('click', () => {
      clicksOnMatched.push('click');
      matchedButton.textContent = 'Ajouté';
    });
    otherButton.addEventListener('click', () => clicksOnOther.push('click'));

    const result = await clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);

    expect(result).toEqual({ added: true });
    expect(clicksOnMatched).toEqual(['click']);
    expect(clicksOnOther).toEqual([]);
  });

  it('renvoie CART_CARD_NOT_FOUND quand aucune carte ne correspond au produit attendu', async () => {
    installGlobals(twoCardsHtml());

    const result = await clickAddToCartOnMatchedLeclercCardOnPage('Produit totalement inconnu 9999', NaN, 1);

    expect(result).toEqual({ added: false, code: 'CART_CARD_NOT_FOUND' });
  });

  it('renvoie ADD_TO_CART_CONTROL_NOT_FOUND quand la carte matche mais n’a pas de contrôle "ajout" visible', async () => {
    installGlobals(`
      <div class="liste-produit-element">
        <div class="vignette-descriptif">Lait demi-écrémé Lactel 6x1L</div>
        <div class="vignette-prix-ajout"><div class="vignette-prix"><p>5,99 €</p></div></div>
      </div>
    `);

    const result = await clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);

    expect(result).toEqual({ added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' });
  });

  it("renvoie CART_ADD_NOT_CONFIRMED quand le clic ne change ni le bouton ni ne fait apparaître de stepper", async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoCardsHtml());
      [...document.querySelectorAll('.vignette-ajout')].forEach(makeVisible);
      const promise = clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: false, code: 'CART_ADD_NOT_CONFIRMED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirme l’ajout via l’apparition d’un stepper "+" même si le texte du bouton "ajout" ne change pas', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoCardsHtml());
      const [matchedButton] = [...document.querySelectorAll('.vignette-ajout')].map(makeVisible);
      const card = matchedButton.closest('.liste-produit-element');
      matchedButton.addEventListener('click', () => {
        const stepper = document.createElement('button');
        stepper.textContent = '+';
        card.appendChild(stepper);
        makeVisible(stepper);
      });

      const promise = clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirme le stepper Leclerc réel rendu avec des liens et lit sa quantité affichée', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoCardsHtml());
      const [matchedButton] = [...document.querySelectorAll('.vignette-ajout')].map(makeVisible);
      const card = matchedButton.closest('.liste-produit-element');
      matchedButton.addEventListener('click', () => {
        const controls = document.createElement('div');
        controls.className = 'vignette-modifier-quantite';
        controls.innerHTML = `
          <a href="#" class="vignette-modifier-retirer">-</a>
          <span class="vignette-modifier-nombre">1</span>
          <a href="#" class="vignette-modifier-ajouter">+</a>
        `;
        card.appendChild(controls);
        [...controls.querySelectorAll('a')].forEach(makeVisible);
      });

      const promise = clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('quantity: 3 déclenche exactement 2 clics supplémentaires sur le stepper', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(twoCardsHtml());
      const [matchedButton] = [...document.querySelectorAll('.vignette-ajout')].map(makeVisible);
      const card = matchedButton.closest('.liste-produit-element');
      const stepper = makeVisible(document.createElement('button'));
      stepper.textContent = '+';
      let stepperClicks = 0;
      stepper.addEventListener('click', () => {
        stepperClicks += 1;
      });
      matchedButton.addEventListener('click', () => card.appendChild(stepper));

      const promise = clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
      expect(stepperClicks).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Point mort corrigé le 2026-08-27 : un produit déjà dans le panier (ex.
  // remplissage précédent interrompu puis repris) n'affiche plus de bouton
  // "Ajouter" sur sa carte, seulement le stepper +/-. Avant ce correctif, ce
  // cas ressortait à tort en ADD_TO_CART_CONTROL_NOT_FOUND — un succès
  // déguisé en échec.
  it('traite un produit déjà présent (stepper visible, pas de bouton "ajouter") comme un succès direct, sans tenter de clic', async () => {
    installGlobals(`
      <div class="liste-produit-element">
        <div class="vignette-descriptif">Lait demi-écrémé Lactel 6x1L</div>
        <div class="vignette-prix-ajout"><div class="vignette-prix"><p>5,99 €</p></div>
          <button aria-label="Augmenter la quantité">+</button>
        </div>
      </div>
    `);
    const stepper = makeVisible(document.querySelector('button'));
    const stepperClicks = [];
    stepper.addEventListener('click', () => stepperClicks.push('click'));

    const result = await clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 1);

    expect(result).toEqual({ added: true });
    expect(stepperClicks).toEqual([]);
  });

  it('un produit déjà présent avec quantity: 3 déclenche exactement 2 clics sur le stepper existant', async () => {
    installGlobals(`
      <div class="liste-produit-element">
        <div class="vignette-descriptif">Lait demi-écrémé Lactel 6x1L</div>
        <div class="vignette-prix-ajout"><div class="vignette-prix"><p>5,99 €</p></div>
          <button aria-label="Augmenter la quantité">+</button>
        </div>
      </div>
    `);
    const stepper = makeVisible(document.querySelector('button'));
    let stepperClicks = 0;
    stepper.addEventListener('click', () => {
      stepperClicks += 1;
    });

    const result = await clickAddToCartOnMatchedLeclercCardOnPage('Lait demi-écrémé Lactel 6x1L', 5.99, 3);

    expect(result).toEqual({ added: true });
    expect(stepperClicks).toBe(2);
  });
});

// Bug rapporté en conditions réelles (2026-08-28) : après un pick manuel
// utilisateur sur la vraie fiche produit standalone Leclerc
// ("/fiche-produits-<id>-<slug>.aspx"), l'URL validée n'était jamais
// réellement utilisée par addToCartLeclercStore. readLeclercProductPageOnPage
// relit cette fiche pour vérifier qu'elle correspond encore au produit
// attendu avant tout clic — voir tryAddToCartLeclercViaProductUrl.
describe('readLeclercProductPageOnPage', () => {
  it('lit le nom et le prix via le palier "prix-actuel" (fiche standalone du template classique)', () => {
    installGlobals(`
      <h1>Boisson soja nature Vg 1L</h1>
      <div class="prix-actuel-partie-entiere">1</div>
      <div class="prix-actuel-partie-decimale">35</div>
      <div class="pWCRS310_PrixUniteMesure">1,35 € / l</div>
    `);

    expect(readLeclercProductPageOnPage()).toEqual({
      ok: true,
      name: 'Boisson soja nature Vg 1L',
      priceEuro: 1.35,
      unitPriceEuro: 1.35,
      unitPriceUnit: 'L',
      priceSource: 'standalone_classique'
    });
  });

  it('ignore le prix du carrousel de produits de substitution (crossell) et lit le prix du produit principal', () => {
    installGlobals(`
      <h1>Boisson soja nature Vg 1L</h1>
      <div class="pWCRS310_PrixUnitairePartieEntiere">1</div>
      <div class="pWCRS310_PrixUnitairePartieDecimale">35</div>
      <div id="ulCrossell" class="crossell">
        <div class="pWCRS310_PrixUnitairePartieEntiere">9</div>
        <div class="pWCRS310_PrixUnitairePartieDecimale">99</div>
      </div>
    `);

    expect(readLeclercProductPageOnPage()).toEqual({
      ok: true,
      name: 'Boisson soja nature Vg 1L',
      priceEuro: 1.35,
      priceSource: 'listing_classique'
    });
  });

  it('détecte un captcha et renvoie SITE_BLOCKED sans tenter de lire nom/prix', () => {
    // JSDOM ne calcule aucun layout réel : `innerText` (contrairement à
    // `textContent`) en dépend et reste vide sans aide — voir le commentaire
    // au-dessus de makeVisible() pour le même constat sur offsetParent.
    installGlobals(`<div>Merci de vérifier que vous êtes humain avant de continuer.</div>`);
    Object.defineProperty(document.body, 'innerText', {
      value: document.body.textContent,
      configurable: true
    });

    expect(readLeclercProductPageOnPage()).toEqual({ ok: false, code: 'SITE_BLOCKED' });
  });

  it("renvoie MANUAL_URL_PAGE_NOT_FOUND quand la page atteinte n'a aucune fiche produit exploitable (lien périmé redirigé)", () => {
    installGlobals(`<div>Contenu générique sans fiche produit</div>`);

    expect(readLeclercProductPageOnPage()).toEqual({ ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' });
  });
});

describe('clickAddToCartOnLeclercProductPageOnPage', () => {
  it('clique le bouton principal "aWCRS310_Add_Produit_Fiche", jamais un bouton du carrousel de substituts', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div id="ulCrossell" class="crossell">
          <a class="aWCRS310_Add" aria-label="Ajouter au panier substitut">Ajouter au panier</a>
        </div>
        <a class="aWCRS310_Add_Produit_Fiche">Ajouter au panier</a>
      `);
      const [crossellButton, mainButton] = [
        makeVisible(document.querySelector('.crossell .aWCRS310_Add')),
        makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'))
      ];
      const crossellClicks = [];
      mainButton.addEventListener('click', () => {
        mainButton.textContent = 'Ajouté';
      });
      crossellButton.addEventListener('click', () => crossellClicks.push('click'));

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
      expect(crossellClicks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('utilise le repli générique ("ajout" dans le texte/attributs) en excluant un contrôle du carrousel, quand la classe dédiée est absente', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="crossell"><button aria-label="Ajouter au panier substitut"></button></div>
        <button aria-label="Ajouter au panier">Ajouter</button>
      `);
      const [crossellButton, mainButton] = [document.querySelector('.crossell button'), document.querySelectorAll('button')[1]].map(
        makeVisible
      );
      const crossellClicks = [];
      mainButton.addEventListener('click', () => {
        mainButton.textContent = 'Ajouté';
      });
      crossellButton.addEventListener('click', () => crossellClicks.push('click'));

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
      expect(crossellClicks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cas réel du 01/09 : 5 produits sur 5 en CART_ADD_NOT_CONFIRMED, bouton
  // toujours présent. La fiche standalone est une page WebForms dont le HTML
  // (titre, prix, bouton) arrive complet dès la 1re réponse, alors que le
  // handler du bouton est attaché plus tard, en délégation jQuery sur
  // `document`. Le clic partait donc dans le vide.
  it('re-clique quand le parcmier clic est resté sans effet, et confirme via le cartouche panier', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="divWCRS319_CartouchePanier">0 Drive : 0,00 €</div>
        <a class="aWCRS310_Add_Produit_Fiche">Ajouter au panier</a>
      `);
      const button = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));
      const clicks = [];
      button.addEventListener('click', () => {
        clicks.push('click');
        // Le site n'écoute qu'à partir du 2e clic : le 1er est parti avant
        // que ses scripts ne soient prêts.
        if (clicks.length >= 2) {
          document.querySelector('.divWCRS319_CartouchePanier').textContent = '1 Drive : 7,29 €';
        }
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
      expect(clicks.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // BUG RÉEL DU 01/09 (quantités doublées dans le panier de l'utilisateur) :
  // après un ajout réussi, la fiche remplace "Ajouter au panier" par le stepper
  // <a href="#plus" class="aWCRS310_More_Produit_Fiche"> logé dans un bloc
  // "ajouterAuPanier-counter-bloc". L'extension ne reconnaissait pas ce
  // stepper, croyait avoir échoué, cherchait à nouveau un bouton "ajout" — et
  // le nom du bloc parent le lui faisait trouver DANS le stepper. Elle
  // cliquait donc "+", une unité de plus par tentative.
  it('ne prend jamais le "+" du stepper pour le bouton d\'ajout après un ajout réussi', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="ajouterAuPanier-counter-bloc">
          <a class="aWCRS310_Add_Produit_Fiche" href="#">Ajouter au panier</a>
          <a class="aWCRS310_Less_Produit_Fiche" href="#moins"></a>
          <span class="counter-value">1</span>
          <a class="aWCRS310_More_Produit_Fiche" href="#plus"></a>
        </div>
      `);
      const addButton = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));
      const plus = makeVisible(document.querySelector('.aWCRS310_More_Produit_Fiche'));
      let plusClicks = 0;
      plus.addEventListener('click', () => {
        plusClicks += 1;
      });
      // Ajout réussi : le site masque le bouton et laisse le stepper visible.
      addButton.addEventListener('click', () => {
        Object.defineProperty(addButton, 'offsetParent', { value: null, configurable: true });
        addButton.getClientRects = () => [];
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ added: true });
      // Le "+" ne doit JAMAIS avoir été cliqué : quantité demandée = 1.
      expect(plusClicks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Contrepartie du test précédent : le stepper seul, bouton d'ajout toujours
  // visible, ne doit pas faire conclure que le produit est déjà au panier —
  // ce serait un ajout jamais effectué rapporté comme un succès.
  it("ne conclut pas à un produit déjà au panier tant que le bouton d'ajout est visible", async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="ajouterAuPanier-counter-bloc">
          <a class="aWCRS310_Add_Produit_Fiche" href="#">Ajouter au panier</a>
          <a class="aWCRS310_More_Produit_Fiche" href="#plus"></a>
        </div>
      `);
      const addButton = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));
      makeVisible(document.querySelector('.aWCRS310_More_Produit_Fiche'));
      let addClicks = 0;
      addButton.addEventListener('click', () => {
        addClicks += 1;
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      // Le bouton reste visible : le site n'a rien pris, donc échec explicite.
      expect(result.added).toBe(false);
      expect(result.code).toBe('CART_ADD_NOT_CONFIRMED');
      // Et le clic d'ajout a bien été tenté, plutôt qu'un succès inventé.
      expect(addClicks).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Garde anti-double-ajout : une tentative = UN seul mode d'activation.
  // La 1re simule un appui, la 2e utilise l'activation native element.click().
  // Si les deux partaient dans la même tentative, le site compterait deux
  // ajouts dans le panier réel de l'utilisateur.
  it("n'active le bouton qu'une fois par tentative, puis bascule sur le clic natif", async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="divWCRS310_Panier masquerPlusUnMoinsUn">
          <a class="aWCRS310_Add_Produit_Fiche" href="#">Ajouter au panier</a>
        </div>
      `);
      const bloc = document.querySelector('.divWCRS310_Panier');
      const addButton = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));
      let activations = 0;
      // Le site ne réagit qu'à l'activation native : la 1re tentative (appui
      // simulé) reste sans effet, la 2e passe.
      addButton.addEventListener('click', (event) => {
        activations += 1;
        if (event.detail === 0 && activations > 1) bloc.className = 'divWCRS310_Panier';
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ added: true });
      // Une activation par tentative, pas deux : 1 appui simulé + 1 clic natif.
      expect(activations).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // Régression observée EN DIRECT sur le téléphone (01/09) : le bandeau
  // "Dernière connexion le ..." (divWCTD224_PopinManager) recouvre la barre
  // fixe du bas qui porte le bouton "Ajouter au panier". Tant qu'il est là,
  // l'ajout ne part pas ; il a fallu le fermer à la main pour atteindre le
  // bouton. La structure reproduite ici est celle relevée dans le diagnostic
  // réel (bloc divWCRS310_Panier porteur de "masquerPlusUnMoinsUn" tant que le
  // produit n'est pas au panier).
  it("ferme le bandeau qui recouvre la barre d'ajout avant de cliquer", async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="divWCRS310_Panier masquerPlusUnMoinsUn">
          <a class="aWCRS310_Add_Produit_Fiche">Ajouter au panier</a>
        </div>
        <div class="divWCTD224_PopinManager">
          Dernière connexion le mardi 01/09/2026 à 22h18
          <span class="closePopin">×</span>
        </div>
      `);
      const popin = makeVisible(document.querySelector('.divWCTD224_PopinManager'));
      const closeControl = makeVisible(document.querySelector('.closePopin'));
      const bloc = document.querySelector('.divWCRS310_Panier');
      const addButton = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));

      closeControl.addEventListener('click', () => popin.remove());
      // Le site n'enregistre l'ajout que si le bandeau n'est plus là : c'est
      // exactement le comportement constaté sur la vraie fiche produit.
      addButton.addEventListener('click', () => {
        if (document.querySelector('.divWCTD224_PopinManager')) return;
        bloc.className = 'divWCRS310_Panier';
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ added: true });
      expect(document.querySelector('.divWCTD224_PopinManager')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  // Le site mobile de Leclerc (m-courses.leclercdrive.fr) n'a pas réagi aux
  // seuls événements souris : bon bouton, page complète, aucun effet
  // (diagnostic du 01/09). Un vrai appui sur mobile émet pointer + touch
  // AVANT les événements souris de compatibilité, dans cet ordre précis.
  it('émet un appui tactile complet (pointer, touch, puis souris) et non un simple clic souris', async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`
        <div class="divWCRS319_CartouchePanier">0 Drive : 0,00 €</div>
        <a class="aWCRS310_Add_Produit_Fiche">Ajouter au panier</a>
      `);
      // JSDOM n'implémente ni PointerEvent ni TouchEvent : on les remplace
      // par des équivalents minimaux pour pouvoir observer la séquence.
      globalThis.PointerEvent = dom.window.MouseEvent;
      globalThis.Touch = class {
        constructor(init) {
          Object.assign(this, init);
        }
      };
      globalThis.TouchEvent = class extends dom.window.Event {
        constructor(type, init) {
          super(type, init);
        }
      };
      const button = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));
      const seen = [];
      for (const type of ['pointerdown', 'touchstart', 'pointerup', 'touchend', 'mousedown', 'mouseup', 'click']) {
        button.addEventListener(type, (event) => seen.push(event.type));
      }
      button.addEventListener('click', () => {
        document.querySelector('.divWCRS319_CartouchePanier').textContent = '1 Drive : 7,29 €';
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
      expect(seen).toEqual([
        'pointerdown',
        'touchstart',
        'pointerup',
        'touchend',
        'mousedown',
        'mouseup',
        'click'
      ]);
    } finally {
      delete globalThis.PointerEvent;
      delete globalThis.Touch;
      delete globalThis.TouchEvent;
      vi.useRealTimers();
    }
  });

  // Garde-fou : re-cliquer à l'aveugle sur une page dont on ne sait pas lire
  // l'état du panier peut ajouter le produit deux fois dans le panier RÉEL de
  // l'utilisateur. Un échec signalé est préférable.
  it("ne re-clique pas quand le cartouche panier n'est pas lisible", async () => {
    vi.useFakeTimers();
    try {
      installGlobals(`<a class="aWCRS310_Add_Produit_Fiche">Ajouter au panier</a>`);
      const button = makeVisible(document.querySelector('.aWCRS310_Add_Produit_Fiche'));
      const clicks = [];
      button.addEventListener('click', () => clicks.push('click'));

      const promise = clickAddToCartOnLeclercProductPageOnPage(1);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(clicks).toEqual(['click']);
      expect(result.added).toBe(false);
      expect(result.code).toBe('CART_ADD_NOT_CONFIRMED');
      expect(result.details).toMatchObject({ attempts: 1, cartSignatureRead: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('renvoie ADD_TO_CART_CONTROL_NOT_FOUND quand le seul contrôle "ajout" visible appartient au carrousel', async () => {
    installGlobals(`<div class="crossell"><a class="aWCRS310_Add">Ajouter au panier</a></div>`);
    makeVisible(document.querySelector('.aWCRS310_Add'));

    const result = await clickAddToCartOnLeclercProductPageOnPage(1);

    expect(result).toEqual({ added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' });
  });

  // Même logique que clickAddToCartOnMatchedLeclercCardOnPage : un produit
  // déjà présent dans le panier (remplissage précédent interrompu puis
  // repris) n'affiche plus de bouton "Ajouter", seulement le stepper +/-.
  it('traite un produit déjà présent (stepper hors carrousel) comme un succès direct, en ignorant un stepper du carrousel', async () => {
    installGlobals(`
      <div class="crossell"><button aria-label="Augmenter la quantité">+</button></div>
      <button aria-label="Augmenter la quantité">+</button>
    `);
    const [crossellStepper, mainStepper] = [document.querySelector('.crossell button'), document.querySelectorAll('button')[1]].map(
      makeVisible
    );
    const crossellClicks = [];
    const mainClicks = [];
    crossellStepper.addEventListener('click', () => crossellClicks.push('click'));
    mainStepper.addEventListener('click', () => mainClicks.push('click'));

    const result = await clickAddToCartOnLeclercProductPageOnPage(3);

    expect(result).toEqual({ added: true });
    expect(crossellClicks).toEqual([]);
    expect(mainClicks).toEqual(['click', 'click']);
  });
});

describe('readLeclercSessionStateOnPage', () => {
  it('détecte un état connecté ("Mon compte")', () => {
    installGlobals(`<header><a href="/compte">Mon compte</a></header>`);
    makeVisible(document.querySelector('a'));
    // evidence est un code de motif détecté, jamais le texte réel du DOM
    // (audit sécurité du 30/08 — voir readLeclercSessionStateOnPage).
    expect(readLeclercSessionStateOnPage()).toEqual({ signedIn: true, evidence: 'mon_compte' });
  });

  it('détecte un état déconnecté ("Se connecter")', () => {
    installGlobals(`<header><a href="/connexion">Se connecter</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readLeclercSessionStateOnPage()).toEqual({ signedIn: false, evidence: 'se_connecter' });
  });

  it("ne reproduit jamais un prénom présent dans le contrôle détecté (audit sécurité 30/08)", () => {
    installGlobals(`<header><a href="/compte">Mon compte, Frédéric</a></header>`);
    makeVisible(document.querySelector('a'));
    const result = readLeclercSessionStateOnPage();
    expect(result).toEqual({ signedIn: true, evidence: 'mon_compte' });
    expect(result.evidence).not.toContain('Frédéric');
  });

  // Le cas le plus important à couvrir : sans signal net, on ne bloque
  // jamais le remplissage — un faux "pas connecté" serait pire que
  // l'absence de détection.
  it('renvoie un état indéterminé (signedIn: null) quand ni l’un ni l’autre signal n’est présent', () => {
    installGlobals(`<header><a href="/promos">Nos promotions</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readLeclercSessionStateOnPage()).toEqual({ signedIn: null, evidence: null });
  });

  // Un lien "Se connecter" présent mais masqué (menu replié, ex. hors écran)
  // ne doit jamais compter comme signal — sinon un menu simplement fermé
  // déclencherait un faux CART_LOGIN_REQUIRED sur un utilisateur connecté.
  it('ignore un contrôle "Se connecter" non visible (offsetParent null)', () => {
    installGlobals(`<header><a href="/connexion">Se connecter</a></header>`);
    expect(readLeclercSessionStateOnPage()).toEqual({ signedIn: null, evidence: null });
  });

  // Faux "pas connecté" observé en réel le 02/09/2026 sur l'accueil du Drive
  // mobile : le menu qui porte "Mon compte" n'est pas dans le DOM tant qu'il
  // n'est pas ouvert, et l'état indéterminé bloquait tout le remplissage
  // alors que la session était bien active.
  it('détecte un état connecté via le bandeau "Dernière connexion le ..." (accueil Drive mobile)', () => {
    installGlobals(
      `<main><div class="bandeau">Dernière connexion le mardi 01/09/2026 à 22h57</div><a href="/rayons">Rayons</a></main>`
    );
    makeVisible(document.querySelector('a'));
    const result = readLeclercSessionStateOnPage();
    expect(result).toEqual({ signedIn: true, evidence: 'derniere_connexion' });
    // Même règle que pour les contrôles : la date de connexion ne ressort
    // jamais dans l'evidence exportable.
    expect(result.evidence).not.toContain('01/09/2026');
  });

  it('détecte un état connecté via un lien de déconnexion sans libellé (href seul)', () => {
    installGlobals(`<header><a href="/deconnexion.aspx" aria-label=""><span class="ico"></span></a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readLeclercSessionStateOnPage()).toEqual({ signedIn: true, evidence: 'lien_deconnexion' });
  });

  // Garde-fou du choix inverse : un href "mon-compte" existe aussi
  // déconnecté (il mène à l'écran de connexion), il ne doit donc jamais
  // valoir preuve de session active.
  it('ne prend pas un href "mon-compte" pour une preuve de connexion', () => {
    installGlobals(`<header><a href="/mon-compte.aspx">Se connecter</a></header>`);
    makeVisible(document.querySelector('a'));
    expect(readLeclercSessionStateOnPage()).toEqual({ signedIn: false, evidence: 'se_connecter' });
  });
});

// Cause racine confirmée le 2026-08-27 : `chrome.scripting.executeScript({
// func })` sérialise UNIQUEMENT le code source de la fonction ciblée
// (`Function.prototype.toString()`, puis ré-analysé dans l'onglet) — aucune
// closure ni référence vers une autre fonction du module ne survit. Appeler
// ces fonctions directement, comme tous les tests ci-dessus, garde l'accès de
// closure normal d'un import ES module et ne peut donc JAMAIS détecter ce
// bug (c'est précisément ce qui l'a laissé passer inaperçu : 180/180 tests
// verts, `tsc` 0 erreur, mais 5/5 échecs sur un vrai refresh téléphone).
// Ce bloc reconstruit chaque fonction à partir de sa propre source, comme le
// fait réellement Chrome, pour attraper toute ReferenceError vers un
// identifiant hors de la fonction.
describe('Injection isolation (chrome.scripting.executeScript ne sérialise que le code source de la fonction)', () => {
  function rebuildFromSource(fn) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fn.toString()});`)();
  }

  it('readProductCandidatesOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`
      <li data-product-id="999">Lait UHT demi écrémé 6 briques de 1L 11,40 €</li>
    `);
    const rebuilt = rebuildFromSource(readProductCandidatesOnPage);
    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt().some((c) => /Lait UHT/.test(c.name))).toBe(true);
  });

  it('readDriveChoicesOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`
      <div data-track-libelle="Clic bloc magasin Belleville - Le Parc (99000)" data-track-categorie="Drive">
        99000 Belleville - Le Parc Distance 2 km
      </div>
    `);
    const rebuilt = rebuildFromSource(readDriveChoicesOnPage);
    expect(() => rebuilt('99000')).not.toThrow();
    expect(rebuilt('99000')).toHaveLength(1);
  });

  it('clickDriveChoiceOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(`
      <div data-track-libelle="Clic bloc magasin Belleville - Le Parc (99000)" data-track-categorie="Drive">
        99000 Belleville - Le Parc Distance 2 km
      </div>
    `);
    const rebuilt = rebuildFromSource(clickDriveChoiceOnPage);
    const result = await rebuilt(0);
    expect(result).toBeDefined();
  });

  it('startProductSearchOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(`<input id="saisieTexte" />`);
    const rebuilt = rebuildFromSource(startProductSearchOnPage);
    const result = await rebuilt({ name: 'Lait', brand: '' });
    expect(result).toBeDefined();
  });

  it('clickAddToCartOnMatchedLeclercCardOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(`
      <div class="liste-produit-element">
        <div class="vignette-descriptif">Lait demi-écrémé Lactel 6x1L</div>
        <div class="vignette-prix-ajout"><div class="vignette-prix"><p>5,99 €</p></div>
          <a class="vignette-ajout" aria-label="Ajouter au panier"></a>
        </div>
      </div>
    `);
    makeVisible(document.querySelector('.vignette-ajout'));
    const rebuilt = rebuildFromSource(clickAddToCartOnMatchedLeclercCardOnPage);
    const result = await rebuilt('Lait demi-écrémé Lactel 6x1L', 5.99, 1);
    expect(result).toBeDefined();
  });

  it('readLeclercSessionStateOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`<a href="/compte">Mon compte</a>`);
    makeVisible(document.querySelector('a'));
    const rebuilt = rebuildFromSource(readLeclercSessionStateOnPage);
    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt().signedIn).toBe(true);
  });

  it('readLeclercProductPageOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`
      <h1>Boisson soja nature Vg 1L</h1>
      <div class="prix-actuel-partie-entiere">1</div>
      <div class="prix-actuel-partie-decimale">35</div>
    `);
    const rebuilt = rebuildFromSource(readLeclercProductPageOnPage);
    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt()).toEqual({
      ok: true,
      name: 'Boisson soja nature Vg 1L',
      priceEuro: 1.35,
      priceSource: 'standalone_classique'
    });
  });

  it('clickAddToCartOnLeclercProductPageOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(`<a class="aWCRS310_Add_Produit_Fiche">Ajouter au panier</a>`);
    const addButton = document.querySelector('.aWCRS310_Add_Produit_Fiche');
    makeVisible(addButton);
    // Reproduit le re-rendu réel de la fiche après un ajout : le site
    // remplace son bloc et DÉTACHE le bouton cliqué. C'est le signal de
    // confirmation le plus rapide ; sans lui la fonction attendrait sa
    // fenêtre complète de 6s avant de conclure.
    addButton.addEventListener('click', () => addButton.remove());
    const rebuilt = rebuildFromSource(clickAddToCartOnLeclercProductPageOnPage);
    const result = await rebuilt(1);
    expect(result).toEqual({ added: true });
  });
});

describe('Validation du code-barres Leclerc (clé de contrôle GS1)', () => {
  it("n'invente pas un EAN à partir d'un numéro quelconque du texte de la carte", () => {
    // Une carte élargie par l'escalade de parents peut englober du texte
    // voisin (numéro de commande, référence, date). L'ancien
    // `text.match(/\b\d{8,14}\b/)` le retenait comme code-barres, et
    // chooseLeclercProductCandidate traitait ensuite l'égalité de cet EAN
    // inventé comme une correspondance PARFAITE (matchScore 1).
    installGlobals(`
      <li data-product-id="999">
        Lait UHT demi écrémé 6 briques de 1L 11,40 €
        Réf. commande 20260828120000 — service client 0980980990
      </li>
    `);
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.barcode).toBeUndefined();
  });

  it('retient un EAN-13 valide présent dans le texte de la carte', () => {
    installGlobals(`
      <li data-product-id="999">Lait UHT demi écrémé 6 briques de 1L 11,40 € EAN 3256224234494</li>
    `);
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.barcode).toBe('3256224234494');
  });

  it("préfère l'attribut data-ean au texte de la carte, qui peut couvrir plusieurs produits", () => {
    // L'attribut structuré décrit à coup sûr CETTE carte ; le texte, non.
    installGlobals(`
      <li data-product-id="999" data-ean="3256224234494">
        Lait UHT demi écrémé 6 briques de 1L 11,40 € — voir aussi 5449000000996
      </li>
    `);
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.barcode).toBe('3256224234494');
  });

  it("ignore un data-ean dont la clé de contrôle est fausse et retombe sur le texte", () => {
    installGlobals(`
      <li data-product-id="999" data-ean="3256224234495">
        Lait UHT demi écrémé 6 briques de 1L 11,40 € EAN 5449000000996
      </li>
    `);
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.barcode).toBe('5449000000996');
  });
});

describe('Lien direct vers la fiche produit Leclerc (v-produit-<id>)', () => {
  // Structure réelle capturée en direct sur le téléphone (31/08,
  // m-courses.leclercdrive.fr/magasin-123456-123456/recherche/Mousline) : la
  // carte elle-même n'a aucun href exploitable, mais son conteneur porte
  // l'identifiant de fiche dans une classe CSS, et la page cite l'hôte qui
  // sert les fiches.
  const grilleReelle = `
    <img class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=3035387&use=l&cat=p">
    <a href="https://fd7-espace-client.leclercdrive.fr/mon-compte">Mon compte</a>
    <a href="https://fd7-courses.leclercdrive.fr/magasin-123456-123456/mon-panier">Mon panier</a>
    <li>
      <div class="liste-produit-element v-produit-208750 v-sousfamille-284431">
        <div class="vignette-produit">
          <div class="vignette-descriptif"><p>Purée Mousline Crème et noix de muscade - 500g</p></div>
          <div class="vignette-prix"><p>3,17 €</p><p class="vignette-prix-unitaire"><span>6,34 € / kg</span></p></div>
          <a href="#" class="vignette-ajout"></a>
        </div>
      </div>
    </li>
  `;
  const urlGrille = 'https://m-courses.leclercdrive.fr/magasin-123456-123456/recherche/Mousline';

  it('construit une URL de fiche directe à partir de la classe du conteneur', () => {
    installGlobals(grilleReelle, urlGrille);
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.productUrl).toBe(
      'https://fd7-courses.leclercdrive.fr/magasin-123456-123456/fiche-produits-208750-Puree-Mousline-Creme-et-noix-de-muscade-500g.aspx'
    );
  });

  it("déduit l'hôte des fiches du sous-domaine des photos quand aucun lien ne le cite", () => {
    // Seul l'hôte fdNN-photos est présent : le préfixe fdNN est le même,
    // donc l'hôte des fiches reste déductible sans rien coder en dur.
    installGlobals(
      `
        <img class="vignette-photo" src="https://fd07-photos.leclercdrive.fr/image.ashx?id=1&cat=p">
        <li><div class="liste-produit-element v-produit-4242">
          <div class="vignette-produit"><div class="vignette-descriptif"><p>Riz basmati</p></div>
          <div class="vignette-prix"><p>2,50 €</p></div></div>
        </div></li>
      `,
      urlGrille
    );
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.productUrl).toBe(
      'https://fd07-courses.leclercdrive.fr/magasin-123456-123456/fiche-produits-4242-Riz-basmati.aspx'
    );
  });

  it("retombe sur l'URL de la page quand aucun identifiant de fiche n'est lisible", () => {
    // Non-régression : une carte sans conteneur v-produit-<id> (ancienne mise
    // en page, ou carte reconstruite par escalade de parents) doit garder le
    // comportement d'avant — jamais d'URL inventée.
    installGlobals(
      `
        <img class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=1&cat=p">
        <li><div class="vignette-produit"><div class="vignette-descriptif"><p>Riz basmati</p></div>
        <div class="vignette-prix"><p>2,50 €</p></div></div></li>
      `,
      urlGrille
    );
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.productUrl).toBe(urlGrille);
  });

  it("n'invente pas d'hôte de fiche quand la page n'en cite aucun", () => {
    installGlobals(
      `<li><div class="liste-produit-element v-produit-208750">
        <div class="vignette-produit"><div class="vignette-descriptif"><p>Purée Mousline</p></div>
        <div class="vignette-prix"><p>3,17 €</p></div></div>
      </div></li>`,
      urlGrille
    );
    const [candidate] = readProductCandidatesOnPage();
    expect(candidate.productUrl).toBe(urlGrille);
  });

  it('donne une URL distincte à chaque carte de la grille', () => {
    // La déduplication des quasi-matchs (collectLeclercStore) est indexée sur
    // productUrl : tant que toutes les cartes retombaient sur l'URL de
    // recherche, elle n'en gardait qu'une seule et l'utilisateur ne voyait
    // qu'une piste au lieu de plusieurs.
    installGlobals(
      `
        <img class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=1&cat=p">
        <li><div class="liste-produit-element v-produit-208750"><div class="vignette-produit">
          <div class="vignette-descriptif"><p>Purée Mousline 500g</p></div>
          <div class="vignette-prix"><p>3,17 €</p></div></div></div></li>
        <li><div class="liste-produit-element v-produit-208636"><div class="vignette-produit">
          <div class="vignette-descriptif"><p>Purée Mousline nature 620g</p></div>
          <div class="vignette-prix"><p>3,95 €</p></div></div></div></li>
      `,
      urlGrille
    );
    // Une même carte est lue plusieurs fois (conteneur ET <li> parent) : ce
    // qui compte ici est que les DEUX produits distincts reçoivent deux URLs
    // distinctes, pas le nombre brut de lectures.
    const urls = readProductCandidatesOnPage().map((candidate) => candidate.productUrl);
    expect(urls.every((url) => /\/fiche-produits-\d+-/.test(url))).toBe(true);
    expect([...new Set(urls)].sort()).toEqual([
      'https://fd7-courses.leclercdrive.fr/magasin-123456-123456/fiche-produits-208636-Puree-Mousline-nature-620g.aspx',
      'https://fd7-courses.leclercdrive.fr/magasin-123456-123456/fiche-produits-208750-Puree-Mousline-500g.aspx'
    ]);
  });
});

describe('Instantané complet d’une carte de grille Leclerc', () => {
  it('récupère en une lecture l’identifiant CSS, la marque, le GTIN structuré, la promotion et la disponibilité', () => {
    installGlobals(`
      <img src="https://fd7-photos.leclercdrive.fr/image.ashx?id=3035387&cat=p">
      <li><div class="liste-produit-element v-produit-208750">
        <div class="vignette-produit">
          <div class="vignette-descriptif"><p>Purée Mousline 500g</p></div>
          <meta itemprop="brand" content="MOUSLINE">
          <meta itemprop="gtin13" content="3760341070335">
          <div class="vignette-prix"><p>3,17 €</p><p class="vignette-prix-unitaire">6,34 € / kg</p></div>
          <span class="vignette-promotion">Ticket E.Leclerc 20%</span>
          <button class="vignette-ajout" disabled aria-label="Indisponible">Ajouter</button>
        </div>
      </div></li>
    `, 'https://m-courses.leclercdrive.fr/magasin-123456-123456/recherche/Mousline');

    const [candidate] = readProductCandidatesOnPage();
    expect(candidate).toMatchObject({
      name: 'Purée Mousline 500g',
      brand: 'MOUSLINE',
      barcode: '3760341070335',
      externalProductId: '208750',
      priceEuro: 3.17,
      unitPriceEuro: 6.34,
      unitPriceUnit: 'kg',
      available: false,
      promotionLabel: 'Ticket E.Leclerc 20%'
    });
  });
});

describe('clickDriveChoiceOnPage — index de magasin périmé', () => {
  const html = `
    <div data-track-libelle="Clic bloc magasin Belleville - Le Parc (99000)" data-track-categorie="Drive">
      99000 Belleville - Le Parc Distance 2 km
    </div>
    <div data-track-libelle="Clic bloc magasin Chartres (28000)" data-track-categorie="Drive">
      28000 Chartres Distance 25 km
    </div>
  `;

  it('clique quand le bloc à cet index porte toujours le texte attendu', async () => {
    installGlobals(html);
    const [choice] = readDriveChoicesOnPage('99000');
    const result = await clickDriveChoiceOnPage(choice.actionIndex, choice.text);
    // Le clic sur le bloc aboutit : la suite (DRIVE_START_CONTROL_NOT_FOUND,
    // faute de bouton 'Commencer mes courses' dans ce DOM réduit) est le
    // comportement normal hors site réel — seul compte ici le fait que la
    // garde d'index périmé n'a PAS bloqué le clic.
    expect(result.code).not.toBe('DRIVE_RESULT_STALE');
  });

  it('refuse de cliquer quand la page a été re-rendue et que le bloc a changé', async () => {
    // Sans cette garde, l'index capturé sur la liste précédente ferait
    // valider silencieusement un AUTRE drive — donc tous les prix relevés
    // ensuite viendraient du mauvais magasin.
    installGlobals(html);
    const result = await clickDriveChoiceOnPage(0, '28000 Chartres Distance 25 km');
    expect(result).toEqual({ clicked: false, code: 'DRIVE_RESULT_STALE' });
  });

  it('reste rétrocompatible avec un appel sans texte attendu', async () => {
    installGlobals(html);
    const result = await clickDriveChoiceOnPage(0);
    expect(result.code).not.toBe('DRIVE_RESULT_STALE');
  });
});

// Le handler du bouton flottant "✓ Valider ce produit" embarque une COPIE
// manuelle de la cascade de paliers de prix de readLeclercProductPageOnPage
// (readGenericLeclercProductOnPage, imbriquée dans
// armLeclercFloatingPickButtonOnPage) : une fonction injectée via
// scripting.executeScript ne peut appeler aucune autre fonction du module.
// Rien n'empêchait jusqu'ici les deux copies de diverger silencieusement — un
// correctif de lecture de prix appliqué à l'une seule laissait le pick manuel
// relever un AUTRE prix que le scraping automatique, sans qu'aucun test ne le
// signale. Ces tests comparent les deux lectures sur le MÊME DOM.
describe('Parité bouton flottant ↔ readLeclercProductPageOnPage', () => {
  function pickViaFloatingButton() {
    armLeclercFloatingPickButtonOnPage();
    const button = document.getElementById('drive-price-splitter-float-pick');
    expect(button).not.toBeNull();
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    return dom.window.__drivePriceSplitterPick ?? null;
  }

  const cases = [
    [
      'palier 1 — balise schema.org itemprop="price"',
      `<h1>Lait demi écrémé Délisse 6x1L</h1><span itemprop="price" content="5.94">5,94 €</span>`
    ],
    [
      'palier 2 — .vignette-prix (template Angular 16)',
      `<h1>Lait demi écrémé Délisse 6x1L</h1><div class="vignette-prix"><p>5,94 €</p></div>`
    ],
    [
      'palier 3 — fiche standalone, carrousel de substituts présent',
      `
        <h1>Lait demi écrémé Délisse 6x1L</h1>
        <span class="prix-actuel-partie-entiere">5</span><span class="prix-actuel-partie-decimale">94</span>
        <div id="ulCrossell" class="crossell-produits">
          <div class="crossell">
            <span class="pWCRS310_PrixUnitairePartieEntiere">4</span>
            <span class="pWCRS310_PrixUnitairePartieDecimale">65</span>
          </div>
        </div>
      `
    ],
    [
      'palier 4 — parties entière/décimale du template classique',
      `
        <h1>Lait demi écrémé Délisse 6x1L</h1>
        <span class="pWCRS310_PrixUnitairePartieEntiere">5</span>
        <span class="pWCRS310_PrixUnitairePartieDecimale">94</span>
      `
    ],
    [
      'palier 4 — carrousel de substituts placé AVANT le produit principal',
      // Fixture discriminante pour l'exclusion `.crossell` : le parcmier
      // élément de prix du DOM appartient à un substitut. Une copie qui
      // perdrait ce filtre relèverait 4,65 € au lieu de 5,94 €.
      `
        <h1>Lait demi écrémé Délisse 6x1L</h1>
        <div class="crossell">
          <span class="pWCRS310_PrixUnitairePartieEntiere">4</span>
          <span class="pWCRS310_PrixUnitairePartieDecimale">65</span>
        </div>
        <span class="pWCRS310_PrixUnitairePartieEntiere">5</span>
        <span class="pWCRS310_PrixUnitairePartieDecimale">94</span>
      `
    ],
    [
      'palier 5 — scan large, prix au litre à écarter en premier',
      `
        <h1>Lait demi écrémé Délisse 6x1L</h1>
        <span class="pWCRS310_PrixUniteMesure">0,99 € / l</span>
        <span class="prix-detail-autre">5,94 €</span>
      `
    ],
    ['aucun prix lisible', `<h1>Lait demi écrémé Délisse 6x1L</h1><p>Prix indisponible</p>`],
    ['aucun titre lisible', `<p>5,94 €</p>`]
  ];

  for (const [label, html] of cases) {
    it(`relève le même nom et le même prix que la lecture canonique — ${label}`, () => {
      installGlobals(html, 'https://fd12-courses.leclercdrive.fr/fiche-produits-1.aspx');
      const canonical = readLeclercProductPageOnPage();
      const viaButton = pickViaFloatingButton();
      if (canonical.ok) {
        expect(viaButton).not.toBeNull();
        expect(viaButton.name).toBe(canonical.name);
        expect(viaButton.priceEuro).toBeCloseTo(canonical.priceEuro);
        expect(viaButton.unitPriceEuro).toBe(canonical.unitPriceEuro);
        expect(viaButton.unitPriceUnit).toBe(canonical.unitPriceUnit);
      } else {
        // Le handler n'expose rien quand la lecture échoue (il affiche
        // "✗ Produit non détecté") : l'absence de pick EST la traduction
        // attendue d'un `ok: false` côté canonique.
        expect(viaButton).toBeNull();
      }
    });
  }
});

// Signalé par l'utilisateur (2026-08-29) : le bouton de pick manuel
// apparaissait sur chaque carte d'une grille de résultats de recherche au
// lieu de seulement la fiche produit précise. Corrigé en supprimant
// l'injection par carte et en gardant la fiche produit comme unique page où
// le bouton flottant s'affiche.
describe('armLeclercFloatingPickButtonOnPage — garde-fou de page', () => {
  const html = `<h1>Lait demi écrémé Délisse 6x1L</h1><span itemprop="price" content="5.94">5,94 €</span>`;
  const ID = 'drive-price-splitter-float-pick';

  it("n'affiche PAS le bouton sur une page de résultats de recherche", () => {
    installGlobals(html, 'https://fd12-courses.leclercdrive.fr/recherche/lait');
    armLeclercFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).toBeNull();
  });

  it("n'affiche PAS le bouton sur une page de catégorie", () => {
    installGlobals(html, 'https://fd12-courses.leclercdrive.fr/rayon/produits-laitiers.aspx');
    armLeclercFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).toBeNull();
  });

  it('affiche le bouton sur une vraie fiche produit standalone', () => {
    installGlobals(html, 'https://fd12-courses.leclercdrive.fr/fiche-produits-1-lait-delisse.aspx');
    armLeclercFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).not.toBeNull();
  });

  it("retire le bouton si l'utilisateur quitte la fiche produit pour une page de liste", () => {
    installGlobals(html, 'https://fd12-courses.leclercdrive.fr/fiche-produits-1-lait-delisse.aspx');
    armLeclercFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).not.toBeNull();
    // Même onglet, nouvelle page (le vrai cycle de sondage réarme toutes les
    // 500ms) : on simule juste la navigation en reconfigurant l'URL du même
    // document plutôt qu'en recréant tout le DOM, pour rester au plus près
    // du comportement réel d'armLeclercFloatingPickButtonOnPage (idempotent
    // via document.getElementById).
    dom.reconfigure({ url: 'https://fd12-courses.leclercdrive.fr/recherche/lait' });
    armLeclercFloatingPickButtonOnPage();
    expect(document.getElementById(ID)).toBeNull();
  });
});

describe('Repli regex du prix Leclerc — montants qui ne sont pas le prix de l’article', () => {
  // Ce repli ne sert que si les sélecteurs de prix dédiés ont tous échoué
  // (site modifié). Il ne doit alors surtout pas présenter un montant
  // promotionnel comme s'il s'agissait du prix : un prix faux est affiché
  // comme certain et fausse la comparaison entre magasins.
  const cases = [
    ['prix barré "au lieu de"', 'Au lieu de 6,20 € 5,94 €', 5.94],
    ['seuil de livraison gratuite', 'Livraison offerte dès 80,00 € 5,94 €', 5.94],
    ['cagnotte fidélité', 'Cagnotte 1,50 € créditée 5,94 €', 5.94],
    ['prix au litre annoncé avant', 'Prix au litre 0,99 € 5,94 €', 5.94],
    ['prix au litre suffixé', '0,99 € / l 5,94 €', 5.94]
  ];

  for (const [label, noise, expected] of cases) {
    it(`retient le prix de l'article et non le montant parasite — ${label}`, () => {
      installGlobals(`<li data-product-id="7">Lait demi écrémé Délisse 6x1L ${noise}</li>`);
      const [candidate] = readProductCandidatesOnPage();
      expect(candidate.priceEuro).toBeCloseTo(expected);
    });
  }
});

// Renforcement AJOUTÉ le 2026-08-28, symétrique de celui de Courses U : les
// clics successifs sur le stepper "+" n'étaient jamais vérifiés. Un clic
// absorbé par le site laissait le panier réel avec moins d'unités que
// demandé, sans aucun signal côté PWA.
describe('Fiabilité de la quantité Leclerc — stepper qui absorbe un clic', () => {
  function stepperPageHtml() {
    return `
      <h1>Lait demi-écrémé Lactel 6x1L</h1>
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
        if (clicks === 1) return;
        field.value = String(Number(field.value) + 1);
      });

      const promise = clickAddToCartOnLeclercProductPageOnPage(3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
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

      const promise = clickAddToCartOnLeclercProductPageOnPage(3);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toEqual({ added: true });
      expect(field.value).toBe('3');
      expect(clicks).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Canari de structure AJOUTÉ le 2026-08-28, pendant Courses U : `priceSource`
// nomme le palier de la cascade qui a fourni le prix. Purement observationnel
// — 'scan_large' signale que plus aucune classe connue n'a été trouvée, donc
// une lecture en mode dégradé à surveiller avant qu'elle ne dérive.
describe('Canari de structure — priceSource (Leclerc)', () => {
  const cases = [
    ['itemprop', `<h1>Lait demi écrémé Délisse 6x1L</h1><span itemprop="price" content="5.94">5,94 €</span>`, 'itemprop'],
    [
      'vignette_prix',
      `<h1>Lait demi écrémé Délisse 6x1L</h1><div class="vignette-prix"><p>5,94 €</p></div>`,
      'vignette_prix'
    ],
    [
      'standalone_classique',
      `<h1>Lait demi écrémé Délisse 6x1L</h1>
       <span class="prix-actuel-partie-entiere">5</span><span class="prix-actuel-partie-decimale">94</span>`,
      'standalone_classique'
    ],
    [
      'listing_classique',
      `<h1>Lait demi écrémé Délisse 6x1L</h1>
       <span class="pWCRS310_PrixUnitairePartieEntiere">5</span>
       <span class="pWCRS310_PrixUnitairePartieDecimale">94</span>`,
      'listing_classique'
    ],
    [
      'scan_large',
      `<h1>Lait demi écrémé Délisse 6x1L</h1><span class="prix-detail-autre">5,94 €</span>`,
      'scan_large'
    ]
  ];

  for (const [label, html, expected] of cases) {
    it(`nomme le palier qui a fourni le prix — ${label}`, () => {
      installGlobals(html, 'https://fd12-courses.leclercdrive.fr/fiche-produits-1.aspx');
      const result = readLeclercProductPageOnPage();
      expect(result.ok).toBe(true);
      expect(result.priceEuro).toBeCloseTo(5.94);
      expect(result.priceSource).toBe(expected);
    });
  }
});

describe('inspectLeclercResultsOnPage — assainissement du diagnostic exportable (audit sécurité 30/08)', () => {
  it('retire les valeurs href/src/data-*/style du snippet HTML du conteneur de résultats, en gardant classes/balises', () => {
    installGlobals(`
      <div cwcrs304_conteneurrechercheproduits class="ng-star-inserted">
        <ul class="clearfix liste-produit">
          <li class="ng-star-inserted">
            <a href="/panier/ajouter?token=SECRET-USER-TOKEN-123&produit=456" data-cart-session="abc-def-ghi" style="background-image:url(/photo-privee.jpg)">
              <img alt="" class="vignette-photo" src="https://fd7-photos.leclercdrive.fr/image.ashx?id=2993403&session=xyz">
              <p class="vignette-descriptif">Lait demi-écrémé 6x1L</p>
              <p class="ng-star-inserted">5,99 €</p>
            </a>
          </li>
        </ul>
      </div>
    `);

    const result = inspectLeclercResultsOnPage();

    expect(result.resultsContainerFound).toBe(true);
    // Les valeurs pouvant porter un token/identifiant ne doivent plus
    // apparaître littéralement dans l'extrait exportable.
    expect(result.resultsContainerHtmlSnippet).not.toContain('SECRET-USER-TOKEN-123');
    expect(result.resultsContainerHtmlSnippet).not.toContain('abc-def-ghi');
    expect(result.resultsContainerHtmlSnippet).not.toContain('photo-privee.jpg');
    expect(result.resultsContainerHtmlSnippet).not.toContain('session=xyz');
    // Les signaux structurels réellement utilisés pour diagnostiquer un
    // changement de markup (classes, noms de balise/attribut) restent lisibles.
    expect(result.resultsContainerHtmlSnippet).toContain('vignette-descriptif');
    expect(result.resultsContainerHtmlSnippet).toContain('liste-produit');
    expect(result.resultsContainerHtmlSnippet).toContain('data-cart-session="…"');
    // Le texte du produit (catalogue public, pas une donnée personnelle)
    // reste utile au diagnostic.
    expect(result.resultsContainerHtmlSnippet).toContain('Lait demi-écrémé 6x1L');
  });

  it("n'expose plus de dump brut de document.body (bodyHtmlSnippet retiré, capturait le header/nav)", () => {
    installGlobals(`<header>Bonjour Frédéric</header><div cwcrs304_conteneurrechercheproduits></div>`);
    const result = inspectLeclercResultsOnPage();
    expect(result.bodyHtmlSnippet).toBeUndefined();
  });
});

describe('Titre de fiche produit : bandeau de navigation vs vrai titre', () => {
  // Structure relevée sur une fiche réelle le 31/08/2026
  // (fiche-produits-208750-Pure-Mousline.aspx) : la page porte DEUX <h1>. Le
  // premier dans le DOM est celui du bandeau de navigation
  // (.pWCSD347_Titre, dans <header>), amputé du grammage ; le vrai titre
  // produit est .titre-fiche, plus bas.
  //
  // querySelector('h1, .titre-fiche') rend le parcmier ÉLÉMENT du document
  // correspondant à l'un des sélecteurs, pas le parcmier sélecteur de la
  // liste : seul un enchaînement d'appels distincts donne une priorité.
  //
  // Enjeu réel : le format d'un candidat vient de parseQuantityFromName(nom).
  // Un nom sans grammage ne produit aucun format, donc ni comparaison de
  // format entre magasins, ni contrôle croisé prix / prix au litre — la purée
  // Leclerc 375 g à 2,56 € (6,83 €/kg) était comparée à un lot Hyper U de
  // 1 040 g à 4,56 € (4,39 €/kg), et Leclerc annoncé moins cher à tort.
  it('retient le titre produit avec son grammage, pas celui du bandeau', () => {
    installGlobals(`
      <header role="banner" class="hdWCSD347_Bandeau">
        <h1 class="pWCSD347_Titre">Purée Mousline</h1>
      </header>
      <div class="ligne element large-screen-only">
        <h1 class="titre-fiche">Purée Mousline x3 - 375g</h1>
      </div>
      <div class="prix-actuel-partie-entiere">2</div>
      <div class="prix-actuel-partie-decimale">56</div>
      <div class="pWCRS310_PrixUniteMesure">6,83 € / kg</div>
    `);

    const result = readLeclercProductPageOnPage();
    expect(result.ok).toBe(true);
    expect(result.name).toBe('Purée Mousline x3 - 375g');
    expect(result.priceEuro).toBeCloseTo(2.56);
    expect(result.unitPriceEuro).toBeCloseTo(6.83);
    expect(result.unitPriceUnit).toBe('kg');
  });

  it('retombe sur le <h1> disponible quand la fiche ne porte pas .titre-fiche', () => {
    // Non-régression : les fiches du template classique n'ont qu'un seul h1,
    // et doivent continuer à être lues exactement comme avant.
    installGlobals(`
      <h1>Boisson soja nature Vg 1L</h1>
      <div class="prix-actuel-partie-entiere">1</div>
      <div class="prix-actuel-partie-decimale">35</div>
    `);

    expect(readLeclercProductPageOnPage().name).toBe('Boisson soja nature Vg 1L');
  });
});
