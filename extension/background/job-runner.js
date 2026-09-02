const STORE_HOME_URLS = {
  leclerc: 'https://www.leclercdrive.fr/',
  hyperu: 'https://www.coursesu.com/'
};

// --- Circuit Breaker (P1) -------------------------------------------------
// Un magasin qui échoue de façon répétée (site en panne, bloqué par
// anti-bot, structure changée) ne doit pas être retenté indéfiniment à
// chaque job : ça gaspille du temps et des tentatives réseau pour un
// résultat connu d'avance. Après CIRCUIT_BREAKER_THRESHOLD échecs
// consécutifs, le magasin est mis en "open" pour CIRCUIT_BREAKER_COOLDOWN_MS
// et sauté immédiatement (code CIRCUIT_BREAKER_OPEN) jusqu'à expiration.
//
// Cet état vit dans `breakerStore` — storage.local en production, PAS
// storage.session : un service worker MV3 est déchargé dès qu'il est inactif,
// et storage.session disparaît avec lui. Le compteur d'échecs repartait donc
// de zéro entre deux collectes espacées, et le cooldown de 10 minutes
// n'arrivait jamais à échéance. Autrement dit le disjoncteur ne s'ouvrait en
// pratique que pendant une même salve de collectes — exactement l'inverse de
// son but, et surtout sur Android où le déchargement est le plus agressif.
const CIRCUIT_BREAKER_KEY = 'driveCircuitBreaker';
// Assoupli (29/08) : un lot de SCRIPT_EXECUTION_TIMEOUT isolés (site lent,
// panier volumineux) ne doit pas mettre le magasin en pause aussi vite —
// depuis que les résultats partiels sont conservés en cas de timeout, le
// coût d'un échec isolé est bien plus faible qu'avant. Seuil relevé et
// cooldown raccourci pour ne réagir qu'à une vraie panne prolongée
// (CAPTCHA, IP bannie, structure cassée) sans pénaliser les analyses
// automatiques normales.
const CIRCUIT_BREAKER_THRESHOLD = 6;
const CIRCUIT_BREAKER_COOLDOWN_MS = 3 * 60 * 1000;

async function getCircuitBreakerState(session, storeKey) {
  const stored = (await session.get(CIRCUIT_BREAKER_KEY))?.[CIRCUIT_BREAKER_KEY] ?? {};
  return stored[storeKey] ?? { consecutiveFailures: 0, openUntil: 0 };
}

async function isCircuitOpen(session, storeKey, now = Date.now()) {
  const state = await getCircuitBreakerState(session, storeKey);
  return state.openUntil > now;
}

async function recordCircuitOutcome(session, storeKey, succeeded, now = Date.now()) {
  const stored = (await session.get(CIRCUIT_BREAKER_KEY))?.[CIRCUIT_BREAKER_KEY] ?? {};
  const current = stored[storeKey] ?? { consecutiveFailures: 0, openUntil: 0 };
  const next = succeeded
    ? { consecutiveFailures: 0, openUntil: 0 }
    : {
        consecutiveFailures: current.consecutiveFailures + 1,
        openUntil:
          current.consecutiveFailures + 1 >= CIRCUIT_BREAKER_THRESHOLD
            ? now + CIRCUIT_BREAKER_COOLDOWN_MS
            : current.openUntil
      };
  await session.set({ [CIRCUIT_BREAKER_KEY]: { ...stored, [storeKey]: next } });
}

