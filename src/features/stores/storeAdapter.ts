import {
  type PriceSnapshot,
  type Product,
  type ProductCandidate,
  type UserStore
} from '../../types/domain';

export type StoreSearchInput = {
  query: string;
  product?: Product;
  userStore?: UserStore;
};

export interface StoreAdapter {
  storeKey: 'leclerc' | 'hyperu';
  displayName: string;
  supportsDirectProductUrl: boolean;
  supportsExperimentalAddToCart: boolean;
  buildSearchUrl: (query: string, userStore?: UserStore) => string;
  searchCandidates: (input: StoreSearchInput) => Promise<ProductCandidate[]>;
  refreshCandidatePrice: (candidate: ProductCandidate) => Promise<PriceSnapshot | null>;
  buildAddToCartUrl?: (candidate: ProductCandidate) => string | null;
}
