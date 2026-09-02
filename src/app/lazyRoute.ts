import { lazy, type ComponentType } from 'react';

// Un import dynamique qui échoue une fois est définitivement perdu pour
// React.lazy : la promesse rejetée est mémorisée, et toute nouvelle tentative
// de rendu rejette immédiatement sans même retenter le réseau. Or l'échec le
// plus courant ici est passager — perte de réseau d'une seconde en mobilité,
// ou coupure le temps d'un changement de cellule. Une seconde tentative
// suffit à absorber ce cas ; au-delà, l'échec remonte à l'ErrorBoundary, qui
// propose un rechargement (le seul remède quand le fichier visé n'existe plus
// côté serveur, après un redéploiement).
const RETRY_DELAY_MS = 600;

export async function loadWithRetry<T>(
  load: () => Promise<Record<string, unknown>>,
  exportName: string,
  retryDelayMs = RETRY_DELAY_MS
): Promise<{ default: T }> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const module = await load();
      const component = module[exportName];
      if (typeof component !== 'function') {
        // Un export renommé ou supprimé ne se répare pas en retentant : la
        // faute est dans le code, pas sur le réseau.
        throw new Error(`Export « ${exportName} » introuvable dans le module chargé.`);
      }
      return { default: component as T };
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError;
}

// Les pages de routes ne reçoivent aucune prop : react-router les instancie
// sans argument.
type PageComponent = ComponentType<Record<string, never>>;

export function lazyRoute(load: () => Promise<Record<string, unknown>>, exportName: string) {
  return lazy(() => loadWithRetry<PageComponent>(load, exportName));
}