// --- Classification d'erreurs (P2) ----------------------------------------
// Toutes les erreurs ne se valent pas, et deux questions distinctes se
// posent pour chacune :
//   1. Vaut-il la peine de retenter avec un nouveau tab DANS ce même job ?
//      (non pour une annulation utilisateur — le job entier est mort ;
//       non pour un captcha/bot-protection — un nouveau tab affrontera le
//       même blocage, retenter ne fait qu'aggraver le fingerprint anti-bot)
//   2. Est-ce un signal réel de panne du magasin pour le circuit breaker ?
//      (non pour une annulation — ce n'est pas la faute du magasin ;
//       oui pour tout le reste, y compris un captcha, qui EST un vrai
//       signal qu'il faut laisser le magasin se reposer)
// Un jeu unique de codes "permanent" confondrait ces deux questions (une
// annulation ne doit ouvrir aucun breaker, un captcha doit en ouvrir un).
// CART_LOGIN_REQUIRED : un utilisateur non connecté n'est pas une panne du
// magasin (le site fonctionne, il attend juste que l'utilisateur se
// connecte lui-même) — un nouvel onglet n'y changerait rien (pas de retry),
// et ça ne doit jamais faire sauter le disjoncteur au détriment des futurs
// rafraîchissements de prix, qui n'ont rien à voir avec cet état.
// DRIVE_PICK_TAB_CLOSED (voir waitForLeclercPick/waitForCoursesUPick) : l'onglet
// de sélection manuelle a été fermé par l'utilisateur pendant l'attente — pas
// une panne du magasin, donc pas de nouvelle tentative (rouvrir un onglet tout
// seul serait surprenant) et pas de pénalité sur le disjoncteur. Réutiliser un
// onglet neuf ne réparerait rien : l'utilisateur a simplement fermé la page.
const NO_IMMEDIATE_RETRY_CODES = new Set([
  'DRIVE_JOB_CANCELLED',
  'CAPTCHA_DETECTED',
  'IP_BANNED',
  'CART_LOGIN_REQUIRED',
  'DRIVE_PICK_TAB_CLOSED'
]);
const NOT_A_STORE_FAILURE_CODES = new Set(['DRIVE_JOB_CANCELLED', 'CART_LOGIN_REQUIRED', 'DRIVE_PICK_TAB_CLOSED']);

function classifyErrorCode(code) {
  return {
    shouldRetryWithinJob: !NO_IMMEDIATE_RETRY_CODES.has(code),
    countsAsStoreFailure: !NOT_A_STORE_FAILURE_CODES.has(code)
  };
}

const ALLOWED_STORE_HOSTS = {
  leclerc: /(^|\.)leclercdrive\.fr$/i,
  hyperu: /(^|\.)coursesu\.com$/i
};

// Prefer the store's own saved page (its specific info/catalog URL) over the
// generic homepage: the generic homepage only offers a city-level search that
// cannot resolve a specific store's transactional catalog, while the store's
// own URL is what the farm/catalog resolution in the collectors expects.
function resolveStoreStartUrl(store) {
  if (store.driveUrl) {
    try {
      const url = new URL(store.driveUrl);
      const allowedHost = ALLOWED_STORE_HOSTS[store.storeKey];
      if (url.protocol === 'https:' && allowedHost?.test(url.hostname)) {
        return store.driveUrl;
      }
    } catch {
      // Fall through to the generic homepage below.
    }
  }
  return STORE_HOME_URLS[store.storeKey];
}

const OWNED_TABS_KEY = 'driveOwnedTabIds';

// Track tabs this extension itself opened so a later collection only ever
// reuses its own tabs — never a tab the user happens to be browsing
// manually on leclercdrive.fr/coursesu.com, which findReusableStoreTab used
// to pick up and drive without warning.
async function rememberOwnedTab(session, tabId) {
  const stored = (await session.get(OWNED_TABS_KEY))?.[OWNED_TABS_KEY] ?? [];
  await session.set({ [OWNED_TABS_KEY]: [...new Set([...stored, tabId])] });
}

async function forgetOwnedTab(session, tabId) {
  const stored = (await session.get(OWNED_TABS_KEY))?.[OWNED_TABS_KEY] ?? [];
  await session.set({ [OWNED_TABS_KEY]: stored.filter((id) => id !== tabId) });
}

const STORE_LABELS = { leclerc: 'Leclerc Drive', hyperu: 'Hyper U Drive' };

// Les deux magasins sont traités au premier plan. Leclerc en a besoin pour
// son lazy-load par IntersectionObserver (voir le commentaire détaillé plus
// bas, juste avant tabs.create). Hyper U avait été basculé en arrière-plan le
// 2026-09-01 (étape 1 du plan « collecte en arrière-plan ») au motif que son
// collecteur ne dépend d'aucun rendu visuel : ce raisonnement était juste sur
// le code du collecteur, mais faux sur le navigateur. Test en conditions
// réelles (Firefox Android, 01/09) : l'utilisateur voit l'onglet magasin
// rester derrière la PWA et l'ensemble des requêtes ralentir — Firefox
// Android throttle les timers et le réseau des onglets non actifs, ce qui
// pénalise TOUT collecteur, quelle que soit sa façon de lire la page.
// L'expérience est donc close : premier plan systématique, ce que le plan
// prévoyait justement de vérifier avant de considérer l'arrière-plan acquis.
const STORE_NEEDS_FOREGROUND = { leclerc: true, hyperu: true };

