import { createMockStoreAdapter } from './mockAdapterFactory';
import { buildLeclercSearchUrl } from './urlBuilders';

export const leclercAdapter = createMockStoreAdapter({
  storeKey: 'leclerc',
  displayName: 'Leclerc Drive',
  buildSearchUrl: buildLeclercSearchUrl
});
