import { describe, expect, it, vi } from 'vitest';
import { addToCartLeclercStore, collectLeclercStore } from './leclerc-collector.js';

// Étape 2 du plan de fiabilisation : empêcher qu'un produit hérite en
// silence des cartes de résultats du produit précédent quand sa propre
// recherche a échoué sans le signaler (page pas encore repeinte au moment de
// la lecture — clic raté, SPA lente...). Mock par NOM de fonction (pas par
// position d'appel dans une file `mockResolvedValueOnce`) : le nombre exact
// d'appels internes à `waitForProductCandidates` peut varier (étages de
// repli, budget de vérification de route) sans casser ce test — seul le
// résultat final (quel produit a été matché à quoi) compte ici.
function makeDispatcher(handlers) {
  return vi.fn(async ({ func, args }) => {
    const handler = handlers[func.name];
    if (!handler) {
      throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
    }
    return [{ result: await handler(...(args ?? [])) }];
  });
}

describe('collectLeclercStore — garde anti-contamination croisée entre produits', () => {
  // Régression réelle confirmée le 30/08 (cas "Emmental râpé" : l'étage
  // 'name' avait déjà la bonne carte sous les yeux, candidateCount remonté à
  // 0, cascade poursuivie jusqu'à 'brand_only' pour rien), puis 2e itération
  // après revue de code : le garde par empreinte comparait chaque lecture à
  // la DERNIÈRE lecture réussie de TOUT le magasin (produit précédent
  // inclus), sans jamais vérifier si une navigation avait réellement eu
  // lieu. Leclerc replie souvent une requête peu spécifique sur la même
  // liste générique "meilleures ventes du rayon" — quand la toute PREMIÈRE
  // recherche d'un nouveau produit retombait légitimement sur cette même
  // liste que la DERNIÈRE lecture du produit précédent, le garde l'effaçait
  // à tort. Correctif final : `inspectLeclercSearchNavigationOnPage`
  // fonctionne désormais aussi sur la route mobile (elle ne marchait qu'en
  // desktop), et son résultat (`routeVerified`) sert de confirmation
  // INDÉPENDANTE du contenu — un contenu identique par coïncidence n'est
  // effacé que si la route n'a PAS confirmé la nouvelle requête.
  it("la 1ère recherche d'un nouveau produit n'hérite pas de l'empreinte du produit précédent quand la route confirme la nouvelle requête", async () => {
    const genericBestSeller = {
      name: 'Camembert Président 250g',
      priceEuro: 1.76,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/camembert-president'
    };

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        // La route confirme positivement chaque nouvelle requête (comme sur
        // le vrai site mobile une fois la SPA navigée) — c'est ce signal,
        // pas le contenu, qui doit décider ici.
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // Les DEUX produits retombent, légitimement (nouvelle page à chaque
        // fois), sur la même liste générique — coïncidence de contenu, pas
        // une page qui n'a pas changé.
        readProductCandidatesOnPage: () => [genericBestSeller],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 20,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [
        { productId: 'product-camembert-1', name: 'Camembert Président 250g', brand: 'President' },
        { productId: 'product-camembert-2', name: 'Camembert Président 250g', brand: 'President' }
      ]
    });

    // Les deux produits doivent trouver leur match dès l'étage 'name', sans
    // qu'aucun ne soit effacé à tort par l'empreinte du précédent.
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(2);
    for (const observation of result.observations) {
      expect(observation.matchStage).toBe('name');
      expect(observation.productUrl).toBe(genericBestSeller.productUrl);
    }
  }, 15_000);

  // Pendant réel du test précédent : protection d'origine (27/08) restaurée
  // — un 2e produit dont la soumission de recherche échoue VRAIMENT en
  // silence (la route ne confirme jamais la nouvelle requête, comme un clic
  // qui n'a eu aucun effet) ne doit toujours jamais hériter des cartes du
  // produit précédent.
  it("un 2e produit dont la recherche échoue en silence (route jamais confirmée) n'hérite toujours pas des cartes du 1er", async () => {
    const rizCandidate = {
      name: 'Riz basmati Lustucru 1kg',
      priceEuro: 2.5,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/riz-1'
    };

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        // La route ne confirme JAMAIS la nouvelle requête (soumission
        // silencieusement ratée : la page n'a en réalité jamais navigué) —
        // c'est ce que le garde doit détecter, faute de mieux, via le
        // contenu identique.
        inspectLeclercSearchNavigationOnPage: () => ({ ready: false }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // Renvoie TOUJOURS la même carte, y compris pour le 2e produit : la
        // page n'a en réalité jamais changé de contenu.
        readProductCandidatesOnPage: () => [rizCandidate],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 22,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [
        // Deux produits DIFFÉRENTS mais assez proches (même famille, format
        // différent) pour que `chooseLeclercProductCandidate` accepterait
        // sincèrement la carte du riz 1kg comme un match plausible du riz
        // 500g si le garde ne l'écartait pas.
        { productId: 'product-riz-1kg', name: 'Riz basmati Lustucru 1kg', brand: '' },
        { productId: 'product-riz-500g', name: 'Riz basmati Lustucru 500g', brand: '' }
      ]
    });

    // Le 1er produit matche légitimement sa propre carte...
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].productId).toBe('product-riz-1kg');
    expect(result.observations[0].productUrl).toBe(rizCandidate.productUrl);

    // ...mais le 2e ne doit JAMAIS se voir attribuer cette même carte.
    expect(result.errors).toEqual([
      expect.objectContaining({ productId: 'product-riz-500g', code: 'PRODUCT_NOT_FOUND' })
    ]);
  }, 20_000);

  // Ce qui reste en jeu à l'intérieur de la cascade d'UN MÊME produit (ex:
  // repli 'brand_only' dont la soumission échoue en silence et relit les
  // cartes déjà vues à l'étage 'name') : le score de correspondance ne
  // dépend jamais de l'étage (toujours calculé contre le même
  // product.name/brand — voir chooseLeclercProductCandidate), donc une carte
  // déjà rejetée à l'étage 'name' ne peut de toute façon jamais devenir un
  // match valide en réapparaissant identique à l'étage suivant : seule la
  // propreté du diagnostic (stageAttempts) est encore en jeu ici.
  it("dans la cascade d'UN MÊME produit, une relecture identique à la précédente est signalée comme périmée (candidateCount à 0)", async () => {
    const staleCard = {
      name: 'Autre article sans rapport',
      priceEuro: 9.99,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/autre-1'
    };
    const product = { productId: 'product-fromage', name: 'Camembert normand', brand: 'President' };

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => ({ started: true, query: searchedProduct.name }),
        // Repli 'brand_only' dont la soumission n'a en réalité jamais changé
        // le contenu de la page (route jamais confirmée non plus).
        inspectLeclercSearchNavigationOnPage: () => ({ ready: false }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [staleCard],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 21,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [product]
    });

    // Aucun match (la carte est réellement sans rapport, avec ou sans le
    // garde) — mais l'étage 'brand_only' doit apparaître avec
    // candidateCount: 0 (lecture jugée périmée), pas 1.
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    const stages = error.details?.stageAttempts ?? [];
    expect(stages.find((s) => s.stage === 'brand_only')?.candidateCount).toBe(0);
  }, 20_000);

  // Diagnostic réel confirmé en direct le 30/08 (protocole de débogage
  // distant Firefox, sur le vrai site) : contrairement à l'hypothèse
  // initialement retenue (une double soumission change+clic), un simple clic
  // ISOLÉ suffit À LUI SEUL à produire une URL de résultat double-encodée
  // (`%2520`) dès sa toute première navigation — bug propre au SPA Leclerc,
  // pas une redondance introduite par l'extension. Avant ce correctif,
  // `inspectLeclercSearchNavigationOnPage` ne reconnaissait jamais cette
  // forme d'URL comme confirmée (un `decodeURIComponent` unique laisse des
  // "%20" littéraux qui ne matchent jamais `expected`), donc
  // `waitForProductCandidates` brûlait tout `routeCheckBudgetMs` (4s) à
  // republic sonder une route qui ne se corrigerait jamais toute seule, avant
  // de laisser le reader (qui sait déjà corriger cette URL) s'exécuter une
  // seule fois. Ce test fige le court-circuit : dès que `doubleEncoded` est
  // signalé, le reader doit être appelé IMMÉDIATEMENT (pas après ~4s).
  it('court-circuite le budget de vérification de route dès qu\'une URL double-encodée est détectée, au lieu de l\'épuiser en entier', async () => {
    const candidate = {
      name: 'Lait demi écrémé UHT',
      priceEuro: 0.95,
      productUrl: 'https://m-courses.leclercdrive.fr/magasin-1/produit/lait-demi-ecreme'
    };

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'm-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche/Lait%2520demi%2520UHT',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        // Reproduit exactement le signal réel observé sur l'URL corrompue.
        inspectLeclercSearchNavigationOnPage: () => ({ ready: false, doubleEncoded: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [candidate],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
      })
    };

    const startedAt = Date.now();
    const result = await collectLeclercStore({
      scripting,
      tabId: 23,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-lait', name: 'Lait demi écrémé UHT', brand: '' }]
    });
    const durationMs = Date.now() - startedAt;

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].productUrl).toBe(candidate.productUrl);
    // Sans le correctif, cet appel attend au moins routeCheckBudgetMs (4000ms)
    // avant même d'essayer de lire les cartes une 1ère fois — largement audessus
    // de ce seuil, qui ne laisse la place qu'à un court-circuit immédiat.
    expect(durationMs).toBeLessThan(2000);
  }, 10_000);

  it("n'écarte pas à tort deux lectures dont les cartes ont des URLs identiques mais des produits réellement différents", async () => {
    // Bug réel confirmé par diagnostic (2026-08-26) : les cartes résultat
    // Leclerc n'ont jamais de lien direct vers leur fiche produit
    // (readProductCandidatesOnPage() y retombe sur le lien "voir le rayon",
    // souvent identique pour toutes les cartes d'une page, ou sur
    // `location.href`) — donc `productUrl` seul est un très mauvais signal
    // pour distinguer deux lectures réellement différentes. Ici, chaque
    // produit a un nom/prix bien distinct mais partage la MÊME `productUrl`
    // (comme sur une vraie page Leclerc) : le garde anti-contamination ne
    // doit pas les confondre.
    const sharedUrl = 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx';
    let call = 0;
    const products = [
      { productId: 'product-lait', name: 'Lait des campagnes', brand: '' },
      { productId: 'product-soja', name: 'Boisson soja nature', brand: '' }
    ];
    const cardsByCall = [
      [{ name: 'Lait des campagnes bio 1L', priceEuro: 1.15, productUrl: sharedUrl }],
      [{ name: 'Boisson soja nature bio 1L', priceEuro: 1.35, productUrl: sharedUrl }]
    ];

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => cardsByCall[Math.min(call++, cardsByCall.length - 1)],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 21,
      signal: new AbortController().signal,
      job: { jobId: 'job-abcdef1234567890' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(2);
    expect(result.observations.find((o) => o.productId === 'product-lait')?.observedName).toBe(
      'Lait des campagnes bio 1L'
    );
    expect(result.observations.find((o) => o.productId === 'product-soja')?.observedName).toBe(
      'Boisson soja nature bio 1L'
    );
  }, 15_000);
});

