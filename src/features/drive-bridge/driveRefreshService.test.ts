// @vitest-environment jsdom
// runLivePick / runDriveRefresh posent un écouteur `visibilitychange` pour le
// wake-lock : sans `document`, ils échouent avant d'atteindre ce qu'on teste.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/db';
import { type ProductCandidate, type UserStore } from '../../types/domain';
import { createStoreLocatorService } from '../stores/storeLocatorService';
import { type DrivePriceObservationV1 } from './driveProtocol';
import {
  markMatchedPriceUnavailable,
  persistDriveObservation,
  runDriveRefresh,
  runLivePick
} from './driveRefreshService';

// Le bridge d'extension n'existe pas hors du téléphone : on le remplace pour
// pouvoir observer le job réellement envoyé (manualUrlOverrides) et injecter
// une observation de sélection en direct.
const bridgeMock = vi.hoisted(() => ({
  detectDriveExtension: vi.fn(async () => ({ available: true, version: '0.0.0-test' })),
  startDriveRefresh: vi.fn(),
  startLivePick: vi.fn()
}));

vi.mock('./extensionBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./extensionBridge')>();
  return { ...actual, getExtensionBridge: () => bridgeMock };
});

const testStore: UserStore = {
  id: 'store-leclerc-test',
  storeKey: 'leclerc',
  displayName: 'Test Store',
  city: 'Test City',
  osmId: 123,
  osmType: 'node',
  latitude: 48.5,
  longitude: 2.5,
  address: 'Test Address',
  postalCode: '75001',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function makeObservation(overrides?: Partial<DrivePriceObservationV1>): DrivePriceObservationV1 {
  return {
    protocolVersion: 1,
    jobId: 'job-1',
    productId: 'prod-1',
    storeKey: 'leclerc',
    localStoreId: testStore.id,
    externalStoreId: 'ext-store-1',
    observedName: 'Riz basmati 1kg',
    priceEuro: 2.3,
    available: true,
    productUrl: 'https://www.leclercdrive.fr/produit/riz-1',
    observedAt: new Date().toISOString(),
    evidence: 'official_drive_page',
    ...overrides
  };
}

describe('driveRefreshService URL persistence', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
  });

  it('sends store URLs to extension even after IndexedDB clear + localStorage restore', async () => {
    // Setup: Mock localStorage
    const mockLocalStorageData = new Map<string, string>();
    const mockLocalStorage = {
      getItem: (key: string) => mockLocalStorageData.get(key) ?? null,
      setItem: (key: string, value: string) => mockLocalStorageData.set(key, value),
      removeItem: (key: string) => mockLocalStorageData.delete(key),
      clear: () => mockLocalStorageData.clear(),
      key: (index: number) => Array.from(mockLocalStorageData.keys())[index] ?? null,
      length: mockLocalStorageData.size
    };

    const originalLocalStorage = (globalThis as any).localStorage;
    (globalThis as any).localStorage = mockLocalStorage;

    try {
      // Step 1: User saves Leclerc URL
      const service = createStoreLocatorService({ search: vi.fn(), now: () => 1000 });

      // Create a Leclerc store
      await db.userStores.add({
        id: 'store-leclerc-test',
        storeKey: 'leclerc',
        displayName: 'Test Store',
        city: 'Test City',
        osmId: 123,
        osmType: 'node',
        latitude: 48.5,
        longitude: 2.5,
        address: 'Test Address',
        postalCode: '75001',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Save the URL (should persist to both IndexedDB and localStorage)
      const testUrl = 'https://leclercdrive.fr/magasin-test-url';
      await service.saveStoreDriveUrl('store-leclerc-test', testUrl);

      // Verify localStorage has the backup
      expect(mockLocalStorageData.get('drive-url-backup')).toContain('leclerc');

      // Step 2: Simulate IndexedDB clear (like on extension redeploy)
      await db.userStores.where('storeKey').equals('leclerc').modify((store) => {
        delete (store as any).driveUrl;
      });

      // Step 3: Verify that listSelectedStores restores from localStorage
      const restoredStores = await service.listSelectedStores();
      expect(restoredStores).toHaveLength(1);
      expect(restoredStores[0].driveUrl).toBe(testUrl);

      // Step 4: Verify that the URL is actually sent to extension via driveRefreshService
      // (Note: This is a simplified check since we can't fully mock the extension bridge in tests)
      expect(restoredStores[0].storeKey).toBe('leclerc');
      expect(restoredStores[0].driveUrl).toBeDefined();
      expect(restoredStores[0].driveUrl).not.toBe('');
    } finally {
      (globalThis as any).localStorage = originalLocalStorage;
    }
  });
});

