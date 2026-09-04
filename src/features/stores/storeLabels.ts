import { type StoreKey } from '../../types/domain';

// Libellés affichés des enseignes, partagés entre les écrans (comparatif et
// ajout de produit) : deux tables séparées finissaient par diverger au
// premier renommage.
export const storeLabels: Record<StoreKey, string> = {
  leclerc: 'Leclerc',
  hyperu: 'Hyper U'
};