describe('collectLeclercStore — quasi-matchs (nearMisses) cumulés sur toute la cascade', () => {
  it("propose en nearMiss un candidat vu à l'étage 'name' même si l'étage suivant tenté ('simplified_name') ne lit aucune carte", async () => {
    // Bug réel (2026-08-27) : l'utilisateur a confirmé avoir vu une autre
    // boisson au soja proposée par la recherche Leclerc, mais le produit est
    // quand même remonté sans aucune alternative. Cause : `winningCandidates`
    // était écrasé à chaque étage de la cascade au lieu d'être cumulé — un
    // quasi-match vu à l'étage 'name' (score insuffisant pour devenir `best`)
    // disparaissait silencieusement si l'étage 'simplified_name' suivant ne
    // lisait aucune carte (page pas encore repeinte, lazy-load raté...).
    const nearMissCard = {
      name: 'Soja bio vanille',
      priceEuro: 1.2,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/soja-vanille'
    };
    const product = { productId: 'product-soja', name: 'Boisson soja nature 1L', brand: '' };
    let currentQuery = null;

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          currentQuery = searchedProduct.name;
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // Ne renvoie la carte "proche" que pour la requête ORIGINALE (étage
        // 'name') — l'étage 'simplified_name' suivant (requête sans "1L")
        // simule une page qui n'a rien chargé, ce qui écrasait auparavant
        // `winningCandidates` avec un tableau vide.
        readProductCandidatesOnPage: () => (currentQuery === product.name ? [nearMissCard] : []),
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 }),
        // Sans marque, la cascade tente désormais un 3e repli (mot-clé seul,
        // voir extractLeclercCoreKeyword) — sans ce mock, waitForProductCandidates
        // attend son budget complet avant de conclure "aucun résultat".
        isLeclercNoResultsConfirmedOnPage: () => true
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 22,
      signal: new AbortController().signal,
      job: { jobId: 'job-11112222aaaabbbb' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [product]
    });

    expect(result.observations).toEqual([]);
    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(error.code).toBe('PRODUCT_NOT_FOUND');
    expect(error.details?.nearMisses).toEqual([
      expect.objectContaining({ name: 'Soja bio vanille', productUrl: nearMissCard.productUrl })
    ]);
  }, 20_000);
});

