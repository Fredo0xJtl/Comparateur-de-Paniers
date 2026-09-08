import { afterEach, describe, expect, it, vi } from 'vitest';
import { addToCartCoursesUStore, chooseCoursesUProduct, collectCoursesUStore } from './courses-u-collector.js';

function baseTabs() {
  return { update: vi.fn(async () => undefined), get: vi.fn(async () => ({ status: 'complete' })) };
}

// Même technique de dispatch par NOM de fonction que
// leclerc-collector-cascade.test.js : ne fournir un handler que pour les
// fonctions attendues sert aussi de garde implicite — un appel à une
// fonction non mockée (ex. startCoursesUSearch, qui ne doit jamais tourner
// sur le chemin de correction manuelle) fait échouer le test bruyamment.
function makeDispatcher(handlers) {
  return vi.fn(async ({ func, args }) => {
    const handler = handlers[func.name];
    if (!handler) {
      throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
    }
    return [{ result: await handler(...(args ?? [])) }];
  });
}

describe('collectCoursesUStore — recherche exacte par EAN', () => {
  it('cherche d’abord le code-barres et retient uniquement le candidat portant exactement cet EAN', async () => {
    const searchedProducts = [];
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        startCoursesUSearch: (product) => {
          searchedProducts.push(product);
          return { started: true, query: product.searchQuery ?? product.name };
        },
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [{
          name: 'Riz basmati 10 min LUSTUCRU 5x180g 900g',
          brand: 'LUSTUCRU',
          barcode: '3760341070335',
          priceEuro: 3.32,
          available: true,
          promotionLabel: 'Prix Carte U : -20%',
          productUrl: 'https://www.coursesu.com/p/riz-basmati-10-min-lustucru-5x180g-900g/2100474.html'
        }]
      })
    };

    const result = await collectCoursesUStore({
      scripting,
      tabs: baseTabs(),
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [{ productId: 'product-riz', name: 'Riz basmati en sachet', brand: 'Lustucru', barcode: '3760341070335' }]
    });

    expect(searchedProducts).toHaveLength(1);
    expect(searchedProducts[0].searchQuery).toBe('3760341070335');
    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({
      observedBrand: 'LUSTUCRU',
      observedBarcode: '3760341070335',
      promotionLabel: 'Prix Carte U : -20%',
      matchScore: 1,
      matchStage: 'ean'
    });
  });

  it('retombe sur la recherche texte si les résultats EAN ne prouvent aucune égalité de code-barres', async () => {
    const queries = [];
    let reads = 0;
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        startCoursesUSearch: (product) => {
          const query = product.searchQuery ?? `${product.name} ${product.brand ?? ''}`.trim();
          queries.push(query);
          return { started: true, query };
        },
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => {
          reads += 1;
          if (reads === 1) return [];
          return [{ name: 'Riz basmati LUSTUCRU 1kg', priceEuro: 3.4, available: true, productUrl: 'https://www.coursesu.com/p/riz/2.html' }];
        },
        inspectCoursesUResults: () => ({ candidateCount: 1 })
      })
    };

    const result = await collectCoursesUStore({
      scripting,
      tabs: baseTabs(),
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [{ productId: 'product-riz', name: 'Riz basmati', brand: 'Lustucru', barcode: '3760341070335' }]
    });

    expect(queries).toEqual(['3760341070335', 'Riz basmati Lustucru']);
    expect(result.observations).toHaveLength(1);
  });
});

