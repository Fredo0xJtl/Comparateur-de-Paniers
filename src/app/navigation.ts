export type AppRoute = {
  path: string;
  label: string;
  shortLabel: string;
};

export const appRoutes = [
  { path: '/', label: 'Accueil', shortLabel: 'Accueil' },
  { path: '/scan', label: 'Ajouter un produit', shortLabel: 'Ajouter' },
  { path: '/produits', label: 'Produits', shortLabel: 'Produits' },
  { path: '/liste', label: 'Liste de courses', shortLabel: 'Liste' },
  { path: '/comparaison', label: 'Comparaison', shortLabel: 'Comparer' },
  { path: '/parametres', label: 'Paramètres', shortLabel: 'Réglages' }
] as const satisfies readonly AppRoute[];
