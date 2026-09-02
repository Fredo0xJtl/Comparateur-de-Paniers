import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { startProductSearchOnPage } from './leclerc-collector.js';

// Régression du bug structurel corrigé : `startProductSearchOnPage` avait deux
// implémentations concurrentes (une ajoutée le 2026-07-31, mobile-first,
// prioritaire sur le vrai site ; une plus ancienne, jamais exécutée en
// production, qui portait tous les correctifs ci-dessous). Fusionnées en un
// seul chemin — ces tests figent les régressions déjà rencontrées par le
// passé pour qu'elles ne reviennent jamais silencieusement avec ce chemin.

let dom;

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

function installGlobals(html) {
  dom = new JSDOM(html, { url: 'https://m-courses.leclercdrive.fr/recherche', runScripts: 'outside-only' });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLInputElement = dom.window.HTMLInputElement;
  globalThis.Event = dom.window.Event;
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
}

// JSDOM ne fait aucun layout réel : `offsetParent`/`getClientRects()` valent
// toujours null/vide, donc `isVisible()` (utilisé partout dans le code réel)
// ne peut jamais être vrai sans aide. On simule "affiché à l'écran" en
// définissant `offsetParent` sur l'élément — c'est le même signal que le code
// de production lit.
function makeVisible(element) {
  if (element) {
    Object.defineProperty(element, 'offsetParent', { value: dom.window.document.body, configurable: true });
  }
  return element;
}

const product = { name: 'Riz basmati', brand: 'Taureau Ailé' };