// Utilisé par describeDriveProgress() pour le titre du badge toolbar.
const SEARCH_STAGE_LABELS = {
  ean: 'recherche par code-barres',
  name: 'code-barres sans résultat, recherche par nom',
  simplified_name: 'nom sans résultat, nouvel essai simplifié',
  name_only: 'toujours rien avec la marque, nouvel essai sans la marque',
  brand_only: 'toujours rien, recherche par marque seule'
};

// Android system notifications were tried for progress display, but this
// Firefox-for-Android build re-alerts (sound/heads-up) on every single
// create() call and doesn't implement update() at all, so there was no way
// to avoid a notification per product. Dropped entirely (2026-07-27) in
// favor of the toolbar badge below, which can't spam an alert.
//
// Un overlay injecté dans la page (position fixe en haut) a aussi été
// essayé, mais il est détruit à chaque rechargement complet de page côté
// Leclerc/Hyper U (une étape = une navigation), donc il clignotait en boucle
// et, en haut de page, recouvrait la barre de recherche du site. Le badge
// sur l'icône de la barre d'outils ci-dessous est du chrome navigateur, pas
// du contenu de page : il survit à chaque rechargement sans clignoter et ne
// recouvre jamais rien. Overlay retiré (2026-09-01), seul le badge subsiste.
function describeDriveProgress(progress, storeLabel, stageLabels) {
  const percent =
    Number.isFinite(progress.productIndex) && Number.isFinite(progress.productTotal) && progress.productTotal > 0
      ? Math.round((progress.productIndex / progress.productTotal) * 100)
      : null;
  const stageLabel = progress.searchStage ? stageLabels[progress.searchStage] : null;
  return progress.state === 'product_search'
    ? `${storeLabel} — produit ${progress.productIndex}/${progress.productTotal}${percent !== null ? ` (${percent}%)` : ''}${stageLabel ? ` · ${stageLabel}` : ''}`
    : progress.state === 'awaiting_pick'
      ? `${storeLabel} — à toi de choisir le bon produit sur la page`
      : progress.state === 'store_retry'
        ? `${storeLabel} — nouvel essai…`
        : `${storeLabel} — démarrage…`;
}

// Un job qui n'atteint jamais son `finally` laisse `activeJob` non nul pour
// toujours : toute collecte ultérieure est alors refusée par « Une collecte
// Drive est déjà active. » jusqu'au redémarrage du navigateur, sans aucun
// moyen de débloquer côté utilisateur. Une deadline globale garantit qu'un
// job finit toujours par rendre la main, quoi qu'il arrive dans l'adaptateur.
const DEFAULT_JOB_TIMEOUT_MS = 15 * 60 * 1000;

