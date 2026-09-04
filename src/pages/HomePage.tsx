import { useEffect, useState } from 'react';
import { loadActiveComparison } from '../features/comparison/comparisonService';
import { getSavingsSummary } from '../features/basket-history/basketHistoryService';
import { StoreLocatorPanel } from '../features/stores/StoreLocatorPanel';

type LoadStatus = 'loading' | 'ready' | 'error';

export function HomePage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [hyperuTotal, setHyperuTotal] = useState<number | null>(null);
  const [leclercTotal, setLeclercTotal] = useState<number | null>(null);
  const [savings, setSavings] = useState<{ estimated: number; validated: number; realized: number } | null>(null);

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
        setSavings(savings);
        setStatus('ready');
      } catch {
        if (!ignore) setStatus('error');
      }
    }

    void load();
    return () => {
      ignore = true;
    };
  }, []);

  return (
    <section className="pageStack" aria-labelledby="home-title">
      <div className="pageTitle">
        <h2 id="home-title">Panier optimisé Hyper U / Leclerc</h2>
      </div>

      {status === 'ready' && savings !== null && (
        <div className="savingsHero" role="status" aria-label="Économies réalisées cumulées">
          <p className="savingsHeroLabel">Économie réalisée</p>
          <p className="savingsHeroAmount">{formatBrickMoney(status, savings.realized)}</p>
          <div className="savingsHeroDivider" />
          <p className="savingsHeroSub">confirmé après remplissage du panier</p>
        </div>
      )}

      <div className="statusGrid statusGrid--pair" aria-label="Niveaux d’économie cumulés">
        <article>
          <span>Économie estimée</span>
          <strong>{formatBrickMoney(status, savings?.estimated ?? null)}</strong>
        </article>
        <article>
          <span>Économie validée</span>
          <strong>{formatBrickMoney(status, savings?.validated ?? null)}</strong>
        </article>
      </div>

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

      <StoreLocatorPanel />
    </section>
  );
}

function formatBrickMoney(status: LoadStatus, value: number | null) {
  if (status === 'loading') return '…';
  if (status === 'error' || value === null) return '—';
  return `${value.toFixed(2)} €`;
}
