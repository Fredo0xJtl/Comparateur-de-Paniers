// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Product } from '../../types/domain';
import { ScanPage } from './ScanPage';

// Troisième chemin d'ajout de cet écran, à côté du scan caméra et du
// code-barres tapé : le nom du produit. Il enchaîne deux mécanismes
// volontairement distincts — la base locale (instantanée, hors ligne) puis le
// catalogue du magasin (via la sélection en direct de l'extension). Aucun mot
// tapé ne doit partir sur le réseau : ces tests vérifient aussi qu'aucun
// lookup Open Food Facts n'est déclenché par une recherche par nom.
vi.mock('../../db/seed', () => ({
  listProducts: vi.fn()
}));
vi.mock('../shopping-list/shoppingListService', () => ({
  addProductToActiveList: vi.fn()
}));
vi.mock('../products/productService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../products/productService')>();
  return { ...actual, createProduct: vi.fn(), markProductUsed: vi.fn() };
});
vi.mock('../products/quickAddService', () => ({
  createProductFromText: vi.fn(),
  confirmProductFromText: vi.fn(),
  discardProductFromText: vi.fn(),
  adoptStorePick: vi.fn()
}));
vi.mock('../drive-bridge/driveRefreshService', () => ({
  runLivePick: vi.fn()
}));
vi.mock('../stores/storeLocatorService', () => ({
  listSelectedStores: vi.fn()
}));
vi.mock('./openFoodFactsClient', () => ({
  lookupOpenFoodFactsProduct: vi.fn(),
  searchOpenFoodFactsProducts: vi.fn()
}));
vi.mock('../settings/settingsService', () => ({
  getSettings: vi.fn()
}));
vi.mock('./productCacheService', () => ({
  getCachedProduct: vi.fn(),
  setCachedProduct: vi.fn(),
  formatCacheAge: vi.fn(() => "à l'instant")
}));

import { listProducts } from '../../db/seed';
import { createProduct, markProductUsed } from '../products/productService';
import {
  adoptStorePick,
  confirmProductFromText,
  createProductFromText,
  discardProductFromText
} from '../products/quickAddService';
import { addProductToActiveList } from '../shopping-list/shoppingListService';
import { runLivePick } from '../drive-bridge/driveRefreshService';
import { listSelectedStores } from '../stores/storeLocatorService';
import { lookupOpenFoodFactsProduct, searchOpenFoodFactsProducts } from './openFoodFactsClient';
import { getSettings } from '../settings/settingsService';

const mockListProducts = vi.mocked(listProducts);
const mockAddProductToActiveList = vi.mocked(addProductToActiveList);
const mockMarkProductUsed = vi.mocked(markProductUsed);
const mockCreateProduct = vi.mocked(createProduct);
const mockCreateProductFromText = vi.mocked(createProductFromText);
const mockConfirmProductFromText = vi.mocked(confirmProductFromText);
const mockDiscardProductFromText = vi.mocked(discardProductFromText);
const mockAdoptStorePick = vi.mocked(adoptStorePick);
const mockRunLivePick = vi.mocked(runLivePick);
const mockListSelectedStores = vi.mocked(listSelectedStores);
const mockLookupOff = vi.mocked(lookupOpenFoodFactsProduct);
const mockSearchOff = vi.mocked(searchOpenFoodFactsProducts);
const mockGetSettings = vi.mocked(getSettings);

// La recherche par nom dans Open Food Facts est un chemin réseau : elle reste
// fermée tant que l'utilisateur ne l'a pas activée dans les réglages.
function withOffNameSearch(enabled: boolean) {
  mockGetSettings.mockResolvedValue({ openFoodFactsNameSearch: enabled } as never);
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-local',
    name: 'Riz basmati',
    comparisonUnit: 'unit',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...overrides
  };
}

function renderScanPage() {
  return render(
    <MemoryRouter>
      <ScanPage />
    </MemoryRouter>
  );
}

function typeName(value: string) {
  fireEvent.change(screen.getByLabelText('Nom du produit'), { target: { value } });
}