export function createDriveJobRunner({
  tabs,
  scripting,
  action,
  session,
  // storage.local en production (voir la note du circuit breaker) ; les tests
  // n'injectent qu'un seul faux store et retombent donc sur `session`.
  breakerStore,
  runStore,
  canRunStore = () => true,
  jobTimeoutMs = DEFAULT_JOB_TIMEOUT_MS,
  // Un clic "Valider le panier" est un geste explicite de l'utilisateur qui
  // regarde son écran à cet instant précis — contrairement à un
  // rafraîchissement de fond, ce n'est pas une tâche qui insiste seule en
  // arrière-plan après un blocage détecté. Le disjoncteur reste néanmoins
  // toujours ALIMENTÉ par ce runner (recordCircuitOutcome plus bas) : seule
  // la vérification qui saute le job est contournée, pas l'état partagé.
  respectCircuitBreaker = true
}) {
  const breaker = breakerStore ?? session;
  let activeJob = null;
  // The toolbar action icon is real browser chrome, not page content — unlike
  // the on-page overlay it is never torn down by a page navigation, which is
  // exactly what was asked for: something that stays visible permanently
  // while a collection runs, at the same level as the browser's own nav bar.
  const paintBadge = (progress) => {
    if (!action) return;
    const badgeText =
      Number.isFinite(progress.productIndex) && Number.isFinite(progress.productTotal)
        ? `${progress.productIndex}/${progress.productTotal}`
        : '…';
    action.setBadgeText?.({ text: badgeText })?.catch?.(() => undefined);
    action.setBadgeBackgroundColor?.({ color: '#111111' })?.catch?.(() => undefined);
  };
  const setBadgeTitle = (progress, storeLabel) => {
    action?.setTitle?.({ title: describeDriveProgress(progress, storeLabel, SEARCH_STAGE_LABELS) })?.catch?.(() => undefined);
  };
  const clearBadge = () => {
    action?.setBadgeText?.({ text: '' })?.catch?.(() => undefined);
    action?.setTitle?.({ title: 'Comparateur de Paniers — Drive' })?.catch?.(() => undefined);
  };

  return {
    async start(job, onProgress = () => undefined, { callerTabId } = {}) {
      if (activeJob) {
        throw new Error('Une collecte Drive est déjà active.');
      }

      const startedAt = Date.now();
      const controller = new AbortController();
      const openTabIds = new Set();
      const derivedTabIds = new Set();
      const processingTabIds = new Set();
      activeJob = { jobId: job.jobId, controller, openTabIds };
      // Chien de garde : un adaptateur bloqué dans une attente sans borne
      // (page qui ne finit jamais de charger, boucle d'attente d'un sélecteur
      // qui n'apparaît plus) empêcherait sinon `finally` de s'exécuter, donc
      // de relâcher `activeJob`. L'abort emprunte exactement le même chemin
      // qu'une annulation utilisateur : le job se termine en 'cancelled',
      // ferme ses onglets et rend la main.
      const watchdog = setTimeout(() => {
        if (!controller.signal.aborted) {
          console.warn('[DriveJob] watchdog', { jobId: job.jobId, timeoutMs: jobTimeoutMs });
          controller.abort();
        }
      }, jobTimeoutMs);
      const observations = [];
      const errors = [];
      // Only steal the PWA tab's focus back at the end if some store's tab
      // was actually foregrounded during this job — otherwise (e.g. an
      // all-background run) there's nothing to hand focus back from, and
      // forcing it would yank the user out of whatever they were doing.
      let didForegroundAnyTab = false;
      // Products already marked "not_found" for this store within the last
      // 14 days (see buildSearchMemoryHints in driveRefreshService.ts) are
      // filtered out below before ever reaching the collector — they get no
      // observation and no error, which used to make the diagnostic's fixed
      // "attempted = products × stores" count look like a mass silent
      // failure. Reporting how many were skipped per store lets the caller
      // compute an honest attempted count instead.
      const skipped = [];
      // Attrape les onglets ouverts PAR le site pendant la collecte (popups,
      // target=_blank) pour ne pas les laisser derrière soi. Mais
      // `openerTabId` est aussi renseigné quand c'est l'UTILISATEUR qui ouvre
      // un onglet depuis l'onglet magasin — sa propre page se retrouvait alors
      // fermée à la fin du job (signalé le 01/09 : la fenêtre du comparatif,
      // gardée en écran partagé pendant l'analyse, disparaissait). D'où
      // derivedTabIds : ces onglets-là ne sont fermés qu'après vérification
      // qu'ils sont bien sur un site de magasin (voir le finally).
      const handleCreatedTab = (tab) => {
        if (Number.isInteger(tab?.id) && processingTabIds.has(tab.openerTabId)) {
          openTabIds.add(tab.id);
          derivedTabIds.add(tab.id);
        }
      };
      tabs.onCreated?.addListener(handleCreatedTab);

      await session.set({
        activeDriveJob: { jobId: job.jobId, state: 'collecting', tabIds: [] }
      });

      try {
        // Sequential on purpose: running both store tabs concurrently in the
        // background doubles memory pressure and Android/Firefox discards one
        // of the tabs mid-collection ("Invalid tab ID"). One store at a time
        // is slower but actually finishes.
        const MAX_ATTEMPTS_PER_STORE = 2;
        for (const store of job.stores) {
          if (controller.signal.aborted) break;
          if (!canRunStore(store)) {
            errors.push({ storeKey: store.storeKey, code: 'ADAPTER_NOT_READY' });
            continue;
          }
          // Circuit breaker : magasin en échecs répétés récents, on saute
          // sans même tenter d'ouvrir un tab pour ne pas gaspiller une
          // tentative sur un site qu'on sait indisponible pour l'instant.
          if (respectCircuitBreaker && (await isCircuitOpen(breaker, store.storeKey))) {
            errors.push({ storeKey: store.storeKey, code: 'CIRCUIT_BREAKER_OPEN' });
            continue;
          }

          const unavailableHere = new Set(job.knownUnavailable?.[store.storeKey] ?? []);
          const storeProducts =
            unavailableHere.size > 0
              ? job.products.filter((product) => !unavailableHere.has(product.productId))
              : job.products;
          if (unavailableHere.size > 0) {
            skipped.push({ storeKey: store.storeKey, count: unavailableHere.size });
          }

          // A thrown exception here (tab discarded by Android mid-run,
          // "Invalid tab ID", ...) is usually transient — retrying once with
          // a brand new tab recovers a lot of these without the user having
          // to relaunch the whole job for one flaky store.
          // Alimente le circuit breaker : seul un échec au niveau du magasin
          // (exception non rattrapée par le retry) compte comme échec —
          // des PRODUCT_NOT_FOUND individuels sur des produits ne doivent
          // pas ouvrir le disjoncteur, le magasin fonctionne correctement.
          let storeLevelFailure = false;
          // Leclerc's search-results grid renders each card lazily via
          // IntersectionObserver as it scrolls into view; Firefox throttles
          // layout/observers in tabs that are never the active one, so a
          // background tab's placeholders never fill in no matter how much
          // we scroll them programmatically. That tab must be foregrounded
          // for the site's own lazy-render to actually fire. (The wake lock
          // already keeps the screen on for exactly this kind of visible,
          // in-progress collection.) Hyper U has no such dependency — see
          // STORE_NEEDS_FOREGROUND above — so it's left in the background,
          // letting the user stay on another tab while it runs.
          const needsForeground = STORE_NEEDS_FOREGROUND[store.storeKey] ?? true;
          if (needsForeground) didForegroundAnyTab = true;
          for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_STORE; attempt += 1) {
            const reusableTab = attempt === 1 ? await findReusableStoreTab(tabs, session, store.storeKey) : null;
            // L'onglet est TOUJOURS créé en arrière-plan, puis sélectionné
            // juste après. Signalé le 01/09 : au lancement de l'analyse, la
            // fenêtre flottante d'une autre application (YouTube, Twitch…)
            // posée par-dessus Firefox se refermait. Ouvrir un onglet
            // directement actif fait demander le premier plan par Firefox au
            // niveau Android, ce que le système traite comme un changement
            // d'application et qui referme la fenêtre flottante. Sélectionner
            // ensuite l'onglet reste une opération interne à Firefox, sans
            // demande de premier plan.
            const tab = reusableTab ?? (await tabs.create({ active: false, url: resolveStoreStartUrl(store) }));
            const ownsTab = reusableTab === null;
            if (!Number.isInteger(tab?.id)) {
              if (attempt < MAX_ATTEMPTS_PER_STORE) continue;
              errors.push({ storeKey: store.storeKey, code: 'TAB_CREATION_FAILED' });
              storeLevelFailure = true;
              break;
            }
            // Un onglet réutilisé traîne depuis un run précédent et n'est pas
            // forcément celui affiché : même besoin de sélection qu'un onglet
            // fraîchement créé, pour ne pas subir le throttling des onglets
            // inactifs.
            if (needsForeground) {
              try {
                await tabs.update(tab.id, { active: true });
              } catch {
                // Non-fatal: the collector will simply hit the same
                // lazy-render issue this tab already had, surfaced via its
                // own PRODUCT_NOT_FOUND diagnostics.
              }
            }
            // A reused tab can be sitting on whatever page the PREVIOUS job
            // left it on — a single product's fiche-produit page, a cart
            // view, a checkout step — none of which necessarily carry the
            // same header search input the collector depends on. Confirmed
            // by a real diagnostic: an add-to-cart job failed
            // CART_SEARCH_NOT_STARTED for every single item in a row, which
            // only makes sense if the FIRST search already failed on a
            // stale page and every later item just replayed the same
            // broken state. A freshly created tab already starts at
            // resolveStoreStartUrl(store); force a reused one back there
            // too so every attempt begins from the same known-good page
            // regardless of what the last job left behind. Unrelated to
            // foreground/background — always applied.
            if (reusableTab) {
              try {
                await tabs.update(tab.id, { url: resolveStoreStartUrl(store) });
                await wait(1_500, controller.signal);
              } catch {
                // Non-fatal: same fallback as above — the collector's own
                // per-item diagnostics will surface whatever state this
                // left the tab in.
              }
            }
            if (ownsTab) await rememberOwnedTab(session, tab.id);

            processingTabIds.add(tab.id);
            if (ownsTab) openTabIds.add(tab.id);
            await session.set({
              activeDriveJob: {
                jobId: job.jobId,
                state: 'collecting',
                tabIds: [...openTabIds]
              }
            });
            // The PWA tab is no longer visible during collection (the store
            // tab is now foregrounded — see the active:true note above), so
            // its live progress UI can't be seen either. The toolbar badge
            // (set below) is what carries progress while this tab is on
            // screen — it's real browser chrome, not page content, so it
            // survives every page reload without flickering (an on-page
            // overlay was tried first but got torn down by every full page
            // reload and, anchored to the top, covered the site's own search
            // bar — dropped in favor of just this badge). A mirrored
            // browser.notifications progress notification was also tried
            // (2026-09-01) so the progress is visible without opening the
            // extensions menu, but Firefox Android re-alerts (sound/
            // heads-up) on every single update regardless of reusing the
            // same id or setting priority: -2 — confirmed live on-device —
            // so it was dropped again. Only the badge is reliable here.
            const storeLabel = STORE_LABELS[store.storeKey] ?? store.storeKey;
            const reportProgress = (progress) => {
              onProgress(progress);
              paintBadge(progress);
              setBadgeTitle(progress, storeLabel);
            };
            reportProgress({ storeKey: store.storeKey, state: attempt === 1 ? 'store_started' : 'store_retry' });
            let keepTabOpen = false;
            let shouldRetry = false;

            try {
              const storeResult = await runStore({
                job,
                store,
                products: storeProducts,
                searchHints: job.searchHints?.[store.storeKey] ?? {},
                tabId: tab.id,
                signal: controller.signal,
                onProgress: reportProgress
              });
              observations.push(...(storeResult.observations ?? []));
              errors.push(...(storeResult.errors ?? []));
              keepTabOpen = storeResult.keepTabOpen === true;
            } catch (error) {
              const failure = describeStoreFailure(error);
              const { shouldRetryWithinJob, countsAsStoreFailure } = classifyErrorCode(failure.code);
              shouldRetry = attempt < MAX_ATTEMPTS_PER_STORE && shouldRetryWithinJob;
              if (shouldRetry) {
                keepTabOpen = false;
              } else {
                // An unexpected exception is as much a troubleshooting case
                // as a deliberate failed() return with keepTabOpen — leave
                // the tab open on the final attempt so the user can see
                // what state the page was in, unless it was a
                // user-requested cancellation or the tab is already gone.
                keepTabOpen = failure.code !== 'DRIVE_JOB_CANCELLED' && failure.code !== 'DRIVE_PICK_TAB_CLOSED';
                errors.push({ storeKey: store.storeKey, ...failure });
                storeLevelFailure = countsAsStoreFailure;
                // Un arrêt en cours de boucle (CAPTCHA/SCRIPT_EXECUTION_TIMEOUT,
                // voir leclerc-collector.js/courses-u-collector.js) ne doit pas
                // jeter les produits déjà trouvés AVANT le blocage — seulement
                // sur cette tentative FINALE (aucune nouvelle tentative fraîche
                // derrière qui repasserait sur les mêmes produits et créerait
                // des doublons). Signalé par l'utilisateur : la plupart des
                // produits ressortaient "non trouvés" chez Leclerc alors qu'ils
                // avaient déjà été identifiés avant qu'un timeout n'efface tout.
                if (Array.isArray(error?.partialObservations)) observations.push(...error.partialObservations);
                if (Array.isArray(error?.partialErrors)) errors.push(...error.partialErrors);
              }
            } finally {
              if (ownsTab && !keepTabOpen) await safelyCloseTab(tabs, tab.id, session);
              openTabIds.delete(tab.id);
              processingTabIds.delete(tab.id);
            }
            if (!shouldRetry) break;
          }
          if (!controller.signal.aborted) {
            await recordCircuitOutcome(breaker, store.storeKey, !storeLevelFailure);
          }
        }

        const status = controller.signal.aborted
          ? 'cancelled'
          : errors.length > 0
            ? observations.length > 0
              ? 'partial'
              : 'failed'
            : 'completed';
        // Log structuré (P3) : sans ça, un pattern de pannes récurrent
        // (ex. 80% des échecs Leclerc sont des CAPTCHA_DETECTED un jour
        // donné) est invisible tant qu'on n'a pas rouvert chaque
        // diagnostic JSON un par un pour les compter à la main.
        const errorCodeCounts = {};
        for (const { code } of errors) {
          errorCodeCounts[code] = (errorCodeCounts[code] ?? 0) + 1;
        }
        console.log('[DriveJob] summary', {
          jobId: job.jobId,
          status,
          durationMs: Date.now() - startedAt,
          storeCount: job.stores.length,
          productCount: job.products.length,
          observationCount: observations.length,
          errorCount: errors.length,
          errorCodeCounts,
          skipped
        });

        return {
          jobId: job.jobId,
          status,
          observations,
          errors,
          skipped
        };
      } finally {
        clearTimeout(watchdog);
        tabs.onCreated?.removeListener(handleCreatedTab);
        for (const tabId of openTabIds) {
          // Fail-closed : un onglet simplement hérité de l'onglet magasin
          // (voir handleCreatedTab) n'est fermé que si on peut confirmer
          // qu'il est bien sur un site de magasin. En cas de doute — URL
          // illisible, tabs.get indisponible — on le laisse ouvert : un
          // onglet de trop est sans gravité, fermer la page de l'utilisateur
          // ne l'est pas.
          if (derivedTabIds.has(tabId) && !(await isStoreTab(tabs, tabId))) continue;
          await safelyCloseTab(tabs, tabId, session);
        }
        // Store tabs needing the foreground (Leclerc's lazy-render) leave
        // the user staring at whichever store tab a leftover/kept-open tab
        // happened to be — bring them back to the app that started the job.
        // Skipped when nothing was ever foregrounded (e.g. an all-Hyper-U
        // run): stealing focus back then would interrupt the user for no
        // reason, since their own tab was never taken from them.
        if (didForegroundAnyTab && Number.isInteger(callerTabId)) {
          try {
            await tabs.update(callerTabId, { active: true });
          } catch {
            // Non-fatal: the PWA tab may have been closed meanwhile.
          }
        }
        await session.remove(['activeDriveJob']);
        clearBadge();
        activeJob = null;
      }
    },

    cancel(jobId) {
      if (!activeJob || activeJob.jobId !== jobId) {
        return false;
      }
      activeJob.controller.abort();
      return true;
    },

    getActiveJobId() {
      return activeJob?.jobId ?? null;
    }
  };
}