describe('collectCoursesUStore — correction manuelle par URL (Hyper U)', () => {
  it('navigue directement vers manualUrlOverrides.hyperu[productId] sans jamais relancer la recherche', async () => {
    const manualUrl = 'https://www.coursesu.com/p/lait-demi-ecreme-uht-lait-dici/1234567.html';
    const tabs = {
      update: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ status: 'complete' }))
    };
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUProductPageOnPage: () => ({
          ok: true,
          name: 'Lait demi écrémé UHT LAIT D\'ICI, 6x1l',
          priceEuro: 5.64,
          barcode: '3564700000014',
          available: true,
          externalProductId: 'p-1234567',
          externalStoreId: 'store-99'
        })
      })
    };

    const result = await collectCoursesUStore({
      scripting,
      tabs,
      tabId: 42,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        manualUrlOverrides: { hyperu: { 'product-lait': manualUrl } }
      },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [{ productId: 'product-lait', name: 'Lait demi écrémé', brand: '' }]
    });

    expect(result.errors).toHaveLength(0);
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0];
    expect(observation.productId).toBe('product-lait');
    expect(observation.matchStage).toBe('manual');
    expect(observation.matchScore).toBe(1);
    expect(observation.priceEuro).toBe(5.64);
    expect(observation.observedBarcode).toBe('3564700000014');
    expect(observation.productUrl).toBe(manualUrl);

    expect(tabs.update).toHaveBeenCalledWith(42, { url: manualUrl });
  });

  it('remonte une erreur exploitable quand la fiche manuelle est introuvable/vide', async () => {
    const manualUrl = 'https://www.coursesu.com/p/produit-disparu/999.html';
    const tabs = {
      update: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ status: 'complete' }))
    };
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUProductPageOnPage: () => ({ ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' })
      })
    };

    const result = await collectCoursesUStore({
      scripting,
      tabs,
      tabId: 42,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        manualUrlOverrides: { hyperu: { 'product-lait': manualUrl } }
      },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [{ productId: 'product-lait', name: 'Lait demi écrémé', brand: '' }]
    });

    expect(result.observations).toHaveLength(0);
    expect(result.errors).toEqual([
      { storeKey: 'hyperu', productId: 'product-lait', code: 'MANUAL_URL_PAGE_NOT_FOUND' }
    ]);
  });

  // Tester #14 (audit 30/08) : ce chemin avalait auparavant TOUTE erreur
  // (y compris SCRIPT_EXECUTION_TIMEOUT) en un simple
  // MANUAL_URL_NAVIGATION_FAILED par produit, sans jamais interrompre tout
  // le magasin — contrairement au chemin de recherche normale (voir
  // "collectCoursesUStore — un onglet figé interrompt tout le magasin" plus
  // haut, qui couvre déjà en détail les deux branches de la sonde de
  // survie). Ce test vérifie seulement que CE point d'entrée précis
  // propage bien vers le même mécanisme.
  it('rejette avec SCRIPT_EXECUTION_TIMEOUT (au lieu de MANUAL_URL_NAVIGATION_FAILED) quand la sonde de survie confirme un onglet mort', async () => {
    const manualUrl = 'https://www.coursesu.com/p/lait-demi-ecreme-uht-lait-dici/1234567.html';
    const tabs = {
      update: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ status: 'complete' }))
    };
    // inspectCoursesUPage sert à deux moments distincts ici : le prologue
    // (ensureCoursesUCatalogReady, doit réussir pour atteindre le chemin
    // manuel) puis la sonde de survie déclenchée par le timeout de lecture
    // de la fiche (doit confirmer un onglet mort). Un dispatcher statique ne
    // peut pas distinguer les deux — compteur d'appels nécessaire.
    let inspectCalls = 0;
    const scripting = {
      executeScript: vi.fn(async ({ func, args }) => {
        if (func.name === 'inspectCoursesUPage') {
          inspectCalls += 1;
          if (inspectCalls === 1) return [{ result: { catalogReady: true, blocked: false, details: {} } }];
          throw new Error('SCRIPT_EXECUTION_TIMEOUT');
        }
        const handlers = {
          dismissCookieConsentOnPage: () => ({ dismissed: false }),
          readCoursesUProductPageOnPage: () => {
            throw new Error('SCRIPT_EXECUTION_TIMEOUT');
          }
        };
        const handler = handlers[func.name];
        if (!handler) throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
        return [{ result: await handler(...(args ?? [])) }];
      })
    };

    await expect(
      collectCoursesUStore({
        scripting,
        tabs,
        tabId: 42,
        signal: new AbortController().signal,
        job: {
          jobId: 'job-1234567890abcdef',
          manualUrlOverrides: { hyperu: { 'product-lait': manualUrl } }
        },
        store: { storeKey: 'hyperu', localStoreId: 'store-1' },
        products: [{ productId: 'product-lait', name: 'Lait demi écrémé', brand: '' }]
      })
    ).rejects.toThrow('SCRIPT_EXECUTION_TIMEOUT');
  });

  // Tester #15 (audit 30/08) : waitForCoursesUTabLoad traitait un
  // `tabs.get` qui échoue (onglet fermé) comme "page chargée avec succès"
  // au lieu de le signaler — voir le même correctif déjà en place côté
  // pick manuel (waitForLeclercPick/waitForCoursesUPick, DRIVE_PICK_TAB_CLOSED).
  it('rejette avec COURSESU_TAB_CLOSED (au lieu de continuer comme si la page était chargée) quand l’onglet est fermé pendant la navigation', async () => {
    const manualUrl = 'https://www.coursesu.com/p/lait-demi-ecreme-uht-lait-dici/1234567.html';
    const tabs = {
      update: vi.fn(async () => undefined),
      get: vi.fn(async () => {
        throw new Error('No tab with id: 42.');
      })
    };
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false })
      })
    };

    await expect(
      collectCoursesUStore({
        scripting,
        tabs,
        tabId: 42,
        signal: new AbortController().signal,
        job: {
          jobId: 'job-1234567890abcdef',
          manualUrlOverrides: { hyperu: { 'product-lait': manualUrl } }
        },
        store: { storeKey: 'hyperu', localStoreId: 'store-1' },
        products: [{ productId: 'product-lait', name: 'Lait demi écrémé', brand: '' }]
      })
    ).rejects.toThrow('COURSESU_TAB_CLOSED');
  });
});