function withStores(...storeKeys: Array<'leclerc' | 'hyperu'>) {
  mockListSelectedStores.mockResolvedValue(
    storeKeys.map((storeKey) => ({
      id: `store-${storeKey}`,
      storeKey,
      displayName: storeKey,
      selected: true,
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z'
    })) as never
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  withOffNameSearch(false);
});

describe('ScanPage — ajout par le nom du produit', () => {
  it('propose un produit connu dès les premières lettres et l ajoute sans appel réseau', async () => {
    const product = makeProduct({ brand: 'Taureau Ailé' });
    mockListProducts.mockResolvedValue([product]);
    withStores('leclerc');

    renderScanPage();
    await waitFor(() => expect(mockListProducts).toHaveBeenCalled());
    typeName('riz');

    const suggestion = await screen.findByRole('button', { name: /Riz basmati/ });
    fireEvent.click(suggestion);

    await waitFor(() => {
      expect(mockAddProductToActiveList).toHaveBeenCalledWith('prod-local');
    });
    expect(mockMarkProductUsed).toHaveBeenCalledWith(product);
    // Rien ne part vers Open Food Facts : la recherche par nom est locale.
    expect(mockLookupOff).not.toHaveBeenCalled();
    await screen.findByText(/Riz basmati ajouté à la liste active/);
  });

  it('ne propose que les magasins réellement configurés', async () => {
    mockListProducts.mockResolvedValue([]);
    withStores('hyperu');

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre demi-sel');

    await screen.findByRole('button', { name: 'Chercher chez Hyper U' });
    expect(screen.queryByRole('button', { name: 'Chercher chez Leclerc' })).toBeNull();
  });

  it('renvoie vers les réglages quand aucun magasin n est configuré', async () => {
    mockListProducts.mockResolvedValue([]);
    withStores();

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre');

    await screen.findByText(/Aucun magasin configuré/);
    expect(screen.queryByRole('button', { name: /Chercher chez/ })).toBeNull();
  });

  it('envoie au magasin les mots tapés, puis adopte le nom et le format de la fiche validée', async () => {
    const created = makeProduct({ id: 'prod-new', name: 'beurre demi-sel' });
    const adopted = makeProduct({
      id: 'prod-new',
      name: 'Beurre Président demi-sel 250 g',
      baseQuantity: 250,
      baseUnit: 'g',
      comparisonUnit: 'kilogram'
    });
    mockListProducts.mockResolvedValue([]);
    withStores('leclerc');
    mockCreateProductFromText.mockResolvedValue(created);
    mockRunLivePick.mockResolvedValue({
      ok: true,
      candidateId: 'price-leclerc-prod-new',
      observedName: 'Beurre Président demi-sel 250 g',
      priceEuro: 2.45,
      observedQuantity: 250,
      observedUnit: 'g'
    });
    mockAdoptStorePick.mockResolvedValue(adopted);

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre demi-sel');
    fireEvent.click(await screen.findByRole('button', { name: 'Chercher chez Leclerc' }));

    await waitFor(() => expect(mockRunLivePick).toHaveBeenCalled());
    // La requête envoyée au site est la formulation de l'utilisateur, pas le
    // nom du produit tel qu'il finira enregistré.
    expect(mockRunLivePick).toHaveBeenCalledWith(
      'prod-new',
      'beurre demi-sel',
      undefined,
      'leclerc',
      undefined,
      undefined,
      'beurre demi-sel'
    );
    expect(mockAdoptStorePick).toHaveBeenCalledWith(
      created,
      expect.objectContaining({
        observedName: 'Beurre Président demi-sel 250 g',
        observedQuantity: 250,
        observedUnit: 'g'
      })
    );
    // L ajout à la liste vient après la fiche validée, et porte le produit
    // enrichi par le catalogue (nom complet et format), pas les mots tapés.
    expect(mockConfirmProductFromText).toHaveBeenCalledWith(adopted);
    expect(mockDiscardProductFromText).not.toHaveBeenCalled();
    await screen.findByText(
      /Beurre Président demi-sel 250 g ajouté à ta liste, validé chez Leclerc à 2,45 €/
    );
  });

  it('n ajoute rien à la liste et efface le produit créé quand aucune fiche n a été validée', async () => {
    const created = makeProduct({ id: 'prod-new', name: 'beurre demi-sel' });
    mockListProducts.mockResolvedValue([]);
    withStores('leclerc');
    mockCreateProductFromText.mockResolvedValue(created);
    mockRunLivePick.mockResolvedValue({ ok: false, reason: 'Aucun produit sélectionné.' });

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre demi-sel');
    fireEvent.click(await screen.findByRole('button', { name: 'Chercher chez Leclerc' }));

    await screen.findByText(/n'a pas été ajouté à ta liste/);
    // Sans fiche magasin, le produit n a ni prix ni format : le laisser dans
    // la liste ne donnerait qu une ligne inutile à retirer à la main.
    expect(mockAdoptStorePick).not.toHaveBeenCalled();
    expect(mockConfirmProductFromText).not.toHaveBeenCalled();
    await waitFor(() => expect(mockDiscardProductFromText).toHaveBeenCalledWith(created));
  });

  it('n affiche aucun bouton Open Food Facts tant que l option est désactivée', async () => {
    mockListProducts.mockResolvedValue([]);
    withStores('leclerc');
    withOffNameSearch(false);

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre demi-sel');

    await screen.findByRole('button', { name: 'Chercher chez Leclerc' });
    expect(screen.queryByRole('button', { name: /Trouver la fiche produit/ })).toBeNull();
    expect(mockSearchOff).not.toHaveBeenCalled();
  });

  it('ne cherche la fiche qu au geste explicite, jamais pendant la frappe', async () => {
    mockListProducts.mockResolvedValue([]);
    withStores('leclerc');
    withOffNameSearch(true);
    mockSearchOff.mockResolvedValue([
      { barcode: '3257980702487', name: 'Beurre demi-sel', brand: 'Cora', baseQuantity: 250, baseUnit: 'g' }
    ]);

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre demi-sel');

    const bouton = await screen.findByRole('button', { name: 'Trouver la fiche produit' });
    // La saisie seule n a rien envoyé sur le réseau.
    expect(mockSearchOff).not.toHaveBeenCalled();

    fireEvent.click(bouton);

    await waitFor(() => expect(mockSearchOff).toHaveBeenCalledWith('beurre demi-sel'));
    await screen.findByRole('button', { name: /Beurre demi-sel/ });
  });

  it('traite une fiche choisie comme un scan de son code-barres', async () => {
    mockListProducts.mockResolvedValue([]);
    withStores('leclerc');
    withOffNameSearch(true);
    mockSearchOff.mockResolvedValue([
      { barcode: '3257980702487', name: 'Beurre demi-sel', brand: 'Cora' }
    ]);
    mockLookupOff.mockResolvedValue(null);

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('beurre demi-sel');
    fireEvent.click(await screen.findByRole('button', { name: 'Trouver la fiche produit' }));
    fireEvent.click(await screen.findByRole('button', { name: /Beurre demi-sel/ }));

    // Le code-barres de la fiche retenue repart dans le chemin du scan : c est
    // lui qui permettra ensuite de confirmer la fiche en magasin.
    await waitFor(() => expect(mockLookupOff).toHaveBeenCalledWith('3257980702487'));
  });

  it('offre la création à la main en dernier recours, et l ajoute à la liste', async () => {
    const created = makeProduct({ id: 'prod-manuel', name: 'pommes en vrac' });
    mockListProducts.mockResolvedValue([]);
    withStores('leclerc');
    mockCreateProduct.mockResolvedValue({ isValid: true, errors: {}, product: created } as never);

    renderScanPage();
    await waitFor(() => expect(mockListSelectedStores).toHaveBeenCalled());
    typeName('pommes en vrac');
    fireEvent.click(await screen.findByRole('button', { name: 'Créer la fiche à la main' }));

    // Le nom déjà tapé est repris : le formulaire ne repart pas de zéro.
    const champNom = await screen.findByLabelText('Nom');
    expect((champNom as HTMLInputElement).value).toBe('pommes en vrac');

    fireEvent.click(screen.getByRole('button', { name: 'Créer et ajouter à ma liste' }));

    await waitFor(() => expect(mockAddProductToActiveList).toHaveBeenCalledWith('prod-manuel'));
    await screen.findByText(/pommes en vrac créé et ajouté à ta liste/);
  });
});