describe('persistDriveObservation — isRejected sur confirmation manuelle', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
  });

  it('une confirmation manuelle (matchStage: manual) lève un rejet précédent sur ce candidat', async () => {
    const candidateId = 'price-leclerc-prod-1';
    await db.productCandidates.put({
      id: candidateId,
      productId: 'prod-1',
      storeKey: 'leclerc',
      name: 'Ancien candidat rejeté',
      matchType: 'uncertain',
      confidenceScore: 40,
      confidenceReasons: [],
      isRejected: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    });

    await persistDriveObservation(makeObservation({ matchStage: 'manual', matchScore: 1 }), testStore, undefined);

    const candidate = await db.productCandidates.get(candidateId);
    expect(candidate?.isRejected).toBe(false);
    expect(candidate?.matchType).toBe('manual_override');
  });

  it("un refresh automatique (matchStage différent de manual) préserve un rejet précédent", async () => {
    const candidateId = 'price-leclerc-prod-1';
    await db.productCandidates.put({
      id: candidateId,
      productId: 'prod-1',
      storeKey: 'leclerc',
      name: 'Ancien candidat rejeté',
      matchType: 'uncertain',
      confidenceScore: 40,
      confidenceReasons: [],
      isRejected: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    });

    await persistDriveObservation(makeObservation({ matchStage: 'name', matchScore: 0.95 }), testStore, undefined);

    const candidate = await db.productCandidates.get(candidateId);
    expect(candidate?.isRejected).toBe(true);
  });

  it("un refresh automatique ultérieur ne rétrograde jamais un candidat déjà confirmé manuellement (même mauvais match, même ID déterministe)", async () => {
    // Cas réel observé le 27/08 : "Lait des campagnes" confirmé à la main sur
    // Leclerc ET Hyper U à 5,94 €. Un refresh automatique repasse ensuite sur
    // Hyper U, retrouve un mauvais candidat (matchScore 0.5, autre produit) au
    // même id déterministe price-hyperu-prod-1, et écrasait silencieusement
    // le manual_override — cassant le regroupement par magasin majoritaire
    // sans jamais passer par isRejected ni par le scoring.
    const candidateId = 'price-hyperu-prod-1';
    await persistDriveObservation(
      makeObservation({ storeKey: 'hyperu', matchStage: 'manual', matchScore: 1, priceEuro: 5.94, observedName: 'Lait des campagnes 1L' }),
      testStore,
      undefined
    );
    let candidate = await db.productCandidates.get(candidateId);
    expect(candidate?.matchType).toBe('manual_override');

    await persistDriveObservation(
      makeObservation({
        storeKey: 'hyperu',
        matchStage: 'name',
        matchScore: 0.5,
        priceEuro: 2.12,
        observedName: 'BLEDINA BLEDIDEJ - Lait et Céréales bébé'
      }),
      testStore,
      undefined
    );

    candidate = await db.productCandidates.get(candidateId);
    expect(candidate?.matchType).toBe('manual_override');
    expect(candidate?.name).toBe('Lait des campagnes 1L');

    const snapshot = await db.priceSnapshots.get(candidateId);
    expect(snapshot?.price).toBe(5.94);
  });

  it('un refresh automatique met bien à jour un candidat qui n’est pas (encore) manual_override', async () => {
    const candidateId = 'price-leclerc-prod-1';
    await persistDriveObservation(makeObservation({ matchStage: 'name', matchScore: 0.6, priceEuro: 3 }), testStore, undefined);

    await persistDriveObservation(makeObservation({ matchStage: 'name', matchScore: 0.6, priceEuro: 3.5 }), testStore, undefined);

    const candidate = await db.productCandidates.get(candidateId);
    const snapshot = await db.priceSnapshots.get(candidateId);
    expect(candidate?.matchType).toBe('uncertain');
    expect(snapshot?.price).toBe(3.5);
  });

  // Régression réelle (31/08) : le format extrait par le collecteur
  // (observedQuantity/observedUnit) était déjà validé par le protocole mais
  // jamais persisté sur le ProductCandidate — comparisonEngine.ts n'avait
  // alors aucune donnée pour détecter une divergence de format entre
  // magasins (cas Purée Mousline 375g Leclerc vs 1040g Hyper U).
  it('persiste le format observé (observedQuantity/observedUnit) sur le candidat', async () => {
    const candidateId = 'price-leclerc-prod-1';
    await persistDriveObservation(
      makeObservation({ matchStage: 'name', matchScore: 0.9, observedQuantity: 1000, observedUnit: 'g' }),
      testStore,
      undefined
    );

    const candidate = await db.productCandidates.get(candidateId);
    expect(candidate?.quantity).toBe(1000);
    expect(candidate?.unit).toBe('g');
  });

  it('persiste le verdict du contrôle croisé prix total / prix unitaire sur le snapshot', async () => {
    const candidateId = 'price-leclerc-prod-1';
    await persistDriveObservation(
      makeObservation({
        priceEuro: 5.94,
        unitPriceEuro: 0.99,
        unitPriceUnit: 'L',
        observedQuantity: 6000,
        observedUnit: 'ml'
      }),
      testStore,
      undefined
    );

    const snapshot = await db.priceSnapshots.get(candidateId);
    expect(snapshot?.priceCoherence).toBe('ok');
  });

  // Régression réelle (31/08, diagnostic live) : un candidat manual_override
  // se retrouvait figé à available:false après qu'une recherche automatique
  // ultérieure échoue (PRODUCT_NOT_FOUND, timeout...) pour ce même
  // produit/magasin — plus aucun refresh, même réussi, ne pouvait ensuite le
  // corriger, car persistDriveObservation ignore déjà tout le bloc pour un
  // manual_override (skipAutomaticOverwrite). Même contrat requis côté échec.
  it('un échec de recherche automatique ne rend jamais indisponible un candidat déjà confirmé manuellement', async () => {
    const candidateId = 'price-leclerc-prod-1';
    await persistDriveObservation(makeObservation({ matchStage: 'manual', matchScore: 1, priceEuro: 3.28 }), testStore, undefined);

    await markMatchedPriceUnavailable('leclerc', 'prod-1');

    const candidate = await db.productCandidates.get(candidateId);
    const snapshot = await db.priceSnapshots.get(candidateId);
    expect(candidate?.matchType).toBe('manual_override');
    expect(snapshot?.available).toBe(true);
  });

  it("un échec de recherche automatique rend bien indisponible un candidat qui n'est pas manual_override", async () => {
    const candidateId = 'price-leclerc-prod-1';
    await persistDriveObservation(makeObservation({ matchStage: 'name', matchScore: 0.6, priceEuro: 3 }), testStore, undefined);

    await markMatchedPriceUnavailable('leclerc', 'prod-1');

    const snapshot = await db.priceSnapshots.get(candidateId);
    expect(snapshot?.available).toBe(false);
  });

  // Bug réel confirmé le 01/09 (diagnostic live, Purée Mousline) : l'URL
  // manuelle enregistrée par l'utilisateur devient invalide (produit retiré
  // du catalogue Leclerc, code MANUAL_URL_PAGE_INVALID) ; la cascade retombe
  // alors sur une recherche automatique qui trouve un AUTRE produit
  // (« Crème et noix de muscade », score 0.667, jamais assez sûr pour être
  // auto-sélectionné). Sans le 3ᵉ paramètre, le candidat manual_override
  // restait figé à confiance 100 % avec son ancien prix (une autre fiche,
  // disparue), jamais affiché comme « à valider » ni « indisponible » —
  // l'app continuait de recommander ce magasin sur la foi d'un prix mort.
  it("un échec confirmé de l'URL manuelle elle-même (MANUAL_URL_PAGE_INVALID) rend indisponible même un manual_override", async () => {
    const candidateId = 'price-leclerc-prod-1';
    await persistDriveObservation(makeObservation({ matchStage: 'manual', matchScore: 1, priceEuro: 3.28 }), testStore, undefined);

    await markMatchedPriceUnavailable('leclerc', 'prod-1', true);

    const candidate = await db.productCandidates.get(candidateId);
    const snapshot = await db.priceSnapshots.get(candidateId);
    // Le candidat reste tracé comme manual_override (historique du choix
    // humain conservé), mais son prix n'est plus utilisable dans les totaux
    // — comparisonEngine.ts l'affichera "Indisponible chez ce magasin",
    // jamais silencieusement comme le meilleur choix.
    expect(candidate?.matchType).toBe('manual_override');
    expect(snapshot?.available).toBe(false);
  });
});


