import { describe, expect, it, vi } from 'vitest';
import { createListImportRunner, resolveImportStartUrl } from './list-import-runner.js';

// L'orchestration est testée sans navigateur : `scripting.executeScript` est
// remplacé par une table « fonction injectée -> résultat », ce qui laisse
// vérifier l'enchaînement réel (garde de page, lecture des rayons, clic, pause,
// relecture, dédoublonnage, fermeture de l'onglet) sans dépendre du DOM des
// sites, déjà couvert par les tests des lecteurs eux-mêmes.

function makeTabs({ url = 'https://www.coursesu.com/mon-compte/mes-listes' } = {}) {
  const removed = [];
  return {
    removed,
    create: vi.fn(async () => ({ id: 42 })),
    get: vi.fn(async () => ({ id: 42, status: 'complete', url })),
    remove: vi.fn(async (tabId) => {
      removed.push(tabId);
    })
  };
}

// `handlers` associe le NOM de la fonction injectée à son résultat (valeur, ou
// fonction appelée avec les arguments de l'injection pour varier les réponses
// d'un appel à l'autre).
function makeScripting(handlers) {
  const calls = [];
  return {
    calls,
    executeScript: vi.fn(async ({ func, args }) => {
      calls.push({ name: func.name, args });
      const handler = handlers[func.name];
      const result = typeof handler === 'function' ? handler(...(args ?? [])) : handler;
      return [{ result }];
    })
  };
}

const COURSES_U_JOB = {
  protocolVersion: 1,
  jobId: 'import-test-1',
  requestedAt: new Date().toISOString(),
  store: { storeKey: 'hyperu', localStoreId: 'store-1', displayName: 'Hyper U' }
};

const LECLERC_JOB = {
  protocolVersion: 1,
  jobId: 'import-test-2',
  requestedAt: new Date().toISOString(),
  store: {
    storeKey: 'leclerc',
    localStoreId: 'store-2',
    displayName: 'Leclerc Trappes',
    driveUrl: 'https://m-courses.leclercdrive.fr/magasin-171201-Trappes/accueil'
  }
};

describe('resolveImportStartUrl', () => {
  it('dérive la page des produits habituels du drive enregistré', () => {
    expect(resolveImportStartUrl(LECLERC_JOB)).toBe(
      'https://m-courses.leclercdrive.fr/magasin-171201-Trappes/produits-habituels'
    );
  });

  it('utilise la page de compte par défaut pour Courses U', () => {
    expect(resolveImportStartUrl(COURSES_U_JOB)).toBe('https://www.coursesu.com/mon-compte/mes-listes');
  });

  it('accepte une URL de liste choisie par l\'utilisateur sur le bon domaine', () => {
    expect(
      resolveImportStartUrl({ ...COURSES_U_JOB, listUrl: 'https://www.coursesu.com/mon-compte/mes-listes?listID=a1' })
    ).toBe('https://www.coursesu.com/mon-compte/mes-listes?listID=a1');
  });

  it('refuse une URL de liste hors du domaine de l\'enseigne', () => {
    // L'URL vient de la page elle-même (code COURSESU_PICK_LIST) : elle ne peut
    // pas être reprise sur confiance, sinon un site compromis ferait ouvrir
    // n'importe quelle page avec la session de l'utilisateur.
    expect(resolveImportStartUrl({ ...COURSES_U_JOB, listUrl: 'https://exemple.invalid/liste' })).toBeNull();
    expect(resolveImportStartUrl({ ...COURSES_U_JOB, listUrl: 'http://www.coursesu.com/liste' })).toBeNull();
  });

  it('refuse un drive Leclerc sans segment magasin', () => {
    expect(
      resolveImportStartUrl({ ...LECLERC_JOB, store: { ...LECLERC_JOB.store, driveUrl: 'https://www.leclercdrive.fr/' } })
    ).toBeNull();
  });

  it('échoue proprement quand aucun drive n\'est enregistré', () => {
    expect(resolveImportStartUrl({ ...LECLERC_JOB, store: { storeKey: 'leclerc' } })).toBeNull();
  });
});

