import { db } from './db';
import { type Product, type UserSettings } from '../types/domain';
import {
  mockPriceSnapshots,
  mockProductCandidates,
  mockUserStores
} from '../features/stores/mockStoreData';

const seedDate = '2026-07-07T10:00:00.000Z';

export const demoProducts: Product[] = [
  {
    id: 'prod-ice-tea-peche',
    barcode: '3012345678907',
    name: 'Thé glacé pêche',
    brand: 'Lipton Ice Tea',
    category: 'boissons',
    variant: 'pêche',
    baseQuantity: 1.5,
    baseUnit: 'L',
    comparisonUnit: 'liter',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'prod-lait-demi-ecreme',
    barcode: '3012345678914',
    name: 'Lait demi-écrémé UHT',
    brand: 'Marque habituelle',
    category: 'lait',
    variant: 'demi-écrémé',
    baseQuantity: 6,
    baseUnit: 'L',
    comparisonUnit: 'liter',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'prod-riz-basmati',
    barcode: '3012345678921',
    name: 'Riz basmati',
    brand: 'Marque habituelle',
    category: 'epicerie_seche',
    variant: 'basmati',
    baseQuantity: 1,
    baseUnit: 'kg',
    comparisonUnit: 'kilogram',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'prod-lessive-liquide',
    barcode: '3012345678938',
    name: 'Lessive liquide',
    brand: 'Marque habituelle',
    category: 'entretien',
    variant: 'classique',
    baseQuantity: 40,
    baseUnit: 'unit',
    comparisonUnit: 'wash',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: seedDate,
    updatedAt: seedDate
  },
  {
    id: 'prod-papier-toilette',
    barcode: '3012345678945',
    name: 'Papier toilette',
    brand: 'Marque habituelle',
    category: 'papier_toilette',
    variant: 'triple épaisseur',
    baseQuantity: 12,
    baseUnit: 'unit',
    comparisonUnit: 'roll',
    allowDifferentFormat: true,
    allowPrivateLabel: true,
    createdAt: seedDate,
    updatedAt: seedDate
  }
];

export const defaultSettings: UserSettings = {
  id: 'default',
  savingThresholdEuro: 3,
  autoDecisionMinConfidence: 75,
  preferExactBarcode: true,
  allowPrivateLabelByDefault: true,
  experimentalAddToCart: false,
  maxPriceAgeDays: 7,
  updatedAt: seedDate
};

export async function resetDemoData() {
  await db.transaction(
    'rw',
    db.products,
    db.userStores,
    db.productCandidates,
    db.priceSnapshots,
    db.settings,
    async () => {
      await db.products.clear();
      await db.userStores.clear();
      await db.productCandidates.clear();
      await db.priceSnapshots.clear();
      await db.products.bulkPut(demoProducts);
      await db.userStores.bulkPut(mockUserStores);
      await db.productCandidates.bulkPut(mockProductCandidates);
      await db.priceSnapshots.bulkPut(mockPriceSnapshots);
      await db.settings.put({
        ...defaultSettings,
        updatedAt: new Date().toISOString()
      });
    }
  );
}

export async function ensureDemoData() {
  // Despite the name, this used to unconditionally clear() every table
  // before reseeding it on EVERY call — and it's called from most page
  // loads (ProductsPage, ScanPage, ShoppingListPage, comparisonService,
  // priceRefreshService, settingsService). That meant a real user's saved
  // Leclerc/Hyper U drive URLs in userStores got wiped and replaced by the
  // demo mock stores every time they navigated back to a page, even though
  // real data already existed — confirmed live: URLs kept reverting to the
  // demo URL. Each table now only gets seeded the first time it's actually
  // empty, same "ensure" semantics as the settings table already had below.
  await db.transaction(
    'rw',
    db.products,
    db.userStores,
    db.productCandidates,
    db.priceSnapshots,
    db.settings,
    async () => {
      // DO NOT seed products — these are user data, not demo data.
      // Users delete products and we should not restore them automatically.
      // DO NOT seed userStores — these are user data, not demo data.
      // Users add their own stores via the UI; seeding demo stores causes
      // user-saved URLs (Leclerc, Hyper U) to revert on app restart/redeploy.
      // See git log for "URL Persistence Bug" fixes.
      if ((await db.productCandidates.count()) === 0) {
        await db.productCandidates.bulkPut(mockProductCandidates);
      }
      if ((await db.priceSnapshots.count()) === 0) {
        await db.priceSnapshots.bulkPut(mockPriceSnapshots);
      }

      const settings = await db.settings.get('default');
      if (!settings) {
        await db.settings.put({
          ...defaultSettings,
          updatedAt: new Date().toISOString()
        });
      }
    }
  );
}

export async function listProducts() {
  await ensureDemoData();
  return db.products.orderBy('name').toArray();
}