// Nettoyage des restes d'un job interrompu par le déchargement du service
// worker. `activeJob` ne vit qu'en mémoire : quand le navigateur décharge le
// worker en pleine collecte (comportement normal de MV3, particulièrement
// agressif sur Android), le `finally` de start() n'est jamais atteint. Restent
// alors derrière : les onglets Drive que l'extension avait ouverts, le badge
// figé sur un compteur, et la clé `activeDriveJob`. storage.session survit au
// déchargement du worker mais pas à la fermeture du navigateur — c'est
// exactement la durée de vie recherchée pour détecter ce cas.
//
// À appeler au chargement du worker, avant tout nouveau job.
export async function recoverInterruptedJob({ tabs, session, action }) {
  let interrupted;
  try {
    interrupted = (await session.get('activeDriveJob'))?.activeDriveJob;
  } catch {
    return null;
  }
  if (!interrupted) return null;

  console.warn('[DriveJob] reprise après déchargement du worker', { jobId: interrupted.jobId });

  // Seuls les onglets ouverts par l'extension sont fermés : `driveOwnedTabIds`
  // exclut déjà tout onglet que l'utilisateur naviguait lui-même.
  let ownedTabIds = [];
  try {
    ownedTabIds = (await session.get(OWNED_TABS_KEY))?.[OWNED_TABS_KEY] ?? [];
  } catch {
    ownedTabIds = [];
  }
  const toClose = (interrupted.tabIds ?? []).filter((tabId) => ownedTabIds.includes(tabId));
  for (const tabId of toClose) {
    await safelyCloseTab(tabs, tabId, session);
  }

  try {
    await session.remove(['activeDriveJob']);
  } catch {
    // Rien à rattraper : la clé disparaîtra de toute façon à la fermeture du
    // navigateur, et un job neuf l'écrasera.
  }
  action?.setBadgeText?.({ text: '' })?.catch?.(() => undefined);
  action?.setTitle?.({ title: 'Comparateur de Paniers — Drive' })?.catch?.(() => undefined);

  return { jobId: interrupted.jobId, closedTabIds: toClose };
}

