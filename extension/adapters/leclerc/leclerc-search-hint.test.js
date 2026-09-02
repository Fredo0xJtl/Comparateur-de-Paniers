import { describe, expect, it, vi } from 'vitest';
import { collectLeclercStore } from './leclerc-collector.js';

// Mémoire de recherche (job.searchHints) : l'étage qui avait trouvé le
// produit au comparatif précédent est renvoyé au collecteur pour qu'il
// démarre directement à cet étage, au lieu de rejouer les étages antérieurs
// qui avaient déjà échoué. Aucun test ne couvrait ce mécanisme — c'est
// précisément pour ça que son décalage d'indice (voir l'audit du 02/09,
// SEARCH_STAGE_ORDER amputé de 'ean' sans réajuster les comparaisons) est
// resté invisible : il ne sautait plus jamais l'étage qu'il devait sauter.
function makeDispatcher(handlers) {
  return vi.fn(async ({ func, args }) => {
    const handler = handlers[func.name];
    if (!handler) {
      throw new Error(`Appel executeScript non mocké pour la fonction "${func.name}"`);
    }
    return [{ result: await handler(...(args ?? [])) }];
  });
}

const PAGE_STATE = {
  hostname: 'fd4-courses.leclercdrive.fr',
  pathname: '/magasin-1/recherche.aspx',
  hasCaptcha: false,
  hasStorePrompt: false,
  hasCatalog: true
};

const EMMENTAL_CARD = {
  name: 'Emmental râpé Président 200g',
  priceEuro: 2.15,
  productUrl: 'https://fd4-courses.leclercdrive.fr/magasin-1/produit/emmental-rape-president'
};

const PRODUCT = {
  productId: 'product-emmental',
  name: 'Emmental râpé 200g',
  brand: 'Président'
};

describe('collectLeclercStore — mémoire de recherche (searchHints)', () => {
  it("démarre réellement à l'étage mémorisé et ne rejoue pas l'étage 'name'", async () => {
    const queries = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => PAGE_STATE,
        startProductSearchOnPage: (product) => {
          queries.push(product.name);
          return { started: true, query: product.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => ({ remainingPlaceholders: 0 }),
        readProductCandidatesOnPage: () => [EMMENTAL_CARD],
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 1 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 30,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [PRODUCT],
      searchHints: { [PRODUCT.productId]: 'simplified_name' }
    });

    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('simplified_name');
    // Une seule recherche envoyée, et c'est bien le nom nettoyé de son
    // grammage — pas le nom brut de l'étage 'name'.
    expect(queries).toEqual(['Emmental râpé']);
  }, 15_000);

  it('rejoue la cascade complète quand aucun étage autorisé par le hint ne trouve plus rien', async () => {
    const queries = [];
    const scripting = {
      executeScript: makeDispatcher({
        dismissCookieConsentOnPage: () => ({ dismissed: false }),
        readPublicLeclercPageState: () => PAGE_STATE,
        startProductSearchOnPage: (product) => {
          queries.push(product.name);
          return { started: true, query: product.name };
        },
        inspectLeclercSearchNavigationOnPage: () => ({ ready: true }),
        triggerLeclercLazyLoadOnPage: () => ({ remainingPlaceholders: 0 }),
        // La marque seule ne remonte plus rien (catalogue du magasin modifié
        // depuis le comparatif qui avait mémorisé 'brand_only'), mais le nom
        // retrouve toujours le produit.
        readProductCandidatesOnPage: () =>
          queries[queries.length - 1] === 'Président' ? [] : [EMMENTAL_CARD],
        isLeclercNoResultsConfirmedOnPage: () => true,
        inspectLeclercResultsOnPage: () => ({ hasCaptcha: false, resultCount: 0 })
      })
    };

    const result = await collectLeclercStore({
      scripting,
      tabId: 31,
      signal: new AbortController().signal,
      job: { jobId: 'job-1234567890abcdef' },
      store: { storeKey: 'leclerc', localStoreId: 'store-1' },
      products: [PRODUCT],
      searchHints: { [PRODUCT.productId]: 'brand_only' }
    });

    // Le produit n'est pas perdu : le hint devenu obsolète est mis de côté et
    // la cascade complète reprend depuis l'étage 'name'.
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].matchStage).toBe('name');
    expect(queries[0]).toBe('Président');
    expect(queries).toContain('Emmental râpé 200g');
  }, 20_000);
});
