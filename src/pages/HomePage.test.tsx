// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';

vi.mock('../features/comparison/comparisonService', () => ({
  loadActiveComparison: vi.fn().mockResolvedValue({ result: { totals: { hyperu: 12, leclerc: 14 } } })
}));
vi.mock('../features/basket-history/basketHistoryService', () => ({
  getSavingsSummary: vi.fn().mockResolvedValue({ estimated: 5, validated: 3, realized: 1.5 })
}));
vi.mock('../features/stores/StoreLocatorPanel', () => ({ StoreLocatorPanel: () => <div>Magasins</div> }));

describe('HomePage', () => {
  it('distingue les économies estimées, validées et réellement obtenues', async () => {
    render(<HomePage />);
    expect(await screen.findByText('1.50 €')).toBeTruthy();
    expect(screen.getByText('Économie estimée')).toBeTruthy();
    expect(screen.getByText('Économie validée')).toBeTruthy();
    expect(screen.getByText('Économie réalisée')).toBeTruthy();
  });
});
