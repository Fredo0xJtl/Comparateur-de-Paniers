import { describe, expect, it, vi } from 'vitest';
import {
  collectLeclercStore,
  chooseLeclercProductCandidate,
  findLeclercAlternateCandidates,
  findLeclercNearMissCandidates,
  fixDoubleEncodedLeclercUrl,
  hasRealLeclercBrand,
  isLeclercInformationPath,
  livePickLeclercProduct,
  mergeLeclercCandidateSnapshots,
  parseLeclercDisplayedPrice,
  sanitizeLeclercSearchText,
  simplifyLeclercSearchQuery
} from './leclerc-collector.js';

describe('mergeLeclercCandidateSnapshots — une identité, un instantané complet', () => {
  it('fusionne les champs complémentaires lus à deux positions de la grille virtualisée', () => {
    const merged = mergeLeclercCandidateSnapshots([], [{
      name: 'Riz basmati Lustucru 900g',
      externalProductId: '2100474',
      priceEuro: 3.32,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-2100474'
    }]);

    const enriched = mergeLeclercCandidateSnapshots(merged, [{
      name: 'Riz basmati Lustucru 900g',
      externalProductId: '2100474',
      brand: 'LUSTUCRU',
      barcode: '3760341070335',
      priceEuro: 3.32,
      unitPriceEuro: 3.69,
      unitPriceUnit: 'kg',
      promotionLabel: 'Ticket E.Leclerc 20%',
      productUrl: 'https://www.leclercdrive.fr/produit/riz-2100474'
    }]);

    expect(enriched).toEqual([expect.objectContaining({
      externalProductId: '2100474',
      brand: 'LUSTUCRU',
      barcode: '3760341070335',
      unitPriceEuro: 3.69,
      unitPriceUnit: 'kg',
      promotionLabel: 'Ticket E.Leclerc 20%'
    })]);
  });

  it('signale un prix contradictoire au lieu d’écraser silencieusement la première lecture', () => {
    const first = [{
      name: 'Riz basmati 900g', externalProductId: '2100474', priceEuro: 3.32,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-2100474'
    }];
    const merged = mergeLeclercCandidateSnapshots(first, [{ ...first[0], priceEuro: 8.99 }]);
    expect(merged).toEqual([expect.objectContaining({ priceEuro: 3.32, dataConflicts: ['priceEuro'] })]);
    expect(chooseLeclercProductCandidate({ name: 'Riz basmati 900g' }, merged)).toBeNull();
  });
});

describe('livePickLeclercProduct — transport du prix unitaire', () => {
  it('conserve le prix unitaire lu par le bouton flottant dans l’observation', async () => {
    const pick = {
      name: 'Lait demi-écrémé Délisse 6x1L',
      priceEuro: 5.94,
      unitPriceEuro: 0.99,
      unitPriceUnit: 'L',
      productUrl: 'https://fd12-courses.leclercdrive.fr/fiche-produits-1.aspx'
    };
    const scripting = {
      executeScript: vi.fn(async ({ func }) => {
        const result =
          func.name === 'dismissCookieConsentOnPage'
            ? { dismissed: true }
            : func.name === 'readPublicLeclercPageState'
              ? {
                  hostname: 'fd12-courses.leclercdrive.fr',
                  pathname: '/magasin-1',
                  hasCaptcha: false,
                  hasSiteError: false,
                  hasStorePrompt: false,
                  hasCatalog: true
                }
              : func.name === 'readLeclercPickOnPage'
                ? pick
                : undefined;
        return [{ result }];
      })
    };

    const result = await livePickLeclercProduct({
      scripting,
      tabs: {},
      tabId: 1,
      job: { jobId: 'job-1' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'prod-1', name: 'Lait demi-écrémé' }],
      signal: new AbortController().signal
    });

    expect(result.observations[0]).toMatchObject({ unitPriceEuro: 0.99, unitPriceUnit: 'L' });
  });
});