// Étape 7 du plan de fiabilisation (points morts additionnels) : un captcha
// bloque TOUTE recherche sur ce tab, pas seulement le produit en cours —
// avant ce correctif, ni le scraping de prix ni l'ajout au panier Hyper U ne
// vérifiaient ce signal (pourtant déjà lu par inspectCoursesUResults /
// inspectCoursesUProductPageOnPage), contrairement au chemin Leclerc
// existant. La détection doit interrompre tout le job (throw), pas
// dégénérer en PRODUCT_NOT_FOUND/CART_PRODUCT_NOT_FOUND répétés.
describe('détection CAPTCHA (Hyper U) — interrompt tout le job plutôt que produit par produit', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('collectCoursesUStore rejette avec CAPTCHA_DETECTED quand la page de résultats en affiche un', async () => {
    vi.useFakeTimers();
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        startCoursesUSearch: () => ({ started: true, query: 'lait' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [],
        inspectCoursesUResults: () => ({ pathKind: 'recherche', resultCardCount: 0, euroNodeCount: 0, hasCaptcha: true })
      })
    };

    const promise = collectCoursesUStore({
      scripting,
      tabs: { update: vi.fn(), get: vi.fn(async () => ({ status: 'complete' })) },
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [{ productId: 'product-lait', name: 'Lait demi écrémé', brand: '' }]
    });
    // Attache le handler de rejet AVANT d'avancer le temps virtuel — sinon
    // le rejet peut se produire (dans la boucle de polling) avant que
    // `expect().rejects` ait eu la chance de s'y accrocher, ce que Vitest
    // signale comme un "unhandled rejection" même si le test passe.
    const assertion = expect(promise).rejects.toThrow('CAPTCHA_DETECTED');
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('addToCartCoursesUStore rejette avec CAPTCHA_DETECTED au lieu de renvoyer CART_PRODUCT_NOT_FOUND', async () => {
    vi.useFakeTimers();
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        startCoursesUSearch: () => ({ started: true, query: 'lait' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [],
        inspectCoursesUProductPageOnPage: () => ({ url: '', pathname: '', pageTitle: '', bodyTextSnippet: '', hasCaptcha: true })
      })
    };

    const promise = addToCartCoursesUStore({
      scripting,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });
    // Attache le handler de rejet AVANT d'avancer le temps virtuel — sinon
    // le rejet peut se produire (dans la boucle de polling) avant que
    // `expect().rejects` ait eu la chance de s'y accrocher, ce que Vitest
    // signale comme un "unhandled rejection" même si le test passe.
    const assertion = expect(promise).rejects.toThrow('CAPTCHA_DETECTED');
    await vi.runAllTimersAsync();
    await assertion;
  });
});

