import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readLeclercDepartmentsOnPage,
  clickLeclercDepartmentOnPage,
  inspectLeclercUsualProductsPageOnPage
} from './leclerc-list-reader.js';

// Page « produits habituels » de m-courses.leclercdrive.fr : les produits y
// sont répartis par rayon, un seul rayon affiché à la fois (voir
// docs/RAPPORT_PASSATION_IMPORT_LISTES.md §3). Ces tests figent la détection
// de la barre de rayons et les gardes qui empêchent de cliquer sur autre chose
// qu'un rayon.

const USUAL_URL = 'https://m-courses.leclercdrive.fr/magasin-171201-Trappes/produits-habituels';

let dom;

afterEach(() => {
  dom?.window?.close();
  dom = undefined;
});

function installGlobals(html, url = USUAL_URL) {
  dom = new JSDOM(html, { url });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent;
}

const DEPARTMENT_BAR = `
  <nav class="barre-rayons">
    <a class="onglet actif" aria-selected="true">Charcuterie Traiteur</a>
    <a class="onglet">Laitier Œufs Végétal</a>
    <a class="onglet">Épicerie salée</a>
  </nav>
`;

describe('readLeclercDepartmentsOnPage', () => {
  it('liste les rayons et repère celui qui est affiché', () => {
    installGlobals(DEPARTMENT_BAR);

    const departments = readLeclercDepartmentsOnPage();

    expect(departments).toEqual([
      { actionIndex: 0, label: 'Charcuterie Traiteur', active: true },
      { actionIndex: 1, label: 'Laitier Œufs Végétal', active: false },
      { actionIndex: 2, label: 'Épicerie salée', active: false }
    ]);
  });

  it('préfère les onglets ARIA quand la page en expose', () => {
    installGlobals(`
      <div role="tablist">
        <button role="tab" aria-selected="true">Viandes Poissons</button>
        <button role="tab">Épicerie sucrée</button>
      </div>
      <nav><a href="/panier">Mon panier</a><a href="/compte">Mon compte</a></nav>
    `);

    expect(readLeclercDepartmentsOnPage().map((entry) => entry.label)).toEqual([
      'Viandes Poissons',
      'Épicerie sucrée'
    ]);
  });

  it('écarte la navigation générale du site, qui n\'est pas une barre de rayons', () => {
    installGlobals(`
      <nav class="menu-principal">
        <a href="/">Accueil</a>
        <a href="/panier">Mon panier</a>
        <a href="/compte">Mon compte</a>
        <a href="/recherche">Recherche</a>
      </nav>
    `);

    expect(readLeclercDepartmentsOnPage()).toEqual([]);
  });

  it('écarte un bloc qui contient des prix — c\'est une grille produit, pas des rayons', () => {
    installGlobals(`
      <nav class="liste-categories">
        <a>Crème fraîche épaisse 30% 20 cl</a>
        <a>2,15 €</a>
      </nav>
    `);

    expect(readLeclercDepartmentsOnPage()).toEqual([]);
  });

  it('ne prend pas un rayon isolé pour une barre de rayons', () => {
    installGlobals(`<nav class="barre-rayons"><a class="onglet">Charcuterie Traiteur</a></nav>`);

    expect(readLeclercDepartmentsOnPage()).toEqual([]);
  });
});

describe('clickLeclercDepartmentOnPage', () => {
  it('clique le rayon attendu et déclenche la séquence complète d\'événements', async () => {
    installGlobals(DEPARTMENT_BAR);
    const target = document.querySelectorAll('.onglet')[1];
    const seen = [];
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.addEventListener(type, () => seen.push(type));
    }

    const result = await clickLeclercDepartmentOnPage(1, 'Laitier Œufs Végétal');

    expect(result).toEqual({ clicked: true });
    expect(seen).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  });

  it('refuse de cliquer quand la grille s\'est re-rendue entre-temps', async () => {
    // Même garde que clickDriveChoiceOnPage pour le choix du magasin : une
    // position seule ne prouve pas qu'on clique toujours le bon rayon.
    installGlobals(`
      <nav class="barre-rayons">
        <a class="onglet">Épicerie salée</a>
        <a class="onglet">Charcuterie Traiteur</a>
      </nav>
    `);

    expect(await clickLeclercDepartmentOnPage(1, 'Laitier Œufs Végétal')).toEqual({
      clicked: false,
      code: 'LECLERC_DEPARTMENT_STALE'
    });
  });

  it('refuse un index hors limites', async () => {
    installGlobals(DEPARTMENT_BAR);

    expect(await clickLeclercDepartmentOnPage(9, 'Épicerie salée')).toEqual({
      clicked: false,
      code: 'LECLERC_DEPARTMENT_STALE'
    });
  });
});

