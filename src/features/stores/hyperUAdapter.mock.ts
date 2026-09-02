import { createMockStoreAdapter } from './mockAdapterFactory';
import { buildHyperUSearchUrl } from './urlBuilders';

export const hyperUAdapter = createMockStoreAdapter({
  storeKey: 'hyperu',
  displayName: 'Hyper U / Courses U',
  buildSearchUrl: buildHyperUSearchUrl
});
