import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app/App';
import './styles.css';

// `import.meta.env.BASE_URL` vaut '/' partout où l'application est servie à
// la racine (dev, `vite preview`, Raspberry) et '/Comparateur-de-Paniers/'
// pour un build destiné à GitHub Pages — voir `base` dans vite.config.ts.
// Sans `basename`, le routeur croirait que le préfixe fait partie de la route
// et n'afficherait aucune page.
const BASE_PATH = import.meta.env.BASE_URL;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter basename={BASE_PATH}>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  // Le service worker doit être demandé sous le même préfixe, sinon il est
  // introuvable (404) et son scope ne couvrirait de toute façon pas l'app.
  navigator.serviceWorker.register(`${BASE_PATH}sw.js`).catch(() => undefined);
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
