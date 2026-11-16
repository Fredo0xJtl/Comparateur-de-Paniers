export const DB_NAME = 'drive-price-splitter';

// v10 : retrait de la table `syncCursors` (synchronisation abandonnée). Un
// retrait de table passe toujours par un nouveau numéro, sinon deux schémas
// différents portent le même numéro selon l'appareil.
export const DB_VERSION = 10;

// Tables supprimées, à déclarer `null` pour que Dexie les efface réellement
// sur les appareils qui les ont encore.
export const removedTables = {
  syncCursors: null
} as const;

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
  driveManualOverrides: '[productId+storeKey], storeKey, updatedAt'
} as const;
