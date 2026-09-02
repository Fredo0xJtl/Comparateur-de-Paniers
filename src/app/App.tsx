import { Suspense } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { appRoutes } from './navigation';
import { ErrorBoundary } from './ErrorBoundary';
import { lazyRoute } from './lazyRoute';
import { HomePage } from '../pages/HomePage';

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

  return (
    <div className="appShell">
      <header className="appHeader">
        <p className="appKicker">Comparateur de Paniers</p>
        <h1>Comparer les prix, puis remplir le panier avec votre accord</h1>
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

      <main className="appMain">
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