// Reproduit le blocage réel signalé le 2026-08-28 : `scripting.executeScript`
// n'a lui-même aucun timeout, donc un onglet figé (page qui ne finit jamais
// de charger) gelait toute la collecte indéfiniment, sans erreur ni
// diagnostic (voir extension/shared/scripting-timeout.js). L'appel figé est
// simulé ici par un rejet SCRIPT_EXECUTION_TIMEOUT.
//
// reviewer #12 (audit 30/08) : collectCoursesUStore reçoit désormais le même
// correctif de sonde de survie que collectLeclercStore (29/08, voir
// leclerc-collector-cascade.test.js) — un timeout ponctuel sur un seul
// produit ne doit plus abandonner tout le magasin si l'onglet répond encore.
// addToCartCoursesUStore N'A PAS reçu ce correctif (ni côté Leclerc), un
// abandon complet du job d'ajout au panier restant volontairement le
// comportement par défaut — voir son propre describe plus bas.
describe('collectCoursesUStore — un onglet figé interrompt tout le magasin (sonde de survie)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejette avec SCRIPT_EXECUTION_TIMEOUT si la sonde de survie confirme que le magasin ne répond plus', async () => {
    const scripting = {
      executeScript: makeDispatcher({
        // Recherche ET sonde de survie échouent toutes les deux : un vrai
        // onglet mort ne répondrait pas davantage à la sonde qu'à la
        // recherche elle-même.
        inspectCoursesUPage: () => {
          throw new Error('SCRIPT_EXECUTION_TIMEOUT');
        },
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        startCoursesUSearch: () => {
          throw new Error('SCRIPT_EXECUTION_TIMEOUT');
        }
      })
    };

    await expect(
      collectCoursesUStore({
        scripting,
        tabs: { update: vi.fn(), get: vi.fn(async () => ({ status: 'complete' })) },
        tabId: 42,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'hyperu', localStoreId: 'store-1' },
        products: [{ productId: 'product-lait', name: 'Lait demi écrémé', brand: '' }]
      })
    ).rejects.toThrow('SCRIPT_EXECUTION_TIMEOUT');
  });

  it("ne saute qu'UN produit (au lieu d'abandonner tout le magasin) quand la sonde de survie confirme que l'onglet répond encore", async () => {
    let searchCalls = 0;
    const secondCandidate = {
      name: 'Riz basmati 1kg',
      priceEuro: 2.5,
      productUrl: 'https://www.coursesu.com/p/riz-basmati/riz-1.html'
    };

    const scripting = {
      executeScript: vi.fn(async ({ func, args }) => {
        if (func.name === 'startCoursesUSearch') {
          searchCalls += 1;
          if (searchCalls === 1) throw new Error('SCRIPT_EXECUTION_TIMEOUT');
          return [{ result: { started: true, query: args?.[0]?.name } }];
        }
        const handlers = {
          dismissCookieConsentOnPage: () => ({ dismissed: false }),
          // Sonde de survie : l'onglet répond normalement (catalogue
          // affiché, pas de blocage) — donc pas un onglet mort.
          inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
          inspectCoursesUSearchNavigation: () => ({ ready: true }),
          readCoursesUProducts: () => [secondCandidate]
        };
        const handler = handlers[func.name];
        if (!handler) throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
        return [{ result: await handler(...(args ?? [])) }];
      })
    };

    const result = await collectCoursesUStore({
      scripting,
      tabs: { update: vi.fn(), get: vi.fn(async () => ({ status: 'complete' })) },
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [
        { productId: 'product-lait', name: 'Lait demi écrémé', brand: '' },
        { productId: 'product-riz', name: 'Riz basmati', brand: '' }
      ]
    });

    expect(result.errors).toEqual([
      { storeKey: 'hyperu', productId: 'product-lait', code: 'PRODUCT_SEARCH_TIMEOUT' }
    ]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ productId: 'product-riz' });
  }, 15_000);
});

describe('addToCartCoursesUStore — un onglet figé interrompt tout le job', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('addToCartCoursesUStore rejette avec SCRIPT_EXECUTION_TIMEOUT au lieu de renvoyer ADD_TO_CART_FAILED', async () => {
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        startCoursesUSearch: () => {
          throw new Error('SCRIPT_EXECUTION_TIMEOUT');
        }
      })
    };

    await expect(
      addToCartCoursesUStore({
        scripting,
        tabId: 42,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'hyperu', localStoreId: 'store-1' },
        items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
      })
    ).rejects.toThrow('SCRIPT_EXECUTION_TIMEOUT');
  });
});

