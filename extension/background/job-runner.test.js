import { describe, expect, it, vi } from 'vitest';
import { createDriveJobRunner, recoverInterruptedJob } from './job-runner.js';

function createFakeSession() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) store.set(key, value);
    },
    // La vraie API storage.session accepte une clé seule OU un tableau de
    // clés, et le code de production utilise les deux formes. Le faux ne
    // gérait que la clé seule : une suppression par tableau y était
    // silencieusement sans effet.
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        store.delete(key);
      }
    }
  };
}

function createFakeTabs({ createdIds = [], urlsById = {} } = {}) {
  let nextId = 100;
  const removed = [];
  const created = [];
  const updated = [];
  const listeners = [];
  return {
    async create(options) {
      const id = createdIds.length > 0 ? createdIds.shift() : nextId++;
      created.push({ id, ...options });
      return { id, ...options };
    },
    async update(id, options) {
      updated.push({ id, ...options });
      return { id, ...options };
    },
    async remove(id) {
      removed.push(id);
    },
    async query() {
      return [];
    },
    async get(id) {
      return { id, status: 'complete', ...(urlsById[id] ? { url: urlsById[id] } : {}) };
    },
    onCreated: {
      addListener: (fn) => listeners.push(fn),
      removeListener: (fn) => {
        const index = listeners.indexOf(fn);
        if (index >= 0) listeners.splice(index, 1);
      }
    },
    _emitCreated: (tab) => listeners.forEach((fn) => fn(tab)),
    _removed: removed,
    _created: created,
    _updated: updated
  };
}

function baseJob(overrides = {}) {
  return {
    jobId: 'job-1',
    stores: [{ storeKey: 'leclerc', localStoreId: 'store-1' }],
    products: [{ productId: 'p1', name: 'Lait' }],
    ...overrides
  };
}

