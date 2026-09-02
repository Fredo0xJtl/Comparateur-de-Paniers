import { describe, expect, it } from 'vitest';
import { mockProductCandidates } from '../stores/mockStoreData';
import { buildAddToCartAction } from './addToCartAction';

describe('buildAddToCartAction', () => {
  it('does not expose an action while the experimental flag is disabled', () => {
    const action = buildAddToCartAction(mockProductCandidates[0], {
      experimentalAddToCart: false
    });

    expect(action).toBeNull();
  });

  it('builds a transparent manual action when the flag is enabled', () => {
    const action = buildAddToCartAction(mockProductCandidates[0], {
      experimentalAddToCart: true
    });

    expect(action).toEqual({
      kind: 'open_product_page',
      label: 'Ouvrir pour ajout manuel',
      url: mockProductCandidates[0].productUrl,
      warning:
        'Expérimental : validation manuelle requise. Vérifie le prix, la quantité et le panier sur le site officiel.'
    });
  });

  it('falls back to the search URL when no product URL is available', () => {
    const candidate = {
      ...mockProductCandidates[0],
      productUrl: undefined,
      searchUrl: 'https://example.test/search?q=demo'
    };

    const action = buildAddToCartAction(candidate, {
      experimentalAddToCart: true
    });

    expect(action?.kind).toBe('open_search_page');
    expect(action?.url).toBe(candidate.searchUrl);
  });

  it('ignores relative product URLs instead of opening an app route that does not exist', () => {
    const candidate = {
      ...mockProductCandidates[0],
      productUrl: '/drive/add/manual',
      searchUrl: 'https://example.test/search?q=demo'
    };

    const action = buildAddToCartAction(candidate, {
      experimentalAddToCart: true
    });

    expect(action?.kind).toBe('open_search_page');
    expect(action?.url).toBe(candidate.searchUrl);
  });

  it('does not expose a manual action when no external URL is available', () => {
    const candidate = {
      ...mockProductCandidates[0],
      productUrl: '/drive/add/manual',
      searchUrl: undefined
    };

    const action = buildAddToCartAction(candidate, {
      experimentalAddToCart: true
    });

    expect(action).toBeNull();
  });
});