// Ajout d'un produit par son nom depuis la PWA : l'utilisateur a tapé sa
// propre formulation, l'extension la saisit dans le champ de recherche du
// site avant de lui rendre la main. La navigation reste libre ensuite, et la
// validation passe toujours par le bouton flottant de la fiche produit.
describe('livePickLeclercProduct — recherche pré-remplie', () => {
  function buildScripting(calls) {
    return {
      executeScript: vi.fn(async ({ func, args }) => {
        calls.push({ name: func.name, args });
        const result =
          func.name === 'dismissCookieConsentOnPage'
            ? { dismissed: true }
            : func.name === 'readPublicLeclercPageState'
              ? {
                  hostname: 'fd12-courses.leclercdrive.fr',
                  pathname: '/magasin-1',
                  hasCaptcha: false,
                  hasSiteError: false,
                  hasStorePrompt: false,
                  hasCatalog: true
                }
              : func.name === 'startProductSearchOnPage'
                ? { started: true }
                : func.name === 'readLeclercPickOnPage'
                  ? {
                      name: 'Beurre President demi-sel 250g',
                      priceEuro: 2.45,
                      productUrl: 'https://fd12-courses.leclercdrive.fr/fiche-produits-1.aspx'
                    }
                  : undefined;
        return [{ result }];
      })
    };
  }

  async function runLivePick(product) {
    const calls = [];
    const result = await livePickLeclercProduct({
      scripting: buildScripting(calls),
      tabs: {},
      tabId: 1,
      job: { jobId: 'job-search' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [product],
      signal: new AbortController().signal
    });
    return { calls, result };
  }

  it('saisit exactement les mots tapés par l’utilisateur, pas le nom du produit', async () => {
    const { calls, result } = await runLivePick({
      productId: 'prod-1',
      name: 'beurre demi-sel',
      searchQuery: 'beurre demi-sel'
    });

    const search = calls.find((call) => call.name === 'startProductSearchOnPage');
    expect(search).toBeDefined();
    expect(search.args[0]).toEqual({ name: 'beurre demi-sel', brand: '' });
    expect(result.observations[0]).toMatchObject({ observedName: 'Beurre President demi-sel 250g' });
  });

  it('ne lance aucune recherche automatique sans requête de l’utilisateur', async () => {
    const { calls } = await runLivePick({ productId: 'prod-1', name: 'Beurre' });

    expect(calls.some((call) => call.name === 'startProductSearchOnPage')).toBe(false);
  });
});

// Régression réelle (2026-08-27, diagnostic live) : deux produits scannés
// portaient "Carrefour" comme marque (Open Food Facts) — le stage de
// recherche brand_only soumettait alors "Carrefour" chez Leclerc, qui ne
// peut structurellement jamais rien retourner (enseigne concurrente). Ce
// n'est pas un problème de scraping : aucun candidat n'existera jamais,
// donc il ne faut même pas tenter cet étage.
describe('hasRealLeclercBrand', () => {
  it('rejette les marques de distributeur des enseignes concurrentes', () => {
    expect(hasRealLeclercBrand('Carrefour')).toBe(false);
    expect(hasRealLeclercBrand('carrefour')).toBe(false);
    expect(hasRealLeclercBrand('Auchan')).toBe(false);
    expect(hasRealLeclercBrand('Super U')).toBe(false);
    expect(hasRealLeclercBrand('Intermarché')).toBe(false);
  });

  it('accepte toujours une vraie marque de produit', () => {
    expect(hasRealLeclercBrand('Lipton')).toBe(true);
    expect(hasRealLeclercBrand('President')).toBe(true);
    expect(hasRealLeclercBrand('Lustucru')).toBe(true);
  });

  it('rejette toujours la marque générique "U" et les valeurs vides/génériques (comportement existant)', () => {
    expect(hasRealLeclercBrand('U')).toBe(false);
    expect(hasRealLeclercBrand('')).toBe(false);
    expect(hasRealLeclercBrand(undefined)).toBe(false);
    expect(hasRealLeclercBrand('Sans marque')).toBe(false);
    expect(hasRealLeclercBrand('Marque habituelle')).toBe(false);
  });

  // Bug réel confirmé par diagnostic (30/08, "Mousse aux fruits" marque
  // "CARREFOUR KIDS") : l'ancienne implémentation testait une égalité
  // STRICTE de la chaîne entière contre COMPETING_RETAILER_BRANDS, donc une
  // sous-marque à plusieurs mots d'une enseigne concurrente ("Carrefour
  // Kids", "Carrefour Bio", "Auchan Bébé"...) n'était jamais reconnue comme
  // concurrente — la requête envoyée à Leclerc incluait alors à tort le nom
  // du concurrent, garantissant 0 résultat.
  it('rejette une sous-marque distributeur concurrente à plusieurs mots', () => {
    expect(hasRealLeclercBrand('Carrefour Kids')).toBe(false);
    expect(hasRealLeclercBrand('CARREFOUR KIDS')).toBe(false);
    expect(hasRealLeclercBrand('Carrefour Bio')).toBe(false);
    expect(hasRealLeclercBrand('Auchan Bébé')).toBe(false);
  });
});

describe('fixDoubleEncodedLeclercUrl', () => {
  it('collapses a double-percent-encoded pathname', () => {
    expect(
      fixDoubleEncodedLeclercUrl('https://m-courses.leclercdrive.fr/magasin-127811-127811/recherche/D%25C3%25A9lisse')
    ).toBe('https://m-courses.leclercdrive.fr/magasin-127811-127811/recherche/D%C3%A9lisse');
  });

  it('leaves an already correctly encoded URL untouched', () => {
    const url = 'https://m-courses.leclercdrive.fr/magasin-127811-127811/recherche/D%C3%A9lisse';
    expect(fixDoubleEncodedLeclercUrl(url)).toBe(url);
  });

  it('returns the raw input when it is not a valid URL', () => {
    expect(fixDoubleEncodedLeclercUrl('not-a-url')).toBe('not-a-url');
  });
});

describe('Leclerc Drive product matching', () => {
  const candidates = [
    { name: 'Lait demi-Ã©crÃ©mÃ© Marque RepÃ¨re 6 x 1 L', barcode: '3564700000014', priceEuro: 5.94, productUrl: 'https://www.leclercdrive.fr/produit/lait-1' },
    { name: 'Boisson vÃ©gÃ©tale amande 1 L', barcode: '3564700000099', priceEuro: 2.1, productUrl: 'https://www.leclercdrive.fr/produit/amande-1' }
  ];

  it('prefers an exact barcode', () => {
    expect(chooseLeclercProductCandidate({ name: 'Autre nom', barcode: '3564700000014' }, candidates)).toMatchObject({
      ...candidates[0],
      matchScore: 1
    });
  });

  it('falls back to a strong name match', () => {
    expect(chooseLeclercProductCandidate({ name: 'Lait demi Ã©crÃ©mÃ© Marque RepÃ¨re' }, candidates)).toMatchObject(candidates[0]);
  });

  it('does not penalize the generic local brand placeholder', () => {
    expect(
      chooseLeclercProductCandidate(
        { name: 'Lait demi Ã©crÃ©mÃ© UHT', brand: 'Marque habituelle' },
        [{ name: 'Lait demi-Ã©crÃ©mÃ© UHT DÃ©lisse 6x1L', priceEuro: 5.94, productUrl: 'https://fd4-courses.leclercdrive.fr/recherche.aspx' }]
      )
    ).toMatchObject({ matchScore: 1 });
  });

  it('rejects weak and cross-domain results', () => {
    expect(chooseLeclercProductCandidate({ name: 'CafÃ© moulu' }, candidates)).toBeNull();
    expect(chooseLeclercProductCandidate({ name: 'Lait' }, [{ ...candidates[0], productUrl: 'https://evil.test/produit/lait' }])).toBeNull();
  });

  // Diagnostic terrain v0.5.73 (31/08) : le seuil historique à 0.5 et les
  // mots grammaticaux ("au", "aux", "de"...) suffisaient à promouvoir des
  // produits de la même famille mais d'un goût ou d'un usage différent. Ces
  // cartes doivent rester des quasi-correspondances manuelles, jamais devenir
  // automatiquement le prix du produit demandé.
  it.each([
    [
      { name: 'Le Petit Pot de Crème au chocolat', brand: 'Nestlé' },
      { name: 'Petit pot de crème Délisse Vanille - 4x100g', priceEuro: 1.78, productUrl: 'https://www.leclercdrive.fr/produit/pot-vanille' }
    ],
    [
      { name: 'Mousse aux fruits', brand: 'CARREFOUR KIDS' },
      { name: 'Mousse aux oeufs Bonne Maman Chocolat au lait - 4x50g', priceEuro: 2.34, productUrl: 'https://www.leclercdrive.fr/produit/mousse-chocolat' }
    ],
    [
      { name: 'Thé glacé pêche sans sucre', brand: 'Lipton' },
      { name: 'Thé glacé Fuze Tea Framboise Menthe Sans sucres - 1.25L', priceEuro: 1.63, productUrl: 'https://www.leclercdrive.fr/produit/the-framboise' }
    ]
  ])('rejette un candidat de même famille qui ne conserve pas assez de mots d’identité', (product, candidate) => {
    expect(chooseLeclercProductCandidate(product, [candidate])).toBeNull();
  });

  it('conserve un équivalent légitime qui atteint exactement le seuil sémantique minimal', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Purée instantanée', brand: 'Mousline' },
      [{ name: 'Purée Mousline Crème et noix de muscade - 500g', priceEuro: 3.17, productUrl: 'https://www.leclercdrive.fr/produit/puree-mousline' }]
    );

    expect(result).not.toBeNull();
    expect(result.matchScore).toBeCloseTo(2 / 3);
  });

  // Open Food Facts peut fournir un nom étranger alors que la marque reste
  // exploitable. Le normaliseur doit comprendre la structure allemande
  // "<fruit>saft" comme "jus <fruit>" sans règle propre à Tropicana.
  it('rapproche un composé allemand en -saft de son équivalent français en jus', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Orangensaft', brand: 'Tropicana' },
      [{ name: 'Jus Tropicana Orange sans pulpe - 90cl', priceEuro: 2.74, productUrl: 'https://www.leclercdrive.fr/produit/jus-orange' }]
    );

    expect(result).not.toBeNull();
    expect(result.matchScore).toBe(1);
  });

  it('calcule les quasi-correspondances avec les mêmes mots d’identité que l’acceptation automatique', () => {
    const [nearMiss] = findLeclercNearMissCandidates(
      { name: 'Mousse aux fruits', brand: 'CARREFOUR KIDS' },
      [{ name: 'Mousse aux oeufs Bonne Maman Chocolat au lait - 4x50g', priceEuro: 2.34, productUrl: 'https://www.leclercdrive.fr/produit/mousse-chocolat' }]
    );

    expect(nearMiss.matchScore).toBe(0.5);
  });

  it('accepts the same product in a different pack size, at a capped confidence', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Jus de pomme Andros 1L' },
      [{ name: 'Jus de pomme Andros 50cl', priceEuro: 1.8, productUrl: 'https://www.leclercdrive.fr/produit/jus-1' }]
    );
    expect(result).not.toBeNull();
    expect(result.matchScore).toBeLessThan(1);
    expect(result.matchScore).toBeGreaterThanOrEqual(0.5);
  });

  it('does not let a pack-size mismatch alone satisfy the category-overlap gate', () => {
    // Only the brand and a bare quantity number line up; no real category word
    // is shared, so this must still be rejected even though a size token is present.
    expect(
      chooseLeclercProductCandidate(
        { name: 'Riz basmati 500g Lustucru' },
        [{ name: 'Pates 500g Lustucru', priceEuro: 1.2, productUrl: 'https://www.leclercdrive.fr/produit/pates-1' }]
      )
    ).toBeNull();
  });

  // Régression réelle (31/08, diagnostic live) : "Riz basmati en sachet 5x 2
  // personnes" retrouvait bien le vrai produit chez Leclerc ("Riz basmati
  // Lustucru 10min - 5x180g"), mais le score tombait à 0.5 ("incertain",
  // validation manuelle forcée) parce que "en", "sachet" et "personnes" —
  // des mots de formulation de liste de courses, jamais présents dans un
  // nom produit marchand — comptaient dans le dénominateur du score sans
  // jamais pouvoir matcher. Le score doit désormais franchir largement le
  // seuil d'acceptation automatique (75) ; il reste capé à 0.9 (pas 1) car
  // "5x 2 personnes" (portions) et "5x180g" (poids) ne sont pas le même
  // token de quantité — le garde-fou "format potentiellement différent"
  // continue légitimement de s'appliquer.
  it('ignores shopping-list packaging/serving words ("en sachet", "N personnes") in the match score', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Riz basmati en sachet 5x 2 personnes', brand: 'Lustucru' },
      [{ name: 'Riz basmati Lustucru 10min - 5x180g', priceEuro: 3.28, productUrl: 'https://www.leclercdrive.fr/produit/riz-lustucru-10min' }]
    );
    expect(result).not.toBeNull();
    expect(result.matchScore).toBe(0.9);
  });

  it('surfaces every other valid candidate as an alternate, not just different pack sizes', () => {
    // Étape 4 (élargissement) : quand `best` n'est pas un match parfait, un
    // autre candidat qui a franchi le seuil d'acceptation doit rester visible
    // pour l'utilisateur même s'il ne s'agit pas du même produit en format
    // différent — sinon un mauvais choix de `best` n'a aucune piste de repli.
    const product = { name: 'Riz basmati Lustucru 1kg' };
    const exact = { name: 'Riz basmati Lustucru 1kg', priceEuro: 2.5, productUrl: 'https://www.leclercdrive.fr/produit/riz-lustucru' };
    const sameFormatOtherBrand = {
      name: 'Riz basmati Taureau AilÃ© 1kg',
      priceEuro: 2.8,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-taureau'
    };
    const differentPackSize = {
      name: 'Riz basmati Lustucru 500g',
      priceEuro: 1.5,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-lustucru-500g'
    };
    const winningCandidates = [exact, sameFormatOtherBrand, differentPackSize];
    const best = chooseLeclercProductCandidate(product, winningCandidates);
    expect(best.productUrl).toBe(exact.productUrl);

    const alternates = findLeclercAlternateCandidates(product, winningCandidates, best, 5);
    const byUrl = new Map(alternates.map((alternate) => [alternate.productUrl, alternate]));

    // Nouveau : un candidat valide de même format mais d'une autre marque
    // apparaît désormais comme alternate (pas seulement les formats différents).
    expect(byUrl.get(sameFormatOtherBrand.productUrl)).toBeDefined();
    expect(byUrl.get(sameFormatOtherBrand.productUrl).quantityDiffers).toBeFalsy();

    // Toujours vrai : le format différent reste proposé, marqué comme tel.
    expect(byUrl.get(differentPackSize.productUrl)).toBeDefined();
    expect(byUrl.get(differentPackSize.productUrl).quantityDiffers).toBe(true);

    // `best` lui-même ne doit jamais réapparaître comme sa propre alternative.
    expect(byUrl.get(exact.productUrl)).toBeUndefined();
  });

  // Bug généralisable confirmé par diagnostic réel (30/08, "Mousse aux
  // fruits" marque "CARREFOUR KIDS") : la marque concurrente était déjà
  // exclue de la requête envoyée à Leclerc (hasRealLeclercBrand), mais restait
  // comptée dans le score attendu — ses tokens ("carrefour", "kids") ne
  // matchent jamais aucun produit Leclerc, ce qui gonflait le dénominateur et
  // faisait rater le seuil à un candidat par ailleurs correct. Les mots
  // grammaticaux étant désormais exclus eux aussi, les deux vrais mots
  // d'identité ("mousse", "fruits") doivent tous deux correspondre : score 1.
  // diagnostic). Touche tout produit à marque distributeur concurrente, pas
  // seulement ce cas précis.
  it('does not let a competing-retailer brand dilute the match score (only the request query excludes it)', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Mousse aux fruits', brand: 'CARREFOUR KIDS' },
      [{ name: 'Yaourts mousse Petits Délis Fruits - 6x74g', priceEuro: 1.77, productUrl: 'https://www.leclercdrive.fr/produit/yaourt-mousse' }]
    );
    expect(result).not.toBeNull();
    expect(result.matchScore).toBe(1);
  });

  // Cas réel signalé par l'utilisateur (31/08) : "Purée Mousline" ressortait
  // à 375g chez Leclerc et 1040g chez Hyper U — deux candidats matchent
  // aussi bien le nom l'un que l'autre, seul le format cible transmis par la
  // PWA (Open Food Facts au scan) permet de les départager.
  it('privilégie le candidat au format cible (baseQuantity/baseUnit) parmi plusieurs candidats valides', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Purée Mousline', brand: 'Mousline', baseQuantity: 1000, baseUnit: 'g' },
      [
        { name: 'Purée Mousline nature 375g', brand: 'Mousline', priceEuro: 1.5, productUrl: 'https://www.leclercdrive.fr/produit/mousline-375' },
        { name: 'Purée Mousline nature 1kg', brand: 'Mousline', priceEuro: 2.8, productUrl: 'https://www.leclercdrive.fr/produit/mousline-1kg' }
      ]
    );
    expect(result).not.toBeNull();
    expect(result.productUrl).toBe('https://www.leclercdrive.fr/produit/mousline-1kg');
    expect(result.observedQuantity).toBe(1000);
    expect(result.observedUnit).toBe('g');
  });

  it('sans format cible connu, départage les scores ex æquo de façon déterministe (indépendante de l’ordre des candidats)', () => {
    // Diagnostic réel (04/09/2026) : un même scan relancé sur les mêmes
    // produits pouvait retenir un candidat différent d'une fois sur l'autre.
    // Cause : à score de nom identique, le tri ne départageait qu'avec
    // l'ordre d'arrivée des candidats dans le DOM du site — non garanti
    // stable d'un scan à l'autre. Ce test vérifie que l'ordre d'entrée du
    // tableau n'influence plus le résultat.
    const candidates = [
      { name: 'Purée Mousline nature 375g', brand: 'Mousline', priceEuro: 1.5, productUrl: 'https://www.leclercdrive.fr/produit/mousline-375' },
      { name: 'Purée Mousline nature 1kg', brand: 'Mousline', priceEuro: 2.8, productUrl: 'https://www.leclercdrive.fr/produit/mousline-1kg' }
    ];
    const product = { name: 'Purée Mousline', brand: 'Mousline' };
    const forward = chooseLeclercProductCandidate(product, candidates);
    const reversed = chooseLeclercProductCandidate(product, [...candidates].reverse());
    expect(forward).not.toBeNull();
    expect(forward.productUrl).toBe(reversed.productUrl);
  });

  it('remonte le format observé même sans format cible (pour le signalement cross-store côté PWA)', () => {
    const result = chooseLeclercProductCandidate(
      { name: 'Riz basmati', brand: 'Lustucru' },
      [{ name: 'Riz basmati Lustucru 1kg', brand: 'Lustucru', priceEuro: 3.2, productUrl: 'https://www.leclercdrive.fr/produit/riz' }]
    );
    expect(result.observedQuantity).toBe(1000);
    expect(result.observedUnit).toBe('g');
  });

  it('distinguishes informational store pages from the transactional catalog', () => {
    expect(isLeclercInformationPath('/magasin-123456-belleville.aspx')).toBe(true);
    expect(isLeclercInformationPath('/region-centre-val-de-loire/belleville/drive.aspx')).toBe(true);
    expect(isLeclercInformationPath('/recherche?q=lait')).toBe(false);
  });

  it('parses the split price used by the real Leclerc Drive catalog', () => {
    expect(parseLeclercDisplayedPrice({ integerPart: '6', decimalPart: '56', text: '6 â‚¬ ,56 Au lieu de 9,37 â‚¬' })).toBe(6.56);
    expect(parseLeclercDisplayedPrice({ text: '5,94 EUR' })).toBe(5.94);
  });

  it('strips packaging/serving noise Open Food Facts names carry but Leclerc search does not match on', () => {
    expect(simplifyLeclercSearchQuery('Riz basmati en sachet 5x 2 personnes Lustucru')).toBe('Riz basmati Lustucru');
    expect(simplifyLeclercSearchQuery('Torti qualité supérieure 500g Panzani')).toBe('Torti qualité supérieure Panzani');
    expect(simplifyLeclercSearchQuery('La Crème Entière De Normandie 30%MG Elle & Vire')).toBe('La Crème Entière De Normandie Elle & Vire');
    expect(simplifyLeclercSearchQuery('Mousse au fromage frais sucré aux fruits - 6x74g U')).toBe('Mousse au fromage frais sucré aux fruits - U');
    // No packaging noise to strip: simplification is a no-op, signalling the
    // caller should not bother retrying the search with an identical query.
    expect(simplifyLeclercSearchQuery('Boisson végétale saveur amande U')).toBe('Boisson végétale saveur amande U');
  });

  // Bug réel confirmé par diagnostic (2026-08-28) puis reproduit en isolation
  // par navigation directe sur le vrai site : une requête de recherche
  // contenant '%' fait atterrir la page sur l'erreur technique du site
  // (pgeWCSD002_Erreur.aspx) au lieu de résultats, la même requête sans '%'
  // fonctionne normalement. `simplifyLeclercSearchQuery` ne retirait "N%"
  // que collé à "mg" ("30%MG"), pas "30%" seul suivi d'autre chose
  // ("reduit de 30% 150g") — le cas réel qui a fait planter le job.
  it("retire le caractère '%' d'une requête de recherche (le nom original, lui, n'est jamais modifié — voir le scoring)", () => {
    expect(sanitizeLeclercSearchText('President emmental rape sel reduit de 30% 150g')).toBe(
      'President emmental rape sel reduit de 30 150g'
    );
    expect(sanitizeLeclercSearchText('30%MG')).toBe('30 MG');
    expect(sanitizeLeclercSearchText('')).toBe('');
    expect(sanitizeLeclercSearchText(undefined)).toBe('');
    // Rien à retirer : no-op, comme simplifyLeclercSearchQuery.
    expect(sanitizeLeclercSearchText('Boisson soja nature')).toBe('Boisson soja nature');
  });

  it('starts navigation and reads results in separate script executions', async () => {
    const scripting = {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: true, started: false } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: undefined }])
        .mockResolvedValueOnce([{ result: [candidates[0]] }])
    };
    const controller = new AbortController();
    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: controller.signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(scripting.executeScript).toHaveBeenCalledTimes(8);
    expect(result.observations).toHaveLength(1);
    expect(result.errors).toEqual([]);
  }, 5_000);

  it('ne dépend pas d’une lecture de route de secours quand aucun produit n’a de correction manuelle', async () => {
    const matchingCandidate = {
      name: 'Lait demi-écrémé UHT Délisse 6x1L',
      priceEuro: 5.94,
      productUrl: 'https://www.leclercdrive.fr/produit/lait'
    };
    const scripting = {
      executeScript: vi.fn(async ({ func }) => {
        const result =
          func.name === 'dismissCookieConsentOnPage'
            ? { dismissed: false }
            : func.name === 'readPublicLeclercPageState'
              ? { hostname: 'm-courses.leclercdrive.fr', pathname: '/magasin-1', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true }
              : func.name === 'readCurrentLeclercUrlOnPage'
                ? (() => { throw new Error('route snapshot unavailable'); })()
                : func.name === 'startProductSearchOnPage'
                  ? { started: true }
                  : func.name === 'inspectLeclercSearchNavigationOnPage'
                    ? { ready: true }
                    : func.name === 'triggerLeclercLazyLoadOnPage'
                      ? { remainingPlaceholders: 0 }
                      : func.name === 'readProductCandidatesOnPage'
                        ? [matchingCandidate]
                        : undefined;
        return [{ result }];
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi-écrémé UHT' }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
  }, 5_000);

  // Bug généralisable identifié le 30/08 (diagnostics réels : Panzani/Emmental
  // ne remontant que 3 candidats un run, contre 17-21 pour une recherche
  // comparable) : triggerLeclercLazyLoadOnPage a son propre budget dur
  // (2500ms) et peut rendre la main avant d'avoir chargé toute une longue
  // liste. waitForProductCandidates retournait alors dès le parcmier candidat
  // non-vide lu, même partiel — le bon produit pouvait être juste en dessous,
  // encore un placeholder vide. Ce test simule un premier passage partiel
  // (des placeholders restent, en baisse) suivi d'un second passage complet
  // (plus aucun placeholder) : le second jeu de candidats, plus complet, doit
  // être celui retenu.
  it('keeps polling while the lazy-load still has placeholders left to render, instead of returning a partial read', async () => {
    const partialCandidate = { name: 'Produit sans rapport', priceEuro: 9.99, productUrl: 'https://www.leclercdrive.fr/produit/sans-rapport' };
    const fullCandidate = { name: 'Lait demi-Ã©crÃ©mÃ© Marque RepÃ¨re 6 x 1 L', barcode: '3564700000014', priceEuro: 5.94, productUrl: 'https://www.leclercdrive.fr/produit/lait-1' };
    const scripting = {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: true, started: false } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        // Passage 1 de waitForProductCandidates : lecture partielle, des
        // placeholders restent (lazy-load pas terminé).
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 3 } }])
        .mockResolvedValueOnce([{ result: [partialCandidate] }])
        // Passage 2 : plus de placeholders restants, la vraie carte est là.
        // Pas de nouveau check de route (routeVerified déjà true).
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 0 } }])
        .mockResolvedValueOnce([{ result: [fullCandidate] }])
    };
    const controller = new AbortController();
    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: controller.signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(scripting.executeScript).toHaveBeenCalledTimes(11);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].productUrl).toBe(fullCandidate.productUrl);
  }, 5_000);

  // Cas réel (30/08, "Orangensaft" — recherche "Tropicana", bandeau "6
  // résultats affichés") : le chargement par IntersectionObserver n'avance
  // pas à chaque passage — un tour entier peut ne rendre aucune carte de
  // plus (le scroll n'a pas encore atteint leur zone) avant que le lot
  // suivant n'apparaisse. Couper au tout premier plateau (comme avant ce
  // correctif) renvoyait alors un jeu partiel dont le bon produit était
  // absent. La tolérance doit couvrir UN plateau isolé sans abandonner.
  it('tolerates a single stalled round with no new cards before resuming progress', async () => {
    const partialCandidate = { name: 'Produit sans rapport', priceEuro: 9.99, productUrl: 'https://www.leclercdrive.fr/produit/sans-rapport' };
    const fullCandidate = { name: 'Lait demi-Ã©crÃ©mÃ© Marque RepÃ¨re 6 x 1 L', barcode: '3564700000014', priceEuro: 5.94, productUrl: 'https://www.leclercdrive.fr/produit/lait-1' };
    const scripting = {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: true, started: false } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        // Passage 1 : lecture partielle, 3 placeholders restants.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 3 } }])
        .mockResolvedValueOnce([{ result: [partialCandidate] }])
        // Passage 2 : plateau — toujours 3 placeholders restants, aucune
        // nouvelle carte rendue ce tour-ci. Ne doit PAS abandonner ici.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 3 } }])
        .mockResolvedValueOnce([{ result: [partialCandidate] }])
        // Passage 3 : le lot restant finit par se charger.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 0 } }])
        .mockResolvedValueOnce([{ result: [fullCandidate] }])
    };
    const controller = new AbortController();
    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: controller.signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(scripting.executeScript).toHaveBeenCalledTimes(14);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].productUrl).toBe(fullCandidate.productUrl);
  }, 5_000);

  // Symétrique du test précédent : un plateau qui persiste sur DEUX passages
  // consécutifs doit, lui, faire abandonner avec le meilleur jeu partiel
  // déjà lu — sinon un lazy-load réellement bloqué (placeholder qui ne se
  // remplira jamais, ex. carte retirée du catalogue entre le rendu du
  // bandeau et le scroll) consommerait tout le budget de 15s en boucle
  // muette au lieu de rendre la main avec ce qu'il a. Le candidat matché dès
  // le 1er passage porte volontairement le bon barcode (comme le test
  // précédent) : ce qui est vérifié ici est le nombre d'appels — la fonction
  // doit rendre la main après le 2e plateau plutôt que de continuer à
  // sonder jusqu'à épuiser tout le budget de 15s.
  it('gives up after two consecutive stalled rounds instead of polling forever', async () => {
    const matchingCandidate = { name: 'Lait demi-Ã©crÃ©mÃ© Marque RepÃ¨re 6 x 1 L', barcode: '3564700000014', priceEuro: 5.94, productUrl: 'https://www.leclercdrive.fr/produit/lait-1' };
    const scripting = {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: true, started: false } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 3 } }])
        .mockResolvedValueOnce([{ result: [matchingCandidate] }])
        // Deux tours de suite sans le moindre progrès — toujours 3
        // placeholders restants, jamais 0.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 3 } }])
        .mockResolvedValueOnce([{ result: [matchingCandidate] }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 3 } }])
        .mockResolvedValueOnce([{ result: [matchingCandidate] }])
    };
    const controller = new AbortController();
    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: controller.signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    // 4 appels du prologue + le passage 1 (avec sa vérification de route,
    // 4 appels) + 2 passages de plateau (3 appels chacun, route déjà
    // vérifiée) = 14 : la fonction s'est arrêtée d'elle-même après le 2e
    // plateau (round 3), pas après avoir épuisé tout le budget de 15s à
    // coups de wait(500ms) jusqu'à la deadline.
    expect(scripting.executeScript).toHaveBeenCalledTimes(14);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].productUrl).toBe(matchingCandidate.productUrl);
  }, 5_000);

  // Découverte réelle (30/08, inspection en direct sur le vrai site,
  // recherche "PRÉSIDENT" — 23 résultats) : Leclerc VIRTUALISE sa liste — une
  // carte déjà rendue peut redevenir un placeholder vide dès qu'on scroll
  // loin d'elle, y compris le bon produit. Le compte de placeholders vides
  // "remainingPlaceholders" peut donc plafonner (jamais 0) sans jamais
  // refléter combien de candidats DIFFÉRENTS ont réellement été vus au fil du
  // scroll. Sans accumulation, le dernier lot lu écrase les précédents — un
  // candidat correct vu tôt puis rechargé en placeholder disparaissait du
  // résultat final alors qu'il avait bien été vu.
  it('accumulates candidates seen across rounds instead of losing ones the list virtualizes back to empty', async () => {
    const fullCandidate = { name: 'Lait demi-Ã©crÃ©mÃ© Marque RepÃ¨re 6 x 1 L', barcode: '3564700000014', priceEuro: 5.94, productUrl: 'https://www.leclercdrive.fr/produit/lait-1' };
    const otherCandidate = { name: 'Autre produit sans rapport', priceEuro: 2.5, productUrl: 'https://www.leclercdrive.fr/produit/autre' };
    const scripting = {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: true, started: false } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        // Tour 1 : le bon produit est vu, 17 placeholders restent.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 17 } }])
        .mockResolvedValueOnce([{ result: [fullCandidate] }])
        // Tour 2 : virtualisation — le bon produit a été revidé, un autre est
        // vu à la place. remainingPlaceholders reste à 17 (plateau apparent
        // côté compteur de vides, alors qu'un nouveau candidat a bien été vu).
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 17 } }])
        .mockResolvedValueOnce([{ result: [otherCandidate] }])
        // Tour 3 : plus rien de nouveau (même candidat relu) — 1er plateau
        // sur le compte de candidats accumulés.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 17 } }])
        .mockResolvedValueOnce([{ result: [otherCandidate] }])
        // Tour 4 : toujours rien de nouveau — 2e plateau consécutif, abandon.
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 17 } }])
        .mockResolvedValueOnce([{ result: [otherCandidate] }])
    };
    const controller = new AbortController();
    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: controller.signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(scripting.executeScript).toHaveBeenCalledTimes(17);
    expect(result.errors).toEqual([]);
    // Le bon produit (vu seulement au tour 1, puis revidé par la
    // virtualisation) reste le match final malgré son absence du dernier lot
    // lu — grâce à l'accumulation, pas au dernier lot brut.
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].productUrl).toBe(fullCandidate.productUrl);
  }, 5_000);

  it('enrichit une même carte partielle lorsqu’elle réapparaît complète pendant le balayage virtualisé', async () => {
    const partial = {
      name: 'Riz basmati Lustucru 900g',
      externalProductId: '2100474',
      priceEuro: 3.32,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-2100474'
    };
    const complete = {
      ...partial,
      brand: 'LUSTUCRU',
      barcode: '3760341070335',
      unitPriceEuro: 3.69,
      unitPriceUnit: 'kg',
      promotionLabel: 'Ticket E.Leclerc 20%'
    };
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: true, started: false } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 5 } }])
        .mockResolvedValueOnce([{ result: [partial] }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 5 } }])
        .mockResolvedValueOnce([{ result: [complete] }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 5 } }])
        .mockResolvedValueOnce([{ result: [complete] }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { remainingPlaceholders: 5 } }])
        .mockResolvedValueOnce([{ result: [complete] }])
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-riz', name: 'Riz basmati Lustucru 900g', barcode: '3760341070335' }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations[0]).toMatchObject({
      externalProductId: '2100474',
      observedBrand: 'LUSTUCRU',
      observedBarcode: '3760341070335',
      unitPriceEuro: 3.69,
      unitPriceUnit: 'kg',
      promotionLabel: 'Ticket E.Leclerc 20%'
    });
  }, 5_000);

  it('searches directly from a redirected transactional home page', async () => {
    const parisCandidate = {
      ...candidates[0],
      productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-997371-000760-Paris/recherche.aspx?TexteRecherche=lait'
    };
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{
          result: {
            hostname: 'fd4-courses.leclercdrive.fr',
            pathname: '/magasin-997371-000760-Paris/home.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }
        }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: undefined }])
                .mockResolvedValueOnce([{ result: [parisCandidate] }])
    };
    const result = await collectLeclercStore({
      scripting,
      tabId: 11,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-paris' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(scripting.executeScript).toHaveBeenCalledTimes(7);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
  });

  it('searches from a bare store path with no .aspx suffix (real driveUrl saved by a user)', async () => {
    // Users copy the URL straight from their browser's address bar, which can
    // land on a bare "/magasin-xxx-name" path with no extension at all.
    const bareCandidate = {
      ...candidates[0],
      productUrl: 'https://m-courses.leclercdrive.fr/magasin-127811-127811-bois-darcy/recherche.aspx?TexteRecherche=lait'
    };
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{
          result: {
            hostname: 'm-courses.leclercdrive.fr',
            pathname: '/magasin-127811-127811-bois-darcy',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }
        }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: undefined }])
                .mockResolvedValueOnce([{ result: [bareCandidate] }])
    };
    const result = await collectLeclercStore({
      scripting,
      tabId: 16,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-bois-darcy' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(scripting.executeScript).toHaveBeenCalledTimes(7);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
  });

  it('recognizes the m-courses mobile transactional subdomain (real store URL saved from Firefox Android)', async () => {
    // A user-saved driveUrl can point at the mobile "m-courses" transactional
    // farm instead of the desktop "fdNN-courses" one; both must be treated
    // as an already-transactional catalog, not an informational store page.
    const mobileCandidate = {
      ...candidates[0],
      productUrl: 'https://m-courses.leclercdrive.fr/magasin-127811-127811-bois-darcy/recherche.aspx?TexteRecherche=lait'
    };
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{
          result: {
            hostname: 'm-courses.leclercdrive.fr',
            pathname: '/magasin-127811-127811-bois-darcy',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }
        }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: undefined }])
                .mockResolvedValueOnce([{ result: [mobileCandidate] }])
    };
    const result = await collectLeclercStore({
      scripting,
      tabId: 15,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-bois-darcy' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    // Before the fix, this hostname was not recognized as transactional, so
    // the collector tried (and failed) to resolve a farm link instead of
    // searching directly, surfacing as LECLERC_FARM_NOT_RESOLVED.
    expect(scripting.executeScript).toHaveBeenCalledTimes(7);
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
  });

  it('discovers the transactional catalog link for an unverified store from the info page', async () => {
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{
          result: {
            hostname: 'www.leclercdrive.fr',
            pathname: '/magasin-997371-000760-paris.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: false
          }
        }])
        .mockResolvedValueOnce([{ result: { url: 'https://fd21-courses.leclercdrive.fr/magasin-997371-000760-paris.aspx' } }])
        .mockResolvedValueOnce([{ result: { started: true } }])
        .mockResolvedValueOnce([{
          result: {
            hostname: 'fd21-courses.leclercdrive.fr',
            pathname: '/magasin-997371-000760-paris.aspx',
            hasCaptcha: false,
            hasStorePrompt: false,
            hasCatalog: true
          }
        }])
        .mockResolvedValueOnce([{ result: { started: true, query: 'Lait demi Ã©crÃ©mÃ©' } }])
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { ready: true } }])
        .mockResolvedValueOnce([{ result: undefined }])
                .mockResolvedValueOnce([{
          result: [{
            ...candidates[0],
            productUrl: 'https://fd21-courses.leclercdrive.fr/magasin-997371-000760-paris/recherche.aspx?TexteRecherche=lait'
          }]
        }])
    };
    const result = await collectLeclercStore({
      scripting,
      tabId: 14,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-paris' },
      products: [{ productId: 'product-1', name: 'Lait demi Ã©crÃ©mÃ©', barcode: '3564700000014' }]
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
  }, 5_000);

  it('stops before product searches when the catalog entry returns to the store page', async () => {
    const scripting = {
      executeScript: vi
        .fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
        .mockResolvedValueOnce([{ result: { ready: false, started: true } }])
        .mockResolvedValueOnce([{ result: { ready: false, details: { pathKind: 'magasin-test', inputCount: 8, hasSearchControl: false } } }])
    };
    const result = await collectLeclercStore({
      scripting,
      tabId: 10,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [{ productId: 'product-1', name: 'Lait' }]
    });

    expect(result.errors).toEqual([
      expect.objectContaining({ code: 'CATALOG_NOT_READY_AFTER_ENTRY' })
    ]);
    expect(scripting.executeScript).toHaveBeenCalledTimes(4);
  }, 5_000);

  it('keeps the Leclerc tab open when automatic Drive selection cannot start', async () => {
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', pathname: '/', hasCaptcha: false, hasStorePrompt: true, hasCatalog: false } }])
        .mockResolvedValueOnce([{ result: { started: false, code: 'POSTAL_AUTOCOMPLETE_NOT_FOUND' } }])
    };
    const result = await collectLeclercStore({
      scripting, tabId: 12, signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-paris', postalCode: '75011', city: 'Paris' },
      products: []
    });
    expect(result.keepTabOpen).toBe(true);
    expect(result.errors).toEqual([expect.objectContaining({ code: 'POSTAL_AUTOCOMPLETE_NOT_FOUND' })]);
  });

  it('completes the current autocomplete then clicks the selected Drive card', async () => {
    const scripting = {
      executeScript: vi.fn()
        .mockResolvedValueOnce([{ result: { dismissed: false } }])
        .mockResolvedValueOnce([{ result: { hostname: 'www.leclercdrive.fr', pathname: '/', hasCaptcha: false, hasStorePrompt: true, hasCatalog: false } }])
        .mockResolvedValueOnce([{ result: { started: true, query: '75011' } }])
        .mockResolvedValueOnce([{ result: [{ actionIndex: 0, text: '75011 Voltaire 0,4 km Retrait piéton' }] }])
        .mockResolvedValueOnce([{ result: { clicked: true } }])
        .mockResolvedValueOnce([{ result: { hostname: 'fd4-courses.leclercdrive.fr', pathname: '/magasin-000000-000000-Paris/home.aspx', hasCaptcha: false, hasStorePrompt: false, hasCatalog: true } }])
    };
    const result = await collectLeclercStore({
      scripting, tabId: 13, signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-voltaire', displayName: 'E.Leclerc 75011 Voltaire', postalCode: '75011', city: 'Paris' },
      products: []
    });
    expect(result.errors).toEqual([]);
    expect(result.keepTabOpen).toBeUndefined();
    expect(scripting.executeScript).toHaveBeenCalledTimes(6);
  }, 5_000);});