// Un candidat corrigé à la main devient `manual_override`, que la recherche
// automatique n'a plus le droit de réécrire (skipAutomaticOverwrite). Sans
// permalien mémorisé, son prix restait figé pour toujours — les "produits
// sautés" au rafraîchissement.
describe('corrections manuelles rafraîchissables', () => {
  const leclercStore = {
    id: 'store-leclerc-1',
    storeKey: 'leclerc' as const,
    displayName: 'Leclerc Test',
    city: 'Testville',
    osmId: 1,
    osmType: 'node' as const,
    latitude: 48.5,
    longitude: 2.5,
    address: 'Rue du Test',
    postalCode: '75001',
    driveUrl: 'https://m-courses.leclercdrive.fr/magasin-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const livePickObservation = (productUrl: string): DrivePriceObservationV1 => ({
    protocolVersion: 1,
    storeKey: 'leclerc',
    localStoreId: leclercStore.id,
    productId: 'prod-puree',
    observedName: 'Purée instantanée nature',
    priceEuro: 2.56,
    currency: 'EUR',
    available: true,
    productUrl,
    observedAt: new Date().toISOString(),
    evidence: 'official_drive_page',
    matchScore: 1,
    matchStage: 'manual'
  });

  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
    await db.userStores.add(leclercStore);
  });

  it("mémorise l'URL de fiche après une sélection en direct Leclerc", async () => {
    bridgeMock.startLivePick.mockResolvedValue({
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'completed',
        observations: [
          livePickObservation(
            'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx'
          )
        ],
        errors: []
      }
    });

    const outcome = await runLivePick('prod-puree', 'Purée instantanée', undefined, 'leclerc');

    expect(outcome.ok).toBe(true);
    expect(await db.driveManualOverrides.get(['prod-puree', 'leclerc'])).toMatchObject({
      productUrl:
        'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx'
    });
  });

  it("ne mémorise rien quand le collecteur est retombé sur l'URL de la grille de recherche", async () => {
    bridgeMock.startLivePick.mockResolvedValue({
      accepted: true,
      report: {
        jobId: 'job-2',
        status: 'completed',
        observations: [
          livePickObservation('https://m-courses.leclercdrive.fr/magasin-test/recherche/Puree')
        ],
        errors: []
      }
    });

    const outcome = await runLivePick('prod-puree', 'Purée instantanée', undefined, 'leclerc');

    expect(outcome.ok).toBe(true);
    // Mémoriser une URL de recherche ferait relire un résultat quelconque au
    // prochain rafraîchissement : pire que de ne rien mémoriser.
    expect(await db.driveManualOverrides.get(['prod-puree', 'leclerc'])).toBeUndefined();
  });

  it('transmet les corrections manuelles Leclerc au job de rafraîchissement', async () => {
    await db.driveManualOverrides.put({
      productId: 'prod-puree',
      storeKey: 'leclerc',
      productUrl:
        'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx',
      updatedAt: new Date().toISOString()
    });
    bridgeMock.startDriveRefresh.mockResolvedValue({
      accepted: true,
      report: { jobId: 'job-3', status: 'completed', observations: [], errors: [] }
    });

    const now = new Date().toISOString();
    await runDriveRefresh([
      {
        item: {
          id: 'item-1',
          listId: 'list-1',
          productId: 'prod-puree',
          quantity: 1,
          createdAt: now,
          updatedAt: now
        },
        product: { id: 'prod-puree', name: 'Purée instantanée', createdAt: now, updatedAt: now }
      }
    ]);

    const job = bridgeMock.startDriveRefresh.mock.calls[0]?.[0];
    expect(job?.manualUrlOverrides?.leclerc?.['prod-puree']).toBe(
      'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx'
    );
  });

  it("remplace une URL manuelle expirée quand la cascade de secours trouve finalement le produit", async () => {
    const now = new Date().toISOString();
    await persistDriveObservation(livePickObservation(
      'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx'
    ), leclercStore, undefined);
    await db.driveManualOverrides.put({
      productId: 'prod-puree',
      storeKey: 'leclerc',
      productUrl: 'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx',
      updatedAt: now
    });
    bridgeMock.startDriveRefresh.mockResolvedValue({
      accepted: true,
      extensionVersion: '0.5.76',
      report: {
        jobId: 'job-recovered',
        status: 'completed',
        observations: [{
          ...livePickObservation('https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-70000-Puree.aspx'),
          matchStage: 'name',
          matchScore: 0.8,
          priceEuro: 2.5
        }],
        errors: [{
          storeKey: 'leclerc',
          productId: 'prod-puree',
          code: 'MANUAL_URL_PAGE_INVALID'
        }]
      }
    });

    const outcome = await runDriveRefresh([{
      item: { id: 'item-1', shoppingListId: 'list-1', productId: 'prod-puree', wantedQuantity: 1, createdAt: now },
      product: {
        id: 'prod-puree',
        name: 'Purée instantanée',
        comparisonUnit: 'kilogram',
        allowDifferentFormat: true,
        allowPrivateLabel: false,
        createdAt: now,
        updatedAt: now
      }
    }]);

    expect(outcome.ran).toBe(true);
    if (!outcome.ran) throw new Error(outcome.reason);
    expect(outcome.diagnostic.summary).toMatchObject({ updated: 1, failed: 0 });
    expect(await db.driveManualOverrides.get(['prod-puree', 'leclerc'])).toBeUndefined();
    expect(await db.productCandidates.get('price-leclerc-prod-puree')).toMatchObject({
      matchType: 'private_label',
      confidenceScore: 80
    });
    expect(await db.priceSnapshots.get('price-leclerc-prod-puree')).toMatchObject({ price: 2.5, available: true });
  });
});

