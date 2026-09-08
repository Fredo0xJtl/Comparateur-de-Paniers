import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Le service worker n'avait aucun test : il s'installe sur des API de
// navigateur dès son chargement, ce qui le rendait pénible à instancier
// ailleurs que dans Firefox. C'est pourtant lui qui porte le contrôle le plus
// important du paquet — celui qui décide quelle page a le droit de faire agir
// l'extension dans la session authentifiée de l'utilisateur sur les sites des
// enseignes. Ce fichier le charge avec des API simulées et vérifie ce
// contrôle, chemin synchrone (origines livrées dans le paquet) comme chemin
// asynchrone (adresse déclarée par l'utilisateur).

const MANIFEST_ORIGIN = 'https://fredo0xjtl.github.io';
const MANIFEST_MATCH = 'https://fredo0xjtl.github.io/Comparateur-de-Paniers/*';

function createBrowserStub({ storedOrigins = [], grantedOrigins = [] } = {}) {
  const listeners = { message: [], storage: [], permissionsAdded: [], permissionsRemoved: [] };
  const local = { customBridgeOrigins: storedOrigins };
  const granted = new Set(grantedOrigins);
  const registered = [];

  const noopArea = () => ({
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  });

  return {
    listeners,
    registered,
    granted,
    api: {
      runtime: {
        getManifest: () => ({
          version: '0.7.0',
          content_scripts: [{ matches: [MANIFEST_MATCH] }]
        }),
        onMessage: { addListener: (fn) => listeners.message.push(fn) },
        sendMessage: vi.fn(async () => undefined)
      },
      tabs: {
        query: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => undefined),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onRemoved: { addListener: vi.fn(), removeListener: vi.fn() }
      },
      scripting: {
        executeScript: vi.fn(async () => []),
        registerContentScripts: vi.fn(async (scripts) => registered.push(...scripts)),
        unregisterContentScripts: vi.fn(async () => undefined)
      },
      action: { setBadgeText: vi.fn(async () => undefined), setBadgeBackgroundColor: vi.fn(async () => undefined) },
      storage: {
        local: {
          get: vi.fn(async (key) => (key in local ? { [key]: local[key] } : {})),
          set: vi.fn(async (values) => Object.assign(local, values)),
          remove: vi.fn(async () => undefined)
        },
        session: noopArea(),
        onChanged: { addListener: (fn) => listeners.storage.push(fn) }
      },
      permissions: {
        contains: vi.fn(async ({ origins }) => origins.every((origin) => granted.has(origin))),
        onAdded: { addListener: (fn) => listeners.permissionsAdded.push(fn) },
        onRemoved: { addListener: (fn) => listeners.permissionsRemoved.push(fn) }
      }
    }
  };
}

async function loadServiceWorker(stub) {
  globalThis.browser = stub.api;
  vi.resetModules();
  await import('./service-worker.js');
  // Le module enregistre son écouteur au chargement ; les traitements
  // asynchrones lancés au démarrage (reprise de job, enregistrement des
  // scripts) doivent avoir eu leur tour avant qu'on observe le résultat.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return stub.listeners.message.at(-1);
}

// Message le plus simple du protocole protégé : réponse synchrone, aucun job
// à valider. Ce qui est testé ici est le garde, pas le traitement.
const PROTECTED_MESSAGE = { type: 'DRIVE_REFRESH_CANCEL', jobId: 'job-de-test' };

afterEach(() => {
  delete globalThis.browser;
  vi.resetModules();
});

