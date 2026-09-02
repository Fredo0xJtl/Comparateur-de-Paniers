// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Product } from '../../types/domain';
import { ScanPage } from './ScanPage';

// Un scan identifie le produit avec certitude (contrairement à une recherche
// manuelle par nom, ambiguë) : ces tests vérifient que handleBarcode() ajoute
// TOUJOURS le produit à la liste active sans étape de confirmation à
// cliquer — que le produit soit déjà connu en local, trouvé sur Open Food
// Facts, ou retrouvé dans le cache de lookup (les deux branches de cache
// avaient régressé sur ce point : elles affichaient une suggestion/un
// produit sans jamais appeler addProductToActiveList).
vi.mock('../../db/seed', () => ({
  listProducts: vi.fn()
}));
vi.mock('../shopping-list/shoppingListService', () => ({
  addProductToActiveList: vi.fn()
}));
vi.mock('../products/productService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../products/productService')>();
  return {
    ...actual,
    createProduct: vi.fn(),
    markProductUsed: vi.fn()
  };
});
vi.mock('./openFoodFactsClient', () => ({
  lookupOpenFoodFactsProduct: vi.fn()
}));
vi.mock('./productCacheService', () => ({
  getCachedProduct: vi.fn(),
  setCachedProduct: vi.fn(),
  formatCacheAge: vi.fn(() => "à l'instant")
}));

import { listProducts } from '../../db/seed';
import { createProduct, markProductUsed } from '../products/productService';
import { addProductToActiveList } from '../shopping-list/shoppingListService';
import { lookupOpenFoodFactsProduct } from './openFoodFactsClient';
import { getCachedProduct, setCachedProduct } from './productCacheService';

const mockListProducts = vi.mocked(listProducts);
const mockAddProductToActiveList = vi.mocked(addProductToActiveList);
const mockCreateProduct = vi.mocked(createProduct);
const mockMarkProductUsed = vi.mocked(markProductUsed);
const mockLookupOff = vi.mocked(lookupOpenFoodFactsProduct);
const mockGetCachedProduct = vi.mocked(getCachedProduct);
const mockSetCachedProduct = vi.mocked(setCachedProduct);

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-local',
    barcode: '3012345678907',
    name: 'Riz basmati',
    comparisonUnit: 'unit',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: '2026-07-07T10:00:00.000Z',
    updatedAt: '2026-07-07T10:00:00.000Z',
    ...overrides
  };
}

async function submitBarcode(barcode: string) {
  const input = screen.getByLabelText('Saisie manuelle');
  fireEvent.change(input, { target: { value: barcode } });
  fireEvent.click(screen.getByRole('button', { name: 'Rechercher en local' }));
}