describe('Format transporté par les alternates', () => {
  it("propage le format lu du candidat au lieu de le jeter après l'avoir calculé", () => {
    // rankLeclercCandidates calcule observedQuantity/observedUnit sur l'ENTRÉE
    // du classement, pas sur `entry.candidate`. Le spread des alternates ne
    // reprenait que le candidat, donc le format était perdu à la ligne
    // suivant son calcul — et le contrôle croisé prix / prix au litre
    // (src/features/comparison/priceCoherence.ts) restait aveugle sur les
    // alternates, alors que leur prix unitaire, lui, traversait bien le
    // protocole. Un alternate est un prix que l'utilisateur peut retenir à la
    // place de celui proposé : il doit être vérifié comme les autres.
    const product = { name: 'Riz basmati Lustucru 1kg' };
    const exact = {
      name: 'Riz basmati Lustucru 1kg',
      priceEuro: 2.5,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-lustucru'
    };
    const differentPackSize = {
      name: 'Riz basmati Lustucru 500g',
      priceEuro: 1.5,
      productUrl: 'https://www.leclercdrive.fr/produit/riz-lustucru-500g'
    };
    const winningCandidates = [exact, differentPackSize];
    const best = chooseLeclercProductCandidate(product, winningCandidates);

    const alternates = findLeclercAlternateCandidates(product, winningCandidates, best, 5);
    const alternate = alternates.find((entry) => entry.productUrl === differentPackSize.productUrl);

    expect(alternate).toBeDefined();
    expect(alternate.observedQuantity).toBe(500);
    expect(alternate.observedUnit).toBe('g');
  });
});
