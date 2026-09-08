import { describe, expect, it } from 'vitest';
import { demoProducts } from '../../db/seed';
import { mockPriceSnapshots, mockProductCandidates } from '../stores/mockStoreData';
import { compareShoppingList } from './comparisonEngine';

// Étape 5 : un snapshot `source: 'mock'` (données de démo) ou trop ancien
// (> `maxPriceAgeDays`) exige désormais une validation — sans ceci, cette
// donnée de fixture (seedDate 2026-07-07, très ancienne) ferait basculer
// tous les tests d'arithmétique/décision ci-dessous en "à valider", alors
// qu'ils testent délibérément le moteur en supposant des prix confirmés
// récents (le comportement "mock/périmé" a ses propres tests dédiés).
const freshPriceSnapshots = mockPriceSnapshots.map((snapshot) => ({
  ...snapshot,
  source: 'adapter' as const,
  checkedAt: new Date().toISOString()
}));

const DEFAULT_MAX_PRICE_AGE_DAYS = 7;

const baseRows = [
  {
    product: demoProducts[0],
    item: {
      id: 'item-ice-tea',
      shoppingListId: 'list-active',
      productId: 'prod-ice-tea-peche',
      wantedQuantity: 1,
      createdAt: '2026-07-07T10:00:00.000Z'
    }
  },
  {
    product: demoProducts[1],
    item: {
      id: 'item-lait',
      shoppingListId: 'list-active',
      productId: 'prod-lait-demi-ecreme',
      wantedQuantity: 1,
      createdAt: '2026-07-07T10:00:00.000Z'
    }
  }
];

