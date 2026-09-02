import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

// Balayage des données périmées une fois l'app affichée : les TTL du cache
// produits, du cache de recherche de magasins et de la mémoire de recherche
// Drive étaient tous vérifiés à la lecture, mais aucun ne supprimait quoi que
// ce soit — les lignes jamais relues restaient en base indéfiniment. Chargés
// dynamiquement pour ne pas ramener la couche base de données dans le bundle
// d'entrée.
const scheduleMaintenance =
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback
    : (callback: () => void) => setTimeout(callback, 2_000);

scheduleMaintenance(() => {
  void import('./features/scan/productCacheService').then((module) =>
    module.purgeExpiredProductCache()
  );
  void import('./db/maintenance').then((module) => module.purgeExpiredCaches());
});
