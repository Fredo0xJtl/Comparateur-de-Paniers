// Lecture des « produits habituels » déjà enregistrés sur le compte Leclerc
// Drive (page /magasin-<id>/produits-habituels).
//
// Fonctionnalité DISTINCTE des collecteurs de recherche : on lit ici une page
// de compte pour importer son contenu dans la liste de courses locale, sans
// rechercher chaque produit un par un.
//
// Ce fichier ne contient QUE ce que le collecteur existant ne sait pas faire :
// la navigation entre les rayons. La lecture des produits eux-mêmes réutilise
// `readProductCandidatesOnPage()` de leclerc-collector.js, telle quelle et
// sans la modifier — les cartes de cette page sont les mêmes que celles des
// résultats de recherche (vérifié en conditions réelles, voir
// docs/RAPPORT_PASSATION_IMPORT_LISTES.md §3), et cette fonction porte déjà
// des protections durement acquises (texte contaminé par les <script>
// Datadome, cartes imbriquées, bandeau panier flottant capté comme produit,
// reconstruction de l'URL de fiche depuis la classe v-produit-NNNN).
//
// ⚠ Contrainte absolue héritée du projet : aucun identifiant ni mot de passe
// manipulé par le code. L'utilisateur se connecte lui-même ; le seul geste
// simulé ici est le changement de rayon — une navigation interne neutre,
// décidée explicitement (voir §13 du rapport), sans rapport avec un ajout au
// panier.

// Libellés de la navigation générale du site : ce sont des liens de la même
// barre ou de barres voisines, mais ce ne sont pas des rayons. Les exclure
// évite de « visiter » le panier ou le compte de l'utilisateur en croyant
// changer de rayon.
const NON_DEPARTMENT_LABELS =
  /^(accueil|mon compte|mon panier|panier|recherche|rechercher|connexion|déconnexion|deconnexion|aide|contact|menu|retour|tous les rayons|mes listes|mes courses|produits habituels|promotions?)$/i;

/**
 * Liste les onglets de rayons de la page « produits habituels ».
 *
 * ⚠ Isolation d'injection : passée en `func:` à `scripting.executeScript`,
 * donc aucun appel à une fonction ou constante définie hors de son corps.
 *
 * @returns {{ actionIndex: number, label: string, active: boolean }[]}
 */