// Revue du 2026-08-28 (après test réel) : un sondage de plusieurs minutes
// dans le service worker a été essayé puis abandonné — MV3 décharge ce
// worker de façon agressive sur Android dès que Firefox n'est plus au
// premier plan, ce qui arrive systématiquement pendant une double
// authentification. addToCartCoursesUStore fait donc un contrôle unique et
// immédiat : pas connecté (y compris état indéterminé) → CART_LOGIN_REQUIRED
// tout de suite, onglet laissé ouvert, sans qu'aucune recherche produit ne
// démarre.
describe('addToCartCoursesUStore — vérification de connexion (contrôle unique, sans sondage)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('échoue immédiatement en CART_LOGIN_REQUIRED sans lancer de recherche, si signedIn: false', async () => {
    const searchStarted = vi.fn();
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: false, evidence: 'Se connecter' }),
        startCoursesUSearch: searchStarted
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });

    expect(searchStarted).not.toHaveBeenCalled();
    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual([
      { storeKey: 'hyperu', code: 'CART_LOGIN_REQUIRED', details: { evidence: 'Se connecter' } }
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
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: null, evidence: null })
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });

    expect(result.observations).toEqual([]);
    expect(result.errors).toEqual([{ storeKey: 'hyperu', code: 'CART_LOGIN_REQUIRED', details: { evidence: null } }]);
    expect(result.keepTabOpen).toBe(true);
  });

  it('lance normalement les recherches quand signedIn: true dès le premier contrôle', async () => {
    vi.useFakeTimers();
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        startCoursesUSearch: () => ({ started: true, query: 'lait' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [],
        inspectCoursesUProductPageOnPage: () => ({ url: '', pathname: '', pageTitle: '', bodyTextSnippet: '', hasCaptcha: false })
      })
    };

    const promise = addToCartCoursesUStore({
      scripting,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', quantity: 1 }]
    });
    await vi.runAllTimersAsync();
    const result = await promise;

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
describe('addToCartCoursesUStore — matching exact par EAN quand disponible', () => {
  it('retient le candidat dont le barcode correspond exactement à item.barcode, pas le mieux noté par nom seul', async () => {
    const clickCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        startCoursesUSearch: () => ({ started: true, query: 'lait' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [
          // Nom quasiment identique, EAN différent — gagnerait un matching
          // par nom seul si l'ordre ou un score approximatif le favorisait.
          { name: 'Lait demi écrémé LAIT D\'ICI', barcode: '1111111111111', priceEuro: 1.1, available: true, productUrl: 'https://www.coursesu.com/p/autre/1.html' },
          // Le candidat réellement validé par l'utilisateur.
          { name: 'Lait demi écrémé LAIT D\'ICI 6x1L', barcode: '2222222222222', priceEuro: 5.64, available: true, productUrl: 'https://www.coursesu.com/p/le-bon/2.html' }
        ],
        clickAddToCartOnMatchedCoursesUCardOnPage: (...args) => {
          clickCalls.push(args);
          return { added: true };
        }
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-lait', name: 'Lait demi écrémé', barcode: '2222222222222', quantity: 1 }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations[0].added).toBe(true);
    expect(clickCalls).toHaveLength(1);
    expect(clickCalls[0][0]).toBe('Lait demi écrémé LAIT D\'ICI 6x1L');
    expect(clickCalls[0][1]).toBe(5.64);
  });
});

// Bug réel confirmé sur le tel (Hyper U, 2026-08-28) : "Riz basmati en sachet
// 5x 2 personnes" (nom générique de la liste de courses) ne renvoie AUCUN
// riz sur le moteur de recherche interne de coursesu.com (résultats
// totalement hors sujet) — deux mauvais produits avaient été ajoutés au
// panier réel. `item.productUrl` (le candidat validé, EAN exact confirmé
// lors du scraping de prix) pointe pourtant directement vers la bonne fiche.
// Voir le commentaire au-dessus d'addToCartCoursesUStore : navigation directe
// tentée en premier, avec vérification stricte par EAN avant tout clic, et
// repli automatique sur la recherche par nom en cas d'échec.
describe('addToCartCoursesUStore — navigation directe vers productUrl (bug réel 2026-08-28)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('navigue directement vers item.productUrl et clique le bouton principal, sans jamais lancer de recherche, quand l’EAN correspond', async () => {
    const productUrl = 'https://www.coursesu.com/p/riz-basmati-10-min-lustucru-5x180g-900g/2100474.html';
    const tabs = baseTabs();
    const clickCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCoursesUProductPageOnPage: () => ({
          ok: true,
          name: 'Riz basmati 10 min LUSTUCRU 5x180g 900g',
          priceEuro: 1.85,
          barcode: '3760341070335',
          available: true
        }),
        clickAddToCartOnCoursesUProductPageOnPage: (...args) => {
          clickCalls.push(args);
          return { added: true };
        }
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabs,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{
        productId: 'product-riz',
        name: 'Riz basmati en sachet 5x 2 personnes',
        barcode: '3760341070335',
        productUrl,
        quantity: 1
      }]
    });

    expect(tabs.update).toHaveBeenCalledWith(42, { url: productUrl });
    expect(clickCalls).toEqual([[1]]);
    expect(result.errors).toEqual([]);
    // Le produit réellement ajouté voyage avec l'observation : sans lui, un
    // ajout sur la mauvaise fiche ressortait comme un simple `added: true`,
    // impossible à recouper avec le produit validé au comparatif.
    expect(result.observations).toEqual([
      {
        protocolVersion: 1,
        jobId: 'job-1234567890abcdef',
        productId: 'product-riz',
        storeKey: 'hyperu',
        added: true,
        matchedName: 'Riz basmati 10 min LUSTUCRU 5x180g 900g',
        matchedPriceEuro: 1.85
      }
    ]);
  });

  it('retombe sur la recherche par nom quand la fiche atteinte ne correspond pas à l’EAN attendu (permalien périmé, redirigé vers une autre page)', async () => {
    const productUrl = 'https://www.coursesu.com/p/riz-basmati-10-min-lustucru-5x180g-900g/2100474.html';
    const tabs = baseTabs();
    const clickCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        // Le permalien périmé a été redirigé vers une tout autre fiche —
        // sans la garde par EAN, ce nom/prix serait pris pour argent
        // comptant et le mauvais produit serait ajouté (bug réel du
        // 2026-08-28 : Emmental râpé ajouté à la place du riz).
        readCoursesUProductPageOnPage: () => ({
          ok: true,
          name: 'Emmental râpé Président 150g',
          priceEuro: 2.42,
          barcode: '3228857000652',
          available: true
        }),
        startCoursesUSearch: () => ({ started: true, query: 'Riz basmati en sachet 5x 2 personnes' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [
          { name: 'Riz basmati 10 min LUSTUCRU 5x180g 900g', barcode: '3760341070335', priceEuro: 1.85, available: true, productUrl }
        ],
        clickAddToCartOnMatchedCoursesUCardOnPage: (...args) => {
          clickCalls.push(args);
          return { added: true };
        }
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabs,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{
        productId: 'product-riz',
        name: 'Riz basmati en sachet 5x 2 personnes',
        barcode: '3760341070335',
        productUrl,
        quantity: 1
      }]
    });

    expect(clickCalls).toHaveLength(1);
    expect(clickCalls[0][0]).toBe('Riz basmati 10 min LUSTUCRU 5x180g 900g');
    expect(result.errors).toEqual([]);
    expect(result.observations[0].added).toBe(true);
  });

  it('retombe sur la recherche par nom quand la fiche productUrl est introuvable (404)', async () => {
    const productUrl = 'https://www.coursesu.com/p/produit-disparu/999.html';
    const tabs = baseTabs();
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCoursesUProductPageOnPage: () => ({ ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' }),
        startCoursesUSearch: () => ({ started: true, query: 'Riz basmati' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [
          { name: 'Riz basmati 10 min LUSTUCRU 5x180g 900g', barcode: '3760341070335', priceEuro: 1.85, available: true, productUrl }
        ],
        clickAddToCartOnMatchedCoursesUCardOnPage: () => ({ added: true })
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabs,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-riz', name: 'Riz basmati', barcode: '3760341070335', productUrl, quantity: 1 }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations[0].added).toBe(true);
  });

  it('interrompt tout le job (CAPTCHA_DETECTED) si un captcha est détecté pendant la navigation directe', async () => {
    const productUrl = 'https://www.coursesu.com/p/riz-basmati-10-min-lustucru-5x180g-900g/2100474.html';
    const tabs = baseTabs();
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCoursesUProductPageOnPage: () => ({ ok: false, code: 'SITE_BLOCKED' })
      })
    };

    await expect(
      addToCartCoursesUStore({
        scripting,
        tabs,
        tabId: 42,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'hyperu', localStoreId: 'store-1' },
        items: [{ productId: 'product-riz', name: 'Riz basmati', barcode: '3760341070335', productUrl, quantity: 1 }]
      })
    ).rejects.toThrow('CAPTCHA_DETECTED');
  });

  it('sans EAN connu des deux côtés, retombe sur la recherche par nom si le nom de la fiche atteinte ne correspond pas assez', async () => {
    const productUrl = 'https://www.coursesu.com/p/produit-quelconque/1.html';
    const tabs = baseTabs();
    const clickCalls = [];
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' }),
        readCoursesUProductPageOnPage: () => ({
          ok: true,
          name: 'Boisson Thé Glacé Pêche Lipton',
          priceEuro: 1.49,
          available: true
        }),
        startCoursesUSearch: () => ({ started: true, query: 'Riz basmati LUSTUCRU' }),
        inspectCoursesUSearchNavigation: () => ({ ready: true }),
        readCoursesUProducts: () => [
          { name: 'Riz basmati 10 min LUSTUCRU 5x180g 900g', priceEuro: 1.85, available: true, productUrl: 'https://www.coursesu.com/p/riz/2.html' }
        ],
        clickAddToCartOnMatchedCoursesUCardOnPage: (...args) => {
          clickCalls.push(args);
          return { added: true };
        }
      })
    };

    const result = await addToCartCoursesUStore({
      scripting,
      tabs,
      tabId: 42,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      items: [{ productId: 'product-riz', name: 'Riz basmati LUSTUCRU', productUrl, quantity: 1 }]
    });

    expect(clickCalls).toHaveLength(1);
    expect(result.observations[0].added).toBe(true);
  });

  // Tester #15 (audit 30/08), même correctif que côté collectCoursesUStore
  // (voir "correction manuelle par URL" plus haut) : waitForCoursesUTabLoad
  // est partagé par les deux chemins de navigation directe (URL manuelle
  // pour le scraping de prix, productUrl validé pour l'ajout au panier ici).
  it('rejette avec COURSESU_TAB_CLOSED quand l’onglet est fermé pendant la navigation vers productUrl', async () => {
    const productUrl = 'https://www.coursesu.com/p/riz-basmati-10-min-lustucru-5x180g-900g/2100474.html';
    const tabs = {
      update: vi.fn(async () => undefined),
      get: vi.fn(async () => {
        throw new Error('No tab with id: 42.');
      })
    };
    const scripting = {
      executeScript: makeDispatcher({
        inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readCoursesUSessionStateOnPage: () => ({ signedIn: true, evidence: 'Mon compte' })
      })
    };

    await expect(
      addToCartCoursesUStore({
        scripting,
        tabs,
        tabId: 42,
        signal: new AbortController().signal,
        job: { jobId: 'job-1234567890abcdef' },
        store: { storeKey: 'hyperu', localStoreId: 'store-1' },
        items: [{ productId: 'product-riz', name: 'Riz basmati', barcode: '3760341070335', productUrl, quantity: 1 }]
      })
    ).rejects.toThrow('COURSESU_TAB_CLOSED');
  });
});