// Attente annulable. `wait` était appelé ici sans jamais être défini ni
// importé : le ReferenceError était avalé par le try/catch appelant, donc la
// pause après le retour d'un onglet réutilisé sur sa page de départ n'avait
// jamais lieu et le collector démarrait sur une page encore en navigation.
function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('DRIVE_JOB_CANCELLED'));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('DRIVE_JOB_CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function describeStoreFailure(error) {
  const message = error instanceof Error ? error.message : '';
  // `error.details` (ex: la phase du prologue Leclerc où un
  // SCRIPT_EXECUTION_TIMEOUT a frappé — voir ensureLeclercCatalogReady) était
  // silencieusement perdu ici dès que le message matchait le format de code
  // court : cette branche ne retournait que `{ code }`, sans jamais regarder
  // si l'erreur portait un contexte utile en plus.
  const details = error instanceof Error && error.details && typeof error.details === 'object' ? error.details : null;
  if (/^[A-Z][A-Z0-9_]*$/.test(message)) return { code: message, ...(details ? { details } : {}) };
  return {
    code: 'STORE_COLLECTION_FAILED',
    ...(details || message ? { details: { ...(details ?? {}), ...(message ? { reason: message.slice(0, 200) } : {}) } } : {})
  };
}

const STORE_HOSTNAME_SUFFIXES = ['leclercdrive.fr', 'coursesu.com'];

