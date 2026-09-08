import { db } from './db';

// Réinitialisation « paramètres d'usine » (demande explicite du 01/09) :
// vide TOUTES les tables IndexedDB, y compris celles hors du périmètre de
// backupService (caches techniques) — contrairement à resetDemoData() qui
// remplace le contenu par des données de démonstration, ceci ne remet rien à
// la place. Irréversible : la confirmation se fait côté UI (SettingsPage).
export async function wipeAllLocalData(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.products,
      db.userStores,
      db.productCandidates,
      db.priceSnapshots,
      db.shoppingLists,
      db.shoppingListItems,
      db.settings,
      db.storeSearchCache,
      db.driveSearchMemory,
      db.validatedBaskets,
      db.productCache,
      db.driveManualOverrides,
      db.syncCursors
    ],
    async () => {
      await Promise.all([
        db.products.clear(),
        db.userStores.clear(),
        db.productCandidates.clear(),
        db.priceSnapshots.clear(),
        db.shoppingLists.clear(),
        db.shoppingListItems.clear(),
        db.settings.clear(),
        db.storeSearchCache.clear(),
        db.driveSearchMemory.clear(),
        db.validatedBaskets.clear(),
        db.productCache.clear(),
        db.driveManualOverrides.clear(),
        db.syncCursors.clear()
      ]);
    }
  );
}

// Deux tables gardaient indéfiniment des lignes que plus rien ne lit :
//
//   - storeSearchCache : une entrée par ville recherchée, avec un TTL de 24 h
//     *vérifié à la lecture* mais jamais suivi d'une suppression. Chaque ville
//     cherchée une fois y laisse une trace définitive — y compris la liste des
//     magasins retournés par Nominatim, c'est-à-dire une donnée de
//     localisation que rien ne justifie de conserver au-delà du cache.
//   - driveSearchMemory : sa clé [productId+storeKey] borne naturellement sa
//     taille, mais les entrées d'un produit supprimé depuis restent
//     orphelines, et celles au-delà du TTL de 14 jours sont ignorées à la
//     lecture sans jamais être effacées.
//
// Aucune de ces suppressions n'est visible par l'utilisateur : ce sont
// exactement les lignes que le code considère déjà comme périmées.

const STORE_SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DRIVE_SEARCH_MEMORY_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// Écrite par storeLocatorService.reserveRemoteRequest() pour faire respecter
// la cadence d'appel de Nominatim. Elle vit dans la même table mais n'est pas
// un résultat de recherche : la purger relâcherait la limite de débit.
const RATE_LIMIT_KEY = '__nominatim_last_request__';

export type MaintenanceReport = {
  storeSearchCache: number;
  driveSearchMemory: number;
  orphanedProductCandidates: number;
  orphanedPriceSnapshots: number;
  orphanedShoppingListItems: number;
};

export async function purgeExpiredCaches(now = Date.now()): Promise<MaintenanceReport> {
  const [storeSearchCache, driveSearchMemory] = await Promise.all([
    purgeStoreSearchCache(now),
    purgeDriveSearchMemory(now)
  ]);
  // Nettoyage des orphelins laissés par l'ancien deleteProduct() (bug réel
  // confirmé le 01/09, corrigé côté productService.ts) : une base déjà
  // touchée par ce bug garde ces lignes tant que rien ne les repasse ici,
  // c'était d'ailleurs ce qui bloquait l'export de sauvegarde (validation de
  // cohérence en échec sur "référence orpheline dans productCandidates").
  const { orphanedProductCandidates, orphanedPriceSnapshots, orphanedShoppingListItems } =
    await purgeOrphanedReferences();

  return { storeSearchCache, driveSearchMemory, orphanedProductCandidates, orphanedPriceSnapshots, orphanedShoppingListItems };
}

async function purgeOrphanedReferences() {
  try {
    const knownProductIds = new Set(await db.products.toCollection().primaryKeys());
    const orphanedCandidateIds = await db.productCandidates
      .filter((candidate) => !knownProductIds.has(candidate.productId))
      .primaryKeys();
    const orphanedProductCandidates = orphanedCandidateIds.length
      ? await db.productCandidates.bulkDelete(orphanedCandidateIds).then(() => orphanedCandidateIds.length)
      : 0;

    const knownCandidateIds = new Set(await db.productCandidates.toCollection().primaryKeys());
    const orphanedPriceSnapshots = await db.priceSnapshots
      .filter((snapshot) => !knownCandidateIds.has(snapshot.candidateId))
      .delete();

    const knownListIds = new Set(await db.shoppingLists.toCollection().primaryKeys());
    const orphanedShoppingListItems = await db.shoppingListItems
      .filter((item) => !knownProductIds.has(item.productId) || !knownListIds.has(item.shoppingListId))
      .delete();

    return { orphanedProductCandidates, orphanedPriceSnapshots, orphanedShoppingListItems };
  } catch {
    // Même logique que les autres purges : du confort, jamais bloquant.
    return { orphanedProductCandidates: 0, orphanedPriceSnapshots: 0, orphanedShoppingListItems: 0 };
  }
}

async function purgeStoreSearchCache(now: number): Promise<number> {
  try {
    return await db.storeSearchCache
      .filter(
        (entry) =>
          entry.queryKey !== RATE_LIMIT_KEY &&
          now - Date.parse(entry.createdAt) > STORE_SEARCH_CACHE_TTL_MS
      )
      .delete();
  } catch {
    // La maintenance est du confort : elle ne doit jamais empêcher l'app de
    // démarrer si IndexedDB est indisponible ou en cours de migration.
    return 0;
  }
}

async function purgeDriveSearchMemory(now: number): Promise<number> {
  try {
    const knownProductIds = new Set(await db.products.toCollection().primaryKeys());

    return await db.driveSearchMemory
      .filter(
        (entry) =>
          !knownProductIds.has(entry.productId) ||
          now - Date.parse(entry.updatedAt) > DRIVE_SEARCH_MEMORY_TTL_MS
      )
      .delete();
  } catch {
    return 0;
  }
}
