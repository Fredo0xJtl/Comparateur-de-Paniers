import { Suspense, useEffect } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { appRoutes } from './navigation';
import { ErrorBoundary } from './ErrorBoundary';
import { lazyRoute } from './lazyRoute';
import { useSwipeNavigation } from './useSwipeNavigation';
import { HomePage } from '../pages/HomePage';
import { applyTheme, getSettings } from '../features/settings/settingsService';

// Chargées à la demande : le scanner tire @zxing/library (la plus grosse
// dépendance de l'app, inutile tant qu'on n'ouvre pas la caméra) et chaque
// page traîne ses propres services. Tout regrouper dans le bundle d'entrée
// faisait payer ~860 kB à l'ouverture, y compris à quelqu'un qui ne consulte
// que l'accueil. HomePage reste en statique : c'est la première vue, la
// charger en différé n'apporterait qu'un écran d'attente supplémentaire.
const ScanPage = lazyRoute(() => import('../features/scan/ScanPage'), 'ScanPage');
const ProductsPage = lazyRoute(() => import('../pages/ProductsPage'), 'ProductsPage');
const ShoppingListPage = lazyRoute(() => import('../pages/ShoppingListPage'), 'ShoppingListPage');
const ComparePage = lazyRoute(() => import('../pages/ComparePage'), 'ComparePage');
const SettingsPage = lazyRoute(() => import('../pages/SettingsPage'), 'SettingsPage');

export function App() {
  const location = useLocation();
  const { onTouchStart, onTouchEnd } = useSwipeNavigation(location.pathname);

  useEffect(() => {
    // Applique le thème enregistré dès le premier rendu ; un léger flash au
    // thème système par défaut est possible le temps de lire IndexedDB (async),
    // sans conséquence pratique (réglage qui change rarement, app déjà en cache).
    void getSettings().then((settings) => applyTheme(settings.theme));
  }, []);

  return (
    <div className="appShell">
      <header className="appHeader">
        <div className="appHeaderBrand">
          <img className="appLogo" src="/icon.svg" alt="" />
          <div>
            <h1>Comparateur de Paniers</h1>
            <p className="appTagline">
              Comparez les prix entre drive, validez, puis remplissez votre panier automatiquement.
            </p>
          </div>
        </div>
      </header>

      <nav className="topNav" aria-label="Navigation principale">
        {appRoutes.map((route) => (
          <NavLink
            key={route.path}
            to={route.path}
            className={({ isActive }) => (isActive ? 'navLink navLinkActive' : 'navLink')}
            end={route.path === '/'}
          >
            {route.shortLabel}
          </NavLink>
        ))}
      </nav>

      <main className="appMain" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        {/* La barrière est placée à l'intérieur du shell : une page qui casse
            laisse la navigation utilisable, au lieu de faire disparaître
            l'application entière. La clé sur le chemin courant la réarme à
            chaque changement de page — sans elle, React garderait l'état
            d'erreur affiché même après avoir navigué ailleurs. */}
        <ErrorBoundary key={location.pathname}>
          <Suspense fallback={<p className="loadingHint">Chargement…</p>}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/scan" element={<ScanPage />} />
              <Route path="/produits" element={<ProductsPage />} />
              <Route path="/liste" element={<ShoppingListPage />} />
              <Route path="/comparaison" element={<ComparePage />} />
              <Route path="/parametres" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
