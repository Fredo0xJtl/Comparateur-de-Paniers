import { type PriceSnapshot, type ProductCandidate, type UserStore } from '../../types/domain';

const seedDate = '2026-07-07T10:00:00.000Z';

export const mockUserStores: UserStore[] = [
  {
    id: 'store-leclerc-demo',
    storeKey: 'leclerc',
    displayName: 'Leclerc Drive Démo',
    driveUrl: 'https://m-courses.leclercdrive.fr/magasin-123456-123456-belleville---le-parc.aspx',
    postalCode: '99000',
    city: 'Belleville',
    osmType: 'node',
    osmId: 3012345,
    latitude: 48.8566,
    longitude: 2.3522,
    address: 'Le Parc, Belleville',
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'store-hyperu-demo',
    storeKey: 'hyperu',
    displayName: 'Hyper U Démo',
    driveUrl: 'https://www.coursesu.com/',
    postalCode: '00000',
    city: 'Démo',
    osmType: 'node',
    osmId: 3012346,
    latitude: 48.8566,
    longitude: 2.3522,
    address: 'Démo',
    createdAt: seedDate,
    updatedAt: seedDate
  }
];

export const mockProductCandidates: ProductCandidate[] = [
  {
    id: 'cand-ice-tea-leclerc-exact',
    productId: 'prod-ice-tea-peche',
    storeKey: 'leclerc',
    name: 'Lipton Ice Tea pêche 1,5 L',
    brand: 'Lipton Ice Tea',
    barcode: '3012345678907',
    variant: 'pêche',
    quantity: 1.5,
    unit: 'L',
    productUrl: 'https://www.leclercdrive.fr/search?q=Lipton%20Ice%20Tea%20p%C3%AAche%201%2C5L',
    searchUrl: 'https://www.leclercdrive.fr/search?q=Lipton%20Ice%20Tea%20p%C3%AAche%201%2C5L',
    matchType: 'exact_barcode',
    confidenceScore: 100,
    confidenceReasons: ['Même code-barres', 'Même marque', 'Même format'],
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'cand-ice-tea-hyperu-format',
    productId: 'prod-ice-tea-peche',
    storeKey: 'hyperu',
    name: 'Lipton Ice Tea pêche 2 L',
    brand: 'Lipton Ice Tea',
    variant: 'pêche',
    quantity: 2,
    unit: 'L',
    productUrl: 'https://www.coursesu.com/recherche?text=Lipton%20Ice%20Tea%20p%C3%AAche%202L',
    searchUrl: 'https://www.coursesu.com/recherche?text=Lipton%20Ice%20Tea%20p%C3%AAche%202L',
    matchType: 'same_brand_different_format',
    confidenceScore: 88,
    confidenceReasons: ['Même marque', 'Même variante', 'Format différent'],
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'cand-ice-tea-hyperu-mdd',
    productId: 'prod-ice-tea-peche',
    storeKey: 'hyperu',
    name: 'Thé glacé pêche marque distributeur 1,5 L',
    brand: 'Marque distributeur',
    variant: 'pêche',
    quantity: 1.5,
    unit: 'L',
    productUrl: 'https://www.coursesu.com/recherche?text=th%C3%A9%20glac%C3%A9%20p%C3%AAche%201%2C5L',
    searchUrl: 'https://www.coursesu.com/recherche?text=th%C3%A9%20glac%C3%A9%20p%C3%AAche%201%2C5L',
    matchType: 'private_label',
    confidenceScore: 72,
    confidenceReasons: ['Même type de produit', 'Même goût', 'Marque différente'],
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'cand-lait-leclerc-exact',
    productId: 'prod-lait-demi-ecreme',
    storeKey: 'leclerc',
    name: 'Lait demi-écrémé UHT 6 x 1 L',
    brand: 'Marque habituelle',
    barcode: '3012345678914',
    variant: 'demi-écrémé',
    quantity: 6,
    unit: 'L',
    productUrl: 'https://www.leclercdrive.fr/search?q=lait%20demi-%C3%A9cr%C3%A9m%C3%A9%206L',
    searchUrl: 'https://www.leclercdrive.fr/search?q=lait%20demi-%C3%A9cr%C3%A9m%C3%A9%206L',
    matchType: 'exact_barcode',
    confidenceScore: 100,
    confidenceReasons: ['Même code-barres', 'Même format'],
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'cand-lait-hyperu-mdd',
    productId: 'prod-lait-demi-ecreme',
    storeKey: 'hyperu',
    name: 'Lait demi-écrémé UHT marque U 6 x 1 L',
    brand: 'Marque U',
    variant: 'demi-écrémé',
    quantity: 6,
    unit: 'L',
    productUrl: 'https://www.coursesu.com/recherche?text=lait%20demi-%C3%A9cr%C3%A9m%C3%A9%206L',
    searchUrl: 'https://www.coursesu.com/recherche?text=lait%20demi-%C3%A9cr%C3%A9m%C3%A9%206L',
    matchType: 'private_label',
    confidenceScore: 76,
    confidenceReasons: ['Même type de produit', 'Même format', 'Marque différente'],
    createdAt: seedDate,
    updatedAt: seedDate
  }
];

export const mockPriceSnapshots: PriceSnapshot[] = [
  {
    id: 'price-ice-tea-leclerc',
    candidateId: 'cand-ice-tea-leclerc-exact',
    storeKey: 'leclerc',
    price: 1.89,
    currency: 'EUR',
    unitPrice: 1.26,
    comparisonUnit: 'liter',
    available: true,
    checkedAt: seedDate,
    source: 'mock'
  },
  {
    id: 'price-ice-tea-hyperu-format',
    candidateId: 'cand-ice-tea-hyperu-format',
    storeKey: 'hyperu',
    price: 2.2,
    currency: 'EUR',
    unitPrice: 1.1,
    comparisonUnit: 'liter',
    available: true,
    checkedAt: seedDate,
    source: 'mock'
  },
  {
    id: 'price-ice-tea-hyperu-mdd',
    candidateId: 'cand-ice-tea-hyperu-mdd',
    storeKey: 'hyperu',
    price: 1.35,
    currency: 'EUR',
    unitPrice: 0.9,
    comparisonUnit: 'liter',
    available: true,
    checkedAt: seedDate,
    source: 'mock'
  },
  {
    id: 'price-lait-leclerc',
    candidateId: 'cand-lait-leclerc-exact',
    storeKey: 'leclerc',
    price: 5.94,
    currency: 'EUR',
    unitPrice: 0.99,
    comparisonUnit: 'liter',
    available: true,
    checkedAt: seedDate,
    source: 'mock'
  },
  {
    id: 'price-lait-hyperu',
    candidateId: 'cand-lait-hyperu-mdd',
    storeKey: 'hyperu',
    price: 5.7,
    currency: 'EUR',
    unitPrice: 0.95,
    comparisonUnit: 'liter',
    available: true,
    checkedAt: seedDate,
    source: 'mock'
  }
];
