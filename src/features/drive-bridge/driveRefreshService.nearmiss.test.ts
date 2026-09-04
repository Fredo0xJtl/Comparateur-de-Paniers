// @vitest-environment jsdom
// runDriveRefresh maintient un Screen Wake Lock via document.addEventListener
// ('visibilitychange') pendant toute la collecte — un environnement `node`
// pur (le défaut du projet) n'a pas de `document` du tout.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/db';
import { demoProducts } from '../../db/seed';
import { runDriveRefresh } from './driveRefreshService';

// Étape 4 du plan de fiabilisation : un PRODUCT_NOT_FOUND ne doit jamais être
// une impasse silencieuse — les quasi-matchs remontés par le collecteur
// (`nearMisses`) doivent devenir des candidats cliquables dans le panneau de
// validation, et un rejet manuel de l'utilisateur doit survivre aux
// refreshes suivants (sinon le bouton "Aucun de ceux-là" est inutile en
// pratique).
const mockStartDriveRefresh = vi.fn();

vi.mock('./extensionBridge', () => ({
  getExtensionBridge: () => ({
    detectDriveExtension: vi.fn().mockResolvedValue(undefined),
    startDriveRefresh: mockStartDriveRefresh
  })
}));

const product = demoProducts[0];
const nearMissId = `price-leclerc-${product.id}-nearmiss-0`;

function makeRow() {
  return {
    product,
    item: {
      id: 'item-1',
      shoppingListId: 'list-1',
      productId: product.id,
      wantedQuantity: 1,
      createdAt: '2026-08-01T00:00:00.000Z'
    }
  };
}

function nearMissReport(overrides?: Partial<{ productUrl: string; priceEuro: number }>) {
  return {
    accepted: true,
    report: {
      jobId: 'job-1',
      status: 'completed' as const,
      observations: [],
      errors: [
        {
          storeKey: 'leclerc',
          productId: product.id,
          code: 'PRODUCT_NOT_FOUND',
          details: {
            nearMisses: [
              {
                name: 'Produit approchant',
                priceEuro: overrides?.priceEuro ?? 3.5,
                productUrl: overrides?.productUrl ?? 'https://www.leclercdrive.fr/produit/proche-1',
                matchScore: 0.4
              }
            ]
          }
        }
      ]
    }
  };
}

describe('runDriveRefresh — persistance des quasi-matchs (nearMisses)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
    await db.userStores.add({
      id: 'store-1',
      storeKey: 'leclerc',
      displayName: 'Leclerc test',
      osmId: 1,
      osmType: 'node',
      latitude: 1,
      longitude: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    });
  });

  it('persiste un nearMiss comme candidat isAlternate + uncertain (jamais auto-sélectionnable)', async () => {
    mockStartDriveRefresh.mockResolvedValue(nearMissReport());

    const outcome = await runDriveRefresh([makeRow()]);
    expect(outcome.ran).toBe(true);

    const candidate = await db.productCandidates.get(nearMissId);
    expect(candidate?.matchType).toBe('uncertain');
    expect(candidate?.isAlternate).toBe(true);
    expect(candidate?.isRejected).toBe(false);
    expect(candidate?.productUrl).toBe('https://www.leclercdrive.fr/produit/proche-1');

    const snapshot = await db.priceSnapshots.get(nearMissId);
    expect(snapshot?.price).toBe(3.5);
  });

  it("un quasi-match rejeté par l'utilisateur reste rejeté après un nouveau refresh qui retrouve la même fiche", async () => {
    mockStartDriveRefresh.mockResolvedValue(nearMissReport());
    await runDriveRefresh([makeRow()]);

    await db.productCandidates.update(nearMissId, { isRejected: true });

    // Refresh suivant : le collecteur retrouve la même fiche (même
    // productUrl) — sans la préservation par identité, le simple fait de la
    // réécrire aurait silencieusement annulé le rejet.
    await runDriveRefresh([makeRow()]);

    const candidate = await db.productCandidates.get(nearMissId);
    expect(candidate?.isRejected).toBe(true);
  });

  it('un vrai match ultérieur efface les quasi-matchs devenus obsolètes pour ce produit/magasin', async () => {
    mockStartDriveRefresh.mockResolvedValueOnce(nearMissReport());
    await runDriveRefresh([makeRow()]);
    expect(await db.productCandidates.get(nearMissId)).toBeDefined();

    mockStartDriveRefresh.mockResolvedValueOnce({
      accepted: true,
      report: {
        jobId: 'job-2',
        status: 'completed' as const,
        observations: [
          {
            protocolVersion: 1,
            jobId: 'job-2',
            productId: product.id,
            storeKey: 'leclerc',
            localStoreId: 'store-1',
            externalStoreId: 'store-1',
            observedName: 'Le vrai produit',
            matchScore: 1,
            priceEuro: 2.5,
            available: true,
            productUrl: 'https://www.leclercdrive.fr/produit/vrai-1',
            observedAt: '2026-08-01T00:00:00.000Z',
            evidence: 'official_drive_page' as const
          }
        ],
        errors: []
      }
    });
    await runDriveRefresh([makeRow()]);

    expect(await db.productCandidates.get(nearMissId)).toBeUndefined();
  });

  it('une collecte qui échoue ensuite pour un produit déjà matché invalide son ancien prix (available: false)', async () => {
    const matchedCandidateId = `price-leclerc-${product.id}`;

    mockStartDriveRefresh.mockResolvedValueOnce({
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'completed' as const,
        observations: [
          {
            protocolVersion: 1,
            jobId: 'job-1',
            productId: product.id,
            storeKey: 'leclerc',
            localStoreId: 'store-1',
            externalStoreId: 'store-1',
            observedName: 'Le vrai produit',
            matchScore: 1,
            priceEuro: 2.5,
            available: true,
            productUrl: 'https://www.leclercdrive.fr/produit/vrai-1',
            observedAt: '2026-08-01T00:00:00.000Z',
            evidence: 'official_drive_page' as const
          }
        ],
        errors: []
      }
    });
    await runDriveRefresh([makeRow()]);
    expect((await db.priceSnapshots.get(matchedCandidateId))?.available).toBe(true);

    // Refresh suivant : le produit n'est plus retrouvé chez ce magasin (retiré
    // du catalogue, recherche en échec...) — le prix confirmé la fois
    // précédente ne doit plus être présenté comme fiable dans les totaux.
    mockStartDriveRefresh.mockResolvedValueOnce(nearMissReport());
    await runDriveRefresh([makeRow()]);

    const snapshot = await db.priceSnapshots.get(matchedCandidateId);
    expect(snapshot?.available).toBe(false);
    // Aucune suppression : le prix précédent reste consultable dans l'historique.
    expect(snapshot?.price).toBe(2.5);
  });
});

