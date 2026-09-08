// Premier contact avec l'application, pour quelqu'un qui n'a jamais installé
// d'extension de navigateur.
//
// L'application ne sert à rien seule : elle a besoin du connecteur Firefox
// pour lire les prix sur les sites des enseignes. Rien ne le disait, et rien
// ne pouvait le dire au bon moment — l'ancien message « Extension Drive
// indisponible » n'apparaissait qu'après avoir tenté un comparatif, c'est-à-dire
// après avoir saisi une liste de courses entière pour rien.
//
// Ce module décide seulement QUOI afficher ; le rendu est dans WelcomeDialog.
// Séparé pour être testable sans navigateur ni React : c'est de la logique
// d'aiguillage, et elle est facile à casser sans s'en apercevoir.

export const EXTENSION_STORE_URL = 'https://addons.mozilla.org/fr/firefox/addon/comparateur-de-paniers/';
export const FIREFOX_DOWNLOAD_URL = 'https://www.mozilla.org/fr/firefox/new/';

// « Vu et tout est en place » : l'accueil ne se rouvrira plus de lui-même.
const SEEN_STORAGE_KEY = 'comparateur.accueil.termine';
// « Vu, mais il manque encore quelque chose » : on n'insiste pas pendant la
// visite en cours, on redemandera à la prochaine ouverture. Sans extension,
// l'application ne peut rien comparer — faire silence définitivement
// laisserait l'utilisateur devant une application qui ne marche pas, sans
// jamais lui redire pourquoi.
const SNOOZE_STORAGE_KEY = 'comparateur.accueil.reporte';

export type BrowserSupport = {
  isFirefox: boolean;
  isMobile: boolean;
};

/**
 * Firefox est indispensable : le connecteur n'existe que pour lui, et rien
 * d'autre ne peut le remplacer. Chrome, Edge, Safari et les navigateurs
 * intégrés aux applications (Facebook, Instagram…) ne pourront jamais
 * l'installer.
 *
 * Détection par la signature du navigateur, qui est déclarative et donc
 * imparfaite. Elle ne sert qu'à ORIENTER un message d'aide, jamais à
 * autoriser quoi que ce soit — un faux positif affiche un conseil inutile,
 * pas une faille.
 */
export function detectBrowserSupport(userAgent: string): BrowserSupport {
  const agent = String(userAgent ?? '');
  return {
    // « Seamonkey » et les dérivés portent aussi « Firefox » dans leur
    // signature ; ils partagent le moteur et le magasin d'extensions, donc
    // les traiter comme Firefox est correct ici.
    isFirefox: /firefox|fxios/i.test(agent),
    isMobile: /android|iphone|ipad|mobile/i.test(agent)
  };
}

export type WelcomeState = {
  /** Le connecteur a répondu : l'installation est complète. */
  extensionReady: boolean;
  support: BrowserSupport;
};

/**
 * L'accueil s'ouvre tout seul tant qu'il reste quelque chose à faire, et
 * seulement une fois quand tout est déjà en place.
 */
export function shouldOpenWelcome(state: WelcomeState, storage: StorageLike | undefined, session: StorageLike | undefined) {
  const everythingReady = state.extensionReady && state.support.isFirefox;
  if (everythingReady) {
    // Rien à faire : on ne montre l'accueil qu'à ceux qui ne l'ont jamais vu,
    // pour expliquer la suite (se connecter à son compte, ajouter à l'écran
    // d'accueil), puis plus jamais.
    return !readFlag(storage, SEEN_STORAGE_KEY);
  }
  return !readFlag(session, SNOOZE_STORAGE_KEY);
}

/** Mémorise la fermeture, définitivement ou pour la visite en cours. */
export function rememberWelcomeDismissed(
  state: WelcomeState,
  storage: StorageLike | undefined,
  session: StorageLike | undefined
) {
  if (state.extensionReady && state.support.isFirefox) {
    writeFlag(storage, SEEN_STORAGE_KEY);
    return;
  }
  writeFlag(session, SNOOZE_STORAGE_KEY);
}

export type WelcomeStep = {
  id: 'firefox' | 'extension' | 'compte';
  title: string;
  description: string;
  done: boolean;
  action?: { label: string; href: string };
};

/**
 * Les trois étapes, dans l'ordre où elles doivent être faites, chacune
 * marquée faite ou non. Un débutant voit ainsi où il en est plutôt qu'une
 * consigne unique dont il ne sait pas si elle le concerne.
 */
export function buildWelcomeSteps(state: WelcomeState): WelcomeStep[] {
  const { isFirefox, isMobile } = state.support;
  return [
    {
      id: 'firefox',
      title: 'Utiliser Firefox',
      description: isFirefox
        ? 'Vous y êtes déjà.'
        : isMobile
          ? 'Cette application a besoin de Firefox pour Android : c’est le seul navigateur mobile capable d’installer le connecteur. Installez-le, puis rouvrez cette page dedans.'
          : 'Cette application a besoin de Firefox : c’est le seul navigateur capable d’installer le connecteur. Installez-le, puis rouvrez cette page dedans.',
      done: isFirefox,
      ...(isFirefox ? {} : { action: { label: 'Télécharger Firefox', href: FIREFOX_DOWNLOAD_URL } })
    },
    {
      id: 'extension',
      title: 'Ajouter le connecteur à Firefox',
      description: state.extensionReady
        ? 'Le connecteur est installé et répond.'
        : 'C’est lui qui va lire les prix sur les sites des enseignes, à votre place. Ajoutez-le depuis le site officiel des modules Firefox, puis revenez ici et rechargez la page.',
      done: state.extensionReady,
      // Le lien reste proposé hors Firefox : la page du module s'ouvre
      // partout, et voir de quoi il s'agit aide à comprendre l'étape
      // précédente.
      ...(state.extensionReady ? {} : { action: { label: 'Ouvrir la page du connecteur', href: EXTENSION_STORE_URL } })
    },
    {
      id: 'compte',
      title: 'Se connecter à vos magasins',
      description:
        'Connectez-vous à vos comptes Leclerc Drive et Courses U dans ce même Firefox, comme d’habitude. ' +
        'L’application ne connaît jamais vos identifiants : elle travaille dans la session que vous avez ouverte vous-même.',
      // Impossible à vérifier sans ouvrir les sites des enseignes, ce qui
      // serait intrusif pour une simple case à cocher : cette étape reste
      // informative.
      done: false
    }
  ];
}

// Type minimal de `localStorage` / `sessionStorage`, pour pouvoir tester sans
// navigateur.
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function readFlag(storage: StorageLike | undefined, key: string) {
  try {
    return storage?.getItem(key) === '1';
  } catch {
    // Navigation privée, cookies bloqués, stockage plein : l'accueil se
    // réaffichera, ce qui est le défaut le moins gênant.
    return false;
  }
}

function writeFlag(storage: StorageLike | undefined, key: string) {
  try {
    storage?.setItem(key, '1');
  } catch {
    // Sans mémoire, l'accueil reviendra à la prochaine ouverture. Tant pis :
    // il n'y a rien d'important à perdre ici.
  }
}
