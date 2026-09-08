import { describe, expect, it } from 'vitest';
import {
  buildWelcomeSteps,
  detectBrowserSupport,
  rememberWelcomeDismissed,
  shouldOpenWelcome,
  type StorageLike,
  type WelcomeState
} from './onboardingService';

function memoryStorage(): StorageLike & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value)
  };
}

const FIREFOX_ANDROID =
  'Mozilla/5.0 (Android 14; Mobile; rv:129.0) Gecko/129.0 Firefox/129.0';
const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

describe('detectBrowserSupport', () => {
  it('reconnaît Firefox sur ordinateur et sur Android', () => {
    expect(detectBrowserSupport('Mozilla/5.0 (Windows NT 10.0; rv:129.0) Gecko/20100101 Firefox/129.0')).toEqual({
      isFirefox: true,
      isMobile: false
    });
    expect(detectBrowserSupport(FIREFOX_ANDROID)).toEqual({ isFirefox: true, isMobile: true });
  });

  it('ne prend pas Chrome pour Firefox', () => {
    expect(detectBrowserSupport(CHROME_DESKTOP).isFirefox).toBe(false);
  });

  it('ne casse pas sur une signature absente', () => {
    expect(detectBrowserSupport('')).toEqual({ isFirefox: false, isMobile: false });
  });
});

describe('shouldOpenWelcome', () => {
  const ready: WelcomeState = { extensionReady: true, support: { isFirefox: true, isMobile: false } };
  const sansExtension: WelcomeState = { extensionReady: false, support: { isFirefox: true, isMobile: false } };
  const sansFirefox: WelcomeState = { extensionReady: false, support: { isFirefox: false, isMobile: false } };

  it('s’ouvre à la toute première visite', () => {
    expect(shouldOpenWelcome(ready, memoryStorage(), memoryStorage())).toBe(true);
  });

  it('ne revient plus une fois vue avec l’installation complète', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    rememberWelcomeDismissed(ready, local, session);
    expect(shouldOpenWelcome(ready, local, session)).toBe(false);
  });

  it('revient à la visite suivante tant que le connecteur manque', () => {
    // Sans connecteur, l'application ne peut rien comparer : se taire
    // définitivement laisserait l'utilisateur devant une application inerte
    // sans jamais lui redire pourquoi.
    const local = memoryStorage();
    const session = memoryStorage();
    rememberWelcomeDismissed(sansExtension, local, session);
    expect(shouldOpenWelcome(sansExtension, local, session)).toBe(false);

    const nouvelleVisite = memoryStorage();
    expect(shouldOpenWelcome(sansExtension, local, nouvelleVisite)).toBe(true);
  });

  it('n’insiste pas deux fois dans la même visite', () => {
    const local = memoryStorage();
    const session = memoryStorage();
    rememberWelcomeDismissed(sansFirefox, local, session);
    expect(shouldOpenWelcome(sansFirefox, local, session)).toBe(false);
  });

  it('reste affichable quand le stockage est indisponible', () => {
    // Navigation privée ou stockage bloqué : mieux vaut réafficher l'accueil
    // que faire disparaître l'explication.
    expect(shouldOpenWelcome(sansExtension, undefined, undefined)).toBe(true);
    expect(() => rememberWelcomeDismissed(sansExtension, undefined, undefined)).not.toThrow();
  });

  it('rouvre si le connecteur a été désinstallé après coup', () => {
    const local = memoryStorage();
    rememberWelcomeDismissed(ready, local, memoryStorage());
    expect(shouldOpenWelcome(sansExtension, local, memoryStorage())).toBe(true);
  });
});

describe('buildWelcomeSteps', () => {
  it('coche ce qui est déjà en place et propose une action pour le reste', () => {
    const steps = buildWelcomeSteps({ extensionReady: false, support: { isFirefox: true, isMobile: true } });
    const [firefox, extension] = steps;
    expect(firefox.done).toBe(true);
    expect(firefox.action).toBeUndefined();
    expect(extension.done).toBe(false);
    expect(extension.action?.href).toContain('addons.mozilla.org');
  });

  it('propose le téléchargement de Firefox hors de Firefox', () => {
    const steps = buildWelcomeSteps({ extensionReady: false, support: { isFirefox: false, isMobile: false } });
    expect(steps[0].done).toBe(false);
    expect(steps[0].action?.href).toContain('mozilla.org');
  });

  it('n’affiche plus aucune action quand tout est installé', () => {
    const steps = buildWelcomeSteps({ extensionReady: true, support: { isFirefox: true, isMobile: false } });
    expect(steps.filter((step) => step.action)).toHaveLength(0);
  });

  it('garde l’étape « se connecter » toujours visible', () => {
    // Impossible à vérifier sans ouvrir les sites des enseignes : elle reste
    // informative, jamais cochée.
    const steps = buildWelcomeSteps({ extensionReady: true, support: { isFirefox: true, isMobile: false } });
    const compte = steps.find((step) => step.id === 'compte');
    expect(compte?.done).toBe(false);
    expect(compte?.description).toContain('identifiants');
  });
});
