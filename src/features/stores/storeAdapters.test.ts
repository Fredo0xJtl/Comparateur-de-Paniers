import { describe, expect, it } from 'vitest';
import { demoProducts } from '../../db/seed';
import { hyperUAdapter } from './hyperUAdapter.mock';
import { leclercAdapter } from './leclercAdapter.mock';
import { buildHyperUSearchUrl, buildLeclercSearchUrl } from './urlBuilders';

describe('store URL builders', () => {
  it('builds encoded manual search URLs for Leclerc and Hyper U', () => {
    expect(buildLeclercSearchUrl('Thé glacé pêche 1,5 L')).toBe(
      'https://www.leclercdrive.fr/search?q=Th%C3%A9%20glac%C3%A9%20p%C3%AAche%201%2C5%20L'
    );
    expect(buildHyperUSearchUrl('Thé glacé pêche 1,5 L')).toBe(
      'https://www.coursesu.com/recherche?text=Th%C3%A9%20glac%C3%A9%20p%C3%AAche%201%2C5%20L'
    );
  });
});

describe('mock store adapters', () => {
  it('returns mock candidates and price snapshots without network access', async () => {
    const product = demoProducts[0];
    const leclercCandidates = await leclercAdapter.searchCandidates({
      query: product.name,
      product
    });
    const hyperUCandidates = await hyperUAdapter.searchCandidates({
      query: product.name,
      product
    });

    expect(leclercCandidates.some((candidate) => candidate.storeKey === 'leclerc')).toBe(true);
    expect(hyperUCandidates.some((candidate) => candidate.storeKey === 'hyperu')).toBe(true);

    const price = await leclercAdapter.refreshCandidatePrice(leclercCandidates[0]);
    expect(price?.source).toBe('mock');
    expect(price?.available).toBe(true);
  });
});