describe('service worker — qui a le droit de faire agir l’extension', () => {
  let stub;

  beforeEach(() => {
    stub = createBrowserStub();
  });

  it('répond au ping de disponibilité quelle que soit l’origine', async () => {
    // Le ping ne déclenche aucune action : il sert à la PWA pour savoir si
    // l'extension est installée, et n'a donc pas à être protégé.
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();
    listener({ type: 'DRIVE_CONNECTOR_STATUS' }, { origin: 'https://site-quelconque.example' }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ available: true, protocolVersion: 1, extensionVersion: '0.7.0' })
    );
  });

  it('accepte un message du protocole venant de l’origine livrée dans le paquet', async () => {
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();
    listener(PROTECTED_MESSAGE, { origin: MANIFEST_ORIGIN }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ cancelled: false });
  });

  it('déduit l’origine de l’URL de l’expéditeur quand elle n’est pas fournie', async () => {
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();
    listener(PROTECTED_MESSAGE, { url: `${MANIFEST_ORIGIN}/Comparateur-de-Paniers/liste` }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ cancelled: false });
  });

  it('ignore un message du protocole venant d’une origine inconnue', async () => {
    // Réponse vide, jamais d'action : rien n'est révélé à l'appelant rejeté
    // (c'est exactement ce que reçoit une page légitime qui enverrait un type
    // de message inconnu), mais le canal est refermé. Le laisser ouvert
    // figeait la page appelante sur une promesse qui ne se résolvait jamais,
    // au lieu de lui faire afficher « Extension Drive indisponible ».
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();
    listener(PROTECTED_MESSAGE, { origin: 'https://attaquant.example' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });

  it('ignore un message sans origine ni URL exploitables', async () => {
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();
    listener(PROTECTED_MESSAGE, { url: 'pas une URL' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });
});

describe('service worker — adresse déclarée par l’utilisateur', () => {
  it('accepte l’origine enregistrée dont la permission est réellement accordée', async () => {
    const stub = createBrowserStub({
      storedOrigins: [{ origin: 'https://mon-nas.local:8443' }],
      grantedOrigins: ['https://mon-nas.local/*']
    });
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();

    expect(listener(PROTECTED_MESSAGE, { origin: 'https://mon-nas.local:8443' }, sendResponse)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith({ cancelled: false });
  });

  it('refuse une origine enregistrée dont la permission a été retirée dans Firefox', async () => {
    // Cas réel : l'utilisateur retire l'autorisation depuis « Gérer les
    // extensions » sans repasser par la page d'options. Le stockage, lui,
    // continuerait d'affirmer que l'adresse est autorisée.
    const stub = createBrowserStub({
      storedOrigins: [{ origin: 'https://mon-nas.local:8443' }],
      grantedOrigins: []
    });
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();

    listener(PROTECTED_MESSAGE, { origin: 'https://mon-nas.local:8443' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });

  it('refuse un autre port que celui qui a été déclaré', async () => {
    // Un match pattern ne sait pas filtrer par port, mais cette vérification
    // à l'exécution le peut — et c'est elle qui décide.
    const stub = createBrowserStub({
      storedOrigins: [{ origin: 'https://mon-nas.local:8443' }],
      grantedOrigins: ['https://mon-nas.local/*']
    });
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();

    listener(PROTECTED_MESSAGE, { origin: 'https://mon-nas.local:9999' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });

  it('refuse une origine que l’utilisateur n’a jamais déclarée, même autorisée par ailleurs', async () => {
    const stub = createBrowserStub({ storedOrigins: [], grantedOrigins: ['https://ailleurs.example/*'] });
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();

    listener(PROTECTED_MESSAGE, { origin: 'https://ailleurs.example' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });
});

describe('service worker — enregistrement du pont sur les adresses déclarées', () => {
  it('enregistre le pont au démarrage pour les adresses réellement autorisées', async () => {
    // Les scripts enregistrés à l'exécution ne survivent pas forcément à un
    // redémarrage du navigateur, alors que les permissions, elles, sont
    // persistantes : sans ce rejeu au réveil, une installation auto-hébergée
    // cesserait de fonctionner après chaque redémarrage, sans aucune erreur.
    const stub = createBrowserStub({
      storedOrigins: [{ origin: 'https://mon-nas.local:8443' }, { origin: 'https://sans-permission.example' }],
      grantedOrigins: ['https://mon-nas.local/*']
    });
    await loadServiceWorker(stub);

    expect(stub.registered).toHaveLength(1);
    expect(stub.registered[0]).toMatchObject({
      // Sans port : Firefox rejette un match pattern qui en porte un, et
      // cesse alors d'injecter le script (bugs Mozilla 1362809 / 1468162).
      matches: ['https://mon-nas.local/*'],
      js: ['bridge/pwa-bridge.js'],
      runAt: 'document_start'
    });
  });

  it('n’enregistre rien quand aucune adresse n’a été déclarée', async () => {
    const stub = createBrowserStub();
    await loadServiceWorker(stub);
    expect(stub.api.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('réenregistre le pont quand la liste enregistrée change', async () => {
    const stub = createBrowserStub({ grantedOrigins: ['https://nouvelle.example/*'] });
    await loadServiceWorker(stub);
    stub.api.storage.local.get = vi.fn(async () => ({
      customBridgeOrigins: [{ origin: 'https://nouvelle.example' }]
    }));

    for (const listener of stub.listeners.storage) listener({ customBridgeOrigins: {} }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.registered).toEqual([expect.objectContaining({ matches: ['https://nouvelle.example/*'] })]);
  });

  it('ignore un changement de stockage sans rapport', async () => {
    const stub = createBrowserStub({ grantedOrigins: ['https://nouvelle.example/*'] });
    await loadServiceWorker(stub);
    stub.api.scripting.unregisterContentScripts.mockClear();

    for (const listener of stub.listeners.storage) listener({ verboseDiagnostics: {} }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.api.scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });
});

describe('service worker — fermeture du canal de réponse', () => {
  it('répond même à un type de message inconnu venu d’une adresse déclarée', async () => {
    // Sans cette réponse, l'appel restait en suspens côté page : aucune
    // erreur, aucun délai de garde, l'interface bloquée sur « en cours ».
    const stub = createBrowserStub({
      storedOrigins: [{ origin: 'https://mon-nas.local:8443' }],
      grantedOrigins: ['https://mon-nas.local/*']
    });
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();

    listener({ type: 'TYPE_QUI_NEXISTE_PAS' }, { origin: 'https://mon-nas.local:8443' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });

  it('répond quand la vérification de permission échoue', async () => {
    const stub = createBrowserStub({ storedOrigins: [{ origin: 'https://mon-nas.local:8443' }] });
    stub.api.permissions.contains = () => Promise.reject(new Error('permissions indisponibles'));
    const listener = await loadServiceWorker(stub);
    const sendResponse = vi.fn();

    listener(PROTECTED_MESSAGE, { origin: 'https://mon-nas.local:8443' }, sendResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendResponse).toHaveBeenCalledWith(undefined);
  });
});