describe('createListImportRunner — Courses U', () => {
  it('renvoie les produits lus et referme l\'onglet du site', async () => {
    const tabs = makeTabs();
    const scripting = makeScripting({
      readCoursesUWishlistOnPage: {
        ok: true,
        listName: 'Favoris',
        usedFallbackSelector: false,
        items: [{ name: 'Lait', barcode: '3256224234494' }]
      }
    });

    const report = await createListImportRunner({ tabs, scripting }).start(COURSES_U_JOB);

    expect(report).toMatchObject({ ok: true, storeKey: 'hyperu', listName: 'Favoris' });
    expect(report.items).toHaveLength(1);
    // L'onglet porte la session authentifiée : il ne doit jamais rester ouvert.
    expect(tabs.removed).toEqual([42]);
  });

  it('remonte tel quel un échec du lecteur (reconnexion nécessaire)', async () => {
    const tabs = makeTabs();
    const scripting = makeScripting({
      readCoursesUWishlistOnPage: { ok: false, code: 'COURSESU_LOGIN_REQUIRED' }
    });

    const report = await createListImportRunner({ tabs, scripting }).start(COURSES_U_JOB);

    expect(report).toMatchObject({ ok: false, code: 'COURSESU_LOGIN_REQUIRED', storeKey: 'hyperu' });
    expect(tabs.removed).toEqual([42]);
  });
});

describe('createListImportRunner — Leclerc', () => {
  const leclercTabs = () => makeTabs({ url: 'https://m-courses.leclercdrive.fr/magasin-171201-Trappes/produits-habituels' });

  it('parcourt chaque rayon et fusionne les produits sans doublon', async () => {
    const tabs = leclercTabs();
    const perDepartment = [
      [{ name: 'Ricotta', externalProductId: '1' }],
      [
        // Volontairement réémis par le second rayon (produit multi-rayons) :
        // le dédoublonnage doit le reconnaître.
        { name: 'Ricotta', externalProductId: '1' },
        { name: 'Lait', externalProductId: '2' }
      ]
    ];
    let readIndex = 0;
    const scripting = makeScripting({
      inspectLeclercUsualProductsPageOnPage: { ready: true, productCardCount: 1 },
      readLeclercDepartmentsOnPage: [
        { actionIndex: 0, label: 'Charcuterie Traiteur', active: true },
        { actionIndex: 1, label: 'Laitier Œufs Végétal', active: false }
      ],
      clickLeclercDepartmentOnPage: { clicked: true },
      readProductCandidatesOnPage: () => perDepartment[readIndex++] ?? []
    });
    const progress = [];

    const report = await createListImportRunner({ tabs, scripting }).start(LECLERC_JOB, (event) =>
      progress.push(event)
    );

    expect(report.ok).toBe(true);
    expect(report.items.map((item) => item.name)).toEqual(['Ricotta', 'Lait']);
    expect(report.departmentsVisited).toEqual([
      { label: 'Charcuterie Traiteur', itemCount: 1 },
      { label: 'Laitier Œufs Végétal', itemCount: 2 }
    ]);
    // Le rayon déjà affiché n'est pas re-cliqué.
    expect(scripting.calls.filter((call) => call.name === 'clickLeclercDepartmentOnPage')).toHaveLength(1);
    expect(progress.some((event) => event.state === 'reading_department')).toBe(true);
  });

  it('importe le rayon affiché plutôt que d\'échouer quand la barre de rayons est introuvable', async () => {
    const tabs = leclercTabs();
    const scripting = makeScripting({
      inspectLeclercUsualProductsPageOnPage: { ready: true, productCardCount: 1 },
      readLeclercDepartmentsOnPage: [],
      readProductCandidatesOnPage: [{ name: 'Mascarpone', externalProductId: '3' }]
    });

    const report = await createListImportRunner({ tabs, scripting }).start(LECLERC_JOB);

    expect(report).toMatchObject({ ok: true, partial: true, partialReason: 'LECLERC_DEPARTMENTS_NOT_FOUND' });
    expect(report.items).toHaveLength(1);
  });

  it('signale un rayon sauté au lieu de laisser croire à un import complet', async () => {
    const tabs = leclercTabs();
    const scripting = makeScripting({
      inspectLeclercUsualProductsPageOnPage: { ready: true, productCardCount: 1 },
      readLeclercDepartmentsOnPage: [
        { actionIndex: 0, label: 'Charcuterie Traiteur', active: true },
        { actionIndex: 1, label: 'Épicerie salée', active: false }
      ],
      clickLeclercDepartmentOnPage: { clicked: false, code: 'LECLERC_DEPARTMENT_STALE' },
      readProductCandidatesOnPage: [{ name: 'Ricotta', externalProductId: '1' }]
    });

    const report = await createListImportRunner({ tabs, scripting }).start(LECLERC_JOB);

    expect(report).toMatchObject({ ok: true, partial: true, partialReason: 'LECLERC_DEPARTMENTS_SKIPPED' });
    expect(report.skippedDepartments).toEqual([{ label: 'Épicerie salée', code: 'LECLERC_DEPARTMENT_STALE' }]);
  });

  it('s\'arrête avant toute lecture quand l\'utilisateur n\'est pas connecté', async () => {
    const tabs = leclercTabs();
    const scripting = makeScripting({
      inspectLeclercUsualProductsPageOnPage: { ready: false, code: 'LECLERC_LOGIN_REQUIRED', productCardCount: 0 }
    });

    const report = await createListImportRunner({ tabs, scripting }).start(LECLERC_JOB);

    expect(report).toMatchObject({ ok: false, code: 'LECLERC_LOGIN_REQUIRED' });
    expect(scripting.calls.map((call) => call.name)).toEqual(['inspectLeclercUsualProductsPageOnPage']);
    expect(tabs.removed).toEqual([42]);
  });
});