describe('comparisonEngine', () => {
  it('calculates single-store totals, optimized total and single-store recommendation below threshold', () => {
    const result = compareShoppingList({
      rows: baseRows,
      candidates: mockProductCandidates,
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.totals.leclerc).toBe(7.83);
    expect(result.totals.hyperu).toBe(7.9);
    // Ice tea : 1,5 L à 1,89 € chez Leclerc (1,26 €/L) contre 2 L à 2,20 €
    // chez Hyper U (1,10 €/L). Les formats diffèrent, donc c'est le prix au
    // litre qui tranche (voir buildUnitPriceArbitration) : Hyper U l'emporte
    // même si sa bouteille coûte plus cher à l'unité. Le panier optimisé
    // n'est donc plus le panier le moins cher en euros, mais celui au
    // meilleur prix au litre/kilo — changement de règle demandé le 31/08.
    expect(result.totals.optimized).toBe(7.9);
    expect(result.savingsVsBestSingleStore).toBe(-0.07);
    expect(result.recommendation.kind).toBe('single_store');
    if (result.recommendation.kind !== 'single_store') {
      throw new Error('Expected a single-store recommendation');
    }
    expect(result.recommendation.storeKey).toBe('leclerc');
  });

  it('recommends splitting when savings reach the configured threshold', () => {
    // Les fixtures d'ice tea ont deux formats différents (1,5 L / 2 L), ce qui
    // déclenche désormais l'arbitrage au prix au litre et envoie les deux
    // lignes chez Hyper U — il n'y aurait alors plus rien à répartir. Ce test
    // porte sur la répartition entre magasins, pas sur l'arbitrage : on aligne
    // donc les formats pour rester sur la règle du prix le plus bas.
    const memeFormat = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-hyperu-format' ? { ...candidate, quantity: 1.5 } : candidate
    );

    const result = compareShoppingList({
      rows: baseRows,
      candidates: memeFormat,
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 0.1,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.recommendation.kind).toBe('split');
  });

  it('exclut sans blocage un produit dont la seule offre observée est indisponible', () => {
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: [mockProductCandidates[0]],
      priceSnapshots: [{ ...freshPriceSnapshots[0], available: false }],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.decisions[0]?.requiresValidation).toBe(false);
    expect(result.decisions[0]?.warnings).toContain('Prix indisponible');
    expect(result.excludedLines).toHaveLength(1);
  });

  it('signale un prix incohérent sans rendre la ligne obligatoire à valider', () => {
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: [mockProductCandidates[0]],
      priceSnapshots: [{ ...freshPriceSnapshots[0], priceCoherence: 'mismatch' as const }],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.decisions[0]?.warnings).toContain(
      'Prix incohérent avec le prix au litre/kilo affiché — à vérifier.'
    );
    expect(result.decisions[0]?.requiresValidation).toBe(false);
  });

  it('separates products that have no price snapshot', () => {
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: [mockProductCandidates[0]],
      priceSnapshots: [],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.decisions[0]?.requiresValidation).toBe(true);
    expect(result.decisions[0]?.warnings).toContain('Prix absent');
  });

  it('calcule les totaux connus sans bloquer un produit absent des deux magasins', () => {
    const result = compareShoppingList({
      rows: [
        baseRows[0],
        {
          product: demoProducts[2],
          item: {
            id: 'item-riz',
            shoppingListId: 'list-active',
            productId: 'prod-riz-basmati',
            wantedQuantity: 1,
            createdAt: '2026-07-07T10:00:00.000Z'
          }
        }
      ],
      candidates: mockProductCandidates,
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.totals.leclerc).toBe(1.89);
    expect(result.totals.hyperu).toBe(2.2);
    // Même cause que plus haut : 1,5 L à 1,89 € (1,26 €/L) contre 2 L à
    // 2,20 € (1,10 €/L) — l'arbitrage au litre retient Hyper U.
    expect(result.totals.optimized).toBe(2.2);
    expect(result.productsToValidate).toHaveLength(0);
    expect(result.excludedLines).toHaveLength(1);
    expect(result.trustReport.canValidateBasket).toBe(true);
  });

  it('exclut un produit absent des deux magasins sans bloquer la validation des lignes achetables', () => {
    const result = compareShoppingList({
      rows: [baseRows[0], { ...baseRows[1], item: { ...baseRows[1].item, id: 'item-absent' } }],
      candidates: mockProductCandidates.filter((candidate) => candidate.productId === baseRows[0].product.id),
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.excludedLines).toEqual([
      { itemId: 'item-absent', productId: baseRows[1].product.id, reason: 'absent_both' }
    ]);
    expect(result.trustReport.canValidateBasket).toBe(true);
    expect(result.productsToValidate).toHaveLength(0);
    expect(result.totals.optimized).toBe(2.2);
  });

  it("ne bloque pas si un magasin ne couvre pas le produit mais que l'autre fournit une offre fiable", () => {
    const leclercOnly = mockProductCandidates.filter((candidate) =>
      candidate.productId === baseRows[0].product.id && candidate.storeKey === 'leclerc'
    );
    const result = compareShoppingList({
      rows: [baseRows[0]], candidates: leclercOnly, priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3, autoDecisionMinConfidence: 75, maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.trustReport.canValidateBasket).toBe(true);
    expect(result.coverage.hyperu.covered).toBe(0);
    expect(result.savingsVsBestSingleStore).toBe(0);
  });

  it('un candidat forcé via forcedCandidateId est sélectionné même si un autre est mieux classé', () => {
    const forcedRow = {
      ...baseRows[0],
      item: { ...baseRows[0].item, forcedCandidateId: 'cand-ice-tea-hyperu-mdd' }
    };
    const result = compareShoppingList({
      rows: [forcedRow],
      candidates: mockProductCandidates,
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.decisions[0]?.selectedCandidateId).toBe('cand-ice-tea-hyperu-mdd');
    expect(result.decisions[0]?.selectedStoreKey).toBe('hyperu');
    expect(result.decisions[0]?.requiresValidation).toBe(false);
    expect(result.decisions[0]?.reason).toContain('Format choisi manuellement');
  });

  it('un forcedStoreKey exclut les candidats des autres magasins même si moins chers ailleurs', () => {
    const forcedRow = {
      ...baseRows[0],
      item: { ...baseRows[0].item, forcedStoreKey: 'hyperu' as const }
    };
    const result = compareShoppingList({
      rows: [forcedRow],
      candidates: mockProductCandidates,
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.decisions[0]?.selectedStoreKey).toBe('hyperu');
    expect(result.decisions[0]?.reason).toContain('Magasin forcé');
  });

  it('un candidat isRejected est totalement exclu (jamais sélectionné, jamais proposé en alternate)', () => {
    const rejectedCandidates = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-leclerc-exact' ? { ...candidate, isRejected: true } : candidate
    );
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: rejectedCandidates,
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    expect(result.decisions[0]?.selectedCandidateId).not.toBe('cand-ice-tea-leclerc-exact');
    expect(result.decisions[0]?.alternates.some((a) => a.candidateId === 'cand-ice-tea-leclerc-exact')).toBe(false);
  });

  it('frontière du seuil d\'auto-décision : confiance strictement égale au seuil est acceptée, juste en dessous exige une validation', () => {
    const borderlineCandidates = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-hyperu-mdd' ? { ...candidate, confidenceScore: 75 } : candidate
    );
    const atThreshold = compareShoppingList({
      rows: [baseRows[0]],
      candidates: borderlineCandidates,
      priceSnapshots: [freshPriceSnapshots[2]],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });
    expect(atThreshold.decisions[0]?.requiresValidation).toBe(false);

    const belowCandidates = mockProductCandidates.map((candidate) =>
      candidate.id === 'cand-ice-tea-hyperu-mdd' ? { ...candidate, confidenceScore: 74 } : candidate
    );
    const belowThreshold = compareShoppingList({
      rows: [baseRows[0]],
      candidates: belowCandidates,
      priceSnapshots: [freshPriceSnapshots[2]],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });
    expect(belowThreshold.decisions[0]?.requiresValidation).toBe(true);
  });

  it('un candidat same_brand_different_format non marqué isAlternate participe normalement aux totaux (pas exclu comme les vraies alternates)', () => {
    // cand-ice-tea-hyperu-format est same_brand_different_format mais n'a PAS
    // isAlternate: true — c'est un résultat de recherche normal (pas une
    // proposition annexe), il doit donc pouvoir être sélectionné et compter
    // dans le total du magasin comme n'importe quel autre candidat.
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: mockProductCandidates.filter((c) => c.id !== 'cand-ice-tea-hyperu-mdd'),
      priceSnapshots: freshPriceSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    // Le total Hyper U reste calculable à partir de ce candidat seul : s'il
    // était traité comme une simple alternative annexe (comme une vraie
    // `isAlternate: true`), il serait exclu de `calculateStoreTotal` et ce
    // total tomberait à `null`.
    expect(result.totals.hyperu).toBe(2.2);
  });

  it('signale un conditionnement non demandé moins cher au litre chez le magasin déjà retenu', () => {
    // Grand format Leclerc non demandé par l'utilisateur (isAlternate: true,
    // same_brand_different_format) mais moins cher au litre (1,00 €/L) que le
    // format 1,5 L retenu (1,26 €/L) — doit être signalé explicitement,
    // jamais sélectionné automatiquement.
    const betterFormatCandidate = {
      id: 'cand-ice-tea-leclerc-grand-format',
      productId: 'prod-ice-tea-peche',
      storeKey: 'leclerc' as const,
      name: 'Lipton Ice Tea pêche 3 L',
      brand: 'Lipton Ice Tea',
      variant: 'pêche',
      quantity: 3,
      unit: 'L' as const,
      productUrl: 'https://www.leclercdrive.fr/fiche-produits-999-lipton-ice-tea-peche-3l.aspx',
      matchType: 'same_brand_different_format' as const,
      confidenceScore: 85,
      confidenceReasons: ['Même marque', 'Même variante', 'Format différent'],
      isAlternate: true,
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z'
    };
    const betterFormatSnapshot = {
      id: 'price-ice-tea-leclerc-grand-format',
      candidateId: 'cand-ice-tea-leclerc-grand-format',
      storeKey: 'leclerc' as const,
      price: 3.0,
      currency: 'EUR' as const,
      unitPrice: 1.0,
      comparisonUnit: 'liter' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    };

    // Ne garde que les candidats Leclerc pour cette ligne : le but est
    // d'isoler la suggestion "même magasin, meilleur format", pas l'arbitrage
    // cross-magasin déjà couvert par d'autres tests.
    const leclercOnlyCandidates = mockProductCandidates
      .filter((c) => !(c.productId === 'prod-ice-tea-peche' && c.storeKey === 'hyperu'))
      .concat(betterFormatCandidate);

    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: leclercOnlyCandidates,
      priceSnapshots: [...freshPriceSnapshots, betterFormatSnapshot],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    const decision = result.decisions[0];
    // Toujours le format 1,5 L demandé qui est sélectionné automatiquement —
    // le grand format n'est qu'une suggestion, jamais un choix automatique.
    expect(decision.selectedCandidateId).toBe('cand-ice-tea-leclerc-exact');
    expect(decision.warnings.some((warning) => warning.includes('Meilleure offre disponible'))).toBe(true);
    expect(decision.warnings.some((warning) => warning.includes('3 L'))).toBe(true);
    expect(decision.warnings.some((warning) => warning.includes('1.00 €/L') || warning.includes('1,00 €/L'))).toBe(
      true
    );
  });

  it('compare au prix au litre le seul candidat "à valider" d\'un magasin plutôt que de le faire disparaître du comparatif (cas réel Tropicana/Andros)', () => {
    // Cas réel signalé le 01/09 : Leclerc ne propose que "Jus d'oranges
    // pressées Sans pulpe Andros - 1,5L" (marque différente de Tropicana,
    // matchType equivalent_brand, confiance < seuil auto -> requiresValidation)
    // pendant que Hyper U a exactement le produit demandé (1L, fiable).
    // Aucun risque de doublon inter-lignes (un seul produit "jus d'orange"
    // dans le panier) : le candidat Leclerc doit être comparé au prix au
    // litre contre Hyper U, pas silencieusement ignoré.
    const product = {
      id: 'prod-jus-orange',
      name: 'Tropicana 100% oranges pressées sans pulpe 1 L',
      brand: 'Tropicana',
      comparisonUnit: 'liter' as const,
      allowDifferentFormat: true,
      allowPrivateLabel: true,
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z'
    };
    const row = {
      product,
      item: {
        id: 'item-jus-orange',
        shoppingListId: 'list-active',
        productId: product.id,
        wantedQuantity: 1,
        createdAt: '2026-07-07T10:00:00.000Z'
      }
    };
    const leclercCandidate = {
      id: 'cand-jus-orange-leclerc',
      productId: product.id,
      storeKey: 'leclerc' as const,
      name: "Jus d'oranges pressées Sans pulpe Andros - 1.5L",
      brand: 'Andros',
      quantity: 1.5,
      unit: 'L' as const,
      productUrl: 'https://fd7-courses.leclercdrive.fr/fiche-produits-62359-jus-oranges-andros-1-5l.aspx',
      matchType: 'equivalent_brand' as const,
      confidenceScore: 60,
      confidenceReasons: ['Marque équivalente'],
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z'
    };
    const hyperuCandidate = {
      id: 'cand-jus-orange-hyperu',
      productId: product.id,
      storeKey: 'hyperu' as const,
      name: "Jus d'orange pure premium sans pulpe TROPICANA, 1l",
      brand: 'Tropicana',
      quantity: 1,
      unit: 'L' as const,
      productUrl: 'https://www.coursesu.com/p/jus-dorange-tropicana-1l/1052122.html',
      matchType: 'exact_barcode' as const,
      confidenceScore: 100,
      confidenceReasons: ['Même code-barres'],
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z'
    };
    const leclercSnapshot = {
      id: 'price-jus-orange-leclerc',
      candidateId: leclercCandidate.id,
      storeKey: 'leclerc' as const,
      price: 4.19,
      currency: 'EUR' as const,
      unitPrice: 2.79,
      comparisonUnit: 'liter' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    };
    const hyperuSnapshot = {
      id: 'price-jus-orange-hyperu',
      candidateId: hyperuCandidate.id,
      storeKey: 'hyperu' as const,
      price: 2.41,
      currency: 'EUR' as const,
      unitPrice: 2.41,
      comparisonUnit: 'liter' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    };

    const result = compareShoppingList({
      rows: [row],
      candidates: [leclercCandidate, hyperuCandidate],
      priceSnapshots: [leclercSnapshot, hyperuSnapshot],
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
    });

    const decision = result.decisions[0];
    // Hyper U reste choisi automatiquement : le candidat Leclerc n'est pas
    // assez confirmé pour un achat automatique.
    expect(decision.selectedStoreKey).toBe('hyperu');
    // Mais la comparaison au prix au litre doit apparaître, avec les deux
    // prix unitaires et la mention explicite que Leclerc reste à valider.
    const mismatchWarning = decision.warnings.find((warning) => warning.includes('pas le même format'));
    expect(mismatchWarning).toBeDefined();
    expect(mismatchWarning).toContain('2.79 €/L');
    expect(mismatchWarning).toContain('2.41 €/L');
    expect(mismatchWarning).toContain('Leclerc');
    expect(mismatchWarning).toMatch(/pas encore confirmé|à valider/);
  });

  it('un snapshot available mais plus vieux que maxPriceAgeDays exige une validation et sort des totaux', () => {
    const staleSnapshots = freshPriceSnapshots.map((snapshot) =>
      snapshot.id === 'price-ice-tea-leclerc'
        ? { ...snapshot, checkedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }
        : snapshot
    );
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: mockProductCandidates,
      priceSnapshots: staleSnapshots,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: 7
    });

    const staleOption = result.decisions[0];
    expect(staleOption?.selectedStoreKey).not.toBe('leclerc');
    // Hyper U reste frais dans cette fixture : le total magasin unique
    // Leclerc doit refléter l'exclusion de son seul prix, désormais périmé.
    expect(result.totals.leclerc).toBeNull();
  });

  it("un snapshot source: 'mock' exige toujours une validation, même très récent", () => {
    const mockButRecent = freshPriceSnapshots.map((snapshot) =>
      snapshot.id === 'price-ice-tea-leclerc' ? { ...snapshot, source: 'mock' as const } : snapshot
    );
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: mockProductCandidates,
      priceSnapshots: mockButRecent,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: 7
    });

    expect(result.totals.leclerc).toBeNull();
  });

  it('un snapshot indisponible (available: false) reste exclu des totaux et de la couverture magasin', () => {
    const unavailable = freshPriceSnapshots.map((snapshot) =>
      snapshot.id === 'price-ice-tea-leclerc' ? { ...snapshot, available: false } : snapshot
    );
    const result = compareShoppingList({
      rows: [baseRows[0]],
      candidates: mockProductCandidates,
      priceSnapshots: unavailable,
      savingThresholdEuro: 3,
      autoDecisionMinConfidence: 75,
      maxPriceAgeDays: 7
    });

    expect(result.totals.leclerc).toBeNull();
    expect(result.coverage.leclerc.covered).toBe(0);
  });

  describe('détail exhaustif par magasin (coverage.lines, 2026-08-29)', () => {
    it('une ligne avec un seul candidat "à valider" apparaît en requiresValidation dans les lines, sans compter dans le total', () => {
      // On retire le candidat Hyper U fiable (format, confiance 89 après
      // plafonnement) et on ne garde que le candidat marque distributeur
      // (confiance brute 72, sous le seuil de 75) : plus aucun candidat
      // Hyper U fiable pour cette ligne, mais un candidat "à valider" existe
      // bien et doit rester visible dans le détail.
      const candidatesWithoutReliableHyperu = mockProductCandidates.filter(
        (candidate) => candidate.id !== 'cand-ice-tea-hyperu-format'
      );
      const result = compareShoppingList({
        rows: [baseRows[0]],
        candidates: candidatesWithoutReliableHyperu,
        priceSnapshots: freshPriceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      expect(result.totals.hyperu).toBeNull();
      expect(result.coverage.hyperu.covered).toBe(0);
      expect(result.coverage.hyperu.lines).toEqual([
        {
          itemId: 'item-ice-tea',
          productId: 'prod-ice-tea-peche',
          status: 'requiresValidation',
          price: 1.35,
          candidateId: 'cand-ice-tea-hyperu-mdd'
        }
      ]);
    });

    it('une ligne sans aucun candidat pour ce magasin apparaît en notFound', () => {
      const result = compareShoppingList({
        rows: [baseRows[0]],
        candidates: [mockProductCandidates[0]], // seul le candidat Leclerc existe
        priceSnapshots: [], // et il n'a aucun prix relevé
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      // Correctif du 01/09 : un candidat existe mais n'a jamais été
      // effectivement priced (aucun snapshot) — c'est une PROPOSITION à
      // valider (l'utilisateur peut la confirmer/rejeter via le bouton de
      // validation live), pas une indisponibilité constatée. Avant ce
      // correctif, ce cas s'affichait à tort "Indisponible chez ce magasin"
      // (signalé en conditions réelles : "Boisson soja nature" chez Leclerc).
      expect(result.coverage.leclerc.lines).toEqual([
        {
          itemId: 'item-ice-tea',
          productId: 'prod-ice-tea-peche',
          status: 'requiresValidation',
          candidateId: 'cand-ice-tea-leclerc-exact'
        }
      ]);
      expect(result.coverage.hyperu.lines).toEqual([
        {
          itemId: 'item-ice-tea',
          productId: 'prod-ice-tea-peche',
          status: 'notFound'
        }
      ]);
    });

    it('une ligne avec un candidat dont le magasin confirme la rupture de stock apparaît en unavailable', () => {
      // Différence avec le test précédent : ici une observation a bien été
      // faite (snapshot présent) et le site a explicitement répondu
      // "indisponible" — c'est le seul cas qui doit encore produire
      // 'unavailable'.
      const outOfStockSnapshot = {
        ...freshPriceSnapshots[0],
        id: 'price-ice-tea-leclerc-oos',
        candidateId: 'cand-ice-tea-leclerc-exact',
        available: false
      };
      const result = compareShoppingList({
        rows: [baseRows[0]],
        candidates: [mockProductCandidates[0]],
        priceSnapshots: [outOfStockSnapshot],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      expect(result.coverage.leclerc.lines).toEqual([
        {
          itemId: 'item-ice-tea',
          productId: 'prod-ice-tea-peche',
          status: 'unavailable',
          candidateId: 'cand-ice-tea-leclerc-exact'
        }
      ]);
    });

    it("le détail reste exhaustif (une ligne par produit de la liste) même quand aucun magasin n'a de candidat pour une ligne", () => {
      const rowWithoutAnyCandidate = {
        product: demoProducts[2],
        item: {
          id: 'item-riz',
          shoppingListId: 'list-active',
          productId: 'prod-riz-basmati',
          wantedQuantity: 1,
          createdAt: '2026-07-07T10:00:00.000Z'
        }
      };
      const result = compareShoppingList({
        rows: [baseRows[0], rowWithoutAnyCandidate],
        candidates: mockProductCandidates,
        priceSnapshots: freshPriceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      expect(result.coverage.leclerc.lines).toHaveLength(2);
      expect(result.coverage.hyperu.lines).toHaveLength(2);
      expect(result.coverage.leclerc.lines.find((line) => line.itemId === 'item-riz')?.status).toBe('notFound');
      expect(result.coverage.hyperu.lines.find((line) => line.itemId === 'item-riz')?.status).toBe('notFound');
      // La ligne priced normale (ice-tea chez Leclerc) reste inchangée à côté.
      expect(result.coverage.leclerc.lines.find((line) => line.itemId === 'item-ice-tea')).toEqual({
        itemId: 'item-ice-tea',
        productId: 'prod-ice-tea-peche',
        status: 'priced',
        price: 1.89,
        candidateId: 'cand-ice-tea-leclerc-exact'
      });
    });
  });

  describe('regroupement à prix égal (2026-08-27)', () => {
    // Fixtures autonomes : 3 lignes, chacune avec un candidat Leclerc et un
    // candidat Hyper U valides (récents, disponibles, confiance suffisante).
    // Les prix sont choisis pour que :
    // - "produit non ambigu 1" et "produit non ambigu 2" soient clairement
    //   moins chers chez Hyper U (pas d'ambiguïté, tranchés normalement en
    //   passe 1) ;
    // - "produit ex æquo" ait EXACTEMENT le même total aux deux magasins,
    //   mais une confiance plus élevée chez Leclerc — pour prouver que c'est
    //   bien la majorité du panier (Hyper U, 2-0) qui l'emporte, et non plus
    //   confidenceScore comme avant ce correctif.
    const makeCandidate = (
      id: string,
      productId: string,
      storeKey: 'leclerc' | 'hyperu',
      confidenceScore: number
    ) => ({
      id,
      productId,
      storeKey,
      name: `${productId} chez ${storeKey}`,
      matchType: 'exact_barcode' as const,
      confidenceScore,
      confidenceReasons: ['test'],
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z'
    });

    const makeSnapshot = (id: string, candidateId: string, storeKey: 'leclerc' | 'hyperu', price: number) => ({
      id,
      candidateId,
      storeKey,
      price,
      currency: 'EUR' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    });

    const rowFor = (productId: string, itemId: string) => ({
      product: { id: productId, name: productId, createdAt: '2026-08-27T08:00:00.000Z', updatedAt: '2026-08-27T08:00:00.000Z' },
      item: {
        id: itemId,
        shoppingListId: 'list-active',
        productId,
        wantedQuantity: 1,
        createdAt: '2026-08-27T08:00:00.000Z'
      }
    });

    const candidates = [
      makeCandidate('cand-1-leclerc', 'prod-1', 'leclerc', 90),
      makeCandidate('cand-1-hyperu', 'prod-1', 'hyperu', 90),
      makeCandidate('cand-2-leclerc', 'prod-2', 'leclerc', 90),
      makeCandidate('cand-2-hyperu', 'prod-2', 'hyperu', 90),
      makeCandidate('cand-tie-leclerc', 'prod-tie', 'leclerc', 95),
      makeCandidate('cand-tie-hyperu', 'prod-tie', 'hyperu', 80)
    ];

    const priceSnapshots = [
      makeSnapshot('price-1-leclerc', 'cand-1-leclerc', 'leclerc', 3),
      makeSnapshot('price-1-hyperu', 'cand-1-hyperu', 'hyperu', 2),
      makeSnapshot('price-2-leclerc', 'cand-2-leclerc', 'leclerc', 3),
      makeSnapshot('price-2-hyperu', 'cand-2-hyperu', 'hyperu', 2),
      makeSnapshot('price-tie-leclerc', 'cand-tie-leclerc', 'leclerc', 1.5),
      makeSnapshot('price-tie-hyperu', 'cand-tie-hyperu', 'hyperu', 1.5)
    ];

    it('à prix strictement égal entre les deux magasins, choisit le magasin déjà majoritaire dans le reste du panier plutôt que le confidenceScore', () => {
      const result = compareShoppingList({
        rows: [rowFor('prod-1', 'item-1'), rowFor('prod-2', 'item-2'), rowFor('prod-tie', 'item-tie')],
        candidates,
        priceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const tieDecision = result.decisions.find((decision) => decision.itemId === 'item-tie');
      // Sans ce correctif, cand-tie-leclerc (confiance 95) aurait gagné.
      expect(tieDecision?.selectedStoreKey).toBe('hyperu');
      expect(tieDecision?.selectedCandidateId).toBe('cand-tie-hyperu');
    });

    it("à prix égal sans aucune autre ligne pour départager (compteur 0-0), retombe sur le confidenceScore comme avant le correctif", () => {
      const result = compareShoppingList({
        rows: [rowFor('prod-tie', 'item-tie')],
        candidates,
        priceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      expect(result.decisions[0]?.selectedStoreKey).toBe('leclerc');
      expect(result.decisions[0]?.selectedCandidateId).toBe('cand-tie-leclerc');
    });
  });

  describe('candidats confirmés manuellement (manual_override)', () => {
    // Fixtures dédiées (pas de forcedCandidateId sur les items) : un pick
    // manuel via ManualCorrectionControls persiste juste un candidat
    // matchType 'manual_override', sans jamais forcer l'item — il doit donc
    // entrer dans le tri normal (prix + storeBias) comme n'importe quel
    // candidat automatique fiable.
    const makeManualCandidate = (id: string, productId: string, storeKey: 'leclerc' | 'hyperu') => ({
      id,
      productId,
      storeKey,
      name: `${productId} chez ${storeKey}`,
      matchType: 'manual_override' as const,
      // Score brut délibérément bas : prouve que le tri se base sur le score
      // 100 fixe de scoring.ts, pas sur ce confidenceScore de fixture.
      confidenceScore: 5,
      confidenceReasons: ['confirmé manuellement'],
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z'
    });

    const makeManualSnapshot = (id: string, candidateId: string, storeKey: 'leclerc' | 'hyperu', price: number) => ({
      id,
      candidateId,
      storeKey,
      price,
      currency: 'EUR' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    });

    const manualRowFor = (productId: string, itemId: string) => ({
      product: {
        id: productId,
        name: productId,
        createdAt: '2026-08-27T08:00:00.000Z',
        updatedAt: '2026-08-27T08:00:00.000Z'
      },
      item: {
        id: itemId,
        shoppingListId: 'list-active',
        productId,
        wantedQuantity: 1,
        createdAt: '2026-08-27T08:00:00.000Z'
        // Pas de forcedCandidateId : la confirmation manuelle ne verrouille
        // plus l'item, elle fiabilise juste le candidat (voir scoring.ts).
      }
    });

    it('deux candidats confirmés manuellement à prix strictement égal : le magasin majoritaire du panier l’emporte', () => {
      const candidates = [
        makeManualCandidate('cand-1-leclerc', 'prod-1', 'leclerc'),
        makeManualCandidate('cand-1-hyperu', 'prod-1', 'hyperu'),
        makeManualCandidate('cand-2-leclerc', 'prod-2', 'leclerc'),
        makeManualCandidate('cand-2-hyperu', 'prod-2', 'hyperu'),
        makeManualCandidate('cand-tie-leclerc', 'prod-tie', 'leclerc'),
        makeManualCandidate('cand-tie-hyperu', 'prod-tie', 'hyperu')
      ];
      const priceSnapshots = [
        makeManualSnapshot('price-1-leclerc', 'cand-1-leclerc', 'leclerc', 3),
        makeManualSnapshot('price-1-hyperu', 'cand-1-hyperu', 'hyperu', 2),
        makeManualSnapshot('price-2-leclerc', 'cand-2-leclerc', 'leclerc', 3),
        makeManualSnapshot('price-2-hyperu', 'cand-2-hyperu', 'hyperu', 2),
        makeManualSnapshot('price-tie-leclerc', 'cand-tie-leclerc', 'leclerc', 1.5),
        makeManualSnapshot('price-tie-hyperu', 'cand-tie-hyperu', 'hyperu', 1.5)
      ];

      const result = compareShoppingList({
        rows: [manualRowFor('prod-1', 'item-1'), manualRowFor('prod-2', 'item-2'), manualRowFor('prod-tie', 'item-tie')],
        candidates,
        priceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 90,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const tieDecision = result.decisions.find((decision) => decision.itemId === 'item-tie');
      expect(tieDecision?.requiresValidation).toBe(false);
      expect(tieDecision?.selectedStoreKey).toBe('hyperu');
      expect(tieDecision?.selectedCandidateId).toBe('cand-tie-hyperu');
    });

    it('deux candidats confirmés manuellement à prix différents : le moins cher l’emporte, pas le dernier confirmé', () => {
      const candidates = [
        makeManualCandidate('cand-solo-leclerc', 'prod-solo', 'leclerc'),
        makeManualCandidate('cand-solo-hyperu', 'prod-solo', 'hyperu')
      ];
      const priceSnapshots = [
        makeManualSnapshot('price-solo-leclerc', 'cand-solo-leclerc', 'leclerc', 2.1),
        makeManualSnapshot('price-solo-hyperu', 'cand-solo-hyperu', 'hyperu', 1.8)
      ];

      const result = compareShoppingList({
        rows: [manualRowFor('prod-solo', 'item-solo')],
        candidates,
        priceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 90,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-solo');
      expect(decision?.requiresValidation).toBe(false);
      expect(decision?.selectedStoreKey).toBe('hyperu');
      expect(decision?.selectedCandidateId).toBe('cand-solo-hyperu');
      expect(decision?.price).toBe(1.8);
    });

    it('un candidat confirmé manuellement est retenu face à une proposition automatique moins chère non validée', () => {
      const automaticLeclerc = {
        id: 'cand-beurre-leclerc-auto',
        productId: 'prod-beurre',
        storeKey: 'leclerc' as const,
        name: 'Beurre proposé automatiquement chez Leclerc',
        matchType: 'exact_barcode' as const,
        barcode: '3017620422003',
        confidenceScore: 100,
        confidenceReasons: ['code-barres identique'],
        createdAt: '2026-08-27T08:00:00.000Z',
        updatedAt: '2026-08-27T08:00:00.000Z'
      };
      const manualHyperU = makeManualCandidate('cand-beurre-hyperu-manual', 'prod-beurre', 'hyperu');
      const priceSnapshots = [
        makeManualSnapshot('price-beurre-leclerc', automaticLeclerc.id, 'leclerc', 1.5),
        makeManualSnapshot('price-beurre-hyperu', manualHyperU.id, 'hyperu', 2.2)
      ];

      const result = compareShoppingList({
        rows: [
          {
            ...manualRowFor('prod-beurre', 'item-beurre'),
            product: { ...manualRowFor('prod-beurre', 'item-beurre').product, barcode: '3017620422003' }
          }
        ],
        candidates: [automaticLeclerc, manualHyperU],
        priceSnapshots,
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 90,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-beurre');
      expect(decision?.requiresValidation).toBe(false);
      expect(decision?.selectedStoreKey).toBe('hyperu');
      expect(decision?.selectedCandidateId).toBe('cand-beurre-hyperu-manual');
      expect(decision?.price).toBe(2.2);
    });
  });

  describe('blocage sur quantité > 1 à format non garanti (étape 4 du plan de fiabilisation)', () => {
    // Fixture minimale : un seul candidat disponible pour le produit, à
    // confiance élevée et prix frais — sans le correctif, il serait
    // auto-sélectionné malgré le risque de mauvaise multiplication.
    const quantityRow = {
      product: {
        id: 'prod-lot',
        name: 'prod-lot',
        allowPrivateLabel: true,
        createdAt: '2026-08-27T08:00:00.000Z',
        updatedAt: '2026-08-27T08:00:00.000Z'
      },
      item: {
        id: 'item-lot',
        shoppingListId: 'list-active',
        productId: 'prod-lot',
        wantedQuantity: 3,
        createdAt: '2026-08-27T08:00:00.000Z'
      }
    };

    const quantityCandidate = {
      id: 'cand-lot-leclerc',
      productId: 'prod-lot',
      storeKey: 'leclerc' as const,
      name: 'Lot de 6 chez Leclerc',
      matchType: 'private_label' as const,
      confidenceScore: 95,
      confidenceReasons: ['test'],
      createdAt: '2026-08-27T08:00:00.000Z',
      updatedAt: '2026-08-27T08:00:00.000Z'
    };

    const quantitySnapshot = {
      id: 'price-lot-leclerc',
      candidateId: 'cand-lot-leclerc',
      storeKey: 'leclerc' as const,
      price: 3.5,
      currency: 'EUR' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    };

    it("une ligne wantedQuantity > 1 dont le seul candidat est à format non garanti (private_label) sort des décisions auto-sélectionnées et rejoint productsToValidate avec le warning attendu", () => {
      const result = compareShoppingList({
        rows: [quantityRow],
        candidates: [quantityCandidate],
        priceSnapshots: [quantitySnapshot],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-lot');
      expect(decision?.requiresValidation).toBe(true);
      expect(decision?.warnings).toContain(
        "Quantité 3 demandée mais le format du produit trouvé n'est pas garanti identique — à confirmer avant ajout au panier"
      );
      expect(result.productsToValidate.some((d) => d.itemId === 'item-lot')).toBe(true);
    });

    it('la même ligne à wantedQuantity 1 est auto-sélectionnée normalement (comportement inchangé)', () => {
      const result = compareShoppingList({
        rows: [{ ...quantityRow, item: { ...quantityRow.item, wantedQuantity: 1 } }],
        candidates: [quantityCandidate],
        priceSnapshots: [quantitySnapshot],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-lot');
      expect(decision?.requiresValidation).toBe(false);
      expect(decision?.selectedCandidateId).toBe('cand-lot-leclerc');
    });

    it('une ligne wantedQuantity > 1 dont le candidat est exact_barcode reste auto-sélectionnée (format garanti identique)', () => {
      const result = compareShoppingList({
        rows: [quantityRow],
        candidates: [{ ...quantityCandidate, matchType: 'exact_barcode' as const }],
        priceSnapshots: [quantitySnapshot],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-lot');
      expect(decision?.requiresValidation).toBe(false);
      expect(decision?.selectedCandidateId).toBe('cand-lot-leclerc');
    });
  });

  // Cas réel signalé par l'utilisateur (31/08) : "Purée Mousline" ressortait
  // à 375g chez Leclerc et 1040g chez Hyper U — deux candidats fiables,
  // chacun bien assorti au produit demandé, mais jamais comparés entre eux.
  describe('divergence de format entre magasins (31/08)', () => {
    const makeFormatCandidate = (
      id: string,
      storeKey: 'leclerc' | 'hyperu',
      quantity: number | undefined,
      unit: 'g' | 'kg' | 'ml' | 'L' | undefined
    ) => ({
      id,
      productId: 'prod-puree',
      storeKey,
      name: `Purée chez ${storeKey}`,
      quantity,
      unit,
      matchType: 'manual_override' as const,
      confidenceScore: 100,
      confidenceReasons: ['confirmé manuellement'],
      createdAt: '2026-08-31T08:00:00.000Z',
      updatedAt: '2026-08-31T08:00:00.000Z'
    });

    const makeFormatSnapshot = (id: string, candidateId: string, storeKey: 'leclerc' | 'hyperu', price: number) => ({
      id,
      candidateId,
      storeKey,
      price,
      currency: 'EUR' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    });

    const formatRow = {
      product: {
        id: 'prod-puree',
        name: 'Purée Mousline',
        createdAt: '2026-08-31T08:00:00.000Z',
        updatedAt: '2026-08-31T08:00:00.000Z'
      },
      item: {
        id: 'item-puree',
        shoppingListId: 'list-active',
        productId: 'prod-puree',
        wantedQuantity: 1,
        createdAt: '2026-08-31T08:00:00.000Z'
      }
    };

    it('avertit quand les deux magasins retiennent des formats différents', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1040, 'g')
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 1.5),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 2.9)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      // Aucune fiche n'affichait de prix au kilo ici : il est recalculé à
      // partir du prix et du format (1,50 € / 0,375 kg = 4,00 €/kg contre
      // 2,90 € / 1,04 kg = 2,79 €/kg).
      expect(decision?.warnings).toContain(
        "Le paquet trouvé n'est pas le même format dans les deux magasins : 375 g chez Leclerc contre 1040 g chez Hyper U. " +
          'Le prix comparé est donc le prix au kilo, pas le prix du paquet — ' +
          '4.00 €/kg chez Leclerc, 2.79 €/kg chez Hyper U. ' +
          "À vérifier : ce n'est un comparatif juste que si c'est vraiment le même produit, juste en quantité différente."
      );
      // C'est le prix au kilo qui désigne le gagnant, pas le prix du paquet
      // (1,50 € aurait gagné avant ce changement).
      expect(decision?.selectedCandidateId).toBe('cand-puree-hyperu');
      // Le signalement n'empêche jamais la sélection auto (portée validée :
      // avertir, jamais bloquer).
      expect(decision?.requiresValidation).toBe(false);
    });

    // Arbitrage au prix au kilo/litre, demandé le 31/08 : quand c'est le même
    // produit mais pas la même quantité, comparer les prix affichés n'a pas de
    // sens — seul le prix au kilo/litre donne une base commune.
    it('choisit le magasin au meilleur prix au kilo, pas le paquet le moins cher', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1040, 'g')
        ],
        priceSnapshots: [
          // Cas réel : 2,56 € les 375 g (6,83 €/kg) contre 4,56 € les 1 040 g
          // (4,39 €/kg). Avant ce changement, Leclerc gagnait avec 2,56 €.
          { ...makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56) },
          {
            ...makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56),
            unitPrice: 4.39,
            comparisonUnit: 'kilogram' as const
          }
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('hyperu');
      // Le prix retenu reste celui réellement payé pour le paquet.
      expect(decision?.price).toBe(4.56);
      expect(decision?.reason).toContain('départagé sur le prix au kilo');
    });

    // Retour explicite du 04/09 : "Voir le calcul de cette ligne" ne montrait
    // que le magasin retenu, impossible d'y vérifier soi-même le choix.
    it('expose le prix (et le prix au kilo) des DEUX magasins pour la vérification manuelle', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1040, 'g')
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 1.5),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 2.9)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.priceComparisonByStore.leclerc).toEqual({
        productName: 'Purée chez leclerc',
        packagePrice: 1.5,
        unitPriceLabel: '4.00 €/kg'
      });
      expect(decision?.priceComparisonByStore.hyperu).toEqual({
        productName: 'Purée chez hyperu',
        packagePrice: 2.9,
        unitPriceLabel: '2.79 €/kg'
      });
    });

    it('utilise les prix au kilo affichés même si le format candidat manque en base', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', undefined, undefined),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', undefined, undefined)
        ],
        priceSnapshots: [
          {
            ...makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 3.17),
            unitPrice: 6.34,
            comparisonUnit: 'kilogram' as const
          },
          {
            ...makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56),
            unitPrice: 4.39,
            comparisonUnit: 'kilogram' as const
          }
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('hyperu');
      expect(decision?.price).toBe(4.56);
      expect(decision?.reason).toContain('départagé sur le prix au kilo');
    });

    it('combine un prix au kilo calculé sur un format connu et un prix affiché sans format candidat', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', undefined, undefined)
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56),
          {
            ...makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56),
            unitPrice: 4.39,
            comparisonUnit: 'kilogram' as const
          }
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('hyperu');
      expect(decision?.price).toBe(4.56);
      expect(decision?.reason).toContain('départagé sur le prix au kilo');
    });

    it('n’arbitre pas au kilo avec un prix unitaire signalé incohérent', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', undefined, undefined)
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56),
          {
            ...makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56),
            unitPrice: 4.39,
            comparisonUnit: 'kilogram' as const,
            priceCoherence: 'mismatch' as const
          }
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('leclerc');
      expect(decision?.reason).not.toContain('départagé sur le prix au kilo');
      expect(decision?.warnings).toContain('Prix incohérent avec le prix au litre/kilo affiché — à vérifier.');
    });

    it('explique les deux prix unitaires utilisés pour l’arbitrage', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', undefined, undefined)
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56),
          {
            ...makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56),
            unitPrice: 4.39,
            comparisonUnit: 'kilogram' as const
          }
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.reason).toContain('6.83 €/kg chez Leclerc');
      expect(decision?.reason).toContain('4.39 €/kg chez Hyper U');
    });

    it('garde la règle du prix le plus bas quand l’écart au kilo tient à l’arrondi', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 500, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1000, 'g')
        ],
        priceSnapshots: [
          // 4,00 €/kg contre 4,02 €/kg : 0,5 % d'écart, sous le seuil.
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.02)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('leclerc');
    });

    it('n’arbitre pas un poids contre un volume', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1000, 'ml')
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('leclerc');
    });

    it('n’arbitre pas quand un des deux formats est inconnu', () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', undefined, undefined)
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('leclerc');
    });

    it('laisse le magasin forcé par l’utilisateur primer sur l’arbitrage', () => {
      const result = compareShoppingList({
        rows: [{ ...formatRow, item: { ...formatRow.item, forcedStoreKey: 'leclerc' as const } }],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1040, 'g')
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.56),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 4.56)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.selectedStoreKey).toBe('leclerc');
    });

    it("n'avertit pas quand les formats sont équivalents (dans la tolérance de 5%)", () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 1000, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', 1030, 'g')
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 2.8),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 2.9)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.warnings.some((w) => w.startsWith('Formats différents'))).toBe(false);
    });

    it("n'avertit pas quand le format est inconnu d'un des deux côtés (pas de faux positif)", () => {
      const result = compareShoppingList({
        rows: [formatRow],
        candidates: [
          makeFormatCandidate('cand-puree-leclerc', 'leclerc', 375, 'g'),
          makeFormatCandidate('cand-puree-hyperu', 'hyperu', undefined, undefined)
        ],
        priceSnapshots: [
          makeFormatSnapshot('price-puree-leclerc', 'cand-puree-leclerc', 'leclerc', 1.5),
          makeFormatSnapshot('price-puree-hyperu', 'cand-puree-hyperu', 'hyperu', 2.9)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-puree');
      expect(decision?.warnings.some((w) => w.startsWith('Formats différents'))).toBe(false);
    });
  });

  // Retour utilisateur réel (01/09) : deux conditionnements de riz basmati
  // de la même marque dans le panier, dont l'un n'a pas été trouvé sous son
  // propre format chez Leclerc — la recherche est retombée sur le même
  // candidat que l'autre riz, produisant deux lignes qui commanderaient en
  // réalité le même produit physique.
  describe("doublon inter-lignes : deux produits résolus vers le même article magasin (01/09)", () => {
    const makeRizCandidate = (
      id: string,
      productId: string,
      storeKey: 'leclerc' | 'hyperu',
      storeProductId: string,
      confidenceScore = 90
    ) => ({
      id,
      productId,
      storeKey,
      storeProductId,
      name: 'Riz basmati Lustucru 10min - 5x180g',
      matchType: 'name_only' as const,
      confidenceScore,
      confidenceReasons: ['nom trouvé'],
      createdAt: '2026-09-01T08:00:00.000Z',
      updatedAt: '2026-09-01T08:00:00.000Z'
    });

    const makeRizSnapshot = (id: string, candidateId: string, storeKey: 'leclerc' | 'hyperu', price: number) => ({
      id,
      candidateId,
      storeKey,
      price,
      currency: 'EUR' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const
    });

    const makeRizRow = (productId: string, itemId: string, name: string) => ({
      product: {
        id: productId,
        name,
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-09-01T08:00:00.000Z'
      },
      item: {
        id: itemId,
        shoppingListId: 'list-active',
        productId,
        wantedQuantity: 1,
        createdAt: '2026-09-01T08:00:00.000Z'
      }
    });

    it('écarte du choix automatique la ligne perdante chez le magasin en doublon, et bascule sur l’autre magasin', () => {
      const result = compareShoppingList({
        rows: [
          makeRizRow('prod-riz-1', 'item-riz-1', 'Riz basmati'),
          makeRizRow('prod-riz-2', 'item-riz-2', 'Riz basmati en sachet 5x 2 personnes')
        ],
        candidates: [
          // Les deux lignes tombent sur la MÊME fiche Leclerc (240482) : la
          // recherche n'a pas su distinguer les deux formats demandés.
          // riz-1 est le vrai match (confiance 100, cf. matchScore 1 réel) ;
          // riz-2 n'est qu'un repli de recherche moins fiable (confiance 90,
          // cf. matchScore 0.9 réel) — c'est lui qui doit être écarté.
          makeRizCandidate('cand-riz-1-leclerc', 'prod-riz-1', 'leclerc', '240482', 100),
          makeRizCandidate('cand-riz-2-leclerc', 'prod-riz-2', 'leclerc', '240482', 90),
          // Hyper U, lui, retrouve bien deux produits distincts.
          makeRizCandidate('cand-riz-1-hyperu', 'prod-riz-1', 'hyperu', 'hu-450g'),
          makeRizCandidate('cand-riz-2-hyperu', 'prod-riz-2', 'hyperu', 'hu-900g')
        ],
        priceSnapshots: [
          makeRizSnapshot('price-riz-1-leclerc', 'cand-riz-1-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-2-leclerc', 'cand-riz-2-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-1-hyperu', 'cand-riz-1-hyperu', 'hyperu', 3.5),
          makeRizSnapshot('price-riz-2-hyperu', 'cand-riz-2-hyperu', 'hyperu', 3.69)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision1 = result.decisions.find((d) => d.itemId === 'item-riz-1');
      const decision2 = result.decisions.find((d) => d.itemId === 'item-riz-2');
      // riz-1 garde légitimement Leclerc (meilleure confiance sur ce produit).
      expect(decision1?.selectedStoreKey).toBe('leclerc');
      expect(decision1?.warnings).toEqual([]);
      // riz-2 ne doit plus jamais atterrir sur le même article Leclerc :
      // basculé sur Hyper U, avec un message expliquant pourquoi.
      expect(decision2?.selectedStoreKey).toBe('hyperu');
      expect(decision2?.selectedCandidateId).toBe('cand-riz-2-hyperu');
      expect(
        decision2?.warnings.some(
          (w) => w.includes("Leclerc n'a pas de fiche propre pour ce conditionnement") && w.includes('Riz basmati')
        )
      ).toBe(true);
    });

    // Cas réel confirmé le 01/09 par inspection directe de l'IndexedDB du
    // téléphone : le candidat validé manuellement (bouton "✓ Valider ce
    // produit") n'a pas de storeProductId et une URL légèrement différente
    // (slug tronqué + `?sProvenance=SM`) de celle trouvée par la recherche
    // auto pour le MÊME produit Leclerc — la comparaison doit quand même
    // détecter le doublon via l'identifiant numérique commun dans l'URL.
    it('détecte le doublon même quand storeProductId manque et que les URLs diffèrent légèrement (validation manuelle)', () => {
      const result = compareShoppingList({
        rows: [
          makeRizRow('prod-riz-1', 'item-riz-1', 'Riz basmati'),
          makeRizRow('prod-riz-2', 'item-riz-2', 'Riz basmati en sachet 5x 2 personnes')
        ],
        candidates: [
          {
            ...makeRizCandidate('cand-riz-1-leclerc', 'prod-riz-1', 'leclerc', '240482', 100),
            productUrl:
              'https://fd7-courses.leclercdrive.fr/magasin-123456-123456/fiche-produits-240482-Riz-basmati-Lustucru-10min-5x180g.aspx'
          },
          {
            // Candidat issu d'une validation manuelle : pas de storeProductId,
            // URL au slug tronqué + paramètre de provenance en plus.
            id: 'cand-riz-2-leclerc',
            productId: 'prod-riz-2',
            storeKey: 'leclerc' as const,
            name: 'Riz basmati Lustucru 10min - 5x180g',
            matchType: 'manual_override' as const,
            confidenceScore: 100,
            confidenceReasons: ['validé manuellement'],
            productUrl:
              'https://fd7-courses.leclercdrive.fr/magasin-123456-123456-belleville---le-parc/fiche-produits-240482-Riz-basmati-Lustucru.aspx?sProvenance=SM',
            createdAt: '2026-09-01T08:00:00.000Z',
            updatedAt: '2026-09-01T08:00:00.000Z'
          },
          makeRizCandidate('cand-riz-1-hyperu', 'prod-riz-1', 'hyperu', 'hu-450g'),
          makeRizCandidate('cand-riz-2-hyperu', 'prod-riz-2', 'hyperu', 'hu-900g')
        ],
        priceSnapshots: [
          makeRizSnapshot('price-riz-1-leclerc', 'cand-riz-1-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-2-leclerc', 'cand-riz-2-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-1-hyperu', 'cand-riz-1-hyperu', 'hyperu', 3.5),
          makeRizSnapshot('price-riz-2-hyperu', 'cand-riz-2-hyperu', 'hyperu', 3.69)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      // Prix identiques et confiance identique (100/100) entre les deux
      // candidats Leclerc en conflit : le départage par confiance ne suffit
      // pas à lui seul, mais peu importe lequel des deux gagne — le point
      // vérifié ici est qu'AU MOINS un des deux perd Leclerc, empêchant le
      // doublon.
      const decision1 = result.decisions.find((d) => d.itemId === 'item-riz-1');
      const decision2 = result.decisions.find((d) => d.itemId === 'item-riz-2');
      const bothLeclerc = decision1?.selectedStoreKey === 'leclerc' && decision2?.selectedStoreKey === 'leclerc';
      expect(bothLeclerc).toBe(false);
    });

    // Cas réel confirmé le 01/09 sur le téléphone de l'utilisateur, PLUS grave
    // que le test précédent : les deux candidats Leclerc en conflit ont la
    // MÊME confiance (100/100), donc le simple départage par confiance retient
    // arbitrairement l'un OU l'autre — ici il retenait à tort le riz "5x90g"
    // (dont le format Leclerc réel est en fait 900 g, pas 90 g). Avec le
    // format connu côté Hyper U pour chaque ligne (450 g / 900 g), on peut
    // vérifier lequel des deux candidats Leclerc ment sur son format et
    // l'écarter — peu importe sa confiance affichée.
    it('départage par cohérence de format entre magasins quand la confiance est identique des deux côtés', () => {
      const result = compareShoppingList({
        rows: [
          makeRizRow('prod-riz-1', 'item-riz-1', 'Riz basmati'),
          makeRizRow('prod-riz-2', 'item-riz-2', 'Riz basmati en sachet 5x 2 personnes')
        ],
        candidates: [
          // Les deux candidats Leclerc pointent vers la même fiche (900 g),
          // avec la même confiance (100) : rien ne les distingue sans le
          // format. Le candidat de riz-1 (qui devrait être 450 g) ment sur
          // son propre format.
          { ...makeRizCandidate('cand-riz-1-leclerc', 'prod-riz-1', 'leclerc', '240482', 100), quantity: 900, unit: 'g' as const },
          { ...makeRizCandidate('cand-riz-2-leclerc', 'prod-riz-2', 'leclerc', '240482', 100), quantity: 900, unit: 'g' as const },
          // Hyper U confirme le vrai format de chaque ligne, via code-barres.
          { ...makeRizCandidate('cand-riz-1-hyperu', 'prod-riz-1', 'hyperu', 'hu-450g', 100), quantity: 450, unit: 'g' as const },
          { ...makeRizCandidate('cand-riz-2-hyperu', 'prod-riz-2', 'hyperu', 'hu-900g', 100), quantity: 900, unit: 'g' as const }
        ],
        priceSnapshots: [
          makeRizSnapshot('price-riz-1-leclerc', 'cand-riz-1-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-2-leclerc', 'cand-riz-2-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-1-hyperu', 'cand-riz-1-hyperu', 'hyperu', 2.23),
          makeRizSnapshot('price-riz-2-hyperu', 'cand-riz-2-hyperu', 'hyperu', 3.32)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision1 = result.decisions.find((d) => d.itemId === 'item-riz-1');
      const decision2 = result.decisions.find((d) => d.itemId === 'item-riz-2');
      // riz-1 (format réel 450g) ne doit jamais garder le candidat Leclerc à
      // 900g : son format contredit celui confirmé chez Hyper U.
      expect(decision1?.selectedStoreKey).toBe('hyperu');
      // riz-2 (format réel 900g) garde légitimement Leclerc : son format
      // colle à celui confirmé chez Hyper U.
      expect(decision2?.selectedStoreKey).toBe('leclerc');
    });

    it("n'exclut rien quand les deux lignes retiennent des identifiants produit distincts", () => {
      const result = compareShoppingList({
        rows: [
          makeRizRow('prod-riz-1', 'item-riz-1', 'Riz basmati'),
          makeRizRow('prod-riz-2', 'item-riz-2', 'Riz basmati en sachet 5x 2 personnes')
        ],
        candidates: [
          makeRizCandidate('cand-riz-1-leclerc', 'prod-riz-1', 'leclerc', '240482'),
          makeRizCandidate('cand-riz-2-leclerc', 'prod-riz-2', 'leclerc', '999999'),
          makeRizCandidate('cand-riz-1-hyperu', 'prod-riz-1', 'hyperu', 'hu-450g'),
          makeRizCandidate('cand-riz-2-hyperu', 'prod-riz-2', 'hyperu', 'hu-900g')
        ],
        priceSnapshots: [
          makeRizSnapshot('price-riz-1-leclerc', 'cand-riz-1-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-2-leclerc', 'cand-riz-2-leclerc', 'leclerc', 3.28),
          makeRizSnapshot('price-riz-1-hyperu', 'cand-riz-1-hyperu', 'hyperu', 2.23),
          makeRizSnapshot('price-riz-2-hyperu', 'cand-riz-2-hyperu', 'hyperu', 3.32)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision1 = result.decisions.find((d) => d.itemId === 'item-riz-1');
      const decision2 = result.decisions.find((d) => d.itemId === 'item-riz-2');
      expect(decision1?.warnings.some((w) => w.includes('Aucun résultat propre trouvé'))).toBe(false);
      expect(decision2?.warnings.some((w) => w.includes('Aucun résultat propre trouvé'))).toBe(false);
    });
  });

  // Audit du 02/09 (F-01/F-02) : les deux alertes « prix incohérent » et
  // « format à confirmer » bloquaient la validation du panier ENTIER sans
  // aucune issue — « Actualiser » relisait la même fiche et retrouvait le
  // même écart. Elles ne bloquent plus que si elles concernent le magasin
  // réellement retenu, et l'utilisateur peut les lever après vérification.
  describe('alertes bloquantes levables (audit 02/09)', () => {
    const makeCoherenceCandidate = (id: string, storeKey: 'leclerc' | 'hyperu') => ({
      id,
      productId: 'prod-coherence',
      storeKey,
      name: `Beurre demi-sel chez ${storeKey}`,
      quantity: 250,
      unit: 'g' as const,
      matchType: 'exact_barcode' as const,
      confidenceScore: 100,
      confidenceReasons: ['code-barres identique'],
      createdAt: '2026-09-02T08:00:00.000Z',
      updatedAt: '2026-09-02T08:00:00.000Z'
    });

    const makeCoherenceSnapshot = (
      id: string,
      candidateId: string,
      storeKey: 'leclerc' | 'hyperu',
      price: number,
      priceCoherence?: 'ok' | 'mismatch'
    ) => ({
      id,
      candidateId,
      storeKey,
      price,
      currency: 'EUR' as const,
      available: true,
      checkedAt: new Date().toISOString(),
      source: 'adapter' as const,
      ...(priceCoherence ? { priceCoherence } : {})
    });

    const coherenceRow = {
      product: {
        id: 'prod-coherence',
        name: 'Beurre demi-sel',
        createdAt: '2026-09-02T08:00:00.000Z',
        updatedAt: '2026-09-02T08:00:00.000Z'
      },
      item: {
        id: 'item-coherence',
        shoppingListId: 'list-active',
        productId: 'prod-coherence',
        wantedQuantity: 1,
        createdAt: '2026-09-02T08:00:00.000Z'
      }
    };

    const candidates = [
      makeCoherenceCandidate('cand-coherence-leclerc', 'leclerc'),
      makeCoherenceCandidate('cand-coherence-hyperu', 'hyperu')
    ];

    it('ne bloque pas le panier quand le prix incohérent vient du magasin NON retenu', () => {
      const result = compareShoppingList({
        rows: [coherenceRow],
        candidates,
        priceSnapshots: [
          makeCoherenceSnapshot('price-coherence-leclerc', 'cand-coherence-leclerc', 'leclerc', 2),
          // Le magasin le plus cher, donc jamais retenu — son incohérence ne
          // doit pas condamner la ligne.
          makeCoherenceSnapshot('price-coherence-hyperu', 'cand-coherence-hyperu', 'hyperu', 3, 'mismatch')
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-coherence');
      expect(decision?.selectedStoreKey).toBe('leclerc');
      // L'information reste affichée...
      expect(decision?.warnings).toContain('Prix incohérent avec le prix au litre/kilo affiché — à vérifier.');
      // ...mais elle n'immobilise plus la validation.
      expect(decision?.signals.some((signal) => signal.code === 'PRICE_MISMATCH')).toBe(false);
      expect(result.trustReport.canValidateBasket).toBe(true);
    });

    it('bloque tant que le prix incohérent porte sur le magasin retenu', () => {
      const result = compareShoppingList({
        rows: [coherenceRow],
        candidates,
        priceSnapshots: [
          makeCoherenceSnapshot('price-coherence-leclerc', 'cand-coherence-leclerc', 'leclerc', 2, 'mismatch'),
          makeCoherenceSnapshot('price-coherence-hyperu', 'cand-coherence-hyperu', 'hyperu', 3)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-coherence');
      expect(decision?.selectedStoreKey).toBe('leclerc');
      expect(
        decision?.signals.find((signal) => signal.code === 'PRICE_MISMATCH')?.severity
      ).toBe('blocking');
      expect(result.trustReport.canValidateBasket).toBe(false);
    });

    it('rétrograde l’alerte en avertissement une fois la ligne vérifiée par l’utilisateur', () => {
      const result = compareShoppingList({
        rows: [
          {
            ...coherenceRow,
            item: { ...coherenceRow.item, checkedDespiteWarningsAt: '2026-09-02T09:00:00.000Z' }
          }
        ],
        candidates,
        priceSnapshots: [
          makeCoherenceSnapshot('price-coherence-leclerc', 'cand-coherence-leclerc', 'leclerc', 2, 'mismatch'),
          makeCoherenceSnapshot('price-coherence-hyperu', 'cand-coherence-hyperu', 'hyperu', 3)
        ],
        savingThresholdEuro: 3,
        autoDecisionMinConfidence: 75,
        maxPriceAgeDays: DEFAULT_MAX_PRICE_AGE_DAYS
      });

      const decision = result.decisions.find((d) => d.itemId === 'item-coherence');
      // L'alerte reste visible : on informe toujours, on ne bloque plus.
      expect(decision?.warnings).toContain('Prix incohérent avec le prix au litre/kilo affiché — à vérifier.');
      expect(
        decision?.signals.find((signal) => signal.code === 'PRICE_MISMATCH')?.severity
      ).toBe('warning');
      expect(result.trustReport.canValidateBasket).toBe(true);
    });
  });
});
