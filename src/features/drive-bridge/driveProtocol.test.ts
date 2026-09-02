import { describe, expect, it } from 'vitest';
import { validateDriveObservation, validateDriveRefreshJob } from './driveProtocol';

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

describe('DrivePriceObservationV1 — unité du prix unitaire', () => {
  it('accepte L et kg', () => {
    expect(validateDriveObservation({ ...baseObservation, unitPriceEuro: 0.99, unitPriceUnit: 'L' }).unitPriceUnit).toBe('L');
    expect(validateDriveObservation({ ...baseObservation, unitPriceEuro: 3.5, unitPriceUnit: 'kg' }).unitPriceUnit).toBe('kg');
  });

  it('rejette une unité de référence inconnue', () => {
    expect(() => validateDriveObservation({ ...baseObservation, unitPriceEuro: 0.99, unitPriceUnit: 'ml' })).toThrow(
      'Observation Drive invalide'
    );
  });
});

describe('DriveAlternateV1 — format observé', () => {
  const alternate = {
    observedName: 'Lait demi-écrémé 6x1L',
    priceEuro: 5.94,
    unitPriceEuro: 0.99,
    unitPriceUnit: 'L',
    productUrl: 'https://www.leclercdrive.fr/produit/lait-2'
  };

  it('transporte la quantité et l’unité observées', () => {
    // Sans ces deux champs, le prix unitaire d'un alternate traversait le
    // protocole mais restait invérifiable : checkPriceCoherence n'avait aucun
    // diviseur et renvoyait 'unknown' pour tous les alternates.
    const result = validateDriveObservation({
      ...baseObservation,
      alternates: [{ ...alternate, observedQuantity: 6000, observedUnit: 'ml' }]
    });
    expect(result.alternates?.[0]?.observedQuantity).toBe(6000);
    expect(result.alternates?.[0]?.observedUnit).toBe('ml');
  });

  it('reste valide sans format observé', () => {
    const result = validateDriveObservation({ ...baseObservation, alternates: [alternate] });
    expect(result.alternates?.[0]?.observedQuantity).toBeUndefined();
  });

  it('rejette une quantité négative plutôt que de la propager', () => {
    expect(() =>
      validateDriveObservation({
        ...baseObservation,
        alternates: [{ ...alternate, observedQuantity: -6000, observedUnit: 'ml' }]
      })
    ).toThrow();
  });
});

describe('knownProductUrls — permaliens appris', () => {
  const baseJob = {
    protocolVersion: 1,
    jobId: 'job-1',
    requestedAt: new Date().toISOString(),
    stores: [{ storeKey: 'leclerc', localStoreId: 'store-1', displayName: 'Leclerc Test' }],
    products: [{ productId: 'prod-1', name: 'Lait demi-écrémé' }]
  };

  it('accepte un permalien du bon magasin', () => {
    const job = validateDriveRefreshJob({
      ...baseJob,
      knownProductUrls: { leclerc: { 'prod-1': 'https://www.leclercdrive.fr/fiche-produits-123-lait.aspx' } }
    });
    expect(job.knownProductUrls?.leclerc?.['prod-1']).toContain('fiche-produits-123');
  });

  it('rejette une URL qui ne pointe pas vers le magasin annoncé', () => {
    // Un permalien appris est navigué directement par le collecteur : une URL
    // d'un autre domaine enverrait l'onglet hors du site marchand.
    expect(() =>
      validateDriveRefreshJob({
        ...baseJob,
        knownProductUrls: { leclerc: { 'prod-1': 'https://exemple.test/fiche-produits-123.aspx' } }
      })
    ).toThrow('Tâche Drive invalide');
  });

  it('accepte "known_url" comme étage d’une observation', () => {
    expect(
      validateDriveObservation({ ...baseObservation, matchStage: 'known_url', matchScore: 0.82 }).matchStage
    ).toBe('known_url');
  });

  it('refuse "known_url" comme hint de recherche', () => {
    // Un hint sert à reprendre la cascade au bon étage : ni 'known_url' ni
    // 'manual' n'en sont un, les mémoriser ferait viser un étage inexistant.
    expect(() =>
      validateDriveRefreshJob({ ...baseJob, searchHints: { leclerc: { 'prod-1': 'known_url' } } })
    ).toThrow('Tâche Drive invalide');
    expect(() =>
      validateDriveRefreshJob({ ...baseJob, searchHints: { leclerc: { 'prod-1': 'manual' } } })
    ).toThrow('Tâche Drive invalide');
  });
});