describe('inspectLeclercUsualProductsPageOnPage', () => {
  it('valide une page qui porte de vraies cartes produit', () => {
    installGlobals(`
      <div class="liste-produit-element v-produit-208750">
        <div class="vignette-descriptif"><p>Crème fraîche épaisse 30%</p></div>
        <div class="vignette-prix"><p>2,15 €</p></div>
      </div>
    `);

    expect(inspectLeclercUsualProductsPageOnPage()).toEqual({ ready: true, productCardCount: 1 });
  });

  it('signale une reconnexion nécessaire plutôt qu\'une liste vide', () => {
    installGlobals(
      `<form><label>Identifiez-vous</label><input type="password" /></form>`,
      'https://m-courses.leclercdrive.fr/connexion'
    );

    expect(inspectLeclercUsualProductsPageOnPage()).toMatchObject({
      ready: false,
      code: 'LECLERC_LOGIN_REQUIRED'
    });
  });

  it('remonte SITE_BLOCKED sur une vérification anti-robot', () => {
    installGlobals(`<div><p>Prouvez que vous n'êtes pas un robot</p></div>`);

    expect(inspectLeclercUsualProductsPageOnPage()).toMatchObject({ ready: false, code: 'SITE_BLOCKED' });
  });

  it('ne confond pas un script de la page avec une vérification anti-robot', () => {
    // Régression connue du projet : `textContent` remonte aussi le code des
    // <script>, dont le challenge Datadome.
    installGlobals(`
      <script>window.ddoptions = {captcha: true};</script>
      <div class="liste-produit-element"><div class="vignette-descriptif"><p>Ricotta</p></div></div>
    `);

    expect(inspectLeclercUsualProductsPageOnPage()).toEqual({ ready: true, productCardCount: 1 });
  });

  it('distingue une page vide de la mauvaise page', () => {
    installGlobals(`<div>Bienvenue sur votre drive</div>`, 'https://m-courses.leclercdrive.fr/magasin-171201/accueil');

    expect(inspectLeclercUsualProductsPageOnPage()).toMatchObject({ ready: false, code: 'LECLERC_WRONG_PAGE' });
  });
});

describe('Injection isolation — lecteur de listes Leclerc', () => {
  function rebuildFromSource(fn) {
    // eslint-disable-next-line no-new-func
    return new Function(`return (${fn.toString()});`)();
  }

  it('readLeclercDepartmentsOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(DEPARTMENT_BAR);
    const rebuilt = rebuildFromSource(readLeclercDepartmentsOnPage);

    expect(() => rebuilt()).not.toThrow();
    expect(rebuilt()).toHaveLength(3);
  });

  it('clickLeclercDepartmentOnPage() survit à une reconstruction depuis sa seule source', async () => {
    installGlobals(DEPARTMENT_BAR);
    const rebuilt = rebuildFromSource(clickLeclercDepartmentOnPage);

    await expect(rebuilt(1, 'Laitier Œufs Végétal')).resolves.toEqual({ clicked: true });
  });

  it('inspectLeclercUsualProductsPageOnPage() survit à une reconstruction depuis sa seule source', () => {
    installGlobals(`<div class="liste-produit-element"><p>Mascarpone</p></div>`);
    const rebuilt = rebuildFromSource(inspectLeclercUsualProductsPageOnPage);

    expect(rebuilt()).toEqual({ ready: true, productCardCount: 1 });
  });
});