// Relevé sur le téléphone le 02/09 : des candidats alternatifs affichés avec
// 100 % de recouvrement de noms étaient stockés en `uncertain`, donc plafonnés
// à 64 % de confiance et redemandés en validation à chaque comparatif. Un
// alternate n'est pourtant PAS un quasi-match : le collecteur ne le remonte
// qu'après avoir franchi le même seuil d'acceptation que le candidat retenu.
describe('runDriveRefresh — étiquette des candidats alternatifs', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
    vi.clearAllMocks();
    await db.userStores.add({
      id: 'store-1',
      storeKey: 'leclerc',
      displayName: 'Leclerc test',
      osmId: 1,
      osmType: 'node',
      latitude: 1,
      longitude: 1,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z'
    });
  });

  function reportWithAlternate(alternate: Record<string, unknown>) {
    return {
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'completed' as const,
        errors: [],
        observations: [
          {
            protocolVersion: 1,
            jobId: 'job-1',
            productId: product.id,
            storeKey: 'leclerc',
            localStoreId: 'store-1',
            externalStoreId: 'ext-1',
            observedName: 'Thé glacé pêche 1,5 L',
            matchStage: 'name',
            matchScore: 0.95,
            priceEuro: 2.1,
            available: true,
            productUrl: 'https://www.leclercdrive.fr/produit/the-1',
            observedAt: '2026-09-02T00:00:00.000Z',
            evidence: 'official_drive_page',
            alternates: [alternate]
          }
        ]
      }
    };
  }

  const alternateId = `price-leclerc-${product.id}-alt-0`;

  it('un alternate au même format et à la bonne marque n’est plus classé incertain', async () => {
    mockStartDriveRefresh.mockResolvedValue(
      reportWithAlternate({
        observedName: 'Thé glacé pêche 1,5 L (autre référence)',
        observedBrand: product.brand,
        matchScore: 1,
        priceEuro: 2.4,
        productUrl: 'https://www.leclercdrive.fr/produit/the-2'
      })
    );

    await runDriveRefresh([makeRow()]);

    const candidate = await db.productCandidates.get(alternateId);
    expect(candidate?.isAlternate).toBe(true);
    expect(candidate?.matchType).toBe('equivalent_brand');
    expect(candidate?.confidenceScore).toBe(100);
  });

  it('un alternate faible reste incertain', async () => {
    mockStartDriveRefresh.mockResolvedValue(
      reportWithAlternate({
        observedName: 'Boisson approchante',
        observedBrand: 'Autre marque',
        matchScore: 0.5,
        priceEuro: 1.4,
        productUrl: 'https://www.leclercdrive.fr/produit/the-3'
      })
    );

    await runDriveRefresh([makeRow()]);

    expect((await db.productCandidates.get(alternateId))?.matchType).toBe('uncertain');
  });

  it('un alternate d’un autre format garde son étiquette de format différent', async () => {
    mockStartDriveRefresh.mockResolvedValue(
      reportWithAlternate({
        observedName: 'Thé glacé pêche 2 L',
        observedBrand: product.brand,
        matchScore: 1,
        quantityDiffers: true,
        priceEuro: 3.1,
        productUrl: 'https://www.leclercdrive.fr/produit/the-4'
      })
    );

    await runDriveRefresh([makeRow()]);

    expect((await db.productCandidates.get(alternateId))?.matchType).toBe('same_brand_different_format');
  });
});