describe('createListImportRunner — cycle de vie', () => {
  it('refuse de lancer deux fois le même job', async () => {
    const tabs = makeTabs();
    const scripting = makeScripting({ readCoursesUWishlistOnPage: { ok: true, items: [{ name: 'Lait' }] } });
    const runner = createListImportRunner({ tabs, scripting });

    const first = runner.start(COURSES_U_JOB);
    await expect(runner.start(COURSES_U_JOB)).rejects.toThrow('IMPORT_ALREADY_RUNNING');
    await first;
  });

  it('échoue sans ouvrir d\'onglet quand l\'adresse de départ est introuvable', async () => {
    const tabs = makeTabs();
    const scripting = makeScripting({});

    const report = await createListImportRunner({ tabs, scripting }).start({
      ...LECLERC_JOB,
      store: { storeKey: 'leclerc', localStoreId: 'store-2', displayName: 'Leclerc' }
    });

    expect(report).toMatchObject({ ok: false, code: 'IMPORT_URL_UNKNOWN' });
    expect(tabs.create).not.toHaveBeenCalled();
  });

  it('cancel() interrompt l\'import et referme l\'onglet', async () => {
    const tabs = makeTabs();
    const runner = createListImportRunner({
      tabs,
      scripting: {
        executeScript: vi.fn(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve([{ result: { ok: true, items: [] } }]), 5_000);
            })
        )
      }
    });

    const running = runner.start(COURSES_U_JOB);
    // Laisse le temps à l'onglet d'être créé avant d'annuler.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.cancel(COURSES_U_JOB.jobId)).toBe(true);

    await expect(running).resolves.toMatchObject({ ok: false, code: 'IMPORT_CANCELLED' });
    expect(tabs.removed).toEqual([42]);
  });

  it('cancel() sur un job inconnu ne prétend pas avoir annulé quelque chose', () => {
    const runner = createListImportRunner({ tabs: makeTabs(), scripting: makeScripting({}) });

    expect(runner.cancel('job-inexistant')).toBe(false);
  });
});