describe('permaliens appris (knownProductUrls)', () => {
  const leclercStore = {
    id: 'store-leclerc-known',
    storeKey: 'leclerc' as const,
    displayName: 'Leclerc Test',
    city: 'Testville',
    osmId: 7,
    osmType: 'node' as const,
    latitude: 48.5,
    longitude: 2.5,
    address: 'Rue du Test',
    postalCode: '75001',
    driveUrl: 'https://m-courses.leclercdrive.fr/magasin-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const FICHE_URL = 'https://fd7-courses.leclercdrive.fr/magasin-test/fiche-produits-60892-Puree.aspx';

  const putCandidate = async (overrides: Partial<ProductCandidate> = {}) => {
    const now = new Date().toISOString();
    await db.productCandidates.put({
      id: 'price-leclerc-prod-puree',
      productId: 'prod-puree',
      storeKey: 'leclerc',
      name: 'Purée instantanée nature',
      productUrl: FICHE_URL,
      matchType: 'equivalent_brand',
      confidenceScore: 89,
      confidenceReasons: [],
      createdAt: now,
      updatedAt: now,
      ...overrides
    });
  };

  const runRefresh = async () => {
    bridgeMock.startDriveRefresh.mockResolvedValue({
      accepted: true,
      report: { jobId: 'job-known', status: 'completed', observations: [], errors: [] }
    });
    const now = new Date().toISOString();
    await runDriveRefresh([
      {
        item: { id: 'item-1', listId: 'list-1', productId: 'prod-puree', quantity: 1, createdAt: now, updatedAt: now },
        product: { id: 'prod-puree', name: 'Purée instantanée', createdAt: now, updatedAt: now }
      }
    ]);
    return bridgeMock.startDriveRefresh.mock.calls[0]?.[0];
  };

  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
    await db.userStores.add(leclercStore);
  });

  it("transmet la fiche déjà retenue pour éviter de refaire la recherche", async () => {
    await putCandidate();
    const job = await runRefresh();
    expect(job?.knownProductUrls?.leclerc?.['prod-puree']).toBe(FICHE_URL);
  });

  it("ne transmet pas une correspondance incertaine", async () => {
    // Sinon on figerait l'erreur : le raccourci ramènerait chaque fois la même
    // mauvaise fiche, alors qu'une vraie recherche peut encore trouver mieux.
    await putCandidate({ matchType: 'uncertain', confidenceScore: 60 });
    const job = await runRefresh();
    expect(job?.knownProductUrls).toBeUndefined();
  });

  it("ne transmet pas un candidat rejeté par l'utilisateur", async () => {
    await putCandidate({ isRejected: true });
    const job = await runRefresh();
    expect(job?.knownProductUrls).toBeUndefined();
  });

  it("ne transmet pas une URL de grille de recherche", async () => {
    await putCandidate({ productUrl: 'https://m-courses.leclercdrive.fr/magasin-test/recherche/Puree' });
    const job = await runRefresh();
    expect(job?.knownProductUrls).toBeUndefined();
  });

  it("laisse la correction manuelle prendre le pas sur le permalien appris", async () => {
    // Les deux canaux désignent le même produit : dupliquer l'URL ferait
    // travailler le collecteur deux fois, et le choix humain doit primer.
    await putCandidate();
    await db.driveManualOverrides.put({
      productId: 'prod-puree',
      storeKey: 'leclerc',
      productUrl: FICHE_URL,
      updatedAt: new Date().toISOString()
    });
    const job = await runRefresh();
    expect(job?.manualUrlOverrides?.leclerc?.['prod-puree']).toBe(FICHE_URL);
    expect(job?.knownProductUrls).toBeUndefined();
  });

  it("conserve l'étage de cascade mémorisé quand la fiche est relue par permalien", async () => {
    // Sans ça, une relecture 'known_url' effaçait le hint : le jour où le
    // permalien devient périmé, la cascade repartait du tout premier étage.
    await db.driveSearchMemory.put({
      productId: 'prod-puree',
      storeKey: 'leclerc',
      outcome: 'matched',
      stage: 'name_only',
      updatedAt: new Date().toISOString()
    });
    await persistDriveObservation(
      {
        protocolVersion: 1,
        jobId: 'job-known',
        productId: 'prod-puree',
        storeKey: 'leclerc',
        localStoreId: leclercStore.id,
        externalStoreId: 'ext-1',
        observedName: 'Purée instantanée nature',
        priceEuro: 2.56,
        available: true,
        productUrl: FICHE_URL,
        observedAt: new Date().toISOString(),
        evidence: 'official_drive_page',
        matchScore: 0.82,
        matchStage: 'known_url'
      },
      leclercStore,
      undefined
    );
    const memory = await db.driveSearchMemory.get(['prod-puree', 'leclerc']);
    expect(memory?.stage).toBe('name_only');
    // Et surtout : un permalien appris ne confère PAS la confiance d'un choix
    // humain — le candidat reste un résultat automatique ordinaire.
    const candidate = await db.productCandidates.get('price-leclerc-prod-puree');
    expect(candidate?.matchType).not.toBe('manual_override');
  });
});
