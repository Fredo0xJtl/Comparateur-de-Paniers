import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadActiveComparison } from '../features/comparison/comparisonService';
import { getSavingsSummary } from '../features/basket-history/basketHistoryService';
import { StoreLocatorPanel } from '../features/stores/StoreLocatorPanel';
import { listSelectedStores } from '../features/stores/storeLocatorService';
import { formatEuro } from '../utils/formatMoney';

type LoadStatus = 'loading' | 'ready' | 'error';

type GuideStep = {
  id: 'magasins' | 'liste' | 'comparer';
  title: string;
  description: string;
  done: boolean;
  action: { label: string; to: string };
};

export function HomePage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [hyperuTotal, setHyperuTotal] = useState<number | null>(null);
  const [leclercTotal, setLeclercTotal] = useState<number | null>(null);
  const [savings, setSavings] = useState<{ estimated: number; validated: number; realized: number } | null>(null);
  const [listCount, setListCount] = useState(0);
  const [storeCount, setStoreCount] = useState(0);

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const [comparison, savings] = await Promise.all([
          loadActiveComparison(),
          getSavingsSummary()
        ]);
        if (ignore) return;
        setHyperuTotal(comparison.result?.totals.hyperu ?? null);
        setLeclercTotal(comparison.result?.totals.leclerc ?? null);
        setListCount(comparison.rows?.length ?? 0);
        setSavings(savings);
        setStatus('ready');
      } catch {
        if (!ignore) setStatus('error');
      }
    }

    void load();
    // Lecture séparée : si elle échoue, le guide considère simplement les
    // magasins comme non choisis, sans masquer le reste de la page.
    void listSelectedStores()
      .then((stores) => {
        if (!ignore) setStoreCount(countStores(stores));
      })
      .catch(() => undefined);
    return () => {
      ignore = true;
    };
  }, []);

  // Tant que rien n'a été comparé, des « 0.00 € » partout ne disent rien à
  // quelqu'un qui découvre l'application : les chiffres n'apparaissent
  // qu'une fois qu'ils ont un sens.
  const hasFigures =
    hyperuTotal !== null ||
    leclercTotal !== null ||
    (savings !== null && (savings.validated > 0 || savings.realized > 0));
  const hasCompared = hyperuTotal !== null || leclercTotal !== null;

  const steps: GuideStep[] = [
    {
      id: 'magasins',
      title: 'Choisir tes magasins',
      description:
        storeCount >= 2
          ? 'Tes deux magasins sont enregistrés.'
          : storeCount === 1
            ? 'Un magasin enregistré sur deux. Ajoute le second pour pouvoir comparer.'
            : 'Indique ton Leclerc Drive et ton Courses U : les prix changent d’un magasin à l’autre.',
      done: storeCount >= 2,
      action: { label: 'Choisir mes magasins', to: '#mes-magasins' }
    },
    {
      id: 'liste',
      title: 'Faire ta liste de courses',
      description:
        listCount > 0
          ? `${listCount} produit${listCount > 1 ? 's' : ''} dans ta liste.`
          : 'Ajoute tes produits en tapant leur nom ou en scannant leur code-barres.',
      done: listCount > 0,
      action: { label: 'Ajouter un produit', to: '/scan' }
    },
    {
      id: 'comparer',
      title: 'Comparer et remplir le panier',
      description: hasCompared
        ? 'Ta liste a été comparée. Tu peux relancer la comparaison à tout moment.'
        : 'L’application cherche les prix dans les deux magasins, te montre où chaque produit est le moins cher, puis remplit ton panier.',
      done: hasCompared,
      action: { label: 'Comparer les prix', to: '/comparaison' }
    }
  ];
  const nextStep = steps.find((step) => !step.done);

  return (
    <section className="pageStack" aria-labelledby="home-title">
      <div className="pageTitle">
        <h2 id="home-title">Tes courses au meilleur prix</h2>
        <p className="lead">
          Fais ta liste une fois : l’application compare Leclerc Drive et Courses U, et te dit quoi acheter où.
        </p>
      </div>

      {status !== 'loading' && (
        <div className="settingsPanel" aria-labelledby="guide-title">
          <h3 id="guide-title">{nextStep ? 'Par où commencer' : 'Tout est prêt'}</h3>
          <ol className="welcomeSteps">
            {steps.map((step, index) => {
              const isNext = step.id === nextStep?.id;
              return (
                <li key={step.id} className={step.done ? 'welcomeStep welcomeStepDone' : 'welcomeStep'}>
                  <span className="welcomeStepMark" aria-hidden="true">
                    {step.done ? '✓' : index + 1}
                  </span>
                  <div>
                    <h3>
                      {step.title}
                      {step.done && <span className="welcomeStepBadge"> — c’est fait</span>}
                    </h3>
                    <p>{step.description}</p>
                    {/* Un seul bouton plein à la fois : celui de la prochaine
                        étape à faire. Les étapes déjà faites gardent un lien
                        discret pour y revenir. */}
                    {step.action.to.startsWith('#') ? (
                      !step.done && (
                        <a className={isNext ? 'welcomeStepAction' : 'guideStepLink'} href={step.action.to}>
                          {step.action.label}
                        </a>
                      )
                    ) : (
                      <Link className={isNext ? 'welcomeStepAction' : 'guideStepLink'} to={step.action.to}>
                        {step.action.label}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {hasFigures && (
        <>
          {status === 'ready' && savings !== null && (
            <div className="savingsHero" role="status" aria-label="Économies réalisées cumulées">
              <p className="savingsHeroLabel">Économie réalisée</p>
              <p className="savingsHeroAmount">{formatBrickMoney(status, savings.realized)}</p>
              <div className="savingsHeroDivider" />
              <p className="savingsHeroSub">paniers réellement remplis</p>
              {/* « Estimée » et « validée » étaient le même chiffre affiché
                  deux fois (getSavingsSummary) : une seule ligne, qui dit ce
                  qu'elle mesure. */}
              {savings.validated !== savings.realized && (
                <p className="savingsHeroSub">
                  Économie validée, tous paniers confondus : {formatBrickMoney(status, savings.validated)}
                </p>
              )}
            </div>
          )}

          <div className="statusGrid statusGrid--pair" aria-label="Résumé des paniers">
            <article>
              <span>Panier Hyper U</span>
              <strong>{formatBrickMoney(status, hyperuTotal)}</strong>
            </article>
            <article>
              <span>Panier Leclerc</span>
              <strong>{formatBrickMoney(status, leclercTotal)}</strong>
            </article>
          </div>
        </>
      )}

      <div id="mes-magasins" className="guideAnchor">
        <StoreLocatorPanel onStoresChange={(stores) => setStoreCount(countStores(stores))} />
      </div>
    </section>
  );
}

// Un magasin compte une seule fois par enseigne, même si la base en garde
// plusieurs lignes.
function countStores(stores: ReadonlyArray<{ storeKey: string }>) {
  return new Set(stores.map((store) => store.storeKey)).size;
}

function formatBrickMoney(status: LoadStatus, value: number | null) {
  if (status === 'loading') return '…';
  if (status === 'error' || value === null) return '—';
  return formatEuro(value);
}
