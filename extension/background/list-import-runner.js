// Orchestration de l'import des listes/favoris de compte (Leclerc « produits
// habituels », Courses U « Mes Listes »).
//
// Runner AUTONOME, volontairement séparé de job-runner.js : celui-ci porte le
// pipeline de comparaison des prix (file de magasins, disjoncteur, reprise
// après déchargement du service worker, badge de progression) et il est
// stabilisé. L'import n'a rien à voir avec ce cycle — un onglet, une lecture,
// un résultat — et n'a aucune raison d'en modifier le code (voir
// docs/RAPPORT_PASSATION_IMPORT_LISTES.md §6).
//
// ⚠ Le seul geste simulé sur les sites est le changement de rayon côté
// Leclerc (navigation interne neutre, décidée au §13 du rapport). Aucune
// saisie, aucun identifiant, aucun ajout au panier.

import { executeScriptWithTimeout } from '../shared/scripting-timeout.js';
import { readCoursesUWishlistOnPage } from '../adapters/courses-u/courses-u-list-reader.js';
import {
  readLeclercDepartmentsOnPage,
  clickLeclercDepartmentOnPage,
  inspectLeclercUsualProductsPageOnPage
} from '../adapters/leclerc/leclerc-list-reader.js';
import { readProductCandidatesOnPage } from '../adapters/leclerc/leclerc-collector.js';

const EXPECTED_HOSTS = {
  leclerc: /(^|\.)leclercdrive\.fr$/i,
  hyperu: /(^|\.)coursesu\.com$/i
};

// Un import complet (ouverture d'onglet + parcours de tous les rayons Leclerc
// avec une pause humaine entre chacun) doit tenir dans ce délai. Au-delà, on
// annule plutôt que de laisser un onglet ouvert indéfiniment.
const JOB_TIMEOUT_MS = 4 * 60 * 1000;
const PAGE_READY_TIMEOUT_MS = 45_000;

// Plafond de sécurité sur le parcours automatique : au-delà, c'est que la
// détection des rayons a ramassé autre chose qu'une barre de rayons.
const MAX_DEPARTMENTS = 25;

