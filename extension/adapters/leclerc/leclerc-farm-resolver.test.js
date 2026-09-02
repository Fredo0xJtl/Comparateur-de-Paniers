import { describe, expect, it } from 'vitest';
import {
  extractLeclercFarmMapping,
  readKnownLeclercFarms,
  rememberLeclercFarm,
  resolveLeclercTransactionalUrl
} from './leclerc-farm-resolver.js';

// Faux stockage, calqué sur chrome.storage.local (get/set asynchrones).
function fakeStore(initial = {}) {
  let data = { ...initial };
  return {
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (patch) => {
      data = { ...data, ...patch };
    },
    read: () => data
  };
}

describe('résolveur de ferme transactionnelle Leclerc', () => {
  it('résout un magasin dont la ferme a été apprise', () => {
    expect(
      resolveLeclercTransactionalUrl('/magasin-123456-123456-ma-ville.aspx', { 123456: 'fd7' })
    ).toBe('https://fd7-courses.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx');
  });

  it("ne devine jamais la ferme d'un magasin inconnu", () => {
    // L'identifiant de ferme est attribué par Leclerc magasin par magasin :
    // le deviner enverrait la collecte sur les prix d'un AUTRE magasin.
    expect(resolveLeclercTransactionalUrl('/magasin-999999-inconnu.aspx')).toBeNull();
    expect(resolveLeclercTransactionalUrl('/magasin-999999-inconnu.aspx', {})).toBeNull();
    expect(resolveLeclercTransactionalUrl('/magasin-123456-654321-ailleurs.aspx', { 999999: 'fd7' })).toBeNull();
    expect(resolveLeclercTransactionalUrl('/region-centre-val-de-loire/une-ville/')).toBeNull();
  });

  it('refuse une ferme mal formée venant du stockage', () => {
    // Le stockage local est modifiable : une valeur abîmée ne doit pas
    // fabriquer une adresse qui partirait vers n'importe quel hôte.
    expect(
      resolveLeclercTransactionalUrl('/magasin-123456-123456-ma-ville.aspx', { 123456: 'evil.example.com' })
    ).toBeNull();
    expect(resolveLeclercTransactionalUrl('/magasin-123456-123456-ma-ville.aspx', { 123456: '' })).toBeNull();
  });

  it("n'extrait une correspondance que d'une adresse de catalogue complète", () => {
    expect(
      extractLeclercFarmMapping('https://fd7-courses.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx')
    ).toEqual({ storeId: '123456', farm: 'fd7' });
    // Hôte public (non transactionnel) : rien à apprendre.
    expect(
      extractLeclercFarmMapping('https://www.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx')
    ).toBeNull();
    // Hôte transactionnel mais chemin sans magasin identifiable.
    expect(extractLeclercFarmMapping('https://fd7-courses.leclercdrive.fr/recherche.aspx')).toBeNull();
    expect(extractLeclercFarmMapping('pas une adresse')).toBeNull();
  });

  it('apprend une correspondance constatée, puis la réutilise', async () => {
    const store = fakeStore();
    expect(
      await rememberLeclercFarm(store, 'https://fd7-courses.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx')
    ).toBe(true);
    const farms = await readKnownLeclercFarms(store);
    expect(farms).toEqual({ 123456: 'fd7' });
    expect(resolveLeclercTransactionalUrl('/magasin-123456-123456-ma-ville.aspx', farms)).toBe(
      'https://fd7-courses.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx'
    );
  });

  it('remplace une correspondance devenue fausse', async () => {
    // Leclerc réattribue ces identifiants (constaté le 18/07/2026 : un
    // magasin passé de fd8 à fd7). Garder l'ancienne valeur enverrait la
    // collecte sur un catalogue qui n'est plus le bon.
    const store = fakeStore({ leclercKnownFarms: { 123456: 'fd8' } });
    expect(
      await rememberLeclercFarm(store, 'https://fd7-courses.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx')
    ).toBe(true);
    expect(await readKnownLeclercFarms(store)).toEqual({ 123456: 'fd7' });
  });

  it('ne réécrit rien quand la correspondance est déjà connue', async () => {
    const store = fakeStore({ leclercKnownFarms: { 123456: 'fd7' } });
    expect(
      await rememberLeclercFarm(store, 'https://fd7-courses.leclercdrive.fr/magasin-123456-123456-ma-ville.aspx')
    ).toBe(false);
  });

  it('reste silencieux quand le stockage est absent ou en panne', async () => {
    // Le repli doit pouvoir manquer sans faire échouer la collecte.
    expect(await readKnownLeclercFarms(null)).toEqual({});
    expect(await rememberLeclercFarm(null, 'https://fd7-courses.leclercdrive.fr/magasin-123456-1.aspx')).toBe(false);
    const broken = {
      get: async () => {
        throw new Error('storage indisponible');
      },
      set: async () => {
        throw new Error('storage indisponible');
      }
    };
    expect(await readKnownLeclercFarms(broken)).toEqual({});
    expect(
      await rememberLeclercFarm(broken, 'https://fd7-courses.leclercdrive.fr/magasin-123456-123456-x.aspx')
    ).toBe(false);
  });
});