describe('startProductSearchOnPage (Leclerc, chemin fusionné)', () => {
  it('remplit un champ #saisieTexte déjà visible, clique le bon bouton, et retourne avant que le clic (différé) ne parte', async () => {
    installGlobals(`
      <form>
        <input id="saisieTexte" placeholder="Rechercher un produit" />
        <input type="button" value="ok" class="bouton-recherche" />
      </form>
    `);
    makeVisible(document.getElementById('saisieTexte'));

    let clicked = false;
    document.querySelector('.bouton-recherche').addEventListener('click', () => {
      clicked = true;
    });

    const result = await startProductSearchOnPage(product);

    expect(result.started).toBe(true);
    expect(result.diag.inputId).toBe('saisieTexte');
    expect(result.diag.valueAfterSet).toBe('Riz basmati Taureau Ailé');
    expect(result.diag.submitControlFound).toBe(true);
    expect(result.diag.submitControlClass).toBe('bouton-recherche');
    // Le clic est planifié via setTimeout(0) : au retour de la fonction, il
    // n'a pas encore eu lieu — c'est ce qui protège d'un contexte détruit par
    // une navigation avant que la promesse ne se résolve.
    expect(clicked).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(clicked).toBe(true);
  });

  it("trouve le champ mobile via son id Angular connu (#inputWRSL301_rechercheTexte) quand #saisieTexte n'existe pas", async () => {
    installGlobals(`
      <input id="inputWRSL301_rechercheTexte" placeholder="Rechercher un produit ou une marque" />
    `);
    makeVisible(document.getElementById('inputWRSL301_rechercheTexte'));

    const result = await startProductSearchOnPage(product);

    expect(result.started).toBe(true);
    expect(result.diag.inputId).toBe('inputWRSL301_rechercheTexte');
    expect(result.diag.valueAfterSet).toBe('Riz basmati Taureau Ailé');
  });

  it('ignore un input caché id="vendor-search-handler" injecté par un script tiers au profit du vrai champ mobile', async () => {
    installGlobals(`
      <input id="vendor-search-handler" type="text" placeholder="search" />
      <input id="realMobileSearch" type="search" />
    `);
    // Les deux sont "visibles" au sens offsetParent : le script tiers ne cache
    // pas son input, il le positionne juste hors champ — seul le filtre
    // /vendor/i sur l'id doit l'exclure, pas la visibilité.
    makeVisible(document.getElementById('vendor-search-handler'));
    makeVisible(document.getElementById('realMobileSearch'));

    const result = await startProductSearchOnPage(product);

    expect(result.started).toBe(true);
    expect(result.diag.inputId).toBe('realMobileSearch');
  });

  it("ouvre la recherche via une <div tabindex> non-bouton quand la barre est cachée, puis remplit le champ révélé", async () => {
    installGlobals(`
      <div class="recherche-home" tabindex="0">Rechercher</div>
      <form>
        <input id="saisieTexte" placeholder="Rechercher un produit" />
        <input type="button" value="ok" class="bouton-recherche" />
      </form>
    `);
    const opener = document.querySelector('.recherche-home');
    const input = document.getElementById('saisieTexte');
    // Le vrai site Angular révèle le champ au clic — on simule cet effet ici.
    opener.addEventListener('click', () => makeVisible(input));

    const result = await startProductSearchOnPage(product);

    expect(result.started).toBe(true);
    expect(result.diag.attempt).toBe('after_opener');
    expect(result.diag.openerUsed).toContain('recherche-home');
  }, 10_000);

  it('retire target="_blank" de l\'opener avant de cliquer pour ne pas faire fuir la recherche dans un nouvel onglet', async () => {
    installGlobals(`
      <a class="header-recherche" target="_blank"></a>
      <input id="saisieTexte" placeholder="Rechercher un produit" />
    `);
    const opener = document.querySelector('.header-recherche');
    const input = document.getElementById('saisieTexte');
    opener.addEventListener('click', () => makeVisible(input));

    await startProductSearchOnPage(product);

    expect(opener.getAttribute('target')).toBeNull();
  }, 10_000);

  it('ne clique jamais un bouton "OK" de bandeau cookies au lieu du vrai bouton de recherche', async () => {
    installGlobals(`
      <form>
        <input id="saisieTexte" placeholder="Rechercher un produit" />
        <div id="cookie-banner"><button id="cookie-ok">OK</button></div>
        <input type="button" value="ok" class="bouton-recherche" />
      </form>
    `);
    makeVisible(document.getElementById('saisieTexte'));

    let cookieClicked = false;
    let searchClicked = false;
    document.getElementById('cookie-ok').addEventListener('click', () => {
      cookieClicked = true;
    });
    document.querySelector('.bouton-recherche').addEventListener('click', () => {
      searchClicked = true;
    });

    const result = await startProductSearchOnPage(product);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.diag.submitControlClass).toBe('bouton-recherche');
    expect(searchClicked).toBe(true);
    expect(cookieClicked).toBe(false);
  });

  it('annule le clic différé dune soumission périmée quand une 2e soumission est lancée avant lui (régression retry v0.5.45)', async () => {
    installGlobals(`
      <form>
        <input id="saisieTexte" placeholder="Rechercher un produit" />
        <input type="button" value="ok" class="bouton-recherche" />
      </form>
    `);
    makeVisible(document.getElementById('saisieTexte'));

    const clicks = [];
    document.querySelector('.bouton-recherche').addEventListener('click', () => {
      clicks.push(document.getElementById('saisieTexte').value);
    });

    // Simule le retry : une 1ère soumission est lancée (son clic est
    // programmé mais pas encore parti), puis une 2e est relancée avant que
    // le premier setTimeout(0) n'ait eu la main.
    const first = await startProductSearchOnPage({ name: 'Riz basmati', brand: '' });
    const second = await startProductSearchOnPage({ name: 'Riz basmati', brand: '' });
    expect(first.started).toBe(true);
    expect(second.started).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Un seul clic doit être parti (le plus récent) — jamais deux
    // soumissions concurrentes sur la même page.
    expect(clicks).toEqual(['Riz basmati']);
  });

  it("retourne PRODUCT_SEARCH_INPUT_NOT_FOUND avec le détail des inputs quand rien n'est trouvé", async () => {
    installGlobals('<input type="hidden" id="csrf" />');

    const result = await startProductSearchOnPage(product);

    expect(result.started).toBe(false);
    expect(result.code).toBe('PRODUCT_SEARCH_INPUT_NOT_FOUND');
    expect(result.details.inputCount).toBe(1);
    expect(Array.isArray(result.details.inputDetails)).toBe(true);
    expect(result.details.attempt).toBe('after_opener');
  }, 10_000);
});
