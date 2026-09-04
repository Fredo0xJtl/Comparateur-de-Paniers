import { describe, expect, it } from 'vitest';
import { validateDriveLivePickJob, validateDriveObservation } from './drive-protocol.js';

const baseObservation = {
  protocolVersion: 1,
  jobId: 'job-1',
  productId: 'prod-1',
  storeKey: 'leclerc',
  localStoreId: 'store-1',
  externalStoreId: 'external-store-1',
  observedName: 'Lait demi-écrémé 6x1L',
  priceEuro: 5.94,
  available: true,
  productUrl: 'https://www.leclercdrive.fr/produit/lait-1',
  observedAt: '2026-08-31T12:00:00.000Z',
  evidence: 'official_drive_page'
};

describe('miroir extension du protocole — unité du prix unitaire', () => {
  it('accepte uniquement L et kg', () => {
    expect(validateDriveObservation({ ...baseObservation, unitPriceEuro: 0.99, unitPriceUnit: 'L' }).unitPriceUnit).toBe('L');
    expect(validateDriveObservation({ ...baseObservation, unitPriceEuro: 3.5, unitPriceUnit: 'kg' }).unitPriceUnit).toBe('kg');
    expect(() => validateDriveObservation({ ...baseObservation, unitPriceEuro: 0.99, unitPriceUnit: 'ml' })).toThrow(
      'Observation Drive invalide'
    );
  });
});

// Requête tapée par l'utilisateur pour un produit tout neuf : elle finit
// saisie telle quelle dans le champ de recherche du site, donc elle est
// bornée comme n'importe quelle chaîne venue de la PWA.
describe('validateDriveLivePickJob — requête de recherche', () => {
  const baseJob = {
    protocolVersion: 1,
    jobId: 'job-1',
    requestedAt: new Date().toISOString(),
    store: { storeKey: 'leclerc', localStoreId: 'store-1', displayName: 'Leclerc Drive' },
    product: { productId: 'prod-1', name: 'beurre demi-sel' }
  };

  it('accepte une tâche sans requête (comportement historique)', () => {
    expect(validateDriveLivePickJob({ ...baseJob })).toBeTruthy();
  });

  it('accepte la requête tapée par l’utilisateur', () => {
    const job = { ...baseJob, product: { ...baseJob.product, searchQuery: 'beurre demi-sel' } };
    expect(validateDriveLivePickJob(job).product.searchQuery).toBe('beurre demi-sel');
  });

  it('refuse une requête démesurée ou d’un mauvais type', () => {
    expect(() =>
      validateDriveLivePickJob({ ...baseJob, product: { ...baseJob.product, searchQuery: 'x'.repeat(301) } })
    ).toThrow('Tâche de sélection manuelle invalide');
    expect(() =>
      validateDriveLivePickJob({ ...baseJob, product: { ...baseJob.product, searchQuery: 42 } })
    ).toThrow('Tâche de sélection manuelle invalide');
  });
});
