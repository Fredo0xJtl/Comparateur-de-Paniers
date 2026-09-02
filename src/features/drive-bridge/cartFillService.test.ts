import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../db/db';
import { type ValidatedBasketItem } from '../../types/domain';

// Étape 1 du plan de fiabilisation : `report.errors` (panne au niveau du
// magasin entier — site bloqué, connexion requise, catalogue inaccessible...)
// n'était jamais lu par runCartFill, seulement `report.observations`. Un job
// qui échouait avant même de tenter un seul produit retournait donc un faux
// succès à zéro ("0 ajouté(s), 0 échec(s)"), message vide de sens qui
// masquait la vraie cause. Ces tests figent la correction pour empêcher toute
// régression silencieuse.
const mockStartAddToCart = vi.fn();
const mockFetchCartReport = vi.fn();

vi.mock('./extensionBridge', () => ({
  getExtensionBridge: () => ({
    detectDriveExtension: vi.fn().mockResolvedValue(undefined),
    startAddToCart: mockStartAddToCart,
    fetchCartReport: mockFetchCartReport
  })
}));

const { runCartFill, fetchCartReport } = await import('./cartFillService');

function makeItem(overrides?: Partial<ValidatedBasketItem>): ValidatedBasketItem {
  return {
    productId: 'prod-1',
    productName: 'Riz basmati 1kg',
    productUrl: 'https://www.leclercdrive.fr/produit/riz-1',
    quantity: 2,
    lineTotal: 4.6,
    ...overrides
  };
}

describe('runCartFill', () => {
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

  it('renvoie ran:false avec une raison exploitable quand report.errors est non vide et rien n’a été ajouté (bug A)', async () => {
    mockStartAddToCart.mockResolvedValue({
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'failed',
        observations: [],
        errors: [{ storeKey: 'leclerc', code: 'CART_LOGIN_REQUIRED' }]
      }
    });

    const outcome = await runCartFill('leclerc', [makeItem()]);

    expect(outcome.ran).toBe(false);
    if (outcome.ran) throw new Error('unreachable');
    expect(outcome.code).toBe('CART_LOGIN_REQUIRED');
    expect(outcome.reason).toContain('CART_LOGIN_REQUIRED');
  });

  it('n’écarte plus silencieusement un item sans productUrl connu — il est envoyé dans le job', async () => {
    mockStartAddToCart.mockResolvedValue({
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'completed',
        observations: [{ protocolVersion: 1, jobId: 'job-1', productId: 'prod-1', storeKey: 'leclerc', added: true }],
        errors: []
      }
    });

    const outcome = await runCartFill('leclerc', [makeItem({ productUrl: undefined })]);

    expect(outcome.ran).toBe(true);
    expect(mockStartAddToCart).toHaveBeenCalledTimes(1);
    const job = mockStartAddToCart.mock.calls[0][0];
    expect(job.items).toHaveLength(1);
    expect(job.items[0]).not.toHaveProperty('productUrl');
    expect(job.items[0].productId).toBe('prod-1');
  });

  it('calcule addedCount/failedCount correctement sur un mix succès/échecs', async () => {
    mockStartAddToCart.mockResolvedValue({
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'partial',
        observations: [
          { protocolVersion: 1, jobId: 'job-1', productId: 'prod-1', storeKey: 'leclerc', added: true },
          {
            protocolVersion: 1,
            jobId: 'job-1',
            productId: 'prod-2',
            storeKey: 'leclerc',
            added: false,
            code: 'CART_CARD_NOT_FOUND'
          }
        ],
        errors: []
      }
    });

    const outcome = await runCartFill('leclerc', [
      makeItem({ productId: 'prod-1' }),
      makeItem({ productId: 'prod-2', productName: 'Jus de pomme 1L' })
    ]);

    expect(outcome.ran).toBe(true);
    if (!outcome.ran) throw new Error('unreachable');
    expect(outcome.addedCount).toBe(1);
    expect(outcome.failedCount).toBe(1);
    expect(outcome.failures).toEqual([{ productId: 'prod-2', code: 'CART_CARD_NOT_FOUND', details: undefined }]);
  });

  it('renvoie ran:false quand la liste d’items est vide, sans appeler l’extension', async () => {
    const outcome = await runCartFill('leclerc', []);

    expect(outcome.ran).toBe(false);
    expect(mockStartAddToCart).not.toHaveBeenCalled();
  });
});

// Bug n°3 (rapport terminé perdu après un rechargement de page pendant
// l'attente) : onJobStart doit recevoir le jobId AVANT que le remplissage ne
// se termine (pour pouvoir le persister immédiatement), et fetchCartReport
// doit traduire un rapport retrouvé après coup exactement comme un rapport
// reçu en direct — sinon un rechargement produirait un affichage différent
// d'un déroulement normal.
describe('runCartFill — persistance du jobId (bug n°3)', () => {
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

  it('appelle onJobStart avec le jobId avant que startAddToCart ne se résolve', async () => {
    let jobIdAtCallTime: string | undefined;
    let resolveStart!: (value: unknown) => void;
    mockStartAddToCart.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      })
    );

    const runPromise = runCartFill('leclerc', [makeItem()], {
      onJobStart: (jobId) => {
        jobIdAtCallTime = jobId;
      }
    });

    // onJobStart doit être appelé avant que startAddToCart ne se résolve
    // (celle-ci reste volontairement en attente ci-dessus) — vi.waitFor
    // absorbe les quelques ticks async réels de listSelectedStores/Dexie qui
    // précèdent cet appel.
    await vi.waitFor(() => {
      expect(jobIdAtCallTime).toBeTruthy();
    });

    resolveStart({
      accepted: true,
      report: {
        jobId: jobIdAtCallTime,
        status: 'completed',
        observations: [{ protocolVersion: 1, jobId: jobIdAtCallTime, productId: 'prod-1', storeKey: 'leclerc', added: true }],
        errors: []
      }
    });
    const outcome = await runPromise;
    expect(outcome.ran).toBe(true);
  });
});

describe('fetchCartReport', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renvoie null quand l’extension ne connaît pas (ou plus) ce jobId', async () => {
    mockFetchCartReport.mockResolvedValue({ found: false });
    const outcome = await fetchCartReport('job-inconnu');
    expect(outcome).toBeNull();
  });

  it('traduit un rapport retrouvé exactement comme runCartFill traduirait une réponse directe', async () => {
    mockFetchCartReport.mockResolvedValue({
      found: true,
      accepted: true,
      report: {
        jobId: 'job-1',
        status: 'partial',
        observations: [
          { protocolVersion: 1, jobId: 'job-1', productId: 'prod-1', storeKey: 'leclerc', added: true },
          { protocolVersion: 1, jobId: 'job-1', productId: 'prod-2', storeKey: 'leclerc', added: false, code: 'CART_CARD_NOT_FOUND' }
        ],
        errors: []
      }
    });

    const outcome = await fetchCartReport('job-1');
    expect(outcome?.ran).toBe(true);
    if (!outcome?.ran) throw new Error('unreachable');
    expect(outcome.addedCount).toBe(1);
    expect(outcome.failedCount).toBe(1);
  });

  it('renvoie null si l’extension est injoignable (onglet fermé, worker déchargé)', async () => {
    mockFetchCartReport.mockRejectedValue(new Error('timeout'));
    const outcome = await fetchCartReport('job-1');
    expect(outcome).toBeNull();
  });
});