describe('createDriveJobRunner', () => {
  it('completes successfully with a single store on the first attempt', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [{ id: 'obs-1' }], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    const report = await runner.start(baseJob());

    expect(report.status).toBe('completed');
    expect(report.observations).toEqual([{ id: 'obs-1' }]);
    expect(runStore).toHaveBeenCalledTimes(1);
    expect(tabs._removed).toEqual([100]);
  });

  it('retries once with a fresh tab after a thrown failure, then succeeds', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi
      .fn()
      .mockRejectedValueOnce(new Error('Invalid tab ID: 100'))
      .mockResolvedValueOnce({ observations: [{ id: 'obs-retry' }], errors: [] });
    const onProgress = vi.fn();
    const runner = createDriveJobRunner({ tabs, session, runStore });

    const report = await runner.start(baseJob(), onProgress);

    expect(report.status).toBe('completed');
    expect(report.observations).toEqual([{ id: 'obs-retry' }]);
    expect(runStore).toHaveBeenCalledTimes(2);
    // Both attempts got their own tab (100 then 101), both closed on success/retry.
    expect(tabs._created.map((t) => t.id)).toEqual([100, 101]);
    expect(tabs._removed).toEqual([100, 101]);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ state: 'store_started' }));
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ state: 'store_retry' }));
  });

  // Signalé en conditions réelles (01/09) : la fenêtre du comparatif gardée
  // en écran partagé pendant l'analyse était fermée à la fin du job, parce
  // qu'un onglet ouvert depuis l'onglet magasin hérite de son openerTabId —
  // qu'il vienne du site ou de l'utilisateur.
  it("ne ferme pas un onglet hérité de l'onglet magasin qui n'est pas sur un site de magasin", async () => {
    const tabs = createFakeTabs({ urlsById: { 555: 'https://192.168.99.15:5174/compare' } });
    const session = createFakeSession();
    const runStore = vi.fn(async () => {
      tabs._emitCreated({ id: 555, openerTabId: 100 });
      return { observations: [], errors: [] };
    });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob());

    expect(tabs._removed).toEqual([100]);
  });

  it('ferme bien un onglet ouvert par le site du magasin lui-même (popup)', async () => {
    const tabs = createFakeTabs({
      urlsById: { 555: 'https://fd7-courses.leclercdrive.fr/magasin-1/popup.aspx' }
    });
    const session = createFakeSession();
    const runStore = vi.fn(async () => {
      tabs._emitCreated({ id: 555, openerTabId: 100 });
      return { observations: [], errors: [] };
    });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob());

    expect(tabs._removed).toEqual([100, 555]);
  });

  it('gives up after exhausting retries and keeps the tab open for inspection', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('Invalid tab ID: 100'));
    const runner = createDriveJobRunner({ tabs, session, runStore });

    const report = await runner.start(baseJob());

    expect(report.status).toBe('failed');
    expect(report.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'STORE_COLLECTION_FAILED' })
    ]);
    expect(runStore).toHaveBeenCalledTimes(2);
    // The final failing attempt's tab (101) is left open; only the first
    // attempt's tab (100) was closed before the retry.
    expect(tabs._removed).toEqual([100]);
  });

  it('does not retry a user-cancelled job', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('DRIVE_JOB_CANCELLED'));
    const runner = createDriveJobRunner({ tabs, session, runStore });

    const report = await runner.start(baseJob());

    expect(runStore).toHaveBeenCalledTimes(1);
    expect(report.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'DRIVE_JOB_CANCELLED' })
    ]);
  });

  // waitForLeclercPick/waitForCoursesUPick lèvent ce code quand l'onglet de
  // sélection manuelle a été fermé par l'utilisateur pendant l'attente —
  // pas une panne du magasin, donc ni retry (rouvrir un onglet tout seul
  // serait surprenant) ni pénalité sur le disjoncteur, et pas d'onglet à
  // garder ouvert (il n'existe déjà plus).
  it('does not retry a live pick whose tab was closed by the user, and does not open the circuit breaker', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('DRIVE_PICK_TAB_CLOSED'));
    const runner = createDriveJobRunner({ tabs, session, runStore, breakerStore: session });

    const report = await runner.start(baseJob());

    expect(runStore).toHaveBeenCalledTimes(1);
    expect(report.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'DRIVE_PICK_TAB_CLOSED' })
    ]);
    // L'onglet fermé par l'utilisateur a quand même été "retiré" une seule
    // fois (celui ouvert par la tentative) — aucune tentative de le garder
    // ouvert pour inspection puisqu'il n'existe plus.
    expect(tabs._removed).toEqual([100]);
  });

  // Signalé par l'utilisateur : la plupart des produits Leclerc ressortaient
  // "non trouvés" alors qu'ils avaient déjà été identifiés avant qu'un
  // SCRIPT_EXECUTION_TIMEOUT (onglet figé sur un produit) n'efface toute la
  // collecte. Le collecteur attache maintenant ce qui a déjà été trouvé à
  // l'erreur elle-même (error.partialObservations/partialErrors) — le
  // runner doit les récupérer, mais seulement quand il n'y a plus de
  // nouvelle tentative derrière (sinon un retry sur onglet neuf repasserait
  // sur les mêmes produits et créerait des doublons).
  it('preserves partial observations from a store-level abort only on the final attempt', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const makeAbort = () => {
      const error = new Error('SCRIPT_EXECUTION_TIMEOUT');
      error.partialObservations = [{ id: 'obs-before-timeout' }];
      error.partialErrors = [{ storeKey: 'leclerc', productId: 'p-stuck', code: 'PRODUCT_SEARCH_FAILED' }];
      return error;
    };
    const runStore = vi.fn().mockRejectedValue(makeAbort());
    const runner = createDriveJobRunner({ tabs, session, runStore });

    const report = await runner.start(baseJob());

    expect(runStore).toHaveBeenCalledTimes(2); // retry tenté (pas un code exempté de retry)
    expect(report.observations).toEqual([{ id: 'obs-before-timeout' }]);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        { storeKey: 'leclerc', productId: 'p-stuck', code: 'PRODUCT_SEARCH_FAILED' },
        expect.objectContaining({ storeKey: 'leclerc', code: 'SCRIPT_EXECUTION_TIMEOUT' })
      ])
    );
  });

  it('skips a store the adapter cannot run without touching any tab', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn();
    const runner = createDriveJobRunner({
      tabs,
      session,
      runStore,
      canRunStore: (store) => store.storeKey !== 'leclerc'
    });

    const report = await runner.start(baseJob());

    expect(runStore).not.toHaveBeenCalled();
    expect(report.errors).toEqual([{ storeKey: 'leclerc', code: 'ADAPTER_NOT_READY' }]);
    expect(tabs._created).toEqual([]);
  });

  it('rejects a second job while one is already active', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    // activeJob is set synchronously before the first await inside start(),
    // so a second call issued right after (without awaiting the first) must
    // see it and reject immediately — no need to keep the first run pending.
    const firstRun = runner.start(baseJob());
    await expect(runner.start(baseJob({ jobId: 'job-2' }))).rejects.toThrow(
      'Une collecte Drive est déjà active.'
    );

    await firstRun;
  });

  it('cancel() aborts the active job and stops further stores', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn(async ({ signal }) => {
      runner.cancel('job-1');
      if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
      return { observations: [], errors: [] };
    });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    const report = await runner.start(
      baseJob({
        stores: [
          { storeKey: 'leclerc', localStoreId: 'store-1' },
          { storeKey: 'hyperu', localStoreId: 'store-2' }
        ]
      })
    );

    expect(report.status).toBe('cancelled');
    expect(runStore).toHaveBeenCalledTimes(1);
  });

  it('opens the circuit breaker after repeated store-level failures and skips future attempts', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('Invalid tab ID: 100'));
    const runner = createDriveJobRunner({ tabs, session, runStore });

    // Chaque job épuise ses 2 tentatives et compte comme 1 échec magasin.
    // Après CIRCUIT_BREAKER_THRESHOLD (6) échecs consécutifs, le breaker
    // s'ouvre et le job suivant ne doit même plus créer de tab.
    for (const jobId of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) {
      await runner.start(baseJob({ jobId }));
    }
    runStore.mockClear();
    tabs._created.length = 0;

    const report = await runner.start(baseJob({ jobId: 'job-7' }));

    expect(runStore).not.toHaveBeenCalled();
    expect(tabs._created).toEqual([]);
    expect(report.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'CIRCUIT_BREAKER_OPEN' })
    ]);
  });

  it('respectCircuitBreaker: false still runs the store even while its breaker is open', async () => {
    // Reproduit le bug remonté par l'utilisateur : un choix manuel Leclerc
    // (livePickRunner) ne doit jamais être bloqué par un disjoncteur ouvert
    // par un rafraîchissement précédent, tout comme "Valider le panier"
    // (addToCartRunner) ne l'est déjà pas — voir respectCircuitBreaker dans
    // service-worker.js.
    const breakerStore = createFakeSession();
    const session = createFakeSession();
    const failingRunStore = vi.fn().mockRejectedValue(new Error('Invalid tab ID: 100'));
    const trippingRunner = createDriveJobRunner({
      tabs: createFakeTabs(),
      session,
      breakerStore,
      runStore: failingRunStore
    });

    // Épuise le seuil (6 échecs consécutifs) pour ouvrir le disjoncteur sur
    // 'leclerc', exactement comme un rafraîchissement automatique le ferait.
    for (const jobId of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) {
      await trippingRunner.start(baseJob({ jobId }));
    }

    // Le disjoncteur est bien ouvert pour un runner par défaut (respectCircuitBreaker: true).
    const guardedRunStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const guardedRunner = createDriveJobRunner({
      tabs: createFakeTabs(),
      session,
      breakerStore,
      runStore: guardedRunStore
    });
    const guardedReport = await guardedRunner.start(baseJob({ jobId: 'job-7' }));
    expect(guardedRunStore).not.toHaveBeenCalled();
    expect(guardedReport.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'CIRCUIT_BREAKER_OPEN' })
    ]);

    // Un runner avec respectCircuitBreaker: false (livePickRunner/addToCartRunner)
    // doit exécuter le job normalement malgré le même état de disjoncteur ouvert.
    const bypassRunStore = vi.fn().mockResolvedValue({ observations: [{ id: 'obs-manual' }], errors: [] });
    const bypassRunner = createDriveJobRunner({
      tabs: createFakeTabs(),
      session,
      breakerStore,
      respectCircuitBreaker: false,
      runStore: bypassRunStore
    });
    const bypassReport = await bypassRunner.start(baseJob({ jobId: 'job-8' }));

    expect(bypassRunStore).toHaveBeenCalledTimes(1);
    expect(bypassReport.status).toBe('completed');
    expect(bypassReport.errors).toEqual([]);
  });

  it('resets the circuit breaker after a successful run', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    // job-1 and job-2 each exhaust both attempts (4 rejections total), then
    // job-3's first attempt succeeds.
    const runStore = vi
      .fn()
      .mockRejectedValueOnce(new Error('Invalid tab ID: 100'))
      .mockRejectedValueOnce(new Error('Invalid tab ID: 100'))
      .mockRejectedValueOnce(new Error('Invalid tab ID: 100'))
      .mockRejectedValueOnce(new Error('Invalid tab ID: 100'))
      .mockResolvedValueOnce({ observations: [{ id: 'obs-1' }], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob({ jobId: 'job-1' }));
    await runner.start(baseJob({ jobId: 'job-2' }));
    const report = await runner.start(baseJob({ jobId: 'job-3' }));

    expect(report.status).toBe('completed');

    // Le breaker a été remis à zéro : deux nouveaux échecs consécutifs ne
    // suffisent pas à eux seuls à atteindre le seuil de 6.
    const runStore2 = vi.fn().mockRejectedValue(new Error('Invalid tab ID: 100'));
    const runner2 = createDriveJobRunner({ tabs: createFakeTabs(), session, runStore: runStore2 });
    await runner2.start(baseJob({ jobId: 'job-4' }));
    const finalReport = await runner2.start(baseJob({ jobId: 'job-5' }));

    expect(finalReport.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'STORE_COLLECTION_FAILED' })
    ]);
  });

  it('does not trip the circuit breaker on a user-cancelled job', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('DRIVE_JOB_CANCELLED'));
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob({ jobId: 'job-1' }));
    await runner.start(baseJob({ jobId: 'job-2' }));
    const report = await runner.start(baseJob({ jobId: 'job-3' }));

    // Toujours DRIVE_JOB_CANCELLED, jamais CIRCUIT_BREAKER_OPEN — une
    // annulation utilisateur n'est pas un signal de panne du magasin.
    expect(report.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'DRIVE_JOB_CANCELLED' })
    ]);
  });

  it('aborts a job that exceeds the global timeout instead of staying active forever', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    // Adaptateur bloqué : il n'aboutit que si le job est annulé. Sans chien
    // de garde, start() ne rendrait jamais la main et `activeJob` resterait
    // non nul définitivement.
    const runStore = vi.fn(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('DRIVE_JOB_CANCELLED')), {
            once: true
          });
        })
    );
    const runner = createDriveJobRunner({ tabs, session, runStore, jobTimeoutMs: 30 });

    const report = await runner.start(baseJob());

    expect(report.status).toBe('cancelled');
    // Le verrou est bien relâché : un job suivant peut démarrer.
    expect(runner.getActiveJobId()).toBeNull();
    const runner2 = createDriveJobRunner({
      tabs,
      session,
      runStore: vi.fn().mockResolvedValue({ observations: [], errors: [] })
    });
    await expect(runner2.start(baseJob({ jobId: 'job-2' }))).resolves.toBeTruthy();
  });

  it('keeps the circuit breaker state in the dedicated persistent store, not the session', async () => {
    const session = createFakeSession();
    const breakerStore = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('Invalid tab ID: 100'));
    const runner = createDriveJobRunner({
      tabs: createFakeTabs(),
      session,
      breakerStore,
      runStore
    });

    await runner.start(baseJob({ jobId: 'job-1' }));

    expect((await breakerStore.get('driveCircuitBreaker')).driveCircuitBreaker).toBeTruthy();
    expect(await session.get('driveCircuitBreaker')).toEqual({});
  });

  it('survives a worker reload with the breaker state intact when session storage is wiped', async () => {
    // storage.local survit au déchargement du worker, storage.session non :
    // le compteur d'échecs doit être porté par le premier, sinon le seuil de
    // 6 n'est jamais atteint entre deux collectes espacées.
    const breakerStore = createFakeSession();
    const runStore = vi.fn().mockRejectedValue(new Error('Invalid tab ID: 100'));

    for (const jobId of ['job-1', 'job-2', 'job-3', 'job-4', 'job-5', 'job-6']) {
      const freshSession = createFakeSession(); // worker rechargé à chaque fois
      const runner = createDriveJobRunner({
        tabs: createFakeTabs(),
        session: freshSession,
        breakerStore,
        runStore
      });
      await runner.start(baseJob({ jobId }));
    }

    runStore.mockClear();
    const runner = createDriveJobRunner({
      tabs: createFakeTabs(),
      session: createFakeSession(),
      breakerStore,
      runStore
    });
    const report = await runner.start(baseJob({ jobId: 'job-7' }));

    expect(runStore).not.toHaveBeenCalled();
    expect(report.errors).toEqual([
      expect.objectContaining({ storeKey: 'leclerc', code: 'CIRCUIT_BREAKER_OPEN' })
    ]);
  });

  it('only reuses tabs the extension itself previously opened', async () => {
    const tabs = createFakeTabs();
    tabs.query = vi.fn().mockResolvedValue([
      { id: 999, lastAccessed: Date.now() }, // a tab the user is browsing manually
      { id: 100, lastAccessed: Date.now() - 1000 } // owned by a prior run below
    ]);
    const session = createFakeSession();
    await session.set({ driveOwnedTabIds: [100] });

    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob());

    expect(runStore).toHaveBeenCalledWith(expect.objectContaining({ tabId: 100 }));
    expect(tabs._created).toEqual([]);
    // A reused (not owned-by-this-run) tab must never be closed automatically.
    expect(tabs._removed).toEqual([]);
  });

  // Hyper U avait été basculé en arrière-plan (son collecteur ne dépend
  // d'aucun rendu visuel), puis remis au premier plan après test réel sur
  // Firefox Android : le navigateur throttle timers et réseau des onglets
  // inactifs, ce qui ralentit n'importe quel collecteur. Voir
  // STORE_NEEDS_FOREGROUND.
  it('opens a Hyper U tab in the foreground too (background tabs are throttled by Firefox Android)', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob({ stores: [{ storeKey: 'hyperu', localStoreId: 'store-1' }] }));

    expect(tabs._updated).toContainEqual(expect.objectContaining({ id: 100, active: true }));
  });

  it('still brings the Leclerc tab to the front', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob({ stores: [{ storeKey: 'leclerc', localStoreId: 'store-1' }] }));

    expect(tabs._updated).toContainEqual(expect.objectContaining({ id: 100, active: true }));
  });

  // Une fenêtre flottante d'une autre application posée par-dessus Firefox se
  // referme dès que Firefox demande le premier plan au système, ce que fait
  // l'ouverture d'un onglet directement actif. L'onglet est donc créé en
  // arrière-plan, puis sélectionné depuis Firefox (opération interne).
  it("ne crée jamais l'onglet magasin directement actif (fenêtre flottante d'une autre app)", async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob());

    expect(tabs._created).toEqual([expect.objectContaining({ active: false })]);
  });

  // Tous les magasins passent maintenant au premier plan, donc l'onglet de
  // l'utilisateur lui est pris quel que soit le magasin : il doit lui être
  // rendu à la fin dans tous les cas, y compris sur un run Hyper U seul.
  it('gives the caller tab back after a Hyper U-only run too', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob({ stores: [{ storeKey: 'hyperu', localStoreId: 'store-1' }] }), undefined, {
      callerTabId: 999
    });

    expect(tabs._updated).toContainEqual(expect.objectContaining({ id: 999, active: true }));
  });

  it('does steal focus back to the caller tab after a run that foregrounded a store (Leclerc)', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const runStore = vi.fn().mockResolvedValue({ observations: [], errors: [] });
    const runner = createDriveJobRunner({ tabs, session, runStore });

    await runner.start(baseJob({ stores: [{ storeKey: 'leclerc', localStoreId: 'store-1' }] }), undefined, {
      callerTabId: 999
    });

    expect(tabs._updated).toContainEqual(expect.objectContaining({ id: 999, active: true }));
  });
});

