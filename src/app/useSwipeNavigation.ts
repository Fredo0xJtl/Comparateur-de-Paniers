import { useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { appRoutes } from './navigation';

// Seuils empiriques : assez grand pour ne pas confondre un swipe voulu avec
// un simple défilement vertical maladroit, assez petit pour rester réactif
// au pouce sur un écran de téléphone.
const MIN_DISTANCE_PX = 60;
const MAX_OFF_AXIS_PX = 60;
const MAX_DURATION_MS = 800;

type TouchStart = { x: number; y: number; time: number };

/**
 * Swipe horizontal sur la zone principale = page précédente/suivante du
 * bandeau, sans passer par les boutons. L'ordre suivi est celui
 * d'`appRoutes` (le même que l'affichage du bandeau).
 */
export function useSwipeNavigation(currentPath: string) {
  const navigate = useNavigate();
  const startRef = useRef<TouchStart | null>(null);

  const onTouchStart = useCallback((event: React.TouchEvent) => {
    // La zone de prévisualisation caméra a ses propres gestes (cadrage du
    // code-barres) : un swipe qui démarre dessus ne doit pas changer de page.
    if (event.target instanceof Element && event.target.closest('.scanPreviewWrap')) {
      startRef.current = null;
      return;
    }
    const touch = event.touches[0];
    if (!touch) return;
    startRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };
  }, []);

  const onTouchEnd = useCallback(
    (event: React.TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start) return;

      const touch = event.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      const elapsed = Date.now() - start.time;

      if (elapsed > MAX_DURATION_MS) return;
      if (Math.abs(deltaY) > MAX_OFF_AXIS_PX) return;
      if (Math.abs(deltaX) < MIN_DISTANCE_PX) return;

      const currentIndex = appRoutes.findIndex((route) => route.path === currentPath);
      if (currentIndex === -1) return;

      // Swipe vers la gauche (deltaX négatif) = avancer dans le bandeau.
      const nextIndex = deltaX < 0 ? currentIndex + 1 : currentIndex - 1;
      const nextRoute = appRoutes[nextIndex];
      if (nextRoute) navigate(nextRoute.path);
    },
    [currentPath, navigate]
  );

  return { onTouchStart, onTouchEnd };
}