describe('chooseCoursesUProduct — cohérence de format cross-store', () => {
  // Même cas réel que côté Leclerc (leclerc-collector.test.js) : "Purée
  // Mousline" ressortait à des formats différents selon le magasin. Le
  // format cible (baseQuantity/baseUnit, transmis par la PWA depuis Open
  // Food Facts au scan) doit départager deux candidats qui matchent aussi
  // bien l'un que l'autre par le nom seul.
  it('privilégie le candidat au format cible parmi plusieurs candidats valides', () => {
    const result = chooseCoursesUProduct(
      { name: 'Purée Mousline', brand: 'Mousline', baseQuantity: 1000, baseUnit: 'g' },
      [
        { name: 'Purée Mousline nature 375g', priceEuro: 1.6, productUrl: 'https://www.coursesu.com/p/mousline-375.html' },
        { name: 'Purée Mousline nature 1kg', priceEuro: 2.9, productUrl: 'https://www.coursesu.com/p/mousline-1kg.html' }
      ]
    );
    expect(result).not.toBeNull();
    expect(result.productUrl).toBe('https://www.coursesu.com/p/mousline-1kg.html');
    expect(result.observedQuantity).toBe(1000);
    expect(result.observedUnit).toBe('g');
  });

  it('sans format cible connu, départage les scores ex æquo de façon déterministe (indépendante de l’ordre des candidats)', () => {
    // Diagnostic réel (04/09/2026) : un même scan relancé sur les mêmes
    // produits pouvait retenir un candidat différent d'une fois sur l'autre.
    // Cause : à score de nom identique, le tri ne départageait qu'avec
    // l'ordre d'arrivée des candidats dans le DOM du site — non garanti
    // stable d'un scan à l'autre. Ce test vérifie que l'ordre d'entrée du
    // tableau n'influence plus le résultat : les deux candidats ci-dessous,
    // fournis dans les deux ordres possibles, doivent toujours désigner le
    // même gagnant.
    const candidates = [
      { name: 'Purée Mousline nature 375g', priceEuro: 1.6, productUrl: 'https://www.coursesu.com/p/mousline-375.html' },
      { name: 'Purée Mousline nature 1kg', priceEuro: 2.9, productUrl: 'https://www.coursesu.com/p/mousline-1kg.html' }
    ];
    const product = { name: 'Purée Mousline', brand: 'Mousline' };
    const forward = chooseCoursesUProduct(product, candidates);
    const reversed = chooseCoursesUProduct(product, [...candidates].reverse());
    expect(forward).not.toBeNull();
    expect(forward.productUrl).toBe(reversed.productUrl);
  });

  it('remonte le format observé même sans format cible', () => {
    const result = chooseCoursesUProduct(
      { name: 'Riz basmati', brand: 'Lustucru' },
      [{ name: 'Riz basmati Lustucru 1kg', priceEuro: 3.4, productUrl: 'https://www.coursesu.com/p/riz.html' }]
    );
    expect(result.observedQuantity).toBe(1000);
    expect(result.observedUnit).toBe('g');
  });

  it('un match EAN exact reste prioritaire, avec son format remonté', () => {
    const result = chooseCoursesUProduct(
      { name: 'Riz basmati', barcode: '3760341070335', baseQuantity: 500, baseUnit: 'g' },
      [
        { name: 'Riz basmati Lustucru 1kg', barcode: '3760341070335', priceEuro: 3.4, productUrl: 'https://www.coursesu.com/p/riz-1kg.html' },
        { name: 'Riz basmati Lustucru 500g', priceEuro: 2.1, productUrl: 'https://www.coursesu.com/p/riz-500g.html' }
      ]
    );
    expect(result.productUrl).toBe('https://www.coursesu.com/p/riz-1kg.html');
    expect(result.matchScore).toBe(1);
    expect(result.observedQuantity).toBe(1000);
  });
});