function renderScanPage() {
  return render(
    <MemoryRouter>
      <ScanPage />
    </MemoryRouter>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ScanPage — ajout direct au scan (sans confirmation)', () => {
  it('ajoute directement un produit déjà connu en local, sans bouton de confirmation', async () => {
    const product = makeProduct();
    mockGetCachedProduct.mockResolvedValue(null);
    mockListProducts.mockResolvedValue([product]);

    renderScanPage();
    await submitBarcode(product.barcode!);

    await waitFor(() => {
      screen.getByText(/ajouté à la liste active/);
    });
    expect(mockAddProductToActiveList).toHaveBeenCalledTimes(1);
    expect(mockAddProductToActiveList).toHaveBeenCalledWith(product.id);
    expect(mockMarkProductUsed).toHaveBeenCalledWith(product);
    // Pas de bouton "Ajouter à la liste" : l'ajout a déjà eu lieu, un tel
    // bouton dupliquerait l'ajout au clic.
    expect(screen.queryByRole('button', { name: /ajouter à la liste/i })).toBeNull();
  });

  it('crée et ajoute automatiquement un produit trouvé sur Open Food Facts, sans clic de confirmation', async () => {
    const barcode = '9999999999999';
    const created = makeProduct({ id: 'prod-off-new', barcode, name: 'Nouveau produit', brand: 'MarqueX' });
    mockGetCachedProduct.mockResolvedValue(null);
    mockListProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    mockLookupOff.mockResolvedValue({ name: 'Nouveau produit', brand: 'MarqueX' });
    mockCreateProduct.mockResolvedValue({ isValid: true, errors: {}, normalized: {} as never });

    renderScanPage();
    await submitBarcode(barcode);

    await waitFor(() => {
      screen.getByText(/ajouté à la liste \(nouveau produit, Open Food Facts\)/);
    });
    expect(mockCreateProduct).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Nouveau produit', brand: 'MarqueX', barcode }),
      { baseQuantity: undefined, baseUnit: undefined }
    );
    expect(mockAddProductToActiveList).toHaveBeenCalledWith(created.id);
    expect(mockSetCachedProduct).toHaveBeenCalledWith(barcode, created, 'local');
    // Aucune carte de suggestion à confirmer : c'est déjà fait.
    expect(screen.queryByRole('button', { name: /ajouter à mes produits/i })).toBeNull();
  });

  it("n'ajoute rien et propose la création manuelle si le code n'est trouvé ni en local ni sur Open Food Facts", async () => {
    const barcode = '1111111111111';
    mockGetCachedProduct.mockResolvedValue(null);
    mockListProducts.mockResolvedValue([]);
    mockLookupOff.mockResolvedValue(null);

    renderScanPage();
    await submitBarcode(barcode);

    await waitFor(() => {
      screen.getByText('Produit non trouvé, ni localement ni sur Open Food Facts.');
    });
    expect(mockAddProductToActiveList).not.toHaveBeenCalled();
    expect(mockCreateProduct).not.toHaveBeenCalled();
    screen.getByText('Créer le produit manuellement');
  });

  it('ajoute quand même à la liste un scan retrouvé dans le cache local (régression : le cache-hit ne faisait plus l\'ajout)', async () => {
    const product = makeProduct({ id: 'prod-cached' });
    mockGetCachedProduct.mockResolvedValue({
      barcode: product.barcode!,
      productId: product.id,
      source: 'local',
      cachedAt: '2026-08-29T09:00:00.000Z'
    });
    mockListProducts.mockResolvedValue([product]);

    renderScanPage();
    await submitBarcode(product.barcode!);

    await waitFor(() => {
      screen.getByText(/ajouté à la liste \(en cache/);
    });
    expect(mockAddProductToActiveList).toHaveBeenCalledWith(product.id);
  });

  it("crée et ajoute automatiquement un produit retrouvé dans le cache 'off' (régression : affichait juste une suggestion à confirmer)", async () => {
    const barcode = '2222222222222';
    const created = makeProduct({ id: 'prod-from-cache', barcode, name: 'Café bio', brand: 'MarqueY' });
    mockGetCachedProduct.mockResolvedValue({
      barcode,
      source: 'off',
      productName: 'Café bio',
      productBrand: 'MarqueY',
      cachedAt: '2026-08-29T09:00:00.000Z'
    });
    // Une seule recherche locale a lieu ici (celle, interne à
    // createProductFromOffAndAdd, après la création) — contrairement au cas
    // "lookup OFF frais" qui en fait deux (une avant, une après création).
    mockListProducts.mockResolvedValue([created]);
    mockCreateProduct.mockResolvedValue({ isValid: true, errors: {}, normalized: {} as never });

    renderScanPage();
    await submitBarcode(barcode);

    await waitFor(() => {
      screen.getByText(/ajouté à la liste \(Open Food Facts, en cache\)/);
    });
    expect(mockCreateProduct).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Café bio', brand: 'MarqueY', barcode }),
      { baseQuantity: undefined, baseUnit: undefined }
    );
    expect(mockAddProductToActiveList).toHaveBeenCalledWith(created.id);
    expect(screen.queryByRole('button', { name: /ajouter/i })).toBeNull();
  });

  it("ignore une double soumission pendant qu'un scan est encore en cours (pas de double ajout ni double création)", async () => {
    // Le lookup Open Food Facts peut rester en vol plusieurs secondes
    // (openFoodFactsClient.ts) : un double-clic/double-Entrée sur
    // "Rechercher en local" pendant ce délai ne doit pas déclencher deux
    // exécutions concurrentes de handleBarcode (qui créerait deux produits
    // pour le même code-barres, la table Dexie `products` n'ayant pas de
    // contrainte d'unicité sur `barcode`).
    const barcode = '3333333333333';
    const created = makeProduct({ id: 'prod-concurrent', barcode, name: 'Produit concurrent' });
    let resolveLookup: (value: { name: string; brand?: string } | null) => void = () => {};
    const lookupPromise = new Promise<{ name: string; brand?: string } | null>((resolve) => {
      resolveLookup = resolve;
    });
    mockGetCachedProduct.mockResolvedValue(null);
    mockListProducts.mockResolvedValueOnce([]).mockResolvedValueOnce([created]);
    mockLookupOff.mockReturnValue(lookupPromise);
    mockCreateProduct.mockResolvedValue({ isValid: true, errors: {}, normalized: {} as never });

    renderScanPage();
    const input = screen.getByLabelText('Saisie manuelle');
    fireEvent.change(input, { target: { value: barcode } });
    const submitButton = screen.getByRole('button', { name: 'Rechercher en local' });
    // Deux clics synchrones, avant que le premier setBarcodeBusy(true) n'ait
    // pu re-render et désactiver le bouton — c'est exactement le scénario
    // que le garde par ref doit couvrir (l'état seul serait trop lent).
    fireEvent.click(submitButton);
    fireEvent.click(submitButton);

    resolveLookup({ name: 'Produit concurrent' });

    await waitFor(() => {
      screen.getByText(/ajouté à la liste \(nouveau produit, Open Food Facts\)/);
    });

    expect(mockLookupOff).toHaveBeenCalledTimes(1);
    expect(mockCreateProduct).toHaveBeenCalledTimes(1);
    expect(mockAddProductToActiveList).toHaveBeenCalledTimes(1);
  });
});