describe('recoverInterruptedJob', () => {
  function createFakeAction() {
    return {
      setBadgeText: vi.fn().mockResolvedValue(undefined),
      setTitle: vi.fn().mockResolvedValue(undefined)
    };
  }

  it('closes the tabs left behind by a job the worker never finished', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    const action = createFakeAction();
    await session.set({
      activeDriveJob: { jobId: 'job-1', state: 'collecting', tabIds: [100, 101] },
      driveOwnedTabIds: [100, 101]
    });

    const recovered = await recoverInterruptedJob({ tabs, session, action });

    expect(recovered).toEqual({ jobId: 'job-1', closedTabIds: [100, 101] });
    expect(tabs._removed).toEqual([100, 101]);
    expect(await session.get('activeDriveJob')).toEqual({});
    expect(action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('never closes a tab the extension did not open itself', async () => {
    const tabs = createFakeTabs();
    const session = createFakeSession();
    await session.set({
      // 999 est un onglet que l'utilisateur navigue lui-même : il figure dans
      // le job interrompu mais pas dans les onglets possédés.
      activeDriveJob: { jobId: 'job-1', state: 'collecting', tabIds: [100, 999] },
      driveOwnedTabIds: [100]
    });

    const recovered = await recoverInterruptedJob({ tabs, session, action: createFakeAction() });

    expect(recovered.closedTabIds).toEqual([100]);
    expect(tabs._removed).toEqual([100]);
  });

  it('does nothing when no job was interrupted', async () => {
    const tabs = createFakeTabs();
    const action = createFakeAction();

    const recovered = await recoverInterruptedJob({
      tabs,
      session: createFakeSession(),
      action
    });

    expect(recovered).toBeNull();
    expect(tabs._removed).toEqual([]);
    expect(action.setBadgeText).not.toHaveBeenCalled();
  });
});