export function createListImportRunner({ tabs, scripting }) {
  /** @type {Map<string, { controller: AbortController }>} */
  const active = new Map();

  async function start(job, onProgress = () => undefined) {
    if (active.has(job.jobId)) throw new Error('IMPORT_ALREADY_RUNNING');

    const controller = new AbortController();
    const signal = controller.signal;
    active.set(job.jobId, { controller });

    const watchdog = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    let tabId;
    try {
      const startUrl = resolveImportStartUrl(job);
      if (!startUrl) {
        return { ok: false, code: 'IMPORT_URL_UNKNOWN', storeKey: job.store.storeKey };
      }

      onProgress({ storeKey: job.store.storeKey, state: 'opening_page' });
      // Onglet inactif : l'import ne doit pas voler l'écran à l'utilisateur,
      // qui reste sur la PWA pendant la lecture.
      const tab = await tabs.create({ active: false, url: startUrl });
      tabId = tab.id;
      await waitForTabReady(tabs, tabId, signal, EXPECTED_HOSTS[job.store.storeKey]);

      const result =
        job.store.storeKey === 'leclerc'
          ? await importLeclerc({ scripting, tabId, signal, onProgress, storeKey: job.store.storeKey })
          : await importCoursesU({ scripting, tabId, signal, onProgress, storeKey: job.store.storeKey });

      return { ...result, storeKey: job.store.storeKey, sourceUrl: startUrl };
    } catch (error) {
      if (signal.aborted) return { ok: false, code: 'IMPORT_CANCELLED', storeKey: job.store.storeKey };
      return {
        ok: false,
        code: 'IMPORT_FAILED',
        storeKey: job.store.storeKey,
        // Message technique brut volontairement absent de la réponse : il
        // peut contenir des fragments d'URL ou de page. Seul le code circule.
        details: { reason: error instanceof Error ? error.name : 'unknown' }
      };
    } finally {
      clearTimeout(watchdog);
      active.delete(job.jobId);
      if (tabId !== undefined) {
        // L'onglet du site est refermé dans tous les cas : il porte la session
        // authentifiée de l'utilisateur et n'a aucune raison de rester ouvert
        // une fois la lecture faite.
        await tabs.remove(tabId).catch(() => undefined);
      }
    }
  }

  function cancel(jobId) {
    const running = active.get(jobId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  return { start, cancel };
}

async function importCoursesU({ scripting, tabId, signal, onProgress, storeKey }) {
  onProgress({ storeKey, state: 'reading_list' });
  const result = await runOnPage(scripting, tabId, readCoursesUWishlistOnPage, [], signal);
  if (!result) return { ok: false, code: 'IMPORT_NO_RESULT' };
  if (!result.ok) return result;
  return {
    ok: true,
    listName: result.listName,
    usedFallbackSelector: result.usedFallbackSelector,
    items: result.items
  };
}

async function importLeclerc({ scripting, tabId, signal, onProgress, storeKey }) {
  onProgress({ storeKey, state: 'reading_list' });
  const page = await runOnPage(scripting, tabId, inspectLeclercUsualProductsPageOnPage, [], signal);
  if (!page?.ready) return { ok: false, code: page?.code ?? 'IMPORT_NO_RESULT' };

  const departments = (await runOnPage(scripting, tabId, readLeclercDepartmentsOnPage, [], signal)) ?? [];

  // Rayons introuvables : on importe quand même ce qui est affiché plutôt que
  // d'échouer. L'utilisateur récupère au moins le rayon courant, et le drapeau
  // `partial` permet à l'écran d'import de le lui dire clairement au lieu de
  // lui laisser croire que tout a été récupéré.
  if (departments.length < 2) {
    const items = (await runOnPage(scripting, tabId, readProductCandidatesOnPage, [], signal)) ?? [];
    return {
      ok: true,
      partial: true,
      partialReason: 'LECLERC_DEPARTMENTS_NOT_FOUND',
      departmentsVisited: [],
      items: dedupeItems(items)
    };
  }

  const planned = departments.slice(0, MAX_DEPARTMENTS);
  const collected = [];
  const visited = [];
  const skipped = [];

  for (const [index, department] of planned.entries()) {
    if (signal.aborted) break;

    onProgress({
      storeKey,
      state: 'reading_department',
      departmentIndex: index + 1,
      departmentTotal: planned.length,
      departmentLabel: department.label
    });

    // Le premier rayon est déjà affiché : ne pas cliquer dessus évite un
    // aller-retour inutile et un rechargement de la grille déjà lue.
    if (!department.active || index > 0) {
      const click = await runOnPage(
        scripting,
        tabId,
        clickLeclercDepartmentOnPage,
        [department.actionIndex, department.label],
        signal
      );
      if (!click?.clicked) {
        skipped.push({ label: department.label, code: click?.code ?? 'LECLERC_DEPARTMENT_CLICK_FAILED' });
        continue;
      }
      // Pause à rythme d'usage humain entre deux rayons (§5 du rapport,
      // décision §13) : elle laisse aussi le SPA Angular re-rendre sa grille
      // avant qu'on la relise.
      await wait(randomJitterMs(1_000, 2_000), signal);
    }

    const items = (await runOnPage(scripting, tabId, readProductCandidatesOnPage, [], signal)) ?? [];
    visited.push({ label: department.label, itemCount: items.length });
    collected.push(...items);
  }

  const items = dedupeItems(collected);
  if (items.length === 0) {
    return { ok: false, code: 'LECLERC_LIST_EMPTY', details: { departmentsVisited: visited, skipped } };
  }
  return {
    ok: true,
    // Un rayon sauté (grille re-rendue entre la lecture des onglets et le
    // clic) rend l'import incomplet : le dire plutôt que de le taire.
    ...(skipped.length > 0 ? { partial: true, partialReason: 'LECLERC_DEPARTMENTS_SKIPPED' } : {}),
    departmentsVisited: visited,
    skippedDepartments: skipped,
    items
  };
}

// Les produits habituels d'un même rayon peuvent réapparaître dans un autre
// (produits multi-rayons), et une grille re-lue trop tôt peut renvoyer une
// partie des cartes précédentes. Identité par identifiant catalogue, puis EAN,
// puis URL de fiche, puis nom — même ordre de fiabilité que côté Courses U.
function dedupeItems(items) {
  const byIdentity = new Map();
  for (const item of items) {
    if (!item?.name) continue;
    const identity = item.externalProductId
      ? `id:${item.externalProductId}`
      : item.barcode
        ? `ean:${item.barcode}`
        : item.productUrl
          ? `url:${item.productUrl}`
          : `name:${String(item.name).toLowerCase()}`;
    const existing = byIdentity.get(identity);
    if (!existing) {
      byIdentity.set(identity, item);
      continue;
    }
    for (const [field, value] of Object.entries(item)) {
      if ((existing[field] === undefined || existing[field] === '') && value !== undefined && value !== '') {
        existing[field] = value;
      }
    }
  }
  return [...byIdentity.values()];
}

/**
 * URL de départ de l'import.
 *
 * `job.listUrl` prime : c'est l'URL d'une liste précise, renvoyée à la PWA par
 * le code COURSESU_PICK_LIST quand le compte en porte plusieurs. Elle est
 * revalidée ici (hôte attendu, HTTPS) et jamais reprise telle quelle sur
 * confiance.
 */
export function resolveImportStartUrl(job) {
  const storeKey = job?.store?.storeKey;
  const expectedHost = EXPECTED_HOSTS[storeKey];
  if (!expectedHost) return null;

  if (job.listUrl) {
    try {
      const url = new URL(job.listUrl);
      if (url.protocol !== 'https:' || !expectedHost.test(url.hostname)) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  if (storeKey === 'hyperu') return 'https://www.coursesu.com/mon-compte/mes-listes';

  // Leclerc : la page des produits habituels vit sous le segment magasin du
  // drive de l'utilisateur (/magasin-<id>/produits-habituels). On le dérive de
  // l'URL du drive déjà enregistrée plutôt que de coder un magasin en dur.
  try {
    const driveUrl = new URL(job.store.driveUrl);
    if (driveUrl.protocol !== 'https:' || !expectedHost.test(driveUrl.hostname)) return null;
    const storeSegment = driveUrl.pathname.split('/').filter(Boolean).find((segment) => /^magasin-/i.test(segment));
    if (!storeSegment) return null;
    return `https://${driveUrl.hostname}/${storeSegment}/produits-habituels`;
  } catch {
    return null;
  }
}

async function runOnPage(scripting, tabId, func, args, signal) {
  if (signal.aborted) throw new Error('IMPORT_CANCELLED');
  // L'annulation doit être ressentie tout de suite, pas au bout du timeout
  // d'injection : sans cette course, un clic sur « Annuler » pendant une
  // lecture laissait l'utilisateur attendre jusqu'à 15 s sans rien voir
  // changer. L'injection abandonnée continue côté navigateur, mais elle meurt
  // avec l'onglet que le `finally` de `start()` referme juste après.
  const injection = executeScriptWithTimeout(scripting, { target: { tabId }, func, args }, 15_000);
  const [result] = await Promise.race([injection, rejectOnAbort(signal)]);
  return result?.result;
}

function rejectOnAbort(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('IMPORT_CANCELLED'));
      return;
    }
    signal.addEventListener?.('abort', () => reject(new Error('IMPORT_CANCELLED')), { once: true });
  });
}

async function waitForTabReady(tabs, tabId, signal, expectedHost) {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('IMPORT_CANCELLED');
    const tab = await tabs.get(tabId);
    if (tab.status === 'complete' && matchesHost(tab.url, expectedHost)) return;
    await wait(200, signal);
  }
  throw new Error('IMPORT_PAGE_TIMEOUT');
}

function matchesHost(url, expectedHost) {
  try {
    return expectedHost.test(new URL(url ?? '').hostname);
  } catch {
    return false;
  }
}

function randomJitterMs(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('IMPORT_CANCELLED'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('IMPORT_CANCELLED'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
