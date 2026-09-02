import { describe, expect, it } from 'vitest';
import { validateDriveObservation } from './drive-protocol.js';

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