describe('collectLeclercStore — marque distributeur concurrente exclue de la requête (name/simplified_name)', () => {
  // Bug réel (diagnostic 2026-08-27) : "Lait des campagnes" (marque
  // distributeur Carrefour) était recherché chez Leclerc comme "Lait des
  // campagnes Carrefour" dès l'étage 'name' — garantissant "Aucun résultat"
  // (déjà le raisonnement documenté pour l'étage brand_only, jamais appliqué
  // aux étages 'name'/'simplified_name' qui, eux, ajoutent toujours la marque
  // brute à la requête). hasRealLeclercBrand() est réutilisée pour exclure la
  // marque de la requête envoyée, sans jamais toucher au nom/marque
  // ORIGINAL utilisé pour le scoring des candidats.
  it("n'ajoute pas la marque concurrente à la requête de l'étage 'name'", async () => {
    const queries = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          queries.push({ name: searchedProduct.name, brand: searchedProduct.brand });
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [],
        // Sans ce mock, waitForProductCandidates ne détecte jamais la fin de
        // recherche et poll pendant tout son budget (15s) avant d'abandonner
        // — comme une vraie page "Aucun résultat ne correspond".
        isLeclercNoResultsConfirmedOnPage: () => true,
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    await collectLeclercStore({
      scripting,
      tabId: 23,
      signal: new AbortController().signal,
      job: { jobId: 'job-33334444cccceeee' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-lait', name: 'Lait des campagnes', brand: 'Carrefour' }]
    });

    // brand_only est sauté (hasRealLeclercBrand rejette déjà "Carrefour"), et
    // le nom simplifié serait identique au nom original ici (pas de bruit
    // d'emballage à retirer) donc cet étage n'est pas tenté. Sans marque,
    // la cascade retente ensuite le premier mot-clé significatif du nom
    // (extractLeclercCoreKeyword) plutôt que de s'arrêter net.
    expect(queries).toEqual([
      { name: 'Lait des campagnes', brand: '' },
      { name: 'Lait', brand: '' }
    ]);
  }, 15_000);

  it("n'ajoute pas la marque concurrente à la requête de repli de l'étage 'simplified_name'", async () => {
    const queries = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          queries.push({ name: searchedProduct.name, brand: searchedProduct.brand });
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // Aucune carte à aucun étage : force la cascade jusqu'à
        // 'simplified_name' pour observer sa propre requête.
        readProductCandidatesOnPage: () => [],
        // Sans ce mock, waitForProductCandidates ne détecte jamais la fin de
        // recherche et poll pendant tout son budget (15s) avant d'abandonner
        // — comme une vraie page "Aucun résultat ne correspond".
        isLeclercNoResultsConfirmedOnPage: () => true,
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    await collectLeclercStore({
      scripting,
      tabId: 24,
      signal: new AbortController().signal,
      job: { jobId: 'job-55556666ffffaaaa' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-lait', name: 'Lait des campagnes en sachet', brand: 'Carrefour' }]
    });

    // Sans marque, la cascade retente ensuite le premier mot-clé significatif
    // du nom (extractLeclercCoreKeyword) plutôt que de s'arrêter net.
    expect(queries).toEqual([
      { name: 'Lait des campagnes en sachet', brand: '' },
      { name: 'Lait des campagnes', brand: '' },
      { name: 'Lait', brand: '' }
    ]);
  }, 15_000);

  it('conserve une vraie marque (non concurrente) dans la requête', async () => {
    const queries = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          queries.push({ name: searchedProduct.name, brand: searchedProduct.brand });
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [],
        // Sans ce mock, waitForProductCandidates ne détecte jamais la fin de
        // recherche et poll pendant tout son budget (15s) avant d'abandonner
        // — comme une vraie page "Aucun résultat ne correspond".
        isLeclercNoResultsConfirmedOnPage: () => true,
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    await collectLeclercStore({
      scripting,
      tabId: 25,
      signal: new AbortController().signal,
      job: { jobId: 'job-77778888bbbbdddd' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-fromage', name: 'Emmental rape', brand: 'President' }]
    });

    expect(queries[0]).toEqual({ name: 'Emmental rape', brand: 'President' });
  }, 15_000);
});

// Bug réel confirmé par diagnostic + test en direct sur le vrai site
// (30/08, "Emmental râpé PRÉSIDENT") : le moteur de recherche Leclerc
// applique un ET strict sur tous les mots de la requête — une requête
// nom+marque échoue à 0 résultat dès que CETTE combinaison exacte n'existe
// pas au catalogue du magasin visé, même quand un équivalent générique du
// même produit existe sous un nom proche ("Emmental râpé" seul : 17
// résultats réels ; avec "PRÉSIDENT" ajouté : 0 résultat). Généralisé à
// N'IMPORTE QUEL produit à marque réelle (pas seulement ce cas précis) via
// le nouvel étage 'name_only', déclenché dès que la marque a effectivement
// été ajoutée à la requête d'un étage précédent.
describe("collectLeclercStore — repli 'name_only' quand une requête nom+marque échoue (ET strict du moteur Leclerc)", () => {
  it("retombe sur une recherche 'nom seul, sans marque' quand la marque réelle empêche tout résultat", async () => {
    const matchingCard = {
      name: 'Emmental râpé PRESIDENT 200g',
      priceEuro: 2.1,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/emmental-president'
    };
    const queries = [];

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          queries.push({ name: searchedProduct.name, brand: searchedProduct.brand });
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // Moteur Leclerc réel simulé : ET strict — toute requête qui inclut
        // encore la marque ne renvoie jamais rien, seule la requête SANS la
        // marque fait remonter la carte.
        readProductCandidatesOnPage: () => (queries.at(-1)?.brand ? [] : [matchingCard]),
        isLeclercNoResultsConfirmedOnPage: () => Boolean(queries.at(-1)?.brand),
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: queries.at(-1)?.brand ? 0 : 1 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 26,
      signal: new AbortController().signal,
      job: { jobId: 'job-99990000aaaabbbb' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-emmental', name: 'Emmental rape', brand: 'President' }]
    });

    // Nom simplifié identique à l'original ici (pas de bruit d'emballage) :
    // l'étage 'simplified_name' est sauté, seuls 'name' (avec marque) puis
    // 'name_only' (sans marque) sont réellement tentés.
    expect(queries).toEqual([
      { name: 'Emmental rape', brand: 'President' },
      { name: 'Emmental rape', brand: '' }
    ]);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('name_only');
    expect(result.observations[0].productUrl).toBe(matchingCard.productUrl);
  }, 20_000);

  // Généralisation du Fix A (hasRealLeclercBrand par mots) : une sous-marque
  // distributeur concurrente à plusieurs mots ("CARREFOUR KIDS") doit être
  // exclue de la requête dès l'étage 'name' — donc 'name_only' n'a rien à
  // apporter de plus ici et ne doit jamais être tenté (brand déjà vide).
  it("ne tente jamais 'name_only' quand la marque était déjà exclue comme concurrente à plusieurs mots dès l'étage 'name'", async () => {
    const matchingCard = {
      name: 'Mousse aux fruits 4x100g',
      priceEuro: 1.8,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/mousse-fruits'
    };
    const queries = [];

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          queries.push({ name: searchedProduct.name, brand: searchedProduct.brand });
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [matchingCard],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 27,
      signal: new AbortController().signal,
      job: { jobId: 'job-aaaa1111bbbb2222' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-mousse', name: 'Mousse aux fruits', brand: 'CARREFOUR KIDS' }]
    });

    // Un seul appel : la marque concurrente est exclue dès l'étage 'name'
    // (Fix A), donc le candidat est trouvé immédiatement — 'name_only'
    // n'est jamais nécessaire (nameStageProduct.brand est déjà vide).
    expect(queries).toEqual([{ name: 'Mousse aux fruits', brand: '' }]);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('name');
  }, 15_000);

  // Bug réel confirmé par diagnostic (30/08, v0.5.59, "Mousse aux fruits"
  // marque "CARREFOUR KIDS") : contrairement au test précédent, le seul
  // résultat trouvé à l'étage 'name' est en RUPTURE de stock — 0 candidat
  // valide, et la cascade s'arrêtait net faute de marque à retirer (aucun
  // repli 'name_only'/'brand_only' possible). Le nouveau repli par mot-clé
  // (extractLeclercCoreKeyword) doit se déclencher même sans marque et
  // trouver une alternative disponible sous un nom proche.
  it("retente avec le premier mot-clé du nom quand le produit n'a pas de marque et que le seul résultat trouvé est en rupture", async () => {
    // Un produit en rupture ("Bientôt disponible") n'affiche aucun prix sur
    // sa carte Leclerc — priceEuro non défini, donc exclu par le filtre
    // `valid` de rankLeclercCandidates (candidateCount: 0), exactement comme
    // dans le diagnostic réel (pas un filtre explicite sur `available`).
    const outOfStockCard = {
      name: 'Mousse aux fruits Petits Délis',
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/mousse-fruits-petits-delis'
    };
    const alternateCard = {
      name: 'Mousse fromage frais sucré fruits',
      priceEuro: 1.81,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/mousse-fromage-frais-fruits'
    };
    const queries = [];
    let currentQuery = null;

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          queries.push({ name: searchedProduct.name, brand: searchedProduct.brand });
          currentQuery = searchedProduct.name;
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // L'étage 'name' ("Mousse aux fruits") ne voit que le produit en
        // rupture ; le repli mot-clé ("Mousse") fait remonter l'alternative.
        readProductCandidatesOnPage: () => (currentQuery === 'Mousse' ? [alternateCard] : [outOfStockCard]),
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 }),
        isLeclercNoResultsConfirmedOnPage: () => false
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 28,
      signal: new AbortController().signal,
      job: { jobId: 'job-cccc3333dddd4444' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-mousse-rupture', name: 'Mousse aux fruits', brand: 'CARREFOUR KIDS' }]
    });

    expect(queries).toEqual([
      { name: 'Mousse aux fruits', brand: '' },
      { name: 'Mousse', brand: '' }
    ]);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('name_only');
    expect(result.observations[0].productUrl).toBe(alternateCard.productUrl);
  }, 15_000);
});