describe('collectCoursesUStore — raccourci "permalien appris"', () => {
  const KNOWN_URL = 'https://www.coursesu.com/p/lait-demi-ecreme-uht-lait-dici/1234567.html';

  const searchHandlers = (searchSpy) => ({
    inspectCoursesUPage: () => ({ catalogReady: true, blocked: false, details: {} }),
    dismissCookieConsentOnPage: () => ({ dismissed: false }),
    readCurrentCoursesUUrlOnPage: () => ({ href: 'https://www.coursesu.com/rayons' }),
    startCoursesUSearch: searchSpy,
    inspectCoursesUSearchNavigation: () => ({ ready: true }),
    readCoursesUProducts: () => [
      {
        name: 'Lait demi écrémé UHT LAIT D\'ICI, 6x1l',
        priceEuro: 5.9,
        productUrl: 'https://www.coursesu.com/p/lait-demi-ecreme-uht-lait-dici/7654321.html'
      }
    ],
    inspectCoursesUResults: () => ({ hasCaptcha: false, resultCount: 1 })
  });

  const run = async (handlers, product) =>
    collectCoursesUStore({
      scripting: { executeScript: makeDispatcher(handlers) },
      tabs: baseTabs(),
      tabId: 42,
      signal: new AbortController().signal,
      job: {
        jobId: 'job-1234567890abcdef',
        knownProductUrls: { hyperu: { 'product-lait': KNOWN_URL } }
      },
      store: { storeKey: 'hyperu', localStoreId: 'store-1' },
      products: [product ?? { productId: 'product-lait', name: 'Lait demi écrémé UHT LAIT D\'ICI', brand: '' }]
    });

  it('relit la fiche mémorisée sans lancer de recherche, sans se donner la confiance d’un choix humain', async () => {
    const searchSpy = vi.fn(() => ({ started: true, query: 'lait' }));
    const result = await run({
      ...searchHandlers(searchSpy),
      readCoursesUProductPageOnPage: () => ({
        ok: true,
        name: 'Lait demi écrémé UHT LAIT D\'ICI, 6x1l',
        priceEuro: 5.64,
        available: true
      })
    });

    expect(result.errors).toHaveLength(0);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('known_url');
    expect(result.observations[0].matchStage).not.toBe('manual');
    expect(result.observations[0].priceEuro).toBe(5.64);
    expect(result.observations[0].productUrl).toBe(KNOWN_URL);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it('rejette la fiche mémorisée quand son code-barres ne correspond plus, et repart en recherche', async () => {
    // Preuve directe que la fiche n'est plus le bon produit : inutile de
    // regarder le nom, on repasse par la recherche normale.
    const searchSpy = vi.fn(() => ({ started: true, query: 'lait' }));
    const result = await run(
      {
        ...searchHandlers(searchSpy),
        readCoursesUProductPageOnPage: () => ({
          ok: true,
          name: 'Lait demi écrémé UHT LAIT D\'ICI, 6x1l',
          priceEuro: 5.64,
          barcode: '3564700000021',
          available: true
        })
      },
      {
        productId: 'product-lait',
        name: 'Lait demi écrémé UHT LAIT D\'ICI',
        brand: '',
        barcode: '3564700000014'
      }
    );

    expect(searchSpy).toHaveBeenCalled();
    expect(result.observations[0].matchStage).not.toBe('known_url');
    // Budget large : un raccourci raté repasse par le catalogue avant de
    // relancer la recherche, ce qui cumule plusieurs attentes réelles.
  }, 20_000);

  it('repart en recherche quand la fiche mémorisée montre un autre produit', async () => {
    const searchSpy = vi.fn(() => ({ started: true, query: 'lait' }));
    const result = await run({
      ...searchHandlers(searchSpy),
      readCoursesUProductPageOnPage: () => ({
        ok: true,
        name: 'Café moulu Carte Noire 250g',
        priceEuro: 3.9,
        available: true
      })
    });

    expect(searchSpy).toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);
    expect(result.observations[0].matchStage).toBe('name');
  }, 20_000);
});
