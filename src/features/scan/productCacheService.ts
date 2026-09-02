import { db } from '../../db/db';
import type { Product } from '../../types/domain';

export type CacheSource = 'local' | 'off' | 'not_found' | 'hyperu_only' | 'leclerc_only';

export interface CachedProductEntry {
  id?: string;
  barcode: string;
  productId?: string;
  productName?: string;
  productBrand?: string;
  source: CacheSource;
  cachedAt: string;
  expiresAt?: string;
  storeAvailability?: {
    hyperu: boolean;
    leclerc: boolean;
  };
}

const CACHE_TTL_DAYS = 30;

export async function getCachedProduct(barcode: string): Promise<CachedProductEntry | null> {
  try {
    // `barcode` est la clé primaire de la table (voir dbSchema) : un `get`
    // direct évite le parcours d'index de `where().equals().first()`, et la
    // table typée `db.productCache` conserve le typage Dexie que
    // `db.table('productCache')` faisait perdre.
    const entry = await db.productCache.get(barcode);
    if (!entry) return null;

    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      await deleteCachedProduct(barcode);
      return null;
    }

    return entry;
  } catch {
    return null;
  }
}

export async function setCachedProduct(
  barcode: string,
  product: Product | null,
  source: CacheSource,
  storeAvailability?: { hyperu: boolean; leclerc: boolean }
): Promise<void> {
  try {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

    const entry: CachedProductEntry = {
      barcode,
      productId: product?.id,
      productName: product?.name,
      productBrand: product?.brand,
      source,
      cachedAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      storeAvailability
    };

    await db.productCache.put(entry);
  } catch {
    // Silencieusement ignorer si le cache échoue
  }
}

export async function deleteCachedProduct(barcode: string): Promise<void> {
  try {
    await db.productCache.delete(barcode);
  } catch {
    // Ignorer
  }
}

// La purge par TTL était uniquement paresseuse : une entrée expirée n'était
// supprimée que si le même code-barres était rescanné. Les codes scannés une
// seule fois — le cas le plus fréquent — restaient donc indéfiniment en base.
// Appelé au démarrage de l'app.
export async function purgeExpiredProductCache(): Promise<number> {
  try {
    const now = new Date().toISOString();
    return await db.productCache.filter((entry) => Boolean(entry.expiresAt && entry.expiresAt < now)).delete();
  } catch {
    return 0;
  }
}

export async function setCachedUnistore(
  barcode: string,
  product: Product | null,
  availableAt: 'hyperu' | 'leclerc'
): Promise<void> {
  const storeAvailability = {
    hyperu: availableAt === 'hyperu',
    leclerc: availableAt === 'leclerc'
  };

  const source = availableAt === 'hyperu' ? 'hyperu_only' : 'leclerc_only';
  await setCachedProduct(barcode, product, source, storeAvailability);
}

export async function clearProductCache(): Promise<void> {
  try {
    await db.productCache.clear();
  } catch {
    // Ignorer
  }
}

export function formatCacheAge(cachedAt: string): string {
  const now = new Date();
  const cached = new Date(cachedAt);
  const diffMs = now.getTime() - cached.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'à l\'instant';
  if (diffMins < 60) return `il y a ${diffMins}m`;
  if (diffHours < 24) return `il y a ${diffHours}h`;
  return `il y a ${diffDays}j`;
}