// Point A du plan d'observabilité (diagnostic réel 2026-08-28) : le
// diagnostic exporté ne traçait `stageAttempts` (détail de chaque étage de la
// cascade réellement tenté) que pour un produit en échec total
// (PRODUCT_NOT_FOUND) — un produit trouvé après plusieurs étages ne laissait
// aucune preuve du chemin parcouru, empêchant de vérifier après coup si un
// étage antérieur avait déjà vu le bon candidat sans le retenir.
describe('collectLeclercStore — stageAttempts exporté même sur un succès', () => {
  it('trace chaque étage tenté (pas seulement le gagnant) sur une observation réussie', async () => {
    const product = { productId: 'product-soja', name: 'Boisson soja nature 1L', brand: '' };
    const matchingCard = {
      name: 'Boisson soja nature 1L',
      priceEuro: 1.35,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/soja-nature'
    };
    let currentQuery = null;

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          currentQuery = searchedProduct.name;
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        // L'étage 'name' (requête complète "...1L") ne lit rien — ce n'est
        // qu'à l'étage 'simplified_name' (bruit de quantité retiré) que la
        // même carte, identique au nom d'origine, est enfin lue.
        readProductCandidatesOnPage: () => (currentQuery === product.name ? [] : [matchingCard]),
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 23,
      signal: new AbortController().signal,
      job: { jobId: 'job-cccc1111dddd2222' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [product]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    const [observation] = result.observations;
    expect(observation.matchStage).toBe('simplified_name');
    expect(observation.stageAttempts).toEqual([
      expect.objectContaining({ stage: 'name', candidateCount: 0 }),
      expect.objectContaining({
        stage: 'simplified_name',
        candidateCount: 1,
        topMatchName: matchingCard.name
      })
    ]);
  }, 20_000);
});

// Bug réel confirmé par diagnostic (2026-08-28) puis reproduit en isolation
// par navigation directe sur le vrai site : une requête de recherche
// contenant '%' fait planter le service Leclerc (redirection immédiate vers
// la page d'erreur technique du site) au lieu de renvoyer des résultats.
describe('collectLeclercStore — le caractère \'%\' du nom produit ne part jamais dans la requête de recherche', () => {
  it("soumet une requête sans '%' dès l'étage 'name', et matche quand même correctement contre le nom ORIGINAL", async () => {
    const product = {
      productId: 'product-emmental',
      name: 'President emmental rape sel reduit de 30% 150g',
      brand: ''
    };
    const matchingCard = {
      name: 'Emmental râpé réduit en sel PRESIDENT - 150g',
      priceEuro: 2.42,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/emmental-president'
    };
    const submittedQueries = [];

    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (searchedProduct) => {
          submittedQueries.push(searchedProduct.name);
          return { started: true, query: searchedProduct.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [matchingCard],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 24,
      signal: new AbortController().signal,
      job: { jobId: 'job-dddd3333eeee4444' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [product]
    });

    expect(submittedQueries.length).toBeGreaterThan(0);
    for (const query of submittedQueries) {
      expect(query).not.toContain('%');
    }
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    // Le scoring reste fait contre le nom ORIGINAL (avec son '%') : le
    // matching a bien fonctionné malgré la requête nettoyée.
    expect(result.observations[0].observedName).toBe(matchingCard.name);
  }, 20_000);
});

// Étape 7 du plan de fiabilisation (points morts additionnels) : le chemin
// d'ajout au panier ne vérifiait jamais `hasCaptcha` sur `!best`,
// contrairement à collectLeclercStore (scraping de prix) — un captcha en
// cours de remplissage dégénérait silencieusement en CART_PRODUCT_NOT_FOUND
// répété au lieu d'interrompre le job. Corrigé le 2026-08-27.
describe('addToCartLeclercStore — détection CAPTCHA interrompt tout le job', () => {
  it('rejette avec CAPTCHA_DETECTED au lieu de renvoyer CART_PRODUCT_NOT_FOUND', async () => {
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [],
        isLeclercNoResultsConfirmedOnPage: () => true,
        inspectLeclercProductPageOnPage: () => ({
          url: '',
          pathname: '',
          pageTitle: '',
          bodyTextSnippet: '',
          hasCaptcha: true
        })
      })
    };

    await expect(
      addToCartLeclercStore({
        scripting,
        tabId: 30,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'leclerc', localStoreId: 'store-1' },
        items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
      })
    ).rejects.toThrow('CAPTCHA_DETECTED');
  }, 15_000);
});

// Revue du 2026-08-28 (après test réel) : un sondage de plusieurs minutes
// dans le service worker a été essayé puis abandonné — MV3 décharge ce
// worker de façon agressive sur Android dès que Firefox n'est plus au
// premier plan, ce qui arrive systématiquement pendant une double
// authentification. addToCartLeclercStore fait donc un contrôle unique et
// immédiat : pas connecté (y compris état indéterminé) → CART_LOGIN_REQUIRED
// tout de suite, onglet laissé ouvert, sans qu'aucune recherche produit ne
// démarre.
describe('addToCartLeclercStore — vérification de connexion (contrôle unique, sans sondage)', () => {
  it('échoue immédiatement en CART_LOGIN_REQUIRED sans lancer de recherche, si signedIn: false', async () => {
    const searchStarted = vi.fn();
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: false, evidence: 'Se connecter' }),
        startProductSearchOnPage: searchStarted
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });

    expect(searchStarted).not.toHaveBeenCalled();
    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual([
      { storeKey: 'leclerc', code: 'CART_LOGIN_REQUIRED', details: { evidence: 'Se connecter' } }
    ]);
    expect(result.keepTabOpen).toBe(true);
  });

  // Contrairement à la détection de connexion utilisée ailleurs dans le
  // projet (qui ne bloque jamais sur un état indéterminé, pour ne pas
  // empêcher à tort un remplissage valide), ici l'utilisateur exige
  // l'inverse : ne JAMAIS chercher un produit tant que la connexion n'est
  // pas confirmée — un état indéterminé (signedIn: null) doit donc bloquer
  // exactement comme un état franchement déconnecté.
  it('bloque aussi sur un état de connexion indéterminé (pas seulement "déconnecté")', async () => {
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: null, evidence: null })
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });

    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual([{ storeKey: 'leclerc', code: 'CART_LOGIN_REQUIRED', details: { evidence: null } }]);
    expect(result.keepTabOpen).toBe(true);
  });

  it('lance normalement les recherches quand signedIn: true dès le premier contrôle', async () => {
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [],
        isLeclercNoResultsConfirmedOnPage: () => true,
        inspectLeclercProductPageOnPage: () => ({ url: '', pathname: '', pageTitle: '', bodyTextSnippet: '', hasCaptcha: false })
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations[0].code).toBe('CART_PRODUCT_NOT_FOUND');
  });
});

