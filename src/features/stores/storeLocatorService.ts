import { db } from '../../db/db';
import {
  type StoreKey,
  type StoreLocatorResult,
  type StoreSearchCacheEntry,
  type UserStore
} from '../../types/domain';
import { searchNominatimStores } from './storeLocatorClient';
import { isVerboseDiagnosticsEnabled } from '../drive-bridge/verboseDiagnostics';

const CACHE_DURATION_MS = 24 * 60 * 60 * 1000;
const MINIMUM_REMOTE_INTERVAL_MS = 1_000;
const RATE_LIMIT_KEY = '__nominatim_last_request__';

type SearchFunction = (input: {
  storeKey: StoreKey;
  city: string;
}) => Promise<StoreLocatorResult[]>;

export function createStoreLocatorService(options?: {
  search?: SearchFunction;
  now?: () => number;
}) {
  const search = options?.search ?? searchNominatimStores;
  const now = options?.now ?? Date.now;
  return {
    async findStores(input: { storeKey: StoreKey; city: string }) {
      const city = normalizeCity(input.city);
      const queryKey = `${input.storeKey}:${city.toLocaleLowerCase('fr')}`;
      const cached = await db.storeSearchCache.get(queryKey);
      const currentTime = now();

      if (cached && currentTime - Date.parse(cached.createdAt) < CACHE_DURATION_MS) {
        return cached.results;
      }

      await reserveRemoteRequest(currentTime);
      const results = await search({ storeKey: input.storeKey, city });
      const entry: StoreSearchCacheEntry = {
        queryKey,
        results,
        createdAt: new Date(currentTime).toISOString()
      };
      await db.storeSearchCache.put(entry);
      return results;
    },

    async selectUserStore(result: StoreLocatorResult) {
      const timestamp = new Date(now()).toISOString();
      const store: UserStore = {
        id: `store-${result.storeKey}-${result.osmType}-${result.osmId}`,
        storeKey: result.storeKey,
        displayName: result.displayName,
        postalCode: result.postalCode,
        city: result.city,
        address: result.address,
        latitude: result.latitude,
        longitude: result.longitude,
        osmType: result.osmType,
        osmId: result.osmId,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      await db.transaction('rw', db.userStores, async () => {
        await db.userStores.where('storeKey').equals(result.storeKey).delete();
        await db.userStores.put(store);
      });
      return store;
    },

    async listSelectedStores() {
      const stores = await db.userStores.toArray();
      // Include both OSM-found stores (osmId !== undefined) and manually-created stores
      // (no osmId but created via manual URL entry). Return a store if it has any
      // meaningful data: either osmId or a driveUrl.
      const filtered = stores.filter((store) => store.osmId !== undefined || !!store.driveUrl);

      // Un même storeKey ne doit jamais apparaître deux fois : chaque entrée
      // devient une ligne de `job.stores` côté extension, et le job-runner
      // relance toute la collecte (tous les produits) pour CHAQUE entrée —
      // un doublon fait donc tourner la recherche Drive plusieurs fois de
      // suite sur les mêmes produits, silencieusement. `selectUserStore`
      // et `handleCreateManualStore` évitent déjà d'en créer, mais ceci
      // protège aussi les bases qui en contiennent déjà (résidu d'un bug
      // corrigé, ou toute future régression) : on garde uniquement l'entrée
      // la plus récemment mise à jour par storeKey.
      const dedupedByStoreKey = new Map<string, (typeof filtered)[number]>();
      for (const store of filtered) {
        const existing = dedupedByStoreKey.get(store.storeKey);
        if (!existing || Date.parse(store.updatedAt) >= Date.parse(existing.updatedAt)) {
          dedupedByStoreKey.set(store.storeKey, store);
        }
      }
      const deduped = [...dedupedByStoreKey.values()];

      // Le filet de sécurité ci-dessus ne fait que masquer les doublons à la
      // lecture — il ne nettoie jamais la base. Un résidu du bug "boucle x3"
      // corrigé précédemment (plusieurs entrées `userStores` pour un même
      // storeKey, créées avant le fix) restait donc en base indéfiniment :
      // sans impact direct sur le job (déjà dédupliqué ici), mais source de
      // confusion et de logs trompeurs. On supprime maintenant les entrées
      // perdantes de la dédup (id différent de celle conservée pour son
      // storeKey).
      const keptIds = new Set(deduped.map((store) => store.id));
      const staleDuplicates = filtered.filter((store) => !keptIds.has(store.id));
      if (staleDuplicates.length > 0) {
        await db.userStores.bulkDelete(staleDuplicates.map((store) => store.id));
      }

      // Restore URLs from localStorage backup if IndexedDB was cleared
      // (happens on extension redeploys). If a store has no driveUrl but
      // localStorage has a backup, restore it.
      const verbose = isVerboseDiagnosticsEnabled();
      if (typeof localStorage !== 'undefined') {
        const backup = JSON.parse(localStorage.getItem('drive-url-backup') ?? '{}');
        if (verbose) console.log('[storeLocatorService] localStorage backup:', backup);
        for (const store of filtered) {
          if (verbose) {
            console.log(`[storeLocatorService] ${store.storeKey}: driveUrl=${store.driveUrl}, backup=${backup[store.storeKey]}`);
          }
          if (!store.driveUrl && backup[store.storeKey]) {
            if (verbose) console.log(`[storeLocatorService] Restoring ${store.storeKey} URL from localStorage:`, backup[store.storeKey]);
            store.driveUrl = backup[store.storeKey];
            await db.userStores.put(store);
          }
        }
      }

      if (verbose) {
        console.log('[storeLocatorService] listSelectedStores returning:', deduped.map((s) => ({ storeKey: s.storeKey, hasUrl: !!s.driveUrl })));
      }
      return deduped;
    },

    async saveStoreDriveUrl(storeId: string, driveUrl: string) {
      const trimmed = driveUrl.trim();
      const store = await db.userStores.get(storeId);
      if (!store) {
        throw new Error('Magasin introuvable.');
      }
      if (trimmed === '') {
        const { driveUrl: _removed, ...rest } = store;
        await db.userStores.put({ ...rest, updatedAt: new Date(now()).toISOString() });
        return { ...rest, updatedAt: new Date(now()).toISOString() } as UserStore;
      }
      if (!isValidStoreDriveUrl(trimmed, store.storeKey)) {
        throw new Error("L'URL doit pointer vers le site officiel du Drive (leclercdrive.fr ou coursesu.com).");
      }
      // A manually-pasted URL can point at a completely different branch than
      // the one originally found via OSM search. If city/displayName/address
      // are left as-is, they go stale — and the extension's on-site store
      // re-selection (leclerc-store-selection.js) scores its candidates
      // against exactly these fields, so a stale city silently makes it pick
      // the wrong branch (or none at all or none at all, it can't find one)
      // even though driveUrl itself is correct. Re-derive them from the URL
      // whenever possible so automation stays in sync with what's displayed.
      const parsedLocation = parseDriveUrlLocation(trimmed, store.storeKey);
      const { address: _staleAddress, postalCode: _stalePostalCode, ...rest } = store;
      const updated: UserStore = {
        ...rest,
        driveUrl: trimmed,
        ...(parsedLocation
          ? {
              city: parsedLocation.city,
              displayName: parsedLocation.branchName
                ? `${parsedLocation.branchName} ${parsedLocation.city}`
                : parsedLocation.city
            }
          : { city: '', displayName: '' }),
        updatedAt: new Date(now()).toISOString()
      };
      // A different branch can have a completely different catalog, so any
      // "not_found"/"matched" memory recorded against the old branch is no
      // longer trustworthy — without this, products wrongly marked
      // not_found under the previous (possibly stale-city, mismatched)
      // branch would keep being silently skipped on every future refresh
      // until their 14-day expiry, even though the underlying bug is fixed.
      await db.driveSearchMemory.where('storeKey').equals(store.storeKey).delete();
      await db.userStores.put(updated);
      // Backup URLs to localStorage for persistence across IndexedDB clears
      // (which happen on extension redeploys). If IndexedDB is cleared but
      // localStorage survives, we can restore the URL on next load.
      if (typeof localStorage !== 'undefined') {
        const backup = JSON.parse(localStorage.getItem('drive-url-backup') ?? '{}');
        backup[store.storeKey] = trimmed;
        localStorage.setItem('drive-url-backup', JSON.stringify(backup));
        if (isVerboseDiagnosticsEnabled()) {
          console.log(`[storeLocatorService] Saved ${store.storeKey} URL to localStorage:`, trimmed);
          console.log('[storeLocatorService] Full localStorage backup:', backup);
        }
      } else {
        console.warn('[storeLocatorService] localStorage not available!');
      }
      return updated;
    }
  };
}

// Kept in sync with the display-only parser in StoreLocatorPanel.tsx (that
// one only formats a label; this one feeds the actual UserStore fields the
// extension uses to re-select the store on-site).
export function parseDriveUrlLocation(
  driveUrl: string,
  storeKey: StoreKey
): { city: string; branchName: string | null } | null {
  try {
    const url = new URL(driveUrl);
    if (storeKey === 'leclerc') {
      const lastSegment = url.pathname.split('/').filter(Boolean).pop() ?? '';
      const withoutExtension = lastSegment.replace(/\.[a-z0-9]+$/i, '');
      const withoutPrefix = withoutExtension.replace(/^magasin-/i, '');
      const [cityPart, namePart] = withoutPrefix.split('---');
      const city = cityPart
        ? titleCase(
            cityPart
              .split('-')
              .filter((token) => token && !/^\d+$/.test(token))
              .join(' ')
          )
        : '';
      const branchName = namePart ? titleCase(namePart.replace(/-/g, ' ')) : null;
      return city ? { city, branchName } : null;
    }
    const segment = url.pathname.split('/').filter(Boolean)[0] ?? '';
    const city = segment
      .split('-')
      .filter((token) => token && !/^(drive|hyperu|u|courses)$/i.test(token))
      .join(' ');
    return city ? { city: titleCase(city), branchName: null } : null;
  } catch {
    return null;
  }
}

function titleCase(value: string) {
  return value
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function isValidStoreDriveUrl(value: string, storeKey: StoreKey) {
  if (value.length > 2_000) return false;
  try {
    const url = new URL(value);
    const allowedHost =
      storeKey === 'leclerc'
        ? url.hostname === 'leclercdrive.fr' || url.hostname.endsWith('.leclercdrive.fr')
        : url.hostname === 'coursesu.com' || url.hostname.endsWith('.coursesu.com');
    return url.protocol === 'https:' && allowedHost;
  } catch {
    return false;
  }
}

async function reserveRemoteRequest(currentTime: number) {
  await db.transaction('rw', db.storeSearchCache, async () => {
    const previousRequest = await db.storeSearchCache.get(RATE_LIMIT_KEY);
    if (
      previousRequest &&
      currentTime - Date.parse(previousRequest.createdAt) < MINIMUM_REMOTE_INTERVAL_MS
    ) {
      throw new Error('Patiente une seconde avant une nouvelle recherche.');
    }

    await db.storeSearchCache.put({
      queryKey: RATE_LIMIT_KEY,
      results: [],
      createdAt: new Date(currentTime).toISOString()
    });
  });
}

function normalizeCity(city: string) {
  const normalized = city.trim().replace(/\s+/g, ' ');
  if (normalized.length < 2 || normalized.length > 100) {
    throw new Error('Renseigne une ville valide.');
  }
  return normalized;
}

const storeLocatorService = createStoreLocatorService();

export const findStores = storeLocatorService.findStores;
export const selectUserStore = storeLocatorService.selectUserStore;
export const listSelectedStores = storeLocatorService.listSelectedStores;
export const saveStoreDriveUrl = storeLocatorService.saveStoreDriveUrl;
