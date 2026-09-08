export const DB_NAME = 'drive-price-splitter';

export const DB_VERSION = 9;

export const dbSchema = {
  products: 'id, barcode, name, brand, category, lastUsedAt, updatedAt',
  userStores: 'id, storeKey, city, createdAt',
  productCandidates:
    'id, productId, storeKey, barcode, matchType, confidenceScore, isRejected, isValidated',
  priceSnapshots: 'id, candidateId, storeKey, checkedAt, source',
  shoppingLists: 'id, status, updatedAt',
  shoppingListItems: 'id, shoppingListId, productId, [shoppingListId+productId], createdAt',
  settings: 'id, updatedAt',
  storeSearchCache: 'queryKey, createdAt',
  driveSearchMemory: '[productId+storeKey], storeKey, updatedAt',
  validatedBaskets: 'id, operationKey, storeKey, validatedAt',
  productCache: 'barcode, cachedAt',
  // Correction manuelle "Hyper U" : URL produit collée par l'utilisateur
  // quand la recherche automatique se trompe. Hyper U a de vraies URLs
  // produit stables (contrairement à Leclerc, corrigé via un choix direct
  // sur la page — voir DriveLivePickJobV1) ; le prochain rafraîchissement
  // navigue directement vers cette URL au lieu de relancer la cascade.
  driveManualOverrides: '[productId+storeKey], storeKey, updatedAt',
  // Synchronisation multi-appareils via le Raspberry (voir features/sync) :
  // une ligne par table synchronisée, retenant le curseur de la dernière
  // synchro réussie dans chaque sens. Reste local à l'appareil — jamais
  // synchronisée elle-même.
  syncCursors: 'table'
} as const;

// Curseur de synchro pour UNE table, retenu localement (jamais synchronisé
// lui-même). Défini ici, au même endroit que la table qui le stocke, et non
// dans `src/features/sync/` : ce dossier est retiré de la version publiée
// (voir tools/publier-vers-public.mjs) alors que le schéma Dexie, lui, est
// identique dans les deux dépôts. Le déclarer côté fonctionnalité laissait
// `db.ts` avec un import vers un fichier absent en public, donc un build
// cassé (trouvé à l'audit du 05/09).
//
// La table elle-même est conservée dans la version publiée bien que rien ne
// l'y remplisse : la retirer changerait la version du schéma et ferait
// diverger les migrations entre les deux dépôts, pour une table vide.
// `table` est un simple `string` ici, et non la liste fermée des tables
// sauvegardées : ce fichier ne dépend d'aucun autre par choix (il décrit le
// stockage, pas les fonctionnalités). Le type précis reste côté synchro, dans
// src/features/sync/syncTypes.ts.
export interface SyncCursorEntry {
  table: string;
  lastPulledAt?: string;
  lastPushedAt?: string;
}