// Renvoie true UNIQUEMENT si l'onglet est lisible et pointe sur un site de
// magasin. Toute incertitude (onglet disparu, URL vide parce que la
// permission "tabs" ne la donne pas, tabs.get absent) répond false : cette
// réponse ne sert qu'à autoriser une fermeture, jamais à en déclencher une.
async function isStoreTab(tabs, tabId) {
  try {
    const tab = await tabs.get(tabId);
    const hostname = new URL(tab?.url ?? '').hostname.toLowerCase();
    return STORE_HOSTNAME_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

async function safelyCloseTab(tabs, tabId, session) {
  try {
    await tabs.remove(tabId);
  } catch {
    // The user or browser may already have closed the temporary tab.
  }
  if (session) await forgetOwnedTab(session, tabId);
}

async function findReusableStoreTab(tabs, session, storeKey) {
  try {
    const patterns =
      storeKey === 'leclerc'
        ? ['https://leclercdrive.fr/*', 'https://*.leclercdrive.fr/*']
        : ['https://coursesu.com/*', 'https://*.coursesu.com/*'];
    const [matches, ownedTabIds] = await Promise.all([
      tabs.query({ url: patterns }),
      session.get(OWNED_TABS_KEY)
    ]);
    const owned = new Set(ownedTabIds?.[OWNED_TABS_KEY] ?? []);
    return (
      matches
        .filter((tab) => Number.isInteger(tab?.id) && owned.has(tab.id))
        .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0] ?? null
    );
  } catch {
    return null;
  }
}
