// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import { loadActiveComparison } from '../features/comparison/comparisonService';
import { getSavingsSummary } from '../features/basket-history/basketHistoryService';
import { listSelectedStores } from '../features/stores/storeLocatorService';

vi.mock('../features/comparison/comparisonService', () => ({
  loadActiveComparison: vi.fn()
}));
vi.mock('../features/basket-history/basketHistoryService', () => ({
  getSavingsSummary: vi.fn()
}));
vi.mock('../features/stores/storeLocatorService', () => ({
  listSelectedStores: vi.fn()
}));
vi.mock('../features/stores/StoreLocatorPanel', () => ({ StoreLocatorPanel: () => <div>Magasins</div> }));

function renderHome() {
  return render(
    <MemoryRouter>
      <HomePage />
    </MemoryRouter>
  );
}

function mockData(options: {
  totals?: { hyperu: number; leclerc: number };
  rows?: unknown[];
  savings?: { estimated: number; validated: number; realized: number };
  stores?: Array<{ storeKey: string }>;
}) {
  vi.mocked(loadActiveComparison).mockResolvedValue({
    result: options.totals ? { totals: options.totals } : null,
    rows: options.rows ?? []
  } as never);
  vi.mocked(getSavingsSummary).mockResolvedValue(options.savings ?? { estimated: 0, validated: 0, realized: 0 });
  vi.mocked(listSelectedStores).mockResolvedValue((options.stores ?? []) as never);
}

afterEach(cleanup);

describe('HomePage', () => {
  it('distingue l’économie validée de l’économie réellement obtenue', async () => {
    mockData({ totals: { hyperu: 12, leclerc: 14 }, rows: [{}], savings: { estimated: 5, validated: 3, realized: 1.5 } });
    renderHome();
    expect(await screen.findByText('1,50 €')).toBeTruthy();
    // Le montant validé n'est affiché qu'une fois, et seulement s'il diffère
    // du montant réalisé.
    expect(screen.getByText(/Économie validée, tous paniers confondus : 3,00 €/)).toBeTruthy();
    expect(screen.queryByText('Économie estimée')).toBeNull();
    expect(screen.getByText('Économie réalisée')).toBeTruthy();
  });

  it('guide un nouvel utilisateur vers la première étape, sans afficher de montants à zéro', async () => {
    mockData({});
    renderHome();
    expect(await screen.findByText('Par où commencer')).toBeTruthy();
    // Le seul bouton plein est celui de la première étape à faire.
    expect(screen.getByText('Choisir mes magasins').className).toBe('welcomeStepAction');
    expect(screen.getByText('Ajouter un produit').className).toBe('guideStepLink');
    expect(screen.queryByText('Économie réalisée')).toBeNull();
    expect(screen.queryByText('0,00 €')).toBeNull();
  });

  it('passe à l’étape suivante une fois les magasins choisis et la liste remplie', async () => {
    mockData({ rows: [{}, {}], stores: [{ storeKey: 'leclerc' }, { storeKey: 'hyperu' }] });
    renderHome();
    expect(await screen.findByText('2 produits dans ta liste.')).toBeTruthy();
    expect((await screen.findByText('Comparer les prix')).className).toBe('welcomeStepAction');
    expect(screen.queryByText('Choisir mes magasins')).toBeNull();
  });
});
