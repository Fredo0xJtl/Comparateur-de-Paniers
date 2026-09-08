import { useCallback, useEffect, useState } from 'react';
import { getExtensionBridge } from '../drive-bridge/extensionBridge';
import {
  detectBrowserSupport,
  rememberWelcomeDismissed,
  shouldOpenWelcome,
  type WelcomeState
} from './onboardingService';

/**
 * Interroge le connecteur au chargement, puis décide si la fenêtre d'accueil
 * doit s'ouvrir. Rend aussi `open()` pour le bouton d'aide, qui doit pouvoir
 * la rouvrir à tout moment.
 *
 * La détection est faite ici, une fois, plutôt que dans le composant : elle
 * envoie un message au connecteur et attend sa réponse (2 secondes maximum,
 * voir extensionBridge.ts), ce qu'il ne faut pas rejouer à chaque rendu.
 */
export function useWelcome() {
  const [state, setState] = useState<WelcomeState | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let ignore = false;
    const support = detectBrowserSupport(navigator.userAgent);

    // Un échec n'est pas une erreur : c'est la réponse « connecteur absent »,
    // qui est justement le cas que cette fenêtre existe pour traiter.
    void getExtensionBridge()
      .detectDriveExtension()
      .then(() => true)
      .catch(() => false)
      .then((extensionReady) => {
        if (ignore) return;
        const resolved: WelcomeState = { extensionReady, support };
        setState(resolved);
        setVisible(shouldOpenWelcome(resolved, safeStorage('local'), safeStorage('session')));
      });

    return () => {
      ignore = true;
    };
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    if (state) rememberWelcomeDismissed(state, safeStorage('local'), safeStorage('session'));
  }, [state]);

  const open = useCallback(() => setVisible(true), []);

  return { state, visible, open, close };
}

// `localStorage` lève une exception à la simple lecture quand le navigateur
// bloque le stockage des sites (mode strict, navigation privée sur certaines
// versions) : sans cette précaution, l'application entière ne s'afficherait
// plus au lieu de perdre un simple réglage d'affichage.
function safeStorage(kind: 'local' | 'session') {
  try {
    return kind === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return undefined;
  }
}