// Bug rapporté en conditions réelles (2026-08-28) : le produit ajouté au
// panier n'était pas celui sélectionné dans la liste de comparaison — le
// matching ne se faisait qu'au nom, transmis seul jusqu'ici (voir
// cartFillService.ts avant fix). Avec l'EAN du candidat validé transmis
// dans l'item, le bon produit doit être retenu même face à un homonyme
// proche par le nom.
describe('addToCartLeclercStore — matching exact par EAN quand disponible', () => {
  it('retient le candidat dont le barcode correspond exactement à item.barcode, pas le mieux noté par nom seul', async () => {
    const clickCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [
          // Nom quasiment identique, EAN différent — gagnerait un matching
          // par nom seul si l'ordre ou un score approximatif le favorisait.
          {
            name: "Lait demi écrémé LAIT D'ICI",
            barcode: '1111111111111',
            priceEuro: 1.1,
            available: true,
            productUrl: 'https://fd4-courses.leclercdrive.fr/produit/autre-1'
          },
          // Le candidat réellement validé par l'utilisateur.
          {
            name: "Lait demi écrémé LAIT D'ICI 6x1L",
            barcode: '2222222222222',
            priceEuro: 5.64,
            available: true,
            productUrl: 'https://fd4-courses.leclercdrive.fr/produit/le-bon-2'
          }
        ],
        clickAddToCartOnMatchedLeclercCardOnPage: (...args) => {
          clickCalls.push(args);
          return { added: true };
        }
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', barcode: '2222222222222', quantity: 1 }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations[0].added).toBe(true);
    expect(clickCalls).toHaveLength(1);
    expect(clickCalls[0][0]).toBe("Lait demi écrémé LAIT D'ICI 6x1L");
    expect(clickCalls[0][1]).toBe(5.64);
  });
});

// Bug rapporté en conditions réelles (2026-08-28) : après un pick manuel
// utilisateur (bouton "✓ Valider ce produit" sur la fiche Leclerc), l'URL
// exacte validée était bien enregistrée dans le candidat (productUrl,
// matchType: 'manual_override') mais jamais réellement utilisée par
// addToCartLeclercStore, qui repartait systématiquement sur une recherche
// par nom. Voir tryAddToCartLeclercViaProductUrl / isLeclercStandaloneProductUrl.
describe('addToCartLeclercStore — utilise item.productUrl (pick manuel) en priorité quand il pointe vers une vraie fiche produit', () => {
  const standaloneUrl =
    'https://fd7-courses.leclercdrive.fr/magasin-1/fiche-produits-5870-Boisson-soja-nature-Vg-1L.aspx?sProvenance=SM';

  it('navigue directement vers la fiche validée et clique son bouton principal, sans jamais lancer de recherche', async () => {
    const searchStarted = vi.fn();
    const navigateCalls = [];
    const clickCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        navigateToLeclercUrlOnPage: (targetUrl) => {
          navigateCalls.push(targetUrl);
          return { started: true };
        },
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Boisson soja nature Vg 1L', priceEuro: 1.35 }),
        clickAddToCartOnLeclercProductPageOnPage: (quantity) => {
          clickCalls.push(quantity);
          return { added: true };
        },
        startProductSearchOnPage: searchStarted
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-soja', name: 'Boisson soja nature', brand: '', quantity: 1, productUrl: standaloneUrl }]
    });

    // Deuxième appel : retour explicite sur la page de recherche mémorisée
    // avant le produit (voir le commentaire dans addToCartLeclercStore) —
    // même en cas de succès, la fiche standalone atteinte n'a aucune zone de
    // recherche, donc ce retour a lieu systématiquement avant de continuer.
    expect(navigateCalls).toEqual([standaloneUrl, 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx']);
    expect(clickCalls).toEqual([1]);
    expect(searchStarted).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
    expect(result.observations).toEqual([
      {
        protocolVersion: 1,
        jobId: 'job-1234567890abcdef',
        productId: 'product-soja',
        storeKey: 'leclerc',
        added: true,
        matchedName: 'Boisson soja nature Vg 1L',
        matchedPriceEuro: 1.35
      }
    ]);
  });

  it("ne tente jamais la navigation directe quand productUrl n'est qu'une page de résultats de recherche partagée", async () => {
    const navigateCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        navigateToLeclercUrlOnPage: (targetUrl) => {
          navigateCalls.push(targetUrl);
          return { started: true };
        },
        startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
        triggerLeclercLazyLoadOnPage: () => undefined,
        readProductCandidatesOnPage: () => [
          { name: 'Boisson soja nature bio 1L', priceEuro: 1.35, available: true, productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }
        ],
        clickAddToCartOnMatchedLeclercCardOnPage: () => ({ added: true })
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [
        {
          productId: 'product-soja',
          name: 'Boisson soja nature',
          brand: '',
          quantity: 1,
          productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx?TexteRecherche=soja'
        }
      ]
    });

    expect(navigateCalls).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.observations[0].added).toBe(true);
  });

  it('échoue sèchement (sans jamais lancer de recherche) si la fiche atteinte ne correspond plus au produit attendu (URL périmée redirigée)', async () => {
    const navigateCalls = [];
    const directClickCalls = [];
    const searchStarted = vi.fn();
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        navigateToLeclercUrlOnPage: (targetUrl) => {
          navigateCalls.push(targetUrl);
          return { started: true };
        },
        // Lien périmé, silencieusement redirigé vers une page de résultats
        // générique : le nom lu n'a plus rien à voir avec le produit attendu.
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Lessive Ariel 3L', priceEuro: 9.9 }),
        clickAddToCartOnLeclercProductPageOnPage: (quantity) => {
          directClickCalls.push(quantity);
          return { added: true };
        },
        startProductSearchOnPage: searchStarted
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-soja', name: 'Boisson soja nature', brand: '', quantity: 1, productUrl: standaloneUrl }]
    });

    // Retour explicite sur la page de recherche même en cas d'échec sec — pour
    // ne pas laisser l'onglet bloqué sur la fiche standalone en vue du
    // produit suivant du job (cf. commentaire dans addToCartLeclercStore).
    expect(navigateCalls).toEqual([standaloneUrl, 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx']);
    expect(directClickCalls).toEqual([]);
    // Plus AUCUN repli sur la recherche par nom (revu le 2026-09-01) : cette
    // fiche n'est pas celle validée, l'ajouter au panier reviendrait à y
    // mettre un produit différent de celui choisi par l'utilisateur.
    expect(searchStarted).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
    // Le motif du refus voyage avec l'observation (ajouté le 2026-09-01) :
    // sans lui, le diagnostic exporté ne montrait qu'un code sec, impossible
    // à distinguer d'une garde trop stricte sur un nom pourtant correct.
    expect(result.observations[0]).toEqual({
      protocolVersion: 1,
      jobId: 'job-1234567890abcdef',
      productId: 'product-soja',
      storeKey: 'leclerc',
      added: false,
      code: 'CART_DIRECT_URL_MISMATCH',
      details: {
        expectedName: 'Boisson soja nature',
        pageName: 'Lessive Ariel 3L',
        nameScore: 0
      }
    });
  });

  it('échoue sèchement (sans jamais lancer de recherche) si le bouton "Ajouter au panier" de la fiche est introuvable', async () => {
    const searchStarted = vi.fn();
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        navigateToLeclercUrlOnPage: () => ({ started: true }),
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Boisson soja nature Vg 1L', priceEuro: 1.35 }),
        clickAddToCartOnLeclercProductPageOnPage: () => ({ added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' }),
        startProductSearchOnPage: searchStarted
      })
    };

    const result = await addToCartLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      items: [{ productId: 'product-soja', name: 'Boisson soja nature', brand: '', quantity: 1, productUrl: standaloneUrl }]
    });

    expect(searchStarted).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toEqual({
      protocolVersion: 1,
      jobId: 'job-1234567890abcdef',
      productId: 'product-soja',
      storeKey: 'leclerc',
      added: false,
      code: 'ADD_TO_CART_CONTROL_NOT_FOUND'
    });
  });

  it('interrompt tout le job en CAPTCHA_DETECTED si la navigation directe tombe sur un captcha, sans jamais lancer de recherche', async () => {
    const searchStarted = vi.fn();
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        navigateToLeclercUrlOnPage: () => ({ started: true }),
        readLeclercProductPageOnPage: () => ({ ok: false, code: 'SITE_BLOCKED' }),
        startProductSearchOnPage: searchStarted
      })
    };

    await expect(
      addToCartLeclercStore({
        scripting,
        tabId: 30,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'leclerc', localStoreId: 'store-1' },
        items: [{ productId: 'product-soja', name: 'Boisson soja nature', brand: '', quantity: 1, productUrl: standaloneUrl }]
      })
    ).rejects.toThrow('CAPTCHA_DETECTED');

    expect(searchStarted).not.toHaveBeenCalled();
  }, 15_000);
});

