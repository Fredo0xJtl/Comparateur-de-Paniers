import { type ProductCandidate, type StoreKey } from '../../types/domain';
import { mockPriceSnapshots, mockProductCandidates } from './mockStoreData';
import { type StoreAdapter, type StoreSearchInput } from './storeAdapter';

export function createMockStoreAdapter(options: {
  storeKey: StoreKey;
  displayName: string;
  buildSearchUrl: StoreAdapter['buildSearchUrl'];
}): StoreAdapter {
  return {
    storeKey: options.storeKey,
    displayName: options.displayName,
    supportsDirectProductUrl: true,
    supportsExperimentalAddToCart: false,
    buildSearchUrl: options.buildSearchUrl,
    async searchCandidates(input: StoreSearchInput) {
      const query = input.query.trim().toLocaleLowerCase('fr');
      return mockProductCandidates
        .filter((candidate) => candidate.storeKey === options.storeKey)
        .filter((candidate) => {
          if (input.product?.id) {
            return candidate.productId === input.product.id;
          }

          const haystack = `${candidate.name} ${candidate.brand ?? ''}`.toLocaleLowerCase('fr');
          return query.length === 0 || haystack.includes(query);
        })
        .map((candidate) => ({
          ...candidate,
          searchUrl: candidate.searchUrl ?? options.buildSearchUrl(candidate.name, input.userStore)
        }));
    },
    async refreshCandidatePrice(candidate: ProductCandidate) {
      const snapshot = mockPriceSnapshots.find(
        (price) => price.candidateId === candidate.id && price.storeKey === options.storeKey
      );

      if (!snapshot) {
        return null;
      }

      return {
        ...snapshot,
        checkedAt: new Date().toISOString()
      };
    },
    buildAddToCartUrl() {
      return null;
    }
  };
}