export function readLeclercDepartmentsOnPage() {
  const nonDepartmentLabels =
    /^(accueil|mon compte|mon panier|panier|recherche|rechercher|connexion|déconnexion|deconnexion|aide|contact|menu|retour|tous les rayons|mes listes|mes courses|produits habituels|promotions?)$/i;

  const labelOf = (element) =>
    (element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

  const isActive = (element) =>
    element.getAttribute('aria-selected') === 'true' ||
    element.getAttribute('aria-current') === 'true' ||
    element.getAttribute('aria-current') === 'page' ||
    /(?:^|[\s-])(?:active|selected|current|selectionne|sélectionné)(?:$|[\s-])/i.test(element.className || '');

  const isPlausibleDepartment = (element) => {
    const label = labelOf(element);
    if (label.length < 3 || label.length > 60) return false;
    if (nonDepartmentLabels.test(label)) return false;
    // Un libellé de rayon ne porte ni prix ni quantité : ce filtre écarte les
    // cartes produit et le bandeau panier ("1 0,85 €") si l'un des sélecteurs
    // ci-dessous est trop large sur une future version du site.
    if (/\d+[,.]\d{2}\s*€|€/.test(label)) return false;
    // Un rayon est un libellé, pas une phrase.
    if (label.split(' ').length > 6) return false;
    return true;
  };

  // Cascade du plus normalisé au plus heuristique. On s'arrête au premier
  // palier qui donne au moins deux entrées : un seul « rayon » détecté n'est
  // jamais une barre de rayons, c'est un faux positif.
  const collect = () => {
    const aria = [...document.querySelectorAll('[role="tab"], [role="tablist"] a, [role="tablist"] button')].filter(
      isPlausibleDepartment
    );
    if (aria.length >= 2) return aria;

    const containers = [
      ...document.querySelectorAll(
        'nav, [class*="rayon" i], [class*="univers" i], [class*="categorie" i], [class*="catégorie" i], [class*="onglet" i], [class*="tab" i], [class*="filtre" i]'
      )
    ];
    for (const container of containers) {
      const controls = [...container.querySelectorAll('a, button, [role="button"], li')].filter(
        (element) =>
          isPlausibleDepartment(element) &&
          // Ne garder que les feuilles : un <li> qui contient lui-même le <a>
          // cliquable ferait un doublon du même rayon.
          !element.querySelector('a, button, [role="button"]')
      );
      // Dédoublonnage par libellé : la même barre peut exister en double dans
      // le DOM (version mobile + version bureau masquée).
      const seen = new Set();
      const unique = controls.filter((element) => {
        const key = labelOf(element).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length >= 2) return unique;
    }
    return [];
  };

  return collect().map((element, actionIndex) => ({
    actionIndex,
    label: labelOf(element).slice(0, 60),
    active: isActive(element)
  }));
}

/**
 * Bascule sur un rayon de la page « produits habituels ».
 *
 * `actionIndex` est une POSITION dans le DOM, capturée par
 * `readLeclercDepartmentsOnPage()` lors d'une injection précédente. Entre les
 * deux injections la page a pu se re-rendre : la même position désigne alors
 * un autre rayon, et on importerait silencieusement le contenu du mauvais.
 * `expectedLabel` est donc revérifié avant le clic — même garde que
 * `clickDriveChoiceOnPage()` pour le choix du magasin.
 *
 * ⚠ Isolation d'injection : aucun appel externe (la logique de sélection est
 * volontairement dupliquée depuis `readLeclercDepartmentsOnPage` ci-dessus,
 * les deux fonctions étant sérialisées séparément).
 *
 * @param {number} actionIndex
 * @param {string} expectedLabel
 * @returns {Promise<{ clicked: boolean, code?: string }>}
 */
export async function clickLeclercDepartmentOnPage(actionIndex, expectedLabel) {
  const nonDepartmentLabels =
    /^(accueil|mon compte|mon panier|panier|recherche|rechercher|connexion|déconnexion|deconnexion|aide|contact|menu|retour|tous les rayons|mes listes|mes courses|produits habituels|promotions?)$/i;

  const labelOf = (element) =>
    (element.textContent || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();

  const isPlausibleDepartment = (element) => {
    const label = labelOf(element);
    if (label.length < 3 || label.length > 60) return false;
    if (nonDepartmentLabels.test(label)) return false;
    if (/\d+[,.]\d{2}\s*€|€/.test(label)) return false;
    if (label.split(' ').length > 6) return false;
    return true;
  };

  const collect = () => {
    const aria = [...document.querySelectorAll('[role="tab"], [role="tablist"] a, [role="tablist"] button')].filter(
      isPlausibleDepartment
    );
    if (aria.length >= 2) return aria;

    const containers = [
      ...document.querySelectorAll(
        'nav, [class*="rayon" i], [class*="univers" i], [class*="categorie" i], [class*="catégorie" i], [class*="onglet" i], [class*="tab" i], [class*="filtre" i]'
      )
    ];
    for (const container of containers) {
      const controls = [...container.querySelectorAll('a, button, [role="button"], li')].filter(
        (element) => isPlausibleDepartment(element) && !element.querySelector('a, button, [role="button"]')
      );
      const seen = new Set();
      const unique = controls.filter((element) => {
        const key = labelOf(element).toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (unique.length >= 2) return unique;
    }
    return [];
  };

  const element = collect()[actionIndex];
  if (!element) return { clicked: false, code: 'LECLERC_DEPARTMENT_STALE' };
  if (expectedLabel && labelOf(element).slice(0, 60) !== expectedLabel) {
    return { clicked: false, code: 'LECLERC_DEPARTMENT_STALE' };
  }

  // Même séquence d'événements que les clics déjà en place côté Leclerc : le
  // SPA Angular n'écoute pas toujours `click` seul.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { clicked: true };
}

/**
 * Vérifie qu'on est bien sur la page « produits habituels » d'un compte
 * connecté, avant de lancer quoi que ce soit.
 *
 * Sans ce contrôle, un utilisateur déconnecté (Leclerc redirige vers une page
 * d'accueil ou de connexion) verrait un import « vide » sans comprendre qu'il
 * doit d'abord se connecter lui-même sur le site.
 *
 * ⚠ Isolation d'injection : aucun appel externe.
 *
 * @returns {{ ready: boolean, code?: string, productCardCount: number }}
 */
export function inspectLeclercUsualProductsPageOnPage() {
  // Clone filtré : `textContent` remonte aussi le code des <script> (dont le
  // challenge Datadome), ce qui a déjà provoqué de faux diagnostics dans ce
  // projet — voir readProductCandidatesOnPage dans leclerc-collector.js.
  const bodyClone = document.body?.cloneNode(true);
  bodyClone?.querySelectorAll('script, style, noscript').forEach((element) => element.remove());
  const text = (bodyClone?.textContent || '').replace(/\s+/g, ' ').trim();

  const productCardCount = document.querySelectorAll('.liste-produit-element:not(.liste-produit-element-vide)').length;

  if (/captcha|pas un robot|accès refusé|acces refuse/i.test(text)) {
    return { ready: false, code: 'SITE_BLOCKED', productCardCount };
  }
  if (productCardCount > 0) return { ready: true, productCardCount };

  const looksLikeLogin =
    Boolean(document.querySelector('input[type="password"]')) ||
    /\/(connexion|identification|login)/i.test(location.pathname) ||
    /identifiez-vous|connectez-vous|mot de passe oublié/i.test(text);
  if (looksLikeLogin) return { ready: false, code: 'LECLERC_LOGIN_REQUIRED', productCardCount };

  if (!/produits\s*habituels/i.test(`${location.pathname} ${text}`)) {
    return { ready: false, code: 'LECLERC_WRONG_PAGE', productCardCount };
  }
  return { ready: false, code: 'LECLERC_LIST_EMPTY', productCardCount };
}

export { NON_DEPARTMENT_LABELS };