// Reproduit le blocage réel signalé le 2026-08-28 : `scripting.executeScript`
// n'a lui-même aucun timeout, donc un onglet figé (page qui ne finit jamais
// de charger — le symptôme observé : « page inexistante » côté site, plus
// aucune progression) gelait toute la collecte indéfiniment, sans erreur ni
// diagnostic — même le chien de garde de 15 min du job-runner ne pouvait pas
// aider (voir extension/shared/scripting-timeout.js). Ici, l'appel figé est
// simulé directement par un rejet SCRIPT_EXECUTION_TIMEOUT (le comportement
// du minuteur lui-même est couvert séparément par scripting-timeout.test.js).
//
// Diagnostic réel complémentaire (29/08, 3 exports consécutifs) : un
// SCRIPT_EXECUTION_TIMEOUT frappait systématiquement le TOUT PREMIER produit
// alors que l'onglet Hyper U tournait sans souci en parallèle — rien
// n'indiquait que l'onglet Leclerc soit réellement mort. collectLeclercStore
// sonde donc désormais l'onglet (budget réduit) avant de décider : onglet qui
// répond encore → un seul produit sauté, la boucle continue ; onglet qui ne
// répond plus non plus → abandon complet du magasin (comportement historique,
// même famille que CAPTCHA_DETECTED ci-dessus), avec préservation des
// observations déjà obtenues.
describe('collectLeclercStore — un onglet figé interrompt tout le magasin', () => {
  it('rejette avec SCRIPT_EXECUTION_TIMEOUT si la sonde de survie confirme que le magasin ne répond plus', async () => {
    const scripting = {
      executeScript: vi.fn(async ({ func, args }) => {
        // Recherche ET sonde de survie échouent toutes les deux : un vrai
        // onglet mort ne répondrait pas davantage à la sonde qu'à la
        // recherche elle-même.
        if (func.name === 'startProductSearchOnPage' || func.name === 'readPublicLeclercPageState') {
          throw new Error('SCRIPT_EXECUTION_TIMEOUT');
        }
        const handlers = {
          dismissCookieConsentOnPage: () => ({ dismissed: false })
        };
        const handler = handlers[func.name];
        if (!handler) throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
        return [{ result: await handler(...(args ?? [])) }];
      })
    };

    await expect(
      collectLeclercStore({
        scripting,
        tabId: 10,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'leclerc', localStoreId: 'store-1' },
        products: [{ productId: 'product-1', name: 'Lait demi écrémé' }]
      })
    ).rejects.toThrow('SCRIPT_EXECUTION_TIMEOUT');
  }, 15_000);

  it("ne saute qu'UN produit (au lieu d'abandonner tout le magasin) quand la sonde de survie confirme que l'onglet répond encore", async () => {
    let searchCalls = 0;
    const secondCandidate = {
      name: 'Riz basmati Lustucru 1kg',
      priceEuro: 2.5,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/riz-1'
    };

    const scripting = {
      executeScript: vi.fn(async ({ func, args }) => {
        if (func.name === 'startProductSearchOnPage') {
          searchCalls += 1;
          // Les 4 premiers appels échouent, tous pour le premier produit :
          // tentative initiale + retry de runPageActionWithTimeoutRetry, puis
          // le rejeu complet du produit (PRODUCT_TIMEOUT_RETRIES, ajouté le
          // 2026-09-01) qui refait la même paire. Le premier produit est donc
          // épuisé, et le second doit être traité normalement par la boucle
          // si elle continue bien après lui.
          if (searchCalls <= 4) throw new Error('SCRIPT_EXECUTION_TIMEOUT');
          return [{ result: { started: true, query: args?.[0]?.name } }];
        }
        const handlers = {
          dismissCookieConsentOnPage: () => ({ dismissed: false }),
          // Sonde de survie : l'onglet répond normalement (catalogue affiché,
          // pas de captcha ni de page d'erreur) — donc pas un onglet mort.
          readPublicLeclercPageState: () => ({
            hostname: 'fd4-courses.leclercdrive.fr',
            pathname: '/magasin-1/recherche.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }),
          inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
          triggerLeclercLazyLoadOnPage: () => undefined,
          readProductCandidatesOnPage: () => [secondCandidate],
          inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
        };
        const handler = handlers[func.name];
        if (!handler) throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
        return [{ result: await handler(...(args ?? [])) }];
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [
        { productId: 'product-1', name: 'Lait demi écrémé' },
        { productId: 'product-2', name: 'Riz basmati' }
      ]
    });

    expect(result.errors).toEqual([
      { storeKey: 'leclerc', productId: 'product-1', code: 'PRODUCT_SEARCH_TIMEOUT' }
    ]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ productId: 'product-2' });
  }, 15_000);

  // Diagnostic réel du 01/09 : 5 produits sur 11 sont ressortis sans prix
  // Leclerc alors que l'onglet répondait encore. Le retry de
  // runPageActionWithTimeoutRetry ne couvre QUE l'appel injecté qui a figé ;
  // si l'accroc dure un peu plus longtemps que ces deux tentatives
  // rapprochées, le produit était perdu définitivement. Un rejeu complet du
  // produit (une seule fois) laisse au site le temps de se remettre.
  it("rejoue une fois le produit entier quand la sonde confirme un onglet sain, et le récupère", async () => {
    let searchCalls = 0;
    const candidate = {
      name: 'Lait demi écrémé UHT Délisse 6x1L',
      priceEuro: 6.3,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/lait-1'
    };

    const scripting = {
      executeScript: vi.fn(async ({ func, args }) => {
        if (func.name === 'startProductSearchOnPage') {
          searchCalls += 1;
          // Tentative initiale + retry rapproché : les deux figent. Le rejeu
          // du produit repart de zéro et, cette fois, le site répond.
          if (searchCalls <= 2) throw new Error('SCRIPT_EXECUTION_TIMEOUT');
          return [{ result: { started: true, query: args?.[0]?.name } }];
        }
        const handlers = {
          dismissCookieConsentOnPage: () => ({ dismissed: false }),
          readPublicLeclercPageState: () => ({
            hostname: 'fd4-courses.leclercdrive.fr',
            pathname: '/magasin-1/recherche.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }),
          inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
          triggerLeclercLazyLoadOnPage: () => undefined,
          readProductCandidatesOnPage: () => [candidate],
          inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
        };
        const handler = handlers[func.name];
        if (!handler) throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
        return [{ result: await handler(...(args ?? [])) }];
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi écrémé' }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ productId: 'product-1', priceEuro: 6.3 });
  }, 15_000);

  // Diagnostic réel (29/08, run après le correctif de sonde de survie) :
  // SCRIPT_EXECUTION_TIMEOUT sur startProductSearchOnPage a frappé 4 produits
  // différents dans la même collecte, sans lien avec le contenu de leurs
  // requêtes — un aléa ponctuel côté pont d'injection, pas un vrai blocage.
  // Une seule nouvelle tentative (runPageActionWithTimeoutRetry) doit
  // absorber ce cas sans même générer de PRODUCT_SEARCH_TIMEOUT.
  it("récupère un produit dont la 1ère soumission de recherche échoue une seule fois (nouvelle tentative automatique)", async () => {
    let searchCalls = 0;
    const candidate = {
      name: 'Lait demi écrémé UHT Délisse',
      priceEuro: 6.3,
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/lait-1'
    };

    const scripting = {
      executeScript: vi.fn(async ({ func, args }) => {
        if (func.name === 'startProductSearchOnPage') {
          searchCalls += 1;
          if (searchCalls === 1) throw new Error('SCRIPT_EXECUTION_TIMEOUT');
          return [{ result: { started: true, query: args?.[0]?.name } }];
        }
        const handlers = {
          dismissCookieConsentOnPage: () => ({ dismissed: false }),
          readPublicLeclercPageState: () => ({
            hostname: 'fd4-courses.leclercdrive.fr',
            pathname: '/magasin-1/recherche.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }),
          inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
          triggerLeclercLazyLoadOnPage: () => undefined,
          readProductCandidatesOnPage: () => [candidate],
          inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
        };
        const handler = handlers[func.name];
        if (!handler) throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
        return [{ result: await handler(...(args ?? [])) }];
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi écrémé' }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ productId: 'product-1' });
    expect(searchCalls).toBe(2);
  }, 15_000);
});

describe('addToCartLeclercStore — un onglet figé interrompt tout le job', () => {
  it('rejette avec SCRIPT_EXECUTION_TIMEOUT au lieu de renvoyer ADD_TO_CART_FAILED', async () => {
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        readLeclercSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
        startProductSearchOnPage: () => {
          throw new Error('SCRIPT_EXECUTION_TIMEOUT');
        }
      })
    };

    await expect(
      addToCartLeclercStore({
        scripting,
        tabId: 30,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'leclerc', localStoreId: 'store-1' },
        items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
      })
    ).rejects.toThrow('SCRIPT_EXECUTION_TIMEOUT');
  }, 15_000);
});

describe('collectLeclercStore — raccourci "permalien appris"', () => {
  const KNOWN_URL = 'https://fd4-courses.leclercdrive.fr/magasin-1/fiche-produits-60892-Riz.aspx';
  const SEARCH_CANDIDATE = {
    name: 'Riz basmati Lustucru 1kg',
    priceEuro: 2.5,
    productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/riz-1'
  };

  // Handlers communs : la recherche fonctionne normalement, si bien que tout
  // écart observé vient uniquement du raccourci testé.
  const baseHandlers = (extra) => ({
    dismissCookieConsentOnPage: () => ({ dismissed: false }),
    readPublicLeclercPageState: () => ({
      hostname: 'fd4-courses.leclercdrive.fr',
      pathname: '/magasin-1/recherche.aspx',
      hasCaptcha: false,
      hasStorePrompt: false,
      hasCatalog: true
    }),
    readCurrentLeclercUrlOnPage: () => ({ href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' }),
    navigateToLeclercUrlOnPage: () => ({ started: true }),
    startProductSearchOnPage: (product) => ({ started: true, query: product.name }),
    inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
    triggerLeclercLazyLoadOnPage: () => undefined,
    readProductCandidatesOnPage: () => [SEARCH_CANDIDATE],
    inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 }),
    ...extra
  });

  const run = async (handlers) =>
    collectLeclercStore({
      scripting: { executeScript: makeDispatcher(handlers) },
      tabs: { update: vi.fn(async () => undefined) },
      tabId: 30,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        knownProductUrls: { leclerc: { 'product-riz-1': KNOWN_URL } }
      },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-riz-1', name: 'Riz basmati Lustucru 1kg', brand: 'Lustucru' }]
    });

  it('relit la fiche mémorisée sans relancer la moindre recherche', async () => {
    const startProductSearchOnPage = vi.fn(() => ({ started: true, query: 'riz' }));
    const result = await run(
      baseHandlers({
        startProductSearchOnPage,
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Riz basmati Lustucru 1kg', priceEuro: 2.4 })
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('known_url');
    expect(result.observations[0].productUrl).toBe(KNOWN_URL);
    expect(result.observations[0].priceEuro).toBe(2.4);
    // Le gain de temps demandé : aucune recherche déclenchée du tout.
    expect(startProductSearchOnPage).not.toHaveBeenCalled();
  });

  it("ne s'octroie jamais la confiance d'un choix humain", async () => {
    // Piège central de cette fonctionnalité : un matchScore de 1 avec un
    // matchStage 'manual' vaudrait 100 % de confiance côté PWA, pour une
    // fiche que personne n'a jamais validée.
    const result = await run(
      baseHandlers({
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Riz basmati Lustucru 1kg', priceEuro: 2.4 })
      })
    );

    expect(result.observations[0].matchStage).toBe('known_url');
    expect(result.observations[0].matchStage).not.toBe('manual');
    expect(result.observations[0].matchScore).toBeLessThanOrEqual(1);
  });

  it('retombe sur la recherche normale quand la fiche mémorisée montre un autre produit', async () => {
    const result = await run(
      baseHandlers({
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Café moulu Carte Noire 250g', priceEuro: 3.9 })
      })
    );

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('name');
    expect(result.observations[0].productUrl).toBe(SEARCH_CANDIDATE.productUrl);
    // Un raccourci raté n'est pas une panne : rien ne doit remonter comme
    // erreur à l'utilisateur puisque la recherche a fait son travail.
    expect(result.errors).toEqual([]);
  });

  it('retombe sur la recherche normale quand la fiche mémorisée a disparu', async () => {
    const result = await run(
      baseHandlers({
        readLeclercProductPageOnPage: () => ({ ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' })
      })
    );

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('name');
  });

  it('quitte la fiche lue par permalien avant de chercher le produit suivant', async () => {
    // Régression réelle du 02/09 : le retour sur la page de recherche n'était
    // fait que lorsque le raccourci ÉCHOUAIT. Après un raccourci réussi,
    // l'onglet restait sur la fiche ASP.NET — qui n'a aucune zone de
    // recherche — et le produit suivant, lui sans permalien, ressortait en
    // "champ de recherche introuvable".
    let onProductPage = false;
    const result = await collectLeclercStore({
      scripting: {
        executeScript: makeDispatcher(
          baseHandlers({
            readLeclercProductPageOnPage: () => {
              onProductPage = true;
              return { ok: true, name: 'Riz basmati Lustucru 1kg', priceEuro: 2.4 };
            },
            navigateToLeclercUrlOnPage: () => {
              onProductPage = false;
              return { started: true };
            },
            readCurrentLeclercUrlOnPage: () => ({
              href: onProductPage
                ? KNOWN_URL
                : 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx'
            }),
            startProductSearchOnPage: (product) => {
              // La vraie contrainte du site : pas de champ de recherche sur
              // une fiche produit.
              if (onProductPage) return { started: false, code: 'PRODUCT_SEARCH_INPUT_NOT_FOUND' };
              return { started: true, query: product.name };
            },
            readProductCandidatesOnPage: () => [
              { name: 'Thé glacé pêche sans sucre 1.5L', priceEuro: 1.8, productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/the-1' }
            ]
          })
        )
      },
      tabs: { update: vi.fn(async () => undefined) },
      tabId: 30,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        knownProductUrls: { leclerc: { 'product-riz-1': KNOWN_URL } }
      },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [
        { productId: 'product-riz-1', name: 'Riz basmati Lustucru 1kg', brand: 'Lustucru' },
        { productId: 'product-the-1', name: 'Thé glacé pêche sans sucre', brand: '' }
      ]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0].matchStage).toBe('known_url');
    expect(result.observations[1].productId).toBe('product-the-1');
  }, 20_000);

  it('attend d’avoir quitté la fiche avant de relancer la recherche', async () => {
    // Constaté en réel le 02/09 : après un raccourci raté, une attente fixe
    // de 2 s laissait parfois l'onglet encore sur la fiche produit — qui n'a
    // aucune zone de recherche — et le produit ressortait en "champ de
    // recherche introuvable" au lieu d'être simplement cherché.
    let urlReads = 0;
    const startProductSearchOnPage = vi.fn((product) => {
      // Au moment où la recherche démarre, l'onglet ne doit plus être sur la
      // fiche : sinon le vrai site n'aurait pas de champ où taper.
      expect(urlReads).toBeGreaterThan(0);
      return { started: true, query: product.name };
    });

    const result = await run(
      baseHandlers({
        startProductSearchOnPage,
        readLeclercProductPageOnPage: () => ({ ok: true, name: 'Café moulu Carte Noire 250g', priceEuro: 3.9 }),
        readCurrentLeclercUrlOnPage: () => {
          urlReads += 1;
          // 1re lecture : la route mémorisée avant la boucle produits.
          // 2e : on est encore sur la fiche, la navigation n'a pas abouti.
          // 3e : le retour est effectif.
          if (urlReads <= 2) {
            return { href: urlReads === 1
              ? 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx'
              : KNOWN_URL };
          }
          return { href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx' };
        }
      })
    );

    expect(startProductSearchOnPage).toHaveBeenCalled();
    expect(result.observations[0].matchStage).toBe('name');
  }, 20_000);

  it('ignore un permalien qui ne pointe pas vers une fiche produit', async () => {
    const readLeclercProductPageOnPage = vi.fn(() => ({ ok: true, name: 'peu importe', priceEuro: 1 }));
    const result = await collectLeclercStore({
      scripting: {
        executeScript: makeDispatcher(baseHandlers({ readLeclercProductPageOnPage }))
      },
      tabs: { update: vi.fn(async () => undefined) },
      tabId: 31,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        knownProductUrls: {
          leclerc: { 'product-riz-1': 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche/Riz' }
        }
      },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-riz-1', name: 'Riz basmati Lustucru 1kg', brand: 'Lustucru' }]
    });

    expect(readLeclercProductPageOnPage).not.toHaveBeenCalled();
    expect(result.observations[0].matchStage).toBe('name');
  });
});

describe('collectLeclercStore — relecture d’une fiche corrigée à la main', () => {
  // Régression réelle trouvée le 02/09 : `tabs` était transmis à
  // collectLeclercManualProduct sans exister dans le scope de
  // collectLeclercStore. Chaque relecture de fiche partait donc en
  // ReferenceError, avalée par le catch, et retombait sur la recherche — une
  // correction manuelle Leclerc n'était en pratique JAMAIS relue.
  it('navigue sur la fiche validée au lieu de relancer la recherche', async () => {
    const FICHE_URL = 'https://fd4-courses.leclercdrive.fr/magasin-1/fiche-produits-60892-Riz.aspx';
    const startProductSearchOnPage = vi.fn(() => ({ started: true, query: 'riz' }));

    const result = await collectLeclercStore({
      scripting: {
        executeScript: makeDispatcher({
          dismissCookieConsentOnPage: () => ({ dismissed: false }),
          readPublicLeclercPageState: () => ({
            hostname: 'fd4-courses.leclercdrive.fr',
            pathname: '/magasin-1/recherche.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }),
          readCurrentLeclercUrlOnPage: () => ({
            href: 'https://fd4-courses.leclercdrive.fr/magasin-1/recherche.aspx'
          }),
          navigateToLeclercUrlOnPage: () => ({ started: true }),
          readLeclercProductPageOnPage: () => ({ ok: true, name: 'Riz basmati Lustucru 1kg', priceEuro: 2.35 }),
          startProductSearchOnPage
        })
      },
      tabs: { update: vi.fn(async () => undefined) },
      tabId: 40,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        manualUrlOverrides: { leclerc: { 'product-riz-1': FICHE_URL } }
      },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-riz-1', name: 'Riz basmati Lustucru 1kg', brand: 'Lustucru' }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('manual');
    expect(result.observations[0].priceEuro).toBe(2.35);
    expect(startProductSearchOnPage).not.toHaveBeenCalled();
  });
});

// Campagne de mesure du 02/09 (tools/bench-leclerc-stages.mjs, 4 étages ×
// 11 produits réels) : sur les 26 étages qui ont abouti, le candidat
// finalement retenu était déjà présent dès la première lecture non vide, et
// aucun étage n'a jamais abouti au-delà de 5,1 s. Les seuls étages à
// consommer les 15 s complètes étaient ceux où la page continuait à charger
// des cartes en lazy-load sans qu'aucune n'atteigne le score : ni le plateau
// (stableRounds) ni `remaining === 0` ne se déclenchaient jamais, donc rien
// n'arrêtait la boucle avant la deadline. Ce test fige la garde qui coupe
// cette attente-là.
describe('collectLeclercStore — une page qui charge sans fin ne consomme plus tout le budget', () => {
  it("abandonne l'étage peu après la première lecture au lieu d'attendre la deadline complète", async () => {
    // Nom d'un seul mot et sans marque : la cascade se réduit au seul étage
    // 'name' ('name_only' produirait la même requête et est dédupliqué,
    // 'brand_only' n'a pas de marque exploitable). Le test mesure donc bien
    // un étage, pas quatre.
    const product = { productId: 'product-boisson', name: 'Boisson', brand: '' };

    // La page ne se stabilise jamais : chaque lecture ramène une carte de
    // plus (lazy-load qui progresse) et il reste toujours des emplacements
    // vides — exactement le profil des recherches "Lipton" / "HERTA"
    // mesurées. Aucune carte ne ressemble au produit cherché.
    let lectures = 0;
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => ({
          hostname: 'fd4-courses.leclercdrive.fr',
          pathname: '/magasin-1/recherche.aspx',
          hasCaptcha: false,
          hasStorePrompt: false,
          hasCatalog: true
        }),
        startProductSearchOnPage: (item) => ({ started: true, query: item.name }),
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => ({ remainingPlaceholders: 5 }),
        readProductCandidatesOnPage: () => {
          lectures += 1;
          return Array.from({ length: lectures }, (_unused, index) => ({
            name: `Chaussettes de randonnée taille ${index + 40}`,
            priceEuro: 3 + index,
            productUrl: `https://fd4-courses.leclercdrive.fr/magasin-1/produit/chaussettes-${index}`
          }));
        },
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: lectures })
      })
    };

    const startedAt = Date.now();
    const result = await collectLeclercStore({
      scripting,
      tabId: 22,
      signal: new AbortController().signal,
      job: { jobId: 'job-eeee3333ffff4444' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [product]
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.errors).toHaveLength(1);
    const stages = result.errors[0].details?.stageAttempts ?? [];
    const nameStage = stages.find((stage) => stage.stage === 'name');
    expect(nameStage?.timing?.exitReason).toBe('settle_budget_exhausted');
    // La boucle a bien laissé au lazy-load plusieurs tours pour ramener
    // d'autres cartes (le cas "Orangensaft/Tropicana" documenté dans
    // waitForProductCandidates), elle n'a pas coupé dès la première lecture.
    expect(lectures).toBeGreaterThan(1);
    // Et surtout : elle n'a pas attendu les 15 s du budget total.
    expect(elapsedMs).toBeLessThan(12_000);
  }, 30_000);
});
