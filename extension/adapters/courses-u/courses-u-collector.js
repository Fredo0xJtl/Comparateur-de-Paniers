import { validateDriveObservation } from '../../shared/drive-protocol.js';
import { runCookieConsentDismissal } from '../../shared/cookie-consent.js';
import { executeScriptWithTimeout } from '../../shared/scripting-timeout.js';
import { stripPackagingNoiseFromSearchName, dedupeBrandFromSearchName } from '../../shared/search-query.js';
import { parseQuantityFromName, normalizeQuantity, quantitiesMatch } from '../../shared/quantity-parser.js';
import { chooseLeclercDriveChoice as chooseStoreChoice } from '../leclerc/leclerc-store-selection.js';
import { isVerboseDiagnosticsEnabled } from '../../shared/verbose-diagnostics.js';

// Journal structuré, jumeau de celui du collecteur Leclerc : contient des noms
// de produits, donc désactivé par défaut (audit sécurité du 30/08, MEDIUM #6)
// — voir extension/shared/verbose-diagnostics.js.
function debugLog(stage, data) {
  if (!isVerboseDiagnosticsEnabled()) return;
  console.log(`[HyperU] ${JSON.stringify({ timestamp: new Date().toISOString(), stage, ...data })}`);
}

// Prologue partagé : amène l'onglet jusqu'au catalogue du bon magasin Hyper U
// (dismiss cookies, sélection du magasin si pas déjà fait). Extrait pour être
// réutilisé tel quel par livePickCoursesUProduct (sélection manuelle en
// direct), à l'identique du prologue Leclerc (ensureLeclercCatalogReady).
async function ensureCoursesUCatalogReady({ scripting, tabId, store, signal }) {
  const consent = await runCookieConsentDismissal(scripting, tabId);
  // Fail-closed (audit sécurité du 30/08, MEDIUM #7) : on ne clique plus
  // "Tout accepter" à la place de l'utilisateur quand aucun bouton de refus
  // n'est reconnu — voir extension/shared/cookie-consent.js. Le magasin
  // échoue ici avec un code explicite plutôt que de continuer sur une page
  // potentiellement toujours bloquée par la bannière.
  if (consent?.code === 'CONSENT_REJECT_UNAVAILABLE') {
    return { ready: false, code: 'COOKIE_CONSENT_BLOCKED' };
  }
  await wait(600, signal);
  let state = await run(scripting, tabId, inspectCoursesUPage, []);
  if (state?.blocked) return { ready: false, code: 'SITE_BLOCKED' };

  if (!state?.catalogReady) {
    const selection = await selectCoursesUStore({ scripting, tabId, store, signal });
    if (!selection.started) return { ready: false, code: selection.code, details: selection.details, keepTabOpen: true };
    await wait(2_500, signal);
    state = await run(scripting, tabId, inspectCoursesUPage, []);
  }
  if (!state?.catalogReady) {
    return { ready: false, code: 'COURSESU_CATALOG_NOT_READY', details: state?.details, keepTabOpen: true };
  }
  return { ready: true };
}

export async function collectCoursesUStore({ scripting, tabs, tabId, job, store, products, signal, onProgress = () => undefined }) {
  const prologue = await ensureCoursesUCatalogReady({ scripting, tabId, store, signal });
  if (!prologue.ready) return failure(store, prologue.code, prologue.details, prologue.keepTabOpen === true);

  const observations = [];
  const errors = [];
  let isFirstProduct = true;
  let productIndex = 0;
  // Route du catalogue mémorisée AVANT le premier produit : le raccourci
  // "permalien appris" ci-dessous amène l'onglet sur une fiche produit, d'où
  // startCoursesUSearch ne retrouve pas forcément le champ de recherche. En
  // cas de repli il faut donc y revenir explicitement. Lue seulement si un
  // raccourci est réellement prévu : une injection de plus avant le premier
  // produit n'a aucune utilité pour une collecte 100 % automatique.
  const needsCatalogRouteFallback = products.some((product) =>
    Boolean(job.knownProductUrls?.hyperu?.[product.productId])
  );
  const catalogRouteUrl = needsCatalogRouteFallback
    ? ((await run(scripting, tabId, readCurrentCoursesUUrlOnPage, []))?.href ?? null)
    : null;
  for (const product of products) {
    if (signal.aborted) break;
    productIndex += 1;
    // Randomized gap between products, mirroring the Leclerc collector, so
    // the search cadence doesn't read as a fixed-interval bot pattern.
    if (!isFirstProduct) await wait(randomJitterMs(500, 1_400), signal);
    isFirstProduct = false;
    onProgress({
      storeKey: store.storeKey,
      state: 'product_search',
      productIndex,
      productTotal: products.length,
      productName: product.name
    });
    // Correction manuelle : l'utilisateur a collé l'URL exacte de la fiche
    // produit (voir DriveManualUrlOverridesV1) — Hyper U a des permaliens
    // stables (contrairement à Leclerc, voir livePickLeclercProduct), donc on
    // y navigue directement plutôt que de relancer la recherche automatique.
    const manualUrl = job.manualUrlOverrides?.hyperu?.[product.productId];
    if (manualUrl) {
      try {
        const manual = await collectCoursesUManualProduct({ scripting, tabs, tabId, signal, manualUrl });
        if (!manual.ok) {
          errors.push({
            storeKey: store.storeKey,
            productId: product.productId,
            code: manual.code ?? 'MANUAL_URL_PAGE_INVALID',
            ...(manual.details ? { details: manual.details } : {})
          });
          continue;
        }
        observations.push(validateDriveObservation({
          protocolVersion: 1,
          jobId: job.jobId,
          productId: product.productId,
          storeKey: 'hyperu',
          localStoreId: store.localStoreId,
          externalStoreId: manual.externalStoreId || store.localStoreId,
          ...(manual.externalProductId ? { externalProductId: manual.externalProductId } : {}),
          observedName: manual.name,
          ...(manual.barcode ? { observedBarcode: manual.barcode } : {}),
          matchScore: 1,
          matchStage: 'manual',
          priceEuro: manual.priceEuro,
          ...(manual.unitPriceEuro !== undefined
            ? { unitPriceEuro: manual.unitPriceEuro, unitPriceUnit: manual.unitPriceUnit }
            : {}),
          available: manual.available !== false,
          productUrl: manualUrl,
          observedAt: new Date().toISOString(),
          evidence: 'official_drive_page'
        }));
      } catch (error) {
        // Tester #14 (audit 30/08) : ce chemin de correction manuelle (URL
        // collée par l'utilisateur) avalait TOUTE erreur — y compris
        // SCRIPT_EXECUTION_TIMEOUT — en un simple MANUAL_URL_NAVIGATION_FAILED
        // par produit, contrairement au chemin de recherche normale
        // ci-dessous qui abandonne tout le magasin (avec sonde de survie) sur
        // le même timeout. Un onglet figé compromet la collecte entière quel
        // que soit le chemin qui l'a détecté en premier — traitement identique
        // ici pour rester cohérent.
        if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') {
          const health = await probeCoursesUTab({ scripting, tabId, timeoutMs: 5_000 }).catch(() => null);
          if (health && !health.blocked) {
            errors.push({ storeKey: store.storeKey, productId: product.productId, code: 'PRODUCT_SEARCH_TIMEOUT' });
            continue;
          }
          error.partialObservations = observations;
          error.partialErrors = errors;
          throw error;
        }
        // COURSESU_TAB_CLOSED (tester #15, audit 30/08) : ce tabId est
        // partagé par tous les produits de la boucle — un onglet confirmé
        // fermé rendrait TOUT produit suivant tout aussi inexploitable, donc
        // abandon immédiat plutôt qu'un MANUAL_URL_NAVIGATION_FAILED répété
        // pour chaque produit restant. Pas besoin de sonde ici : la fermeture
        // de l'onglet est déjà confirmée (voir waitForCoursesUTabLoad), une
        // sonde échouerait de toute façon.
        if (error instanceof Error && error.message === 'COURSESU_TAB_CLOSED') {
          error.partialObservations = observations;
          error.partialErrors = errors;
          throw error;
        }
        errors.push({ storeKey: store.storeKey, productId: product.productId, code: 'MANUAL_URL_NAVIGATION_FAILED' });
      }
      continue;
    }

    // Raccourci "permalien appris" (02/09/2026) : ce produit a déjà été trouvé
    // ici lors d'un rafraîchissement précédent et l'adresse exacte de sa fiche
    // a été mémorisée (job.knownProductUrls — voir buildKnownProductUrls côté
    // PWA). On relit cette fiche directement plutôt que de relancer une
    // recherche qui peut retenir un autre produit si le catalogue a bougé.
    //
    // Aucune valeur de preuve humaine, contrairement au bloc manuel ci-dessus :
    // la fiche est revérifiée (EAN si les deux sont connus, sinon nom) et
    // l'observation porte le score RÉELLEMENT mesuré, jamais 1. En cas de
    // doute, on ne retient rien et la recherche normale reprend juste en
    // dessous — un permalien appris ne doit jamais empêcher de trouver mieux.
    const knownUrl = job.knownProductUrls?.hyperu?.[product.productId];
    if (knownUrl) {
      let known = null;
      try {
        known = await collectCoursesUManualProduct({ scripting, tabs, tabId, signal, manualUrl: knownUrl });
      } catch (error) {
        // Un onglet figé ou fermé compromet la collecte entière quel que soit
        // le chemin qui le détecte : même traitement que le bloc manuel.
        if (
          error instanceof Error &&
          (error.message === 'SCRIPT_EXECUTION_TIMEOUT' || error.message === 'COURSESU_TAB_CLOSED')
        ) {
          error.partialObservations = observations;
          error.partialErrors = errors;
          throw error;
        }
        known = null;
      }
      // Un EAN différent est une preuve directe que la fiche n'est plus la
      // bonne : rejet sans même regarder le nom.
      const barcodeConflict = Boolean(product.barcode && known?.barcode && known.barcode !== product.barcode);
      const knownScore = known?.ok && !barcodeConflict ? scoreCoursesUProductPageName(product, known.name) : 0;
      if (known?.ok && !barcodeConflict && knownScore >= KNOWN_URL_MIN_NAME_SCORE) {
        observations.push(validateDriveObservation({
          protocolVersion: 1,
          jobId: job.jobId,
          productId: product.productId,
          storeKey: 'hyperu',
          localStoreId: store.localStoreId,
          externalStoreId: known.externalStoreId || store.localStoreId,
          ...(known.externalProductId ? { externalProductId: known.externalProductId } : {}),
          observedName: known.name,
          ...(known.barcode ? { observedBarcode: known.barcode } : {}),
          matchScore: Number(knownScore.toFixed(2)),
          matchStage: 'known_url',
          priceEuro: known.priceEuro,
          ...(known.unitPriceEuro !== undefined
            ? { unitPriceEuro: known.unitPriceEuro, unitPriceUnit: known.unitPriceUnit }
            : {}),
          available: known.available !== false,
          productUrl: knownUrl,
          observedAt: new Date().toISOString(),
          evidence: 'official_drive_page'
        }));
        continue;
      }
      // Pas une erreur pour l'utilisateur : le raccourci a échoué, la
      // recherche normale prend le relais. Trace quand même, sinon un
      // permalien devenu systématiquement faux resterait invisible.
      debugLog('known_url_fallback', {
        product: product.name,
        reason: barcodeConflict ? 'barcode_mismatch' : known?.ok ? 'name_mismatch' : (known?.code ?? 'page_unreadable')
      });
      // La navigation a laissé l'onglet sur la fiche produit : startCoursesUSearch
      // cherche son champ de recherche dans la PAGE COURANTE, donc on revient
      // d'abord sur la route depuis laquelle les recherches fonctionnent
      // (même piège que côté Leclerc, documenté le 28/08). Sans ça, un
      // raccourci raté transformait la recherche de repli en
      // PRODUCT_SEARCH_INPUT_NOT_FOUND.
      if (catalogRouteUrl) {
        try {
          await tabs.update(tabId, { url: catalogRouteUrl });
          await waitForCoursesUTabLoad(tabs, tabId, signal);
          await wait(600, signal);
        } catch {
          // Retour impossible : la recherche ci-dessous échouera avec son
          // propre code explicite, pas besoin d'en inventer un ici.
        }
      }
    }

    try {
      // Courses U accepte les EAN comme requêtes (preuve réelle Firefox du
      // 01/09/2026). C'est la meilleure clé de découverte : on ne valide ce
      // chemin que si la carte retournée expose exactement le même EAN. Une
      // réponse vide, tronquée ou sans EAN retombe sur le texte ci-dessous.
      let best = null;
      let matchStage;
      if (product.barcode) {
        const eanSearch = await run(scripting, tabId, startCoursesUSearch, [{ ...product, searchQuery: product.barcode }]);
        if (eanSearch?.started) {
          const eanCandidates = await waitForCoursesUProducts({ scripting, tabId, signal, expectedQuery: eanSearch.query });
          best = chooseCoursesUProduct(product, eanCandidates.filter((candidate) => candidate.barcode === product.barcode));
          if (best) matchStage = 'ean';
        }
      }

      // Un nom Open Food Facts embarque souvent du bruit d'emballage/nutrition
      // ("Emmental râpé fondant PRESIDENT - 30% de matière grasse - 200g")
      // et parfois la marque déjà répétée dans le nom — signalé par
      // l'utilisateur comme cassant la pertinence de la recherche magasin.
      // Contrairement à Leclerc, Hyper U n'a pas de cascade de repli : ce
      // nettoyage est appliqué dès l'unique tentative, sur une copie dédiée
      // (le scoring plus bas continue de comparer contre `product` ORIGINAL).
      const searchName = stripPackagingNoiseFromSearchName(product.name);
      const searchProduct = {
        ...product,
        name: searchName || product.name,
        brand: dedupeBrandFromSearchName(searchName || product.name, product.brand)
      };
      if (!best) {
        const search = await run(scripting, tabId, startCoursesUSearch, [searchProduct]);
        if (!search?.started) {
          errors.push({ storeKey: store.storeKey, productId: product.productId, code: search?.code ?? 'PRODUCT_SEARCH_NOT_STARTED' });
          continue;
        }
        const candidates = await waitForCoursesUProducts({ scripting, tabId, signal, expectedQuery: search.query });
        best = chooseCoursesUProduct(product, candidates);
        if (best) matchStage = 'name';
      }
      if (!best) {
        const details = await inspectProductResults(scripting, tabId, inspectCoursesUResults);
        // Alignement sur le comportement Leclerc (voir leclerc-collector.js,
        // collectLeclercStore) : un captcha bloque TOUTE recherche sur ce
        // tab, pas seulement ce produit — continuer à enchaîner les
        // produits suivants ne ferait que multiplier les PRODUCT_NOT_FOUND
        // et prolonger l'exposition au système anti-bot pour rien. Ce
        // signal existait déjà dans inspectCoursesUResults mais n'était
        // jamais lu ici — point mort corrigé le 2026-08-27.
        if (details?.hasCaptcha) {
          throw new Error('CAPTCHA_DETECTED');
        }
        errors.push({ storeKey: store.storeKey, productId: product.productId, code: 'PRODUCT_NOT_FOUND', details });
        continue;
      }
      observations.push(validateDriveObservation({
        protocolVersion: 1,
        jobId: job.jobId,
        productId: product.productId,
        storeKey: 'hyperu',
        localStoreId: store.localStoreId,
        externalStoreId: best.externalStoreId || store.localStoreId,
          ...(best.externalProductId ? { externalProductId: best.externalProductId } : {}),
          observedName: best.name,
          ...(best.brand ? { observedBrand: best.brand } : {}),
          ...(best.barcode ? { observedBarcode: best.barcode } : {}),
        ...(best.observedQuantity !== undefined ? { observedQuantity: best.observedQuantity } : {}),
        ...(best.observedUnit ? { observedUnit: best.observedUnit } : {}),
        matchScore: best.matchScore,
        ...(matchStage ? { matchStage } : {}),
        priceEuro: best.priceEuro,
        ...(best.unitPriceEuro !== undefined
          ? { unitPriceEuro: best.unitPriceEuro, unitPriceUnit: best.unitPriceUnit }
          : {}),
          available: best.available !== false,
          ...(best.promotionLabel ? { promotionLabel: best.promotionLabel } : {}),
          productUrl: best.productUrl,
        observedAt: new Date().toISOString(),
        evidence: 'official_drive_page'
      }));
    } catch (error) {
      // CAPTCHA_DETECTED (levé volontairement ci-dessus) doit interrompre
      // toute la collecte du magasin, pas seulement ce produit — un
      // catch-all générique ici l'aurait avalé en PRODUCT_SEARCH_FAILED par
      // produit et laissé la boucle continuer sur une page qui bloque
      // activement (même raisonnement que collectLeclercStore).
      if (error instanceof Error && error.message === 'CAPTCHA_DETECTED') {
        error.partialObservations = observations;
        error.partialErrors = errors;
        throw error;
      }
      // SCRIPT_EXECUTION_TIMEOUT — reviewer #12 (audit 30/08) : port du
      // correctif appliqué à collectLeclercStore le 29/08 (voir le
      // commentaire détaillé là-bas). Avant ce correctif, un unique appel
      // injecté qui ne répond pas en 10s abandonnait TOUTE la collecte
      // Hyper U, sur l'hypothèse qu'un appel figé signifie l'onglet entier
      // mort — alors que le diagnostic réel côté Leclerc a montré que ce
      // timeout peut frapper un seul produit ponctuellement sans que
      // l'onglet soit réellement bloqué. Sonde rapide (budget réduit) :
      // seul un onglet qui ne répond pas non plus à cette sonde confirme un
      // vrai blocage global et justifie l'abandon complet.
      if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') {
        const health = await probeCoursesUTab({ scripting, tabId, timeoutMs: 5_000 }).catch(() => null);
        if (health && !health.blocked) {
          errors.push({ storeKey: store.storeKey, productId: product.productId, code: 'PRODUCT_SEARCH_TIMEOUT' });
          continue;
        }
        // Les produits déjà trouvés avant ce blocage ne doivent pas
        // disparaître silencieusement (même logique que collectLeclercStore).
        error.partialObservations = observations;
        error.partialErrors = errors;
        throw error;
      }
      errors.push({ storeKey: store.storeKey, productId: product.productId, code: 'PRODUCT_SEARCH_FAILED' });
    }
  }
  return { observations, errors };
}

// Décision utilisateur (2026-08-28, revue après test réel) : une première
// version attendait ici, en sondant la page pendant jusqu'à 4 minutes, que
// l'utilisateur se connecte — dans l'espoir de reprendre le remplissage tout
// seul sans qu'il ait à recliquer. Abandonné : ce sondage tourne dans le
// service worker de l'extension, que MV3 décharge de façon particulièrement
// agressive sur Android dès que Firefox n'est plus au premier plan (voir la
// note équivalente dans job-runner.js) — or se connecter implique presque
// toujours une double authentification, qui oblige justement à quitter
// Firefox. Constaté en conditions réelles : le sondage meurt silencieusement
// à ce moment-là (plus aucun rappel de progression), et l'onglet lui-même
// peut être déchargé et rechargé par le navigateur pendant l'absence,
// perdant l'état du formulaire de connexion en cours. Un contrôle unique et
// immédiat, suivi d'un message invitant à recliquer "Valider le panier" une
// fois connecté, ne dépend d'aucun processus censé survivre en arrière-plan
// pendant plusieurs minutes — c'est nettement plus fiable sur cette
// plateforme, au prix d'un second clic explicite.

// Adds each item to the real Courses U cart.
//
// Historique : un premier essai (2026-07-29) naviguait directement vers
// `item.productUrl` (le lien du candidat validé par le scraping de prix) —
// abandonné après un diagnostic réel montrant un permalien devenu périmé
// entre le scraping et ce remplissage, silencieusement redirigé par le site
// vers une page de résultats de recherche générique au lieu d'un 404. Le
// repli choisi alors (recherche fraîche par nom, comme collectCoursesUStore)
// a fini par causer un bug distinct et plus grave (2026-08-28) : le moteur de
// recherche interne de coursesu.com gère mal les noms génériques d'une liste
// de courses ("Riz basmati en sachet 5x 2 personnes") et peut renvoyer des
// résultats totalement hors sujet, ne contenant même pas la catégorie de
// produit recherchée — aucun matching EAN en aval ne peut alors retrouver le
// bon produit puisqu'il n'apparaît jamais parmi les candidats scannés. Deux
// mauvais produits avaient ainsi été ajoutés au panier réel de l'utilisateur.
//
// Nouvelle approche (2026-08-28, validée par l'utilisateur — « le produit
// exact est bien dans la fiche produit [...] c'est ce qu'il faut réutiliser
// [...] pour valider le panier ») : on retente la navigation directe vers
// `item.productUrl` en PREMIER (voir tryAddToCartCoursesUViaProductUrl),
// mais cette fois sans jamais lui faire confiance aveuglément — la fiche
// atteinte est relue et son EAN doit correspondre exactement à
// `item.barcode` (ou, à défaut d'EAN connu, un recouvrement de nom suffisant)
// avant le moindre clic. Ça couvre exactement le cas de permalien périmé qui
// avait fait abandonner cette approche en juillet, sans revenir au bug
// d'origine : tout échec de cette vérification (URL absente, page
// introuvable, EAN qui ne correspond pas, bouton introuvable) retombe sur la
// recherche par nom ci-dessous, inchangée.
export async function addToCartCoursesUStore({ scripting, tabs, tabId, job, store, items, signal, onProgress = () => undefined }) {
  // Rebranché ici (2026-08-27) : cette fonction attaquait directement la
  // recherche sans jamais vérifier que l'onglet était sur une page de
  // recherche exploitable (contrairement à collectCoursesUStore et
  // livePickCoursesUProduct, qui appellent toujours ce prologue en premier).
  // Un onglet resté sur une fiche produit ou un hôte non transactionnel
  // faisait échouer CART_SEARCH_NOT_STARTED sur la totalité des produits.
  const prologue = await ensureCoursesUCatalogReady({ scripting, tabId, store, signal });
  if (!prologue.ready) return failure(store, prologue.code, prologue.details, true);

  // Vérification de connexion, une seule fois pour tout le job, AVANT toute
  // recherche produit : si l'utilisateur n'est pas connecté, aucun clic
  // "ajouter" n'aboutira, quel que soit le produit. Contrôle unique et
  // immédiat, sans sondage — voir le commentaire au-dessus de cette fonction
  // (décision utilisateur du 2026-08-28, revue après test réel). Exigence
  // stricte : seule une confirmation EXPLICITE (signedIn === true) laisse
  // passer, y compris quand le signal reste indéterminé plutôt que
  // franchement "déconnecté".
  const session = await run(scripting, tabId, readCoursesUSessionStateOnPage, []);
  if (session?.signedIn !== true) {
    return failure(store, 'CART_LOGIN_REQUIRED', { evidence: session?.evidence ?? null }, true);
  }

  const results = [];
  let itemIndex = 0;
  for (const item of items) {
    if (signal.aborted) break;
    itemIndex += 1;
    if (itemIndex > 1) await wait(randomJitterMs(700, 1_600), signal);
    onProgress({ storeKey: store.storeKey, state: 'product_search', productIndex: itemIndex, productTotal: items.length, productName: item.name });
    try {
      if (item.productUrl && isCoursesUUrl(item.productUrl)) {
        const direct = await tryAddToCartCoursesUViaProductUrl({ scripting, tabs, tabId, signal, item });
        if (direct.captcha) throw new Error('CAPTCHA_DETECTED');
        if (direct.added) {
          results.push({
            protocolVersion: 1,
            jobId: job.jobId,
            productId: item.productId,
            storeKey: 'hyperu',
            added: true,
            matchedName: direct.matchedName,
            matchedPriceEuro: direct.matchedPriceEuro
          });
          continue;
        }
        // Échec de la navigation directe (URL périmée, EAN qui ne
        // correspond pas au produit attendu, bouton introuvable...) : on
        // retombe sur la recherche par nom ci-dessous plutôt que d'abandonner
        // cet item — voir le commentaire au-dessus de cette fonction.
      }
      // Même nettoyage que pour la recherche d'analyse (voir plus haut dans
      // ce fichier) — le scoring plus bas (ligne suivante) continue de
      // comparer contre `item.name`/`item.brand` ORIGINAUX.
      const cartSearchName = stripPackagingNoiseFromSearchName(item.name) || item.name;
      const search = await run(scripting, tabId, startCoursesUSearch, [
        { name: cartSearchName, brand: dedupeBrandFromSearchName(cartSearchName, item.brand ?? '') }
      ]);
      if (!search?.started) {
        results.push({ protocolVersion: 1, jobId: job.jobId, productId: item.productId, storeKey: 'hyperu', added: false, code: 'CART_SEARCH_NOT_STARTED' });
        continue;
      }
      const candidates = await waitForCoursesUProducts({ scripting, tabId, signal, expectedQuery: search.query });
      // brand/barcode viennent du candidat validé par l'utilisateur dans le
      // panneau de comparaison (voir ValidatedBasketItem) : sans eux, ce
      // matching ne pouvait départager qu'au nom seul, ce qui pouvait
      // retenir un produit différent de celui réellement choisi — bug
      // rapporté en conditions réelles (2026-08-28, le lait ajouté au panier
      // n'était pas celui sélectionné dans la liste).
      const best = chooseCoursesUProduct({ name: item.name, brand: item.brand ?? '', barcode: item.barcode }, candidates);
      if (!best) {
        const details = await inspectProductResults(scripting, tabId, inspectCoursesUProductPageOnPage);
        // Même logique que collectCoursesUStore et le chemin d'ajout au
        // panier Leclerc : un captcha bloque TOUTE recherche sur ce tab, pas
        // seulement ce produit — point mort corrigé le 2026-08-27.
        if (details?.hasCaptcha) {
          throw new Error('CAPTCHA_DETECTED');
        }
        results.push({
          protocolVersion: 1,
          jobId: job.jobId,
          productId: item.productId,
          storeKey: 'hyperu',
          added: false,
          code: 'CART_PRODUCT_NOT_FOUND',
          details
        });
        continue;
      }
      const outcome = await run(scripting, tabId, clickAddToCartOnMatchedCoursesUCardOnPage, [
        best.name,
        best.priceEuro,
        item.quantity
      ]);
      const details = outcome?.added
        ? undefined
        : await inspectProductResults(scripting, tabId, inspectCoursesUProductPageOnPage);
      results.push({
        protocolVersion: 1,
        jobId: job.jobId,
        productId: item.productId,
        storeKey: 'hyperu',
        added: Boolean(outcome?.added),
        // Même raison que sur le chemin par URL directe : le rapport doit
        // dire QUELLE carte a été ajoutée, pas seulement que ça a marché.
        ...(outcome?.added
          ? { matchedName: best.name, matchedPriceEuro: best.priceEuro }
          : { code: outcome?.code ?? 'ADD_TO_CART_CONTROL_NOT_FOUND', details })
      });
    } catch (error) {
      // CAPTCHA_DETECTED (levé volontairement ci-dessus) doit interrompre
      // tout le job d'ajout au panier, pas seulement ce produit (voir
      // collectCoursesUStore et l'équivalent Leclerc).
      // SCRIPT_EXECUTION_TIMEOUT (voir executeScriptWithTimeout) reçoit le
      // même traitement : un onglet figé compromet tout le job, pas
      // seulement cet item.
      // COURSESU_TAB_CLOSED (tester #15, audit 30/08, levé par
      // waitForCoursesUTabLoad via tryAddToCartCoursesUViaProductUrl) : un
      // onglet confirmé fermé compromet tout autant tout le job — même
      // traitement.
      if (
        error instanceof Error &&
        (error.message === 'CAPTCHA_DETECTED' ||
          error.message === 'SCRIPT_EXECUTION_TIMEOUT' ||
          error.message === 'COURSESU_TAB_CLOSED')
      ) {
        throw error;
      }
      results.push({ protocolVersion: 1, jobId: job.jobId, productId: item.productId, storeKey: 'hyperu', added: false, code: 'ADD_TO_CART_FAILED' });
    }
  }
  // keepTabOpen: true unconditionally — the user needs the tab open
  // afterward to review the real cart and pay. Confirmed live: without this
  // the job-runner's default (close on success) closed the Hyper U tab the
  // instant a successful add-to-cart job finished.
  return { observations: results, errors: [], keepTabOpen: true };
}

// Navigue directement vers la fiche produit du candidat validé par
// l'utilisateur (item.productUrl) et y clique sur le bouton PRINCIPAL
// « Ajouter au panier » — jamais un bouton de carrousel de suggestions situé
// sur la même page (voir clickAddToCartOnCoursesUProductPageOnPage). Avant
// tout clic, vérifie que la fiche réellement atteinte correspond bien au
// produit attendu (EAN exact si connu, sinon recouvrement de nom) : un
// permalien périmé peut être silencieusement redirigé par le site vers une
// page de résultats de recherche générique au lieu d'un 404 (diagnostic réel
// du 2026-07-29) — sans cette garde, readCoursesUProductPageOnPage lirait
// alors le nom/prix du premier résultat de cette page comme s'il s'agissait
// de la bonne fiche, reproduisant exactement le bug qu'on corrige.
async function tryAddToCartCoursesUViaProductUrl({ scripting, tabs, tabId, signal, item }) {
  try {
    await tabs.update(tabId, { url: item.productUrl });
  } catch {
    return { added: false, code: 'CART_DIRECT_URL_NAVIGATION_FAILED' };
  }
  await waitForCoursesUTabLoad(tabs, tabId, signal);
  await runCookieConsentDismissal(scripting, tabId);
  await wait(600, signal);

  // Même logique de relecture que collectCoursesUManualProduct : la SPA peut
  // mettre un instant à hydrater la fiche après le chargement du document.
  // Seul MANUAL_URL_PRICE_NOT_FOUND vaut la peine d'être réessayé —
  // SITE_BLOCKED et MANUAL_URL_PAGE_NOT_FOUND sont des états terminaux.
  const deadline = Date.now() + 12_000;
  let page = null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      page = await run(scripting, tabId, readCoursesUProductPageOnPage, []);
    } catch {
      page = null;
    }
    if (page?.ok) break;
    if (page?.code === 'SITE_BLOCKED') return { added: false, captcha: true };
    if (page?.code === 'MANUAL_URL_PAGE_NOT_FOUND') return { added: false, code: 'CART_DIRECT_URL_PAGE_NOT_FOUND' };
    await wait(500, signal);
  }
  if (!page?.ok) return { added: false, code: 'CART_DIRECT_URL_PAGE_NOT_READY' };

  // Canari de structure (voir readCoursesUProductPageOnPage) : trace, sans
  // rien changer au déroulement, le fait que le prix n'a pu être lu que dans
  // le texte affiché — signe que coursesu.com a modifié son bloc prix.
  if (page.priceSource === 'texte_affiche') {
    console.log(
      `[Courses U] ${JSON.stringify({ timestamp: new Date().toISOString(), stage: 'price_source_degraded', product: item.name, priceSource: page.priceSource })}`
    );
  }

  if (item.barcode && page.barcode) {
    if (page.barcode !== item.barcode) return { added: false, code: 'CART_DIRECT_URL_MISMATCH' };
  } else {
    // Pas d'EAN exploitable des deux côtés : repli sur un recouvrement de nom
    // suffisamment strict pour écarter une redirection vers une autre fiche.
    const expected = tokens(`${item.name} ${item.brand ?? ''}`);
    if (overlap(expected, tokens(page.name || '')) < 0.5) {
      return { added: false, code: 'CART_DIRECT_URL_MISMATCH' };
    }
  }

  const outcome = await run(scripting, tabId, clickAddToCartOnCoursesUProductPageOnPage, [item.quantity]);
  // Le produit réellement ajouté remonte jusqu'au diagnostic exporté : sans
  // lui, un ajout "réussi" sur la mauvaise fiche (URL périmée redirigée,
  // garde de nom trop permissive) était indétectable — le rapport ne
  // contenait que `added: true`, sans jamais dire QUOI avait été ajouté.
  return outcome?.added
    ? { added: true, matchedName: page.name, matchedPriceEuro: page.priceEuro }
    : { added: false, code: outcome?.code ?? 'ADD_TO_CART_CONTROL_NOT_FOUND' };
}

// Runs in the page world. Lecture seule du DOM, uniquement — ne cherche
// jamais de champ mot de passe, ne remplit et ne clique jamais rien. Sert
// uniquement à distinguer "le site refuse l'ajout parce que l'utilisateur
// n'est pas connecté" des autres échecs (rupture de stock, bug de
// correspondance...). Ne JAMAIS faire évoluer cette fonction pour qu'elle
// automatise la connexion elle-même — ça doit rester un geste humain
// volontaire, quel que soit le confort perdu.
export function readCoursesUSessionStateOnPage() {
  const signalOf = (element) =>
    `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
  const hrefOf = (element) => (element.getAttribute('href') || '').toLowerCase();

  // Signal fort, SANS filtre de visibilité : sur coursesu.com le menu "Mon
  // compte" du header est fermé par défaut (conteneur avec une classe
  // "hidden") — un filtre de visibilité classique l'exclut donc toujours,
  // qu'on soit connecté ou pas, alors que son CONTENU (généré côté serveur)
  // dépend bien de l'état de connexion réel, lui. Diagnostic réel confirmé en
  // conditions réelles (2026-08-28, inspection DOM du téléphone) : un
  // utilisateur bien connecté ne déclenchait jamais signedIn:true parce que
  // ce lien "Déconnexion" restait invisible dans ce menu fermé et qu'aucun
  // autre signal net n'existait ailleurs sur la page — la vérification
  // stricte (signedIn !== true bloque, y compris sur un état indéterminé)
  // affichait alors à tort "tu n'es pas connecté" à un utilisateur connecté.
  // Audit sécurité du 30/08 : l'evidence exportée ne doit jamais reproduire
  // le texte réel du contrôle DOM matché — coursesu.com affiche notamment un
  // signal "Bonjour [Prénom]" ci-dessous, qui finirait sinon littéralement
  // dans un diagnostic exportable/partagé. On ne renvoie que le code du
  // motif qui a déclenché la détection, jamais le texte source.
  const strongSignedInLink = [...document.querySelectorAll('a[href]')].find((element) =>
    /\/deconnexion(\?|$)/i.test(hrefOf(element))
  );
  if (strongSignedInLink) {
    return { signedIn: true, evidence: 'href_deconnexion' };
  }

  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const controls = [...document.querySelectorAll('a, button, [role="button"]')].filter(isVisible);

  // Diagnostic réel (Hyper U, 2026-08-28) : coursesu.com affiche un lien
  // texté "Mon compte" qui MÈNE EN FAIT À LA PAGE DE CONNEXION
  // (href="/connexion?hasorigin=true") même pour un visiteur non connecté
  // — le texte seul est donc un signal trompeur sur ce site. On vérifie la
  // destination réelle du lien en complément : un href de connexion
  // l'emporte sur un texte qui semble "connecté", sauf s'il s'agit en fait
  // d'un lien de DÉconnexion ("connexion" est un sous-mot de
  // "déconnexion", d'où le garde négatif explicite ci-dessous).
  const pointsToLogout = (element) => /d[ée]connexion|logout|signout/i.test(hrefOf(element));
  const pointsToLogin = (element) => !pointsToLogout(element) && /connexion|login|signin|identif/i.test(hrefOf(element));

  const SIGNED_IN_TEXT_PATTERNS = [
    { code: 'mon_compte', pattern: /mon compte/i },
    { code: 'se_deconnecter', pattern: /se d[ée]connecter/i },
    { code: 'deconnexion', pattern: /d[ée]connexion/i },
    { code: 'bonjour', pattern: /bonjour/i }
  ];
  const SIGNED_OUT_TEXT_PATTERNS = [
    { code: 'se_connecter', pattern: /se connecter/i },
    { code: 's_identifier', pattern: /s'identifier/i },
    { code: 'identifiez_vous', pattern: /identifiez-vous/i },
    { code: 'creer_un_compte', pattern: /cr[ée]er un compte/i }
  ];
  const matchedPatternCode = (signal, patterns) =>
    (patterns.find(({ pattern }) => pattern.test(signal)) || {}).code || 'unspecified';

  const signedInControl = controls.find((element) => {
    if (pointsToLogin(element)) return false;
    return SIGNED_IN_TEXT_PATTERNS.some(({ pattern }) => pattern.test(signalOf(element)));
  });
  if (signedInControl) {
    return { signedIn: true, evidence: matchedPatternCode(signalOf(signedInControl), SIGNED_IN_TEXT_PATTERNS) };
  }

  const signedOutControl = controls.find(
    (element) =>
      pointsToLogin(element) || SIGNED_OUT_TEXT_PATTERNS.some(({ pattern }) => pattern.test(signalOf(element)))
  );
  if (signedOutControl) {
    const evidence = pointsToLogin(signedOutControl)
      ? 'href_points_to_login'
      : matchedPatternCode(signalOf(signedOutControl), SIGNED_OUT_TEXT_PATTERNS);
    return { signedIn: false, evidence };
  }

  // Ni l'un ni l'autre signal : état indéterminé. On ne bloque jamais dessus
  // — un faux "pas connecté" empêcherait à tort un remplissage par ailleurs
  // valide, ce qui serait pire que l'absence de détection.
  return { signedIn: null, evidence: null };
}

function inspectCoursesUProductPageOnPage() {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    url: location.href,
    pathname: location.pathname,
    pageTitle: document.title,
    bodyTextSnippet: text.slice(0, 500),
    hasCaptcha: /captcha|v[ée]rifier que vous [êe]tes humain/i.test(text)
  };
}

// Runs in the page world, right after a fresh search for the item. Re-finds
// the matching result card using the same link-climbing strategy as
// readCoursesUProducts (Hyper U has no single stable card class name), then
// clicks that card's own inline "Ajouter au panier" control — never a
// page-wide one that could belong to an unrelated product.
export async function clickAddToCartOnMatchedCoursesUCardOnPage(expectedName, expectedPriceEuro, quantity) {
  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const normalize = (value) =>
    String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const tokenize = (value) => new Set(normalize(value).split(' ').filter((token) => token.length > 1));
  const expectedTokens = tokenize(expectedName);

  // Diagnostic réel (Hyper U, 2026-08-28) : le contrôle "Ajouter au panier"
  // de coursesu.com n'est PAS un <button>/<a>/[role="button"] — c'est un
  // <div class="product-button__bag" aria-label="Ajouter au panier ...">
  // nu, sans rôle ARIA explicite. `button, a, [role="button"]` ne le trouve
  // donc jamais, ce qui faisait échouer TOUTE carte Hyper U en
  // CART_CARD_NOT_FOUND malgré un produit visiblement présent sur la page.
  // Élargi à `[aria-label]` : le filtre par regex sur le contenu de
  // `signal` reste le garde-fou contre les faux positifs.
  const findAddControl = (node) =>
    [...node.querySelectorAll('button, a, [role="button"], [aria-label]')].find((element) => {
      if (!isVisible(element) || element.disabled) return false;
      const signal = `${element.textContent} ${element.getAttribute('aria-label')} ${element.getAttribute('title')} ${element.className || ''}`;
      return /ajouter.{0,20}panier|ajouter.{0,10}au.{0,10}chariot/i.test(signal);
    });
  const hasAddButton = (node) => Boolean(findAddControl(node));

  // Un produit déjà dans le panier n'affiche plus de bouton "Ajouter au
  // panier" du tout, seulement le stepper +/-. Sans ce second signal, la
  // sélection de carte ci-dessous exigeait `hasAddButton` et écartait donc
  // ces cartes avant même d'atteindre la détection "déjà présent" plus bas —
  // point mort corrigé le 2026-08-27 (voir aussi leclerc-collector.js).
  //
  // Même diagnostic du 2026-08-28 : le stepper réel de coursesu.com EST un
  // <div role="button" data-quantity="increase" aria-label="Ajouter une
  // quantité de ..."> — il matche déjà `button, [role="button"]`, mais son
  // aria-label ne contient ni "+" ni "augmenter"/"increment", donc l'ancien
  // regex ne le reconnaissait jamais. `data-quantity="increase"` est un
  // signal direct et fiable (immunisé aux variations de libellé), vérifié
  // en priorité avant le repli sur le texte/aria-label.
  const findStepper = (node) =>
    [...node.querySelectorAll('button, [role="button"], [data-quantity]')].find((element) => {
      if (!isVisible(element)) return false;
      if (element.getAttribute('data-quantity') === 'increase') return true;
      const signal = `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.className || ''}`;
      return /^\+$|augmenter|increment/i.test(signal.trim());
    });
  const hasStepper = (node) => Boolean(findStepper(node));
  const hasCartControl = (node) => hasAddButton(node) || hasStepper(node);

  // Renforcement AJOUTÉ (2026-08-28) : un clic sur "+" peut être absorbé par
  // le site (stepper re-rendu pendant la mise à jour du panier), et rien ne
  // le détectait — le panier réel se retrouvait alors avec moins d'unités que
  // demandé, silencieusement. On relit donc le compteur affiché après chaque
  // clic et on retente au plus 2 fois s'il n'a pas bougé. Deux garde-fous :
  // si le compteur n'est pas lisible on garde EXACTEMENT le comportement
  // d'origine (un clic par unité, sans vérification), et on s'arrête dès que
  // la cible est atteinte — cette fonction ne peut qu'ajouter des unités,
  // jamais en retirer.
  const readStepperValue = (stepper) => {
    const scope =
      stepper.closest?.('[class*="quantity" i], [class*="stepper" i], [class*="qty" i]') || stepper.parentElement;
    const field = scope?.querySelector('input[type="number"], input[data-quantity], [data-quantity-value]');
    if (!field) return undefined;
    const raw = field.value ?? field.getAttribute('data-quantity-value');
    const parsed = Number(String(raw ?? '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const increaseTo = async (stepper, target) => {
    for (let index = 1; index < target; index += 1) {
      const before = readStepperValue(stepper);
      if (before !== undefined && before >= target) return;
      stepper.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (before === undefined) continue;
      for (let retry = 0; retry < 2 && readStepperValue(stepper) === before; retry += 1) {
        stepper.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };

  const containers = [];
  for (const link of document.querySelectorAll('a[href*="/p/"]')) {
    let container = link;
    // The price and the "Ajouter au panier" control can sit in a sibling
    // block one or two levels above the container that first satisfies the
    // price-pattern check — stopping the climb the instant a price is seen
    // (the old behaviour) sometimes landed on a container that had the price
    // but not yet the button, so the click phase later found a good match
    // but zero add-control inside it. Confirmed via a real diagnostic:
    // ADD_TO_CART_CONTROL_NOT_FOUND despite the exact matching product
    // ("Lait demi écrémé UHT LAIT D'ICI, 6x1l 5,64€") being visible in the
    // page's text. Now the climb keeps going (up to the same depth/length
    // caps) until it finds a container with BOTH the price AND the button,
    // falling back to the old price-only container if that combo is never
    // found within the caps. BUT: only push containers that have BOTH price
    // and button to avoid clicking wrong products.
    let priceOnlyContainer = null;
    let validContainer = null;
    for (let depth = 0; depth < 7 && container.parentElement; depth += 1) {
      const parent = container.parentElement;
      const text = (parent.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 2_500) break;
      container = parent;
      if (/\d{1,4}[,.]\d{2}\s*(?:€|eur)/i.test(text)) {
        if (!priceOnlyContainer) priceOnlyContainer = container;
        if (hasCartControl(container)) {
          validContainer = container;
          break;
        }
      }
    }
    const chosen = validContainer || (hasCartControl(container) ? container : null);
    if (chosen && /€|eur/i.test(chosen.textContent || '')) containers.push(chosen);
  }

  let best = null;
  let bestScore = -1;
  for (const node of new Set(containers)) {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const matches = [...text.matchAll(/(\d{1,4})(?:[,.](\d{2})\s*€|\s*€\s*(\d{2}))/gi)];
    const price = matches[0] ? Number(`${matches[0][1]}.${matches[0][2] || matches[0][3]}`) : NaN;
    const nameNode = node.querySelector('h2, h3, h4, [itemprop="name"], [class*="title" i]');
    const cardTokens = tokenize(nameNode?.textContent || text);
    let overlap = 0;
    for (const token of expectedTokens) if (cardTokens.has(token)) overlap += 1;
    const nameScore = expectedTokens.size > 0 ? overlap / expectedTokens.size : 0;
    // Only boost score for price match if expectedPriceEuro is actually provided and valid.
    // If expectedPriceEuro is missing/NaN, do not give a score boost to items that merely
    // have *some* price, else a Nutella with any valid price beats a Milk with name-only match.
    const priceBoost = Number.isFinite(expectedPriceEuro) && Number.isFinite(price) && Math.abs(price - expectedPriceEuro) < 0.01 ? 1 : 0;
    const score = nameScore + priceBoost;
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  }
  if (!best || bestScore < 0.6) {
    return { added: false, code: 'CART_CARD_NOT_FOUND' };
  }

  // Le produit peut déjà être dans le panier (remplissage précédent
  // interrompu puis repris, ou double-clic utilisateur) : la carte n'affiche
  // alors plus aucun bouton "Ajouter", seulement le stepper +/-. Sans cette
  // détection, ce cas ressortait à tort en ADD_TO_CART_CONTROL_NOT_FOUND —
  // un succès déguisé en échec (point mort confirmé le 2026-08-27).
  const alreadyInCartStepper = findStepper(best);
  if (alreadyInCartStepper) {
    if (quantity > 1) {
      await increaseTo(alreadyInCartStepper, quantity);
    }
    return { added: true };
  }

  const addButton = findAddControl(best);
  if (!addButton) return { added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' };

  const initialButtonState = addButton.textContent.trim();

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    addButton.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // After clicking, wait for the UI to update and verify that the item was
  // actually added to the cart. Hyper U's card state changes when an item is
  // added (button text/class changes, or a stepper appears). Without this wait,
  // we'd assume success even if the click had no effect (e.g., user not logged
  // in, item out of stock, or network error).
  const deadline = Date.now() + 2_000;
  let buttonStateChanged = false;
  while (Date.now() < deadline) {
    const currentButtonState = addButton.textContent.trim();
    if (currentButtonState !== initialButtonState) {
      buttonStateChanged = true;
      break;
    }
    // Also check if the stepper appeared (indicating the item is in the cart)
    if (findStepper(best)) {
      buttonStateChanged = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // If the button state didn't change and no stepper appeared, the add-to-cart
  // likely failed (user not logged in, network error, etc.).
  if (!buttonStateChanged) {
    return { added: false, code: 'CART_ADD_NOT_CONFIRMED' };
  }

  if (quantity > 1) {
    const stepper = findStepper(best);
    if (stepper) {
      await increaseTo(stepper, quantity);
    }
  }

  return { added: true };
}

// Runs in the page world, right after navigating straight to the confirmed
// product page (see tryAddToCartCoursesUViaProductUrl). Diagnostic réel
// (Hyper U, 2026-08-28) : le bouton « Ajouter au panier » PRINCIPAL d'une
// fiche produit a un aria-label au format « Bouton ajouter le produit <nom>
// au panier » — préfixe absent des boutons « Ajouter au panier <nom> » des
// carrousels de produits recommandés présents sur la même page. Cibler ce
// préfixe précis garantit qu'on ne clique jamais un produit du carrousel à la
// place du produit principal de la fiche.
export async function clickAddToCartOnCoursesUProductPageOnPage(quantity) {
  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;

  // Diagnostic réel (Hyper U, 2026-08-28, fiche "Lait UHT demi écrémé") :
  // une même fiche produit peut contenir PLUSIEURS boutons partageant ce
  // préfixe d'aria-label (3 constatés) — un seul porte la classe
  // pdp-add-to-cart, propre au bouton d'ajout principal de la fiche. On la
  // priorise explicitement plutôt que de prendre le premier élément trouvé,
  // dont l'ordre DOM n'est pas garanti.
  const findMainAddControl = () => {
    const candidates = [...document.querySelectorAll('[aria-label]')].filter((element) => {
      if (!isVisible(element) || element.disabled) return false;
      return /^bouton ajouter le produit\b/i.test((element.getAttribute('aria-label') || '').trim());
    });
    const preferred = candidates.find((element) => element.classList.contains('pdp-add-to-cart')) || candidates[0];
    if (preferred) return preferred;

    // Repli AJOUTÉ (2026-08-28), exécuté UNIQUEMENT si aucun aria-label ne
    // porte plus le préfixe attendu — c'est-à-dire si coursesu.com a changé
    // le libellé d'accessibilité. Sans lui, l'ajout échouerait en
    // ADD_TO_CART_CONTROL_NOT_FOUND alors que le bouton est bien là.
    // Règle de sûreté : on n'accepte ce repli que s'il désigne le bouton SANS
    // ambiguïté. En cas de doute on ne clique rien plutôt que de risquer
    // d'ajouter un produit d'un carrousel de recommandations.
    const isOutsideMainBlock = (element) =>
      Boolean(
        element.closest?.(
          '[class*="mini-cart" i], [class*="recommendation" i], [class*="crossell" i], [class*="carousel" i], [class*="suggestion" i]'
        )
      );
    const byClass = [...document.querySelectorAll('.pdp-add-to-cart')].filter(
      (element) => isVisible(element) && !element.disabled
    );
    if (byClass.length === 1) return byClass[0];

    // Sélecteur volontairement large : coursesu.com utilise des <div
    // aria-label> nus pour ce contrôle (diagnostic réel 2026-08-28), donc se
    // limiter à button/[role=button] raterait précisément le cas visé.
    // L'exigence d'unicité ci-dessous est ce qui rend cette largeur sûre.
    const byText = [...document.querySelectorAll('button, a[href], [role="button"], [aria-label], input[type="submit"]')].filter(
      (element) => {
        if (!isVisible(element) || element.disabled) return false;
        if (isOutsideMainBlock(element)) return false;
        const signal = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`
          .replace(/\s+/g, ' ')
          .trim();
        return /ajouter\b.{0,40}panier\b/i.test(signal);
      }
    );
    return byText.length === 1 ? byText[0] : undefined;
  };

  // Même heuristique de stepper que clickAddToCartOnMatchedCoursesUCardOnPage
  // (diagnostic 2026-08-28) : data-quantity="increase" est un signal direct
  // et fiable, immunisé aux variations de libellé.
  const findStepper = () =>
    [...document.querySelectorAll('button, [role="button"], [data-quantity]')].find((element) => {
      if (!isVisible(element)) return false;
      if (element.getAttribute('data-quantity') === 'increase') return true;
      const signal = `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.className || ''}`;
      return /^\+$|augmenter|increment/i.test(signal.trim());
    });

  // Même renforcement du stepper que dans
  // clickAddToCartOnMatchedCoursesUCardOnPage — dupliqué ici parce que cette
  // fonction est injectée seule dans la page (isolation d'injection).
  const readStepperValue = (stepper) => {
    const scope =
      stepper.closest?.('[class*="quantity" i], [class*="stepper" i], [class*="qty" i]') || stepper.parentElement;
    const field = scope?.querySelector('input[type="number"], input[data-quantity], [data-quantity-value]');
    if (!field) return undefined;
    const raw = field.value ?? field.getAttribute('data-quantity-value');
    const parsed = Number(String(raw ?? '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const increaseTo = async (stepper, target) => {
    for (let index = 1; index < target; index += 1) {
      const before = readStepperValue(stepper);
      if (before !== undefined && before >= target) return;
      stepper.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (before === undefined) continue;
      for (let retry = 0; retry < 2 && readStepperValue(stepper) === before; retry += 1) {
        stepper.click();
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };

  // Le produit peut déjà être dans le panier (remplissage précédent
  // interrompu puis repris) : la fiche n'affiche alors plus de bouton
  // « Ajouter », seulement le stepper +/-.
  const alreadyInCartStepper = findStepper();
  if (alreadyInCartStepper) {
    if (quantity > 1) {
      await increaseTo(alreadyInCartStepper, quantity);
    }
    return { added: true };
  }

  const addButton = findMainAddControl();
  if (!addButton) return { added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' };

  const initialButtonState = addButton.textContent.trim();
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    addButton.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  const deadline = Date.now() + 2_000;
  let buttonStateChanged = false;
  while (Date.now() < deadline) {
    const currentButtonState = addButton.textContent.trim();
    if (currentButtonState !== initialButtonState) {
      buttonStateChanged = true;
      break;
    }
    if (findStepper()) {
      buttonStateChanged = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!buttonStateChanged) return { added: false, code: 'CART_ADD_NOT_CONFIRMED' };

  if (quantity > 1) {
    const stepper = findStepper();
    if (stepper) {
      await increaseTo(stepper, quantity);
    }
  }

  return { added: true };
}

// Jeu de mots attendu pour ce produit. "Marque habituelle"/"Sans marque" sont
// des valeurs de saisie, pas des marques : les inclure ajouterait du bruit à
// comparer contre le nom du catalogue.
function expectedCoursesUTokens(product) {
  const brand = /^(?:marque habituelle|sans marque)$/i.test(product.brand || '') ? '' : product.brand || '';
  return tokens(`${product.name} ${brand}`);
}

// Recouvrement entre le nom demandé et le nom lu sur une fiche atteinte
// directement (raccourci "permalien appris"). Même calcul que le tri des
// candidats de recherche ci-dessous, volontairement partagé pour que les deux
// chemins ne puissent pas juger différemment la même fiche.
function scoreCoursesUProductPageName(product, pageName) {
  return overlap(expectedCoursesUTokens(product), tokens(pageName || ''));
}

// Seuil du raccourci "permalien appris" : le score mesuré devient le score de
// confiance du candidat, et en dessous de 0.7 la PWA le classerait en
// 'uncertain'. Autant laisser la recherche normale reprendre la main plutôt
// que de dégrader un candidat sur une différence de formulation.
const KNOWN_URL_MIN_NAME_SCORE = 0.7;

export function chooseCoursesUProduct(product, candidates) {
  const valid = candidates.filter((candidate) =>
    candidate && Number.isFinite(candidate.priceEuro) && candidate.priceEuro >= 0 && isCoursesUUrl(candidate.productUrl)
  );
  if (product.barcode) {
    const exact = valid.find((candidate) => candidate.barcode === product.barcode);
    if (exact) {
      const format = parseQuantityFromName(exact.name);
      return { ...exact, matchScore: 1, observedQuantity: format?.quantity, observedUnit: format?.unit };
    }
  }
  const expected = expectedCoursesUTokens(product);
  // Format cible transmis par la PWA (Open Food Facts au moment du scan —
  // voir src/features/scan/openFoodFactsClient.ts) : absent pour un produit
  // ajouté manuellement ou quand OFF n'a pas cette info, auquel cas
  // targetFormat reste null et le tri ci-dessous retombe exactement sur le
  // comportement précédent (score de nom seul). Même mécanisme que côté
  // Leclerc (rankLeclercCandidates) : ne change jamais l'ACCEPTATION (filtre
  // score >= 0.5 déjà en place ci-dessous), seulement l'ORDRE parmi des
  // candidats déjà valides.
  const targetFormat = normalizeQuantity(product.baseQuantity, product.baseUnit);
  const match = valid
    .map((candidate) => {
      const candidateFormat = parseQuantityFromName(candidate.name);
      return {
        candidate,
        score: overlap(expected, tokens(candidate.name)),
        matchesTargetFormat: Boolean(targetFormat && quantitiesMatch(targetFormat, candidateFormat)),
        observedQuantity: candidateFormat?.quantity,
        observedUnit: candidateFormat?.unit
      };
    })
    .filter((entry) => entry.score >= 0.5)
    .sort((left, right) => {
      if (left.matchesTargetFormat !== right.matchesTargetFormat) {
        return left.matchesTargetFormat ? -1 : 1;
      }
      return right.score - left.score;
    })[0];
  return match
    ? { ...match.candidate, matchScore: match.score, observedQuantity: match.observedQuantity, observedUnit: match.observedUnit }
    : null;
}

async function selectCoursesUStore({ scripting, tabId, store, signal }) {
  const submit = await run(scripting, tabId, submitCoursesULocation, [store]);
  if (!submit?.started) return { started: false, code: submit?.code ?? 'STORE_SELECTION_FAILED' };
  await wait(1_500, signal);
  const choices = (await run(scripting, tabId, readCoursesUChoices, [])) ?? [];
  const decision = chooseStoreChoice(store, choices);
  if (!decision.choice) {
    return {
      started: false,
      code: decision.code === 'DRIVE_RESULT_AMBIGUOUS' ? 'STORE_RESULT_AMBIGUOUS' : 'STORE_RESULT_NOT_FOUND',
      details: { candidateCount: decision.ranked.length, topScores: decision.ranked.slice(0, 3).map((item) => item.score) }
    };
  }
  const click = await run(scripting, tabId, clickCoursesUChoice, [
    decision.choice.actionIndex,
    decision.choice.controlText ?? ''
  ]);
  return click?.clicked
    ? { started: true }
    : { started: false, code: click?.code === 'STORE_RESULT_STALE' ? 'STORE_RESULT_STALE' : 'STORE_RESULT_NOT_CLICKABLE' };
}

async function run(scripting, tabId, func, args) {
  return (await executeScriptWithTimeout(scripting, { target: { tabId }, func, args }))?.[0]?.result;
}

async function waitForCoursesUProducts({ scripting, tabId, signal, expectedQuery }) {
  // 15s (down from the original 20s, but with headroom over the too-tight
  // 10s that was cutting off real renders).
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      await runCookieConsentDismissal(scripting, tabId);
      const navigation = await run(scripting, tabId, inspectCoursesUSearchNavigation, [expectedQuery]);
      if (!navigation?.ready) {
        await wait(500, signal);
        continue;
      }
      const candidates = await run(scripting, tabId, readCoursesUProducts, []);
      if (Array.isArray(candidates) && candidates.length > 0) return candidates;
    } catch (error) {
      // Tester #13 (audit 30/08), même correctif que côté Leclerc
      // (waitForProductCandidates) : un SCRIPT_EXECUTION_TIMEOUT ici était
      // avalé comme n'importe quelle autre interruption transitoire de la
      // SPA — la boucle continuait à sonder jusqu'à épuiser les 15s, puis
      // renvoyait [] comme un simple "aucun résultat", sans jamais
      // déclencher la sonde de survie/l'abandon de magasin que ce même
      // timeout déclenche partout ailleurs (voir collectCoursesUStore).
      // Repropagé pour un traitement identique à un timeout survenu ailleurs.
      if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') throw error;
      // Toute autre erreur reste ignorée : la SPA remplace sa vue de
      // résultats, ce court intervalle est normal.
    }
    await wait(500, signal);
  }
  return [];
}

// Navigue directement vers la fiche produit confirmée par l'utilisateur
// (job.manualUrlOverrides) et en extrait nom/prix/EAN/disponibilité — sans
// jamais passer par la recherche automatique. Nécessite `tabs` (fourni par
// le service-worker) pour changer l'URL de l'onglet existant.
async function collectCoursesUManualProduct({ scripting, tabs, tabId, signal, manualUrl }) {
  try {
    await tabs.update(tabId, { url: manualUrl });
  } catch {
    return { ok: false, code: 'MANUAL_URL_NAVIGATION_FAILED' };
  }
  await waitForCoursesUTabLoad(tabs, tabId, signal);
  await runCookieConsentDismissal(scripting, tabId);
  await wait(600, signal);

  // La SPA peut mettre un instant à hydrater la fiche produit après le
  // chargement du document — on relit jusqu'à obtenir un résultat exploitable
  // ou expiration, comme pour waitForCoursesUProducts. Seul
  // MANUAL_URL_PRICE_NOT_FOUND (prix pas encore affiché) vaut la peine d'être
  // réessayé : SITE_BLOCKED et MANUAL_URL_PAGE_NOT_FOUND (404 confirmée, ou
  // nom absent même de document.title) sont des états terminaux — les
  // retenter jusqu'à expiration ferait juste perdre 12s pour rien.
  const deadline = Date.now() + 12_000;
  let last = null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      last = await run(scripting, tabId, readCoursesUProductPageOnPage, []);
    } catch (error) {
      // Tester #14 (audit 30/08), même correctif que tester #13 : un
      // SCRIPT_EXECUTION_TIMEOUT ici doit remonter jusqu'à l'appelant
      // (collectCoursesUStore) pour y déclencher la sonde de survie, pas
      // être traité comme "pas encore lisible, on réessaie" — sinon ce
      // timeout épuise silencieusement les 12s de ce sondage avant de
      // retomber sur un simple MANUAL_URL_PAGE_NOT_READY.
      if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') throw error;
      last = null;
    }
    if (last?.ok) return last;
    if (last?.code === 'SITE_BLOCKED' || last?.code === 'MANUAL_URL_PAGE_NOT_FOUND') return last;
    await wait(500, signal);
  }
  return last?.ok === false ? last : { ok: false, code: 'MANUAL_URL_PAGE_NOT_READY', details: last ?? undefined };
}

async function waitForCoursesUTabLoad(tabs, tabId, signal) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    let tab;
    try {
      tab = await tabs.get(tabId);
    } catch {
      // Tester #15 (audit 30/08) : `tabs.get` qui échoue signifie que
      // l'onglet a été fermé (par l'utilisateur, ou déchargé par Android),
      // pas "page chargée avec succès" — avant ce correctif, ce cas se
      // comportait comme un retour normal, laissant le code suivant
      // continuer à agir sur un tabId qui n'existe plus, avec des échecs en
      // aval difficiles à rattacher à la vraie cause. Même principe que
      // DRIVE_PICK_TAB_CLOSED côté Leclerc (waitForLeclercPick) : signal
      // explicite plutôt qu'un swallow silencieux.
      throw new Error('COURSESU_TAB_CLOSED');
    }
    if (tab.status === 'complete') return;
    await wait(200, signal);
  }
}

// Sélection manuelle en direct sur Hyper U (pendant que collectCoursesUStore
// gère la sélection automatique + le fallback URL confirmée). Amène l'onglet
// sur l'accueil catalogue du bon magasin préenregistré (ensureCoursesUCatalogReady),
// puis ne fait plus AUCUNE navigation automatique : l'utilisateur navigue
// librement (recherche tapée à la main, catégories, fiche produit) et clique
// sur le bouton flottant "✓ Valider ce produit" une fois sur la bonne fiche —
// identique dans son principe au flux Leclerc (livePickLeclercProduct).
export async function livePickCoursesUProduct({
  scripting,
  tabs,
  tabId,
  job,
  store,
  products,
  signal,
  onProgress = () => undefined
}) {
  const [product] = products;
  const prologue = await ensureCoursesUCatalogReady({ scripting, tabId, store, signal });
  if (!prologue.ready) return failure(store, prologue.code, prologue.details, prologue.keepTabOpen === true);

  // job.startUrl (retour explicite du 31/08, symétrique au chemin Leclerc —
  // voir livePickLeclercProduct) : un candidat est déjà connu (lien "Voir le
  // produit" du détail par magasin) — mieux vaut y amener l'onglet plutôt que
  // l'accueil vide. Seul l'échec de la navigation elle-même (URL invalide,
  // onglet déjà fermé à cet instant précis) est avalé — un onglet perdu
  // PENDANT le chargement (waitForCoursesUTabLoad) reste un vrai signal
  // bloquant, remonté normalement comme partout ailleurs dans ce fichier.
  if (job.startUrl) {
    let navigated = true;
    try {
      await tabs.update(tabId, { url: job.startUrl });
    } catch {
      navigated = false;
    }
    if (navigated) {
      await waitForCoursesUTabLoad(tabs, tabId, signal);
      await runCookieConsentDismissal(scripting, tabId);
      await wait(600, signal);
    }
  }

  onProgress({
    storeKey: store.storeKey,
    state: 'awaiting_pick',
    productIndex: 1,
    productTotal: 1,
    productName: product.name
  });
  const pick = await waitForCoursesUPick({ scripting, tabs, tabId, signal, onProgress, store, product });
  if (!pick) {
    return {
      observations: [],
      errors: [{ storeKey: store.storeKey, productId: product.productId, code: 'PICK_TIMEOUT' }],
      // Onglet laissé ouvert : l'utilisateur était peut-être encore en train
      // de regarder / sur le point de cliquer au moment du timeout.
      keepTabOpen: true
    };
  }

  return {
    observations: [
      validateDriveObservation({
        protocolVersion: 1,
        jobId: job.jobId,
        productId: product.productId,
        storeKey: 'hyperu',
        localStoreId: store.localStoreId,
        externalStoreId: pick.externalStoreId || store.localStoreId,
        ...(pick.externalProductId ? { externalProductId: pick.externalProductId } : {}),
        observedName: pick.name,
        ...(pick.barcode ? { observedBarcode: pick.barcode } : {}),
        matchScore: 1,
        matchStage: 'manual',
        priceEuro: pick.priceEuro,
        ...(pick.unitPriceEuro !== undefined
          ? { unitPriceEuro: pick.unitPriceEuro, unitPriceUnit: pick.unitPriceUnit }
          : {}),
        available: pick.available !== false,
        productUrl: pick.productUrl,
        observedAt: new Date().toISOString(),
        evidence: 'official_drive_page'
      })
    ],
    errors: [],
    keepTabOpen: false
  };
}

// Pose un bouton flottant "✓ Valider ce produit" (bottom-right). Le clic lit
// la fiche produit et affiche un retour visuel IMMÉDIAT (bouton rouge
// "✗ Produit non détecté" en cas d'échec), à l'identique du bouton flottant
// Leclerc (armLeclercFloatingPickButtonOnPage) — sans ce feedback dans le
// handler lui-même, un clic qui échoue à lire la page semblait ne rien faire
// (bug observé en test réel : le bouton restait affiché sans aucune
// indication). La lecture est une COPIE volontaire du corps de
// readCoursesUProductPageOnPage plutôt qu'un appel à cette fonction : comme
// pour Leclerc, scripting.executeScript n'injecte que le code propre de la
// fonction passée à `func`, jamais les autres fonctions du module qu'elle
// référencerait par leur nom — impossible d'appeler une fonction externe
// depuis ce handler de clic. Garder cette copie synchronisée avec
// readCoursesUProductPageOnPage (même logique JSON-LD + heuristiques DOM) en
// cas de modification de l'une des deux.
//
// Garde-fou de page (même raisonnement que Leclerc) : le bouton ne s'affiche
// QUE sur une vraie fiche produit standalone (URL contenant "/p/"), jamais
// sur une grille de résultats/catégorie — sans ce garde-fou, un clic sur le
// bouton depuis une page de liste aurait pu silencieusement lire la première
// tuile produit de la grille (querySelector prend le premier élément trouvé)
// au lieu du produit réellement voulu par l'utilisateur.
export function armCoursesUFloatingPickButtonOnPage() {
  const ID = 'drive-price-splitter-float-pick';
  const isProductDetailPage = /\/p\//.test(location.pathname);
  if (!isProductDetailPage) {
    document.getElementById(ID)?.remove();
    return;
  }
  function readCoursesUProductPageOnPageInline() {
    // Copie locale de normalizeEan/findEanInText (extension/shared/barcode.js)
    // — une fonction injectée ne peut appeler aucune fonction externe du
    // module. Garder les trois copies de ce fichier synchronisées entre elles
    // et avec le module partagé ; les tests d'isolation les comparent.
    const normalizeEanLocal = (value) => {
      const digits = String(value ?? '').replace(/[\s-]/g, '');
      if (!/^\d+$/.test(digits)) return undefined;
      if (![8, 12, 13, 14].includes(digits.length)) return undefined;
      let sum = 0;
      for (let index = 0; index < digits.length - 1; index += 1) {
        sum += Number(digits[index]) * ((digits.length - index) % 2 === 0 ? 3 : 1);
      }
      return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]) ? digits : undefined;
    };
    const findEanInTextLocal = (value) => {
      for (const match of String(value ?? '').matchAll(/\b\d{12,14}\b/g)) {
        const normalized = normalizeEanLocal(match[0]);
        if (normalized) return normalized;
      }
      return undefined;
    };

    // Un clone sans <script>/<style> : `textContent` remonte aussi le
    // contenu JS/CSS des balises enfants, pas seulement le texte affiché —
    // un `<script>` de config produit réel contient "SHOW_CAPTCHA":null
    // (window.SessionAttributes), ce qui déclenchait à tort SITE_BLOCKED
    // via le test /captcha/i ci-dessous sur une vraie fiche produit valide.
    const bodyClone = document.body?.cloneNode(true);
    bodyClone?.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    const text = (bodyClone?.textContent || '').replace(/\s+/g, ' ').trim();
    if (/captcha|pas un robot|accès refusé/i.test(text)) return { ok: false, code: 'SITE_BLOCKED' };

    let ld = null;
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent || 'null');
        const entries = Array.isArray(data) ? data : [data];
        ld = entries.find((entry) => {
          const type = entry?.['@type'];
          return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
        });
        if (ld) break;
      } catch {
        // JSON-LD malformé : on ignore ce bloc et on retombe sur les heuristiques DOM.
      }
    }

    // Voir le commentaire équivalent dans readCoursesUProductPageOnPage :
    // le premier [data-tc-product-tile] du DOM peut appartenir au
    // mini-panier ou au carrousel de suggestions plutôt qu'au produit
    // affiché — on cible l'ancêtre du bouton d'ajout principal en priorité.
    const pdpButtonInline = document.querySelector('.pdp-add-to-cart');
    const tileNode =
      pdpButtonInline?.closest('[data-tc-product-tile]') ||
      [...document.querySelectorAll('[data-tc-product-tile]')].find(
        (element) => !/mini-cart-product|recommendation-tile/.test(element.className || '')
      );
    let tileData;
    try {
      tileData = JSON.parse(tileNode?.getAttribute('data-tc-product-tile') || 'null');
    } catch {
      tileData = null;
    }

    const name = (
      (tileData?.name && tileData.name !== 'unknown' ? tileData.name : null) ||
      ld?.name ||
      document.querySelector('h1, [itemprop="name"]')?.textContent ||
      document.title ||
      ''
    ).trim().slice(0, 500);

    const ldOffer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
    const ldPrice = Number(ldOffer?.price);

    // Palier le plus fiable, vérifié en direct sur de vraies fiches produit
    // coursesu.com (2026-08-27, magasin Hyper U - Hanches) : l'attribut
    // data-item-price du bloc prix officiel du magasin sélectionné contient
    // la valeur numérique exacte du prix total de l'article — distinct du
    // prix de référence au litre/kg (.unit-info, dans un <span> séparé sans
    // cet attribut) et du prix barré avant promo (.pdp-standard-price).
    // Aucun parsing de texte affiché nécessaire, donc aucune ambiguïté
    // possible avec un texte promo du type "Soit 2,12€ d'économie." (qui,
    // lui, n'a pas de suffixe /L ou /kg et pouvait tromper le filtre regex
    // ci-dessous — c'est ce qui explique la lecture erronée du diagnostic
    // 2026-08-27 malgré le premier correctif par regex).
    //
    // Replis AJOUTÉS (2026-08-28) : ils ne s'exécutent QUE si le sélecteur
    // d'origine ci-dessus n'a rien trouvé — ce chemin reste prioritaire et
    // strictement inchangé. Ils couvrent le cas où coursesu.com renommerait
    // `.actions-container-price` ou `.sale-price` : sans eux, la lecture
    // chuterait d'un coup jusqu'au repli texte, beaucoup plus exposé aux
    // montants promotionnels. Les nœuds du mini-panier et du carrousel de
    // suggestions sont exclus pour la même raison que pour la tuile produit :
    // leur prix décrit un AUTRE article (bug réel du 2026-08-28).
    const isForeignPriceNode = (element) =>
      Boolean(
        element.closest?.(
          '[class*="mini-cart" i], [class*="recommendation" i], [class*="crossell" i], [class*="carousel" i], [class*="suggestion" i]'
        )
      );
    const readItemPriceAttr = () => {
      const primary = document.querySelector('.actions-container-price .sale-price[data-item-price]');
      if (primary) return { value: primary.getAttribute('data-item-price'), source: 'item_price_attr' };
      const scopedFallback = [
        ...document.querySelectorAll('.sale-price[data-item-price], [data-item-price]'),
      ].find((element) => !isForeignPriceNode(element));
      return {
        value: scopedFallback?.getAttribute('data-item-price') ?? undefined,
        source: scopedFallback ? 'item_price_attr_hors_bloc' : undefined
      };
    };
    const itemPriceRead = readItemPriceAttr();
    const itemPriceAttr = itemPriceRead.value;
    const itemPrice = Number(itemPriceAttr);

    // JSON-LD n'a en pratique presque jamais de "offers" sur les vraies fiches
    // coursesu.com (constaté en conditions réelles). Le repli DOM ci-dessous
    // (utilisé seulement si ni data-item-price ni JSON-LD n'ont donné de
    // prix) reste exposé au même risque que ci-dessus si le magasin n'a pas
    // encore été sélectionné sur cette page (bloc .actions-container-price
    // absent) : sans filtre, le premier montant "X,XX €" du texte peut être
    // un prix unitaire au lieu du prix réel de l'article (régression réelle
    // 2026-08-27).
    const priceCandidates = [...text.matchAll(/(\d{1,4})(?:[,.](\d{2})\s*€|\s*€\s*(\d{2}))/gi)].map((m) => ({
      value: Number(`${m[1]}.${m[2] || m[3]}`),
      start: m.index,
      end: m.index + m[0].length
    }));
    // Voir le commentaire équivalent dans readCoursesUProductPageOnPage.
    const contextBefore = (start) => {
      const raw = text.slice(Math.max(0, start - 28), start);
      const cut = raw.lastIndexOf('€');
      return cut === -1 ? raw : raw.slice(cut + 1);
    };
    const contextAfter = (end) => {
      const raw = text.slice(end, end + 24);
      const cut = raw.indexOf('€');
      return cut === -1 ? raw : raw.slice(0, cut);
    };
    const isUnitPriceContext = (c) =>
      /^\s*(\/\s*(l|kg|cl|g)\b|d[’']?\s*[ée]conomie|de remise|offerts?\b)/i.test(contextAfter(c.end)) ||
      /(litre|au kg|le kg|au lieu de|[àa] partir de|livraison|frais de port|cagnotte)\b/i.test(
        contextBefore(c.start)
      );
    const totalPriceCandidate = priceCandidates.find((c) => !isUnitPriceContext(c)) || priceCandidates[0];
    const domPrice = totalPriceCandidate ? totalPriceCandidate.value : NaN;
    const priceEuro =
      Number.isFinite(itemPrice) && itemPrice > 0
        ? itemPrice
        : Number.isFinite(ldPrice) && ldPrice > 0
          ? ldPrice
          : domPrice;
    // Canari de structure AJOUTÉ (2026-08-28) : purement observationnel — il
    // décrit d'où vient le prix retenu, sans influencer aucune décision. Une
    // valeur 'texte_affiche' signale que la page ne ressemble plus à ce que le
    // code suppose (ni attribut, ni JSON-LD), donc une lecture en mode dégradé
    // à surveiller AVANT qu'elle ne produise un prix faux.
    const priceSource =
      Number.isFinite(itemPrice) && itemPrice > 0
        ? itemPriceRead.source
        : Number.isFinite(ldPrice) && ldPrice > 0
          ? 'json_ld'
          : 'texte_affiche';

    const unitInfoText = [...document.querySelectorAll('.unit-info')]
      .find((element) => !isForeignPriceNode(element))
      ?.textContent?.trim();
    const unitInfoMatch = unitInfoText?.match(/(\d{1,4})[,.]\s*(\d{1,2})\s*€?\s*\/\s*(l|kg|cl|g)\b/i);
    const unitPriceRaw = unitInfoMatch ? Number(`${unitInfoMatch[1]}.${unitInfoMatch[2].padEnd(2, '0')}`) : NaN;
    const unitPriceSuffix = unitInfoMatch?.[3]?.toLowerCase();
    const unitPriceEuro =
      Number.isFinite(unitPriceRaw) && unitPriceSuffix
        ? unitPriceRaw * (unitPriceSuffix === 'cl' ? 100 : unitPriceSuffix === 'g' ? 1000 : 1)
        : undefined;
    const unitPriceUnit = unitPriceSuffix === 'l' || unitPriceSuffix === 'cl' ? 'L' : unitPriceSuffix ? 'kg' : undefined;

    // Voir le commentaire équivalent dans readCoursesUProductPageOnPage :
    // toute valeur d'EAN doit passer la clé de contrôle GS1 avant d'être
    // retenue, sinon un simple numéro du pied de page devient un code-barres.
    const barcode =
      normalizeEanLocal(tileData?.EAN) ||
      normalizeEanLocal(ld?.gtin13) ||
      normalizeEanLocal(ld?.gtin) ||
      findEanInTextLocal(text);

    // Le texte global `text` inclut les avis clients tout en bas de la page —
    // un avis mentionnant "en rupture de stock" à propos du service de
    // livraison en général (pas de CE produit) faisait passer `available` à
    // false pour n'importe quel article (constaté en conditions réelles
    // 2026-08-27, magasin Hyper U - Hanches, "Lait UHT demi écrémé" pourtant
    // bien en stock). On restreint donc le repli textuel au bloc prix/actions
    // du produit, qui ne contient jamais les avis clients ; repli sur `text`
    // si ce bloc est absent, pour ne rien perdre du comportement existant.
    const priceContainer = document.querySelector('.actions-container-price');
    const priceContainerClone = priceContainer?.cloneNode(true);
    priceContainerClone?.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
    const availabilityText = priceContainer
      ? (priceContainerClone?.textContent || '').replace(/\s+/g, ' ').trim()
      : text;

    const availability = String(ldOffer?.availability || '').toLowerCase();
    const available = availability ? !/outofstock/.test(availability) : !/indisponible|rupture/i.test(availabilityText);

    const notFound = /page (introuvable|non trouv[ée]e)|produit introuvable|erreur 404/i.test(text);
    if (notFound || !name) return { ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' };
    if (!Number.isFinite(priceEuro) || priceEuro < 0) return { ok: false, code: 'MANUAL_URL_PRICE_NOT_FOUND' };

    return {
      ok: true,
      name,
      priceEuro,
      priceSource,
      ...(unitPriceEuro !== undefined ? { unitPriceEuro, unitPriceUnit } : {}),
      barcode: barcode || undefined,
      available,
      productUrl: location.href,
      externalProductId: tileNode?.getAttribute('data-product-id') || document.documentElement.getAttribute('data-product-id') || undefined,
      externalStoreId: document.documentElement.getAttribute('data-store-id') || 'courses-u-store'
    };
  }

  if (document.getElementById(ID)) return;
  const button = document.createElement('button');
  button.id = ID;
  button.type = 'button';
  button.textContent = '✓ Valider ce produit';
  button.style.cssText =
    'position:fixed;z-index:2147483647;bottom:16px;right:16px;padding:12px 18px;' +
    'background:#0a7d32;color:#fff;border:none;border-radius:999px;' +
    'font:700 14px/1.3 -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const result = readCoursesUProductPageOnPageInline();
    if (!result?.ok) {
      const originalText = button.textContent;
      const originalBackground = button.style.background;
      button.textContent = '✗ Produit non détecté';
      button.style.background = '#b3261e';
      setTimeout(() => {
        button.textContent = originalText;
        button.style.background = originalBackground;
      }, 1500);
      return;
    }
    window.__drivePriceSplitterPick = result;
  });
  document.body.appendChild(button);
}

function disarmCoursesUFloatingPickButtonOnPage() {
  document.getElementById('drive-price-splitter-float-pick')?.remove();
  delete window.__drivePriceSplitterPick;
}

function readCoursesUFloatingPickOnPage() {
  return window.__drivePriceSplitterPick ?? null;
}

async function waitForCoursesUPick({ scripting, tabs, tabId, signal, onProgress, store, product, timeoutMs = 4 * 60 * 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      await run(scripting, tabId, armCoursesUFloatingPickButtonOnPage, []);
      const pick = await run(scripting, tabId, readCoursesUFloatingPickOnPage, []);
      if (pick && Number.isFinite(pick.priceEuro)) {
        await run(scripting, tabId, disarmCoursesUFloatingPickButtonOnPage, []);
        return pick;
      }
    } catch {
      // Voir le même correctif côté waitForLeclercPick : un onglet fermé par
      // l'utilisateur tombait ici en silence et faisait sonder pendant les 4
      // minutes complètes, bloquant le runner de pick manuel (partagé entre
      // les deux magasins) pour l'autre magasin pendant tout ce temps.
      if (tabs) {
        const tabStillExists = await tabs
          .get(tabId)
          .then(() => true)
          .catch(() => false);
        if (!tabStillExists) throw new Error('DRIVE_PICK_TAB_CLOSED');
      }
    }
    tick += 1;
    // Rappelle périodiquement à la PWA qu'on attend toujours, sans spammer
    // un événement de progression à chaque sondage de 500ms.
    if (tick % 4 === 0) {
      onProgress({
        storeKey: store.storeKey,
        state: 'awaiting_pick',
        productIndex: 1,
        productTotal: 1,
        productName: product.name
      });
    }
    await wait(500, signal);
  }
  return null;
}

// Runs in the page world, on a Hyper U product page (coursesu.com/p/...)
// reached via a manually-confirmed URL. Prefers the page's own JSON-LD
// Product schema and product-tile payload when present (exact catalog data,
// same source readCoursesUProducts trusts for search-result cards), falling
// back to DOM-text heuristics identical to the search-results reader.
export function readCoursesUProductPageOnPage() {
  // Copie locale de normalizeEan/findEanInText (extension/shared/barcode.js)
  // — une fonction injectée ne peut appeler aucune fonction externe du
  // module. Garder les trois copies de ce fichier synchronisées entre elles
  // et avec le module partagé ; les tests d'isolation les comparent.
  const normalizeEanLocal = (value) => {
    const digits = String(value ?? '').replace(/[\s-]/g, '');
    if (!/^\d+$/.test(digits)) return undefined;
    if (![8, 12, 13, 14].includes(digits.length)) return undefined;
    let sum = 0;
    for (let index = 0; index < digits.length - 1; index += 1) {
      sum += Number(digits[index]) * ((digits.length - index) % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]) ? digits : undefined;
  };
  const findEanInTextLocal = (value) => {
    for (const match of String(value ?? '').matchAll(/\b\d{12,14}\b/g)) {
      const normalized = normalizeEanLocal(match[0]);
      if (normalized) return normalized;
    }
    return undefined;
  };

  // textContent (pas innerText, non implémenté par jsdom — voir
  // courses-u-real-dom.test.js) : cohérent avec readCoursesUProducts /
  // inspectCoursesUResults dans ce même fichier, qui lisent déjà via
  // textContent plutôt qu'innerText. Mais textContent remonte aussi le
  // contenu JS/CSS des <script>/<style> enfants, pas seulement le texte
  // affiché — une vraie fiche produit a un <script> de config contenant
  // "SHOW_CAPTCHA":null (window.SessionAttributes), qui déclenchait à tort
  // SITE_BLOCKED via le test /captcha/i ci-dessous. D'où le clone filtré.
  const bodyClone = document.body?.cloneNode(true);
  bodyClone?.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  const text = (bodyClone?.textContent || '').replace(/\s+/g, ' ').trim();
  if (/captcha|pas un robot|accès refusé/i.test(text)) return { ok: false, code: 'SITE_BLOCKED' };

  let ld = null;
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(script.textContent || 'null');
      const entries = Array.isArray(data) ? data : [data];
      ld = entries.find((entry) => {
        const type = entry?.['@type'];
        return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
      });
      if (ld) break;
    } catch {
      // JSON-LD malformé : on ignore ce bloc et on retombe sur les heuristiques DOM.
    }
  }

  // Le premier [data-tc-product-tile] du DOM n'est PAS forcément le produit
  // affiché : une fiche produit coursesu.com peut contenir un widget
  // "mini-panier" (classe mini-cart-product, un tile par article déjà dans
  // le panier) placé AVANT le produit principal, ainsi qu'un carrousel de
  // suggestions (classe recommendation-tile) placé après — chacun avec son
  // propre [data-tc-product-tile] et son propre EAN. Bug réel constaté
  // 2026-08-28 (RDP, fiche "Lait UHT demi écrémé") : sur une page avec 4
  // articles déjà au panier, le premier tile lu était celui de l'Emmental du
  // mini-panier (EAN 3228022120040) au lieu du lait affiché (EAN
  // 3256224234494), provoquant un faux mismatch EAN côté ajout au panier
  // (tryAddToCartCoursesUViaProductUrl) et un repli vers une recherche par
  // nom qui a ajouté le mauvais produit. Le tile fiable est l'ANCÊTRE du
  // bouton d'ajout principal (classe pdp-add-to-cart, présente uniquement
  // sur ce bouton précis) ; repli sur le premier tile qui n'appartient ni au
  // mini-panier ni au carrousel de suggestions si ce bouton est introuvable.
  const pdpButton = document.querySelector('.pdp-add-to-cart');
  const tileNode =
    pdpButton?.closest('[data-tc-product-tile]') ||
    [...document.querySelectorAll('[data-tc-product-tile]')].find(
      (element) => !/mini-cart-product|recommendation-tile/.test(element.className || '')
    );
  let tileData;
  try {
    tileData = JSON.parse(tileNode?.getAttribute('data-tc-product-tile') || 'null');
  } catch {
    tileData = null;
  }

  const name = (
    (tileData?.name && tileData.name !== 'unknown' ? tileData.name : null) ||
    ld?.name ||
    document.querySelector('h1, [itemprop="name"]')?.textContent ||
    document.title ||
    ''
  ).trim().slice(0, 500);

  const ldOffer = Array.isArray(ld?.offers) ? ld.offers[0] : ld?.offers;
  const ldPrice = Number(ldOffer?.price);

  // Palier le plus fiable, vérifié en direct sur de vraies fiches produit
  // coursesu.com (2026-08-27, magasin Hyper U - Hanches) : l'attribut
  // data-item-price du bloc prix officiel du magasin sélectionné contient la
  // valeur numérique exacte du prix total de l'article — distinct du prix de
  // référence au litre/kg (.unit-info, dans un <span> séparé sans cet
  // attribut) et du prix barré avant promo (.pdp-standard-price). Aucun
  // parsing de texte affiché nécessaire, donc aucune ambiguïté possible avec
  // un texte promo du type "Soit 2,12€ d'économie." (qui, lui, n'a pas de
  // suffixe /L ou /kg et pouvait tromper le filtre regex ci-dessous — c'est
  // ce qui explique la lecture erronée du diagnostic 2026-08-27 malgré le
  // premier correctif par regex).
  //
  // Replis AJOUTÉS (2026-08-28) : ils ne s'exécutent QUE si le sélecteur
  // d'origine ci-dessus n'a rien trouvé — ce chemin reste prioritaire et
  // strictement inchangé. Ils couvrent le cas où coursesu.com renommerait
  // `.actions-container-price` ou `.sale-price` : sans eux, la lecture
  // chuterait d'un coup jusqu'au repli texte, beaucoup plus exposé aux
  // montants promotionnels. Les nœuds du mini-panier et du carrousel de
  // suggestions sont exclus pour la même raison que pour la tuile produit :
  // leur prix décrit un AUTRE article (bug réel du 2026-08-28).
  const isForeignPriceNode = (element) =>
    Boolean(
      element.closest?.(
        '[class*="mini-cart" i], [class*="recommendation" i], [class*="crossell" i], [class*="carousel" i], [class*="suggestion" i]'
      )
    );
  const readItemPriceAttr = () => {
    const primary = document.querySelector('.actions-container-price .sale-price[data-item-price]');
    if (primary) return { value: primary.getAttribute('data-item-price'), source: 'item_price_attr' };
    const scopedFallback = [...document.querySelectorAll('.sale-price[data-item-price], [data-item-price]')].find(
      (element) => !isForeignPriceNode(element)
    );
    return {
      value: scopedFallback?.getAttribute('data-item-price') ?? undefined,
      source: scopedFallback ? 'item_price_attr_hors_bloc' : undefined
    };
  };
  const itemPriceRead = readItemPriceAttr();
  const itemPriceAttr = itemPriceRead.value;
  const itemPrice = Number(itemPriceAttr);

  // JSON-LD n'a en pratique presque jamais de "offers" sur les vraies fiches
  // coursesu.com (constaté en conditions réelles). Le repli DOM ci-dessous
  // (utilisé seulement si ni data-item-price ni JSON-LD n'ont donné de prix)
  // reste exposé au même risque que ci-dessus si le magasin n'a pas encore
  // été sélectionné sur cette page (bloc .actions-container-price absent) :
  // sans filtre, le premier montant "X,XX €" du texte peut être un prix
  // unitaire au lieu du prix réel de l'article (régression réelle 2026-08-27).
  const priceCandidates = [...text.matchAll(/(\d{1,4})(?:[,.](\d{2})\s*€|\s*€\s*(\d{2}))/gi)].map((m) => ({
    value: Number(`${m[1]}.${m[2] || m[3]}`),
    start: m.index,
    end: m.index + m[0].length
  }));
  // Ce repli ne sert que si data-item-price ET le JSON-LD ont tous deux
  // échoué — typiquement quand le site a changé la structure du bloc prix, ou
  // quand le magasin n'est pas encore sélectionné. Dans ce cas, le premier
  // montant du texte n'est pas forcément le prix de l'article : ça peut être
  // un prix au litre/kg, mais aussi une bulle promo ("Soit 2,12 € d'économie",
  // cas réel du 2026-08-27), un prix barré introduit par "au lieu de", un
  // seuil de livraison gratuite ou un montant de cagnotte. Un prix faux est
  // ici PIRE qu'une absence de prix : il est présenté à l'utilisateur comme
  // certain et fausse toute la comparaison entre magasins. On écarte donc
  // aussi ces contextes, avant comme après le montant.
  // Les fenêtres de contexte s'arrêtent au symbole € le plus proche : sans
  // cette coupure, la mention qui qualifie un montant ("Au lieu de 6,20 €")
  // débordait sur le montant SUIVANT — le vrai prix — et le faisait écarter
  // lui aussi, si bien qu'aucun candidat ne passait et que le repli
  // `priceCandidates[0]` retenait justement le prix barré.
  const contextBefore = (start) => {
    const raw = text.slice(Math.max(0, start - 28), start);
    const cut = raw.lastIndexOf('€');
    return cut === -1 ? raw : raw.slice(cut + 1);
  };
  const contextAfter = (end) => {
    const raw = text.slice(end, end + 24);
    const cut = raw.indexOf('€');
    return cut === -1 ? raw : raw.slice(0, cut);
  };
  const isUnitPriceContext = (c) =>
    /^\s*(\/\s*(l|kg|cl|g)\b|d[’']?\s*[ée]conomie|de remise|offerts?\b)/i.test(contextAfter(c.end)) ||
    /(litre|au kg|le kg|au lieu de|[àa] partir de|livraison|frais de port|cagnotte)\b/i.test(
      contextBefore(c.start)
    );
  const totalPriceCandidate = priceCandidates.find((c) => !isUnitPriceContext(c)) || priceCandidates[0];
  const domPrice = totalPriceCandidate ? totalPriceCandidate.value : NaN;
  const priceEuro =
    Number.isFinite(itemPrice) && itemPrice > 0
      ? itemPrice
      : Number.isFinite(ldPrice) && ldPrice > 0
        ? ldPrice
        : domPrice;
  // Canari de structure AJOUTÉ (2026-08-28) : purement observationnel — il
  // décrit d'où vient le prix retenu, sans influencer aucune décision. Une
  // valeur 'texte_affiche' signale que la page ne ressemble plus à ce que le
  // code suppose (ni attribut, ni JSON-LD), donc une lecture en mode dégradé
  // à surveiller AVANT qu'elle ne produise un prix faux.
  const priceSource =
    Number.isFinite(itemPrice) && itemPrice > 0
      ? itemPriceRead.source
      : Number.isFinite(ldPrice) && ldPrice > 0
        ? 'json_ld'
        : 'texte_affiche';

  const unitInfoText = [...document.querySelectorAll('.unit-info')]
    .find((element) => !isForeignPriceNode(element))
    ?.textContent?.trim();
  const unitInfoMatch = unitInfoText?.match(/(\d{1,4})[,.]\s*(\d{1,2})\s*€?\s*\/\s*(l|kg|cl|g)\b/i);
  const unitPriceRaw = unitInfoMatch ? Number(`${unitInfoMatch[1]}.${unitInfoMatch[2].padEnd(2, '0')}`) : NaN;
  const unitPriceSuffix = unitInfoMatch?.[3]?.toLowerCase();
  const unitPriceEuro =
    Number.isFinite(unitPriceRaw) && unitPriceSuffix
      ? unitPriceRaw * (unitPriceSuffix === 'cl' ? 100 : unitPriceSuffix === 'g' ? 1000 : 1)
      : undefined;
  const unitPriceUnit = unitPriceSuffix === 'l' || unitPriceSuffix === 'cl' ? 'L' : unitPriceSuffix ? 'kg' : undefined;

  // Tout EAN, quelle que soit sa source, doit passer la clé de contrôle GS1
  // avant d'être retenu (voir extension/shared/barcode.js pour le pourquoi
  // détaillé) : `text` couvre toute la fiche, pied de page compris, et
  // l'ancien `text.match(/\b\d{8,14}\b/)` y prenait la première suite de
  // chiffres venue — numéro de service client, référence interne, date au
  // format AAAAMMJJ. Cet EAN inventé sert ensuite de correspondance PARFAITE
  // dans chooseCoursesUProduct et de critère de rejet dans
  // tryAddToCartCoursesUViaProductUrl : les deux décident de ce qui atterrit
  // dans le panier réel. normalizeEanLocal écarte aussi la valeur sentinelle
  // "unknown" des tuiles, d'où la disparition du garde explicite.
  const barcode =
    normalizeEanLocal(tileData?.EAN) ||
    normalizeEanLocal(ld?.gtin13) ||
    normalizeEanLocal(ld?.gtin) ||
    findEanInTextLocal(text);

  // Le texte global `text` inclut les avis clients tout en bas de la page —
  // un avis mentionnant "en rupture de stock" à propos du service de
  // livraison en général (pas de CE produit) faisait passer `available` à
  // false pour n'importe quel article (constaté en conditions réelles
  // 2026-08-27, magasin Hyper U - Hanches, "Lait UHT demi écrémé" pourtant
  // bien en stock). On restreint donc le repli textuel au bloc prix/actions
  // du produit, qui ne contient jamais les avis clients ; repli sur `text`
  // si ce bloc est absent, pour ne rien perdre du comportement existant.
  const priceContainer = document.querySelector('.actions-container-price');
  const priceContainerClone = priceContainer?.cloneNode(true);
  priceContainerClone?.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
  const availabilityText = priceContainer
    ? (priceContainerClone?.textContent || '').replace(/\s+/g, ' ').trim()
    : text;

  const availability = String(ldOffer?.availability || '').toLowerCase();
  const available = availability ? !/outofstock/.test(availability) : !/indisponible|rupture/i.test(availabilityText);

  const notFound = /page (introuvable|non trouv[ée]e)|produit introuvable|erreur 404/i.test(text);
  if (notFound || !name) {
    return { ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' };
  }
  if (!Number.isFinite(priceEuro) || priceEuro < 0) {
    return { ok: false, code: 'MANUAL_URL_PRICE_NOT_FOUND' };
  }

  return {
    ok: true,
    name,
    priceEuro,
    priceSource,
    ...(unitPriceEuro !== undefined ? { unitPriceEuro, unitPriceUnit } : {}),
    barcode: barcode || undefined,
    available,
    productUrl: location.href,
    externalProductId: tileNode?.getAttribute('data-product-id') || document.documentElement.getAttribute('data-product-id') || undefined,
    externalStoreId: document.documentElement.getAttribute('data-store-id') || 'courses-u-store'
  };
}

function inspectCoursesUSearchNavigation(expectedQuery) {
  let url;
  try { url = new URL(location.href); } catch { return { ready: false }; }
  const actualQuery = url.searchParams.get('q') || '';
  return {
    ready:
      /\/recherche\/?$/i.test(url.pathname) &&
      actualQuery.trim().toLowerCase() === String(expectedQuery || '').trim().toLowerCase()
  };
}

async function inspectProductResults(scripting, tabId, inspector) {
  try {
    return (await run(scripting, tabId, inspector, [])) ?? {};
  } catch {
    return { inspectionFailed: true };
  }
}

function failure(store, code, details, keepTabOpen = false) {
  return { observations: [], errors: [{ storeKey: store.storeKey, code, ...(details ? { details } : {}) }], keepTabOpen };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('DRIVE_JOB_CANCELLED')); }, { once: true });
  });
}

function randomJitterMs(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

function tokens(value) {
  return new Set(String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1));
}

function overlap(expected, actual) {
  if (!expected.size) return 0;
  let count = 0;
  for (const token of expected) if (actual.has(token)) count += 1;
  return count / expected.size;
}

function isCoursesUUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'coursesu.com' || url.hostname.endsWith('.coursesu.com'));
  } catch { return false; }
}

function inspectCoursesUPage() {
  const text = (document.body?.innerText || '').toLowerCase();
  const inputs = [...document.querySelectorAll('input')];
  const catalogReady = inputs.some((input) => input.type === 'search' || /recherch|search.*produit/i.test(`${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label')}`));
  return {
    catalogReady,
    blocked: /captcha|pas un robot|accès refusé/.test(text),
    details: { inputCount: inputs.length, pathKind: location.pathname.split('/').filter(Boolean)[0] || 'home', hasSearchControl: catalogReady }
  };
}

// Sonde de survie (reviewer #12, audit 30/08) — même raisonnement que
// probeLeclercTab côté Leclerc (voir leclerc-probe.js) : réutilise
// inspectCoursesUPage, déjà utilisé par le prologue ensureCoursesUCatalogReady,
// avec un budget de temps réduit et configurable pour un simple contrôle
// "l'onglet répond-il encore ?" après un SCRIPT_EXECUTION_TIMEOUT ponctuel,
// sans attendre la pleine fenêtre par défaut.
async function probeCoursesUTab({ scripting, tabId, timeoutMs }) {
  const results = await executeScriptWithTimeout(scripting, { target: { tabId }, func: inspectCoursesUPage }, timeoutMs);
  return results?.[0]?.result ?? null;
}

function submitCoursesULocation(store) {
  const input = [...document.querySelectorAll('input')].find((element) => /postal|ville|adresse|localis/i.test(`${element.name} ${element.id} ${element.placeholder} ${element.getAttribute('aria-label')}`));
  if (!input) return { started: false, code: 'LOCATION_INPUT_NOT_FOUND' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, store.postalCode || store.city || '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  setTimeout(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })), 0);
  return { started: true };
}

export function readCoursesUChoices() {
  const controls = [...document.querySelectorAll('button, a[href], [role="button"]')];
  return controls.map((control, actionIndex) => ({
    actionIndex,
    controlText: (control.textContent || '').replace(/\s+/g, ' ').trim(),
    // Start the search from the parent: the control itself can carry a class
    // like "stores-button" that already satisfies `[class*="store"]`, which
    // would stop closest() right there instead of reaching the real card
    // that holds the store's name and postal code.
    text: (control.parentElement?.closest('article, li, [class*="store" i], [class*="magasin" i]')?.textContent || control.textContent || '').replace(/\s+/g, ' ').trim()
  })).filter(({ text, controlText }) => text.length < 1_000 && (/choisir|sélectionner|selectionner|drive|retrait/i.test(controlText) || /\b\d{5}\b/.test(text)));
}

// `actionIndex` est une POSITION dans le DOM, capturée par readCoursesUChoices
// lors d'une injection précédente. Entre les deux injections, coursesu.com a
// pu re-rendre sa liste de magasins (résultats affinés, bannière consentement
// refermée, chargement différé d'une carte) : la même position désigne alors
// un autre magasin, et on validerait silencieusement le mauvais drive — donc
// TOUS les prix comparés ensuite. On revérifie donc que le contrôle occupant
// cette position porte encore le libellé retenu par chooseStoreChoice avant
// de cliquer, plutôt que de faire confiance à l'index seul.
export function clickCoursesUChoice(actionIndex, expectedControlText) {
  const control = [...document.querySelectorAll('button, a[href], [role="button"]')][actionIndex];
  if (!control) return { clicked: false, code: 'STORE_RESULT_STALE' };
  const currentText = (control.textContent || '').replace(/\s+/g, ' ').trim();
  if (expectedControlText && currentText !== expectedControlText) {
    return { clicked: false, code: 'STORE_RESULT_STALE' };
  }
  control.removeAttribute?.('target');
  setTimeout(() => control.click(), 0);
  return { clicked: true };
}

// Injectée : renvoie l'adresse de la page courante. Aucun symbole externe —
// contrainte des fonctions reconstruites depuis leur source dans le monde
// isolé de l'extension.
function readCurrentCoursesUUrlOnPage() {
  return { href: location.href };
}

function startCoursesUSearch(product) {
  const input = [...document.querySelectorAll('input')].find((element) => element.type === 'search' || /recherch|search.*produit/i.test(`${element.name} ${element.id} ${element.placeholder} ${element.getAttribute('aria-label')}`));
  if (!input) return { started: false, code: 'PRODUCT_SEARCH_INPUT_NOT_FOUND' };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const brand = /^(?:marque habituelle|sans marque)$/i.test(product.brand || '') ? '' : product.brand || '';
  const query = String(product.searchQuery || `${product.name} ${brand}`).trim();
  setter?.call(input, query);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const searchContainer = input.closest('form, [role="search"], search') || input.parentElement;
  const submit = [...(searchContainer || document).querySelectorAll('button, input[type="submit"]')].find((element) =>
    /recherch|search/i.test(`${element.textContent || ''} ${element.value || ''} ${element.getAttribute('aria-label') || ''}`)
  );
  setTimeout(() => {
    if (submit) submit.click();
    else if (input.form?.requestSubmit) input.form.requestSubmit();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  }, 0);
  return { started: true, query };
}

export function readCoursesUProducts() {
  // Copie locale de normalizeEan/findEanInText (extension/shared/barcode.js)
  // — une fonction injectée ne peut appeler aucune fonction externe du
  // module. Garder les trois copies de ce fichier synchronisées entre elles
  // et avec le module partagé ; les tests d'isolation les comparent.
  const normalizeEanLocal = (value) => {
    const digits = String(value ?? '').replace(/[\s-]/g, '');
    if (!/^\d+$/.test(digits)) return undefined;
    if (![8, 12, 13, 14].includes(digits.length)) return undefined;
    let sum = 0;
    for (let index = 0; index < digits.length - 1; index += 1) {
      sum += Number(digits[index]) * ((digits.length - index) % 2 === 0 ? 3 : 1);
    }
    return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]) ? digits : undefined;
  };
  const findEanInTextLocal = (value) => {
    for (const match of String(value ?? '').matchAll(/\b\d{12,14}\b/g)) {
      const normalized = normalizeEanLocal(match[0]);
      if (normalized) return normalized;
    }
    return undefined;
  };

  const nodes = [];
  for (const link of document.querySelectorAll('a[href*="/p/"]')) {
    let container = link;
    for (let depth = 0; depth < 7 && container.parentElement; depth += 1) {
      const parent = container.parentElement;
      const text = (parent.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 2_500) break;
      container = parent;
      if (/\d{1,4}[,.]\d{2}\s*(?:€|eur)/i.test(text)) break;
    }
    if (/€|eur/i.test(container.textContent || '')) nodes.push(container);
  }
  for (const node of document.querySelectorAll('[data-product-id], [itemtype*="Product"], article')) {
    if (/€|eur/i.test(node.textContent || '')) nodes.push(node);
  }
  const candidates = [...new Set(nodes)].slice(0, 60).map((node) => {
    const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
    const link = node.querySelector('a[href*="/p/"]');
    const matches = [...text.matchAll(/(\d{1,4})(?:[,.](\d{2})\s*€|\s*€\s*(\d{2}))/gi)];
    const match = /prix r[ée]duit/i.test(text) && matches.length > 1 ? matches[1] : matches[0];
    // The tile carries a JSON payload with the exact catalog name/brand/EAN;
    // prefer it over heading text, which can pick up a promo ribbon instead
    // of the product title when both share the same h2/h3/h4 tag.
    const tileNode = node.closest('[data-tc-product-tile]') ?? node.querySelector('[data-tc-product-tile]');
    let tileData;
    try { tileData = JSON.parse(tileNode?.getAttribute('data-tc-product-tile') || 'null'); } catch { tileData = null; }
    // Prix de référence au litre/kilo affiché sur la carte (.unit-info), déjà
    // lu sur la fiche produit (readCoursesUProductPageOnPage) mais jamais ici
    // — vérifié sur une recherche réelle le 31/08 : 24 blocs .unit-info sur
    // une seule page de résultats. Il alimente le contrôle croisé prix / prix
    // au litre côté PWA (src/features/comparison/priceCoherence.ts), seule
    // vérification du projet qui ne dépende d'aucun sélecteur.
    //
    // L'enjeu est direct ici : `priceEuro` ci-dessous est extrait du texte
    // ENTIER de la carte, qui contient aussi ce prix au kilo, et ne retient
    // le bon montant que parce que le prix de l'article le précède dans le
    // DOM. Le jour où Hyper U inverse les deux blocs, tous les prix
    // deviennent des prix au kilo — le contrôle croisé est ce qui rend cette
    // bascule visible au lieu de silencieuse.
    //
    // La même classe sert aussi à des mentions sans prix ("Soit environ
    // 216 g") : on retient donc le premier bloc portant réellement un montant
    // suivi d'une unité de mesure, pas le premier bloc rencontré. Un "€/pce"
    // ne correspond volontairement pas — une pièce ne dit rien du grammage.
    let unitPriceEuro;
    let unitPriceUnit;
    for (const unitNode of node.querySelectorAll('.unit-info')) {
      const unitMatch = (unitNode.textContent || '').trim().match(/(\d{1,4})[,.]\s*(\d{1,2})\s*€?\s*\/\s*(l|kg|cl|g)\b/i);
      if (!unitMatch) continue;
      const unitSuffix = unitMatch[3].toLowerCase();
      const unitRaw = Number(`${unitMatch[1]}.${unitMatch[2].padEnd(2, '0')}`);
      if (!Number.isFinite(unitRaw) || unitRaw <= 0) continue;
      unitPriceEuro = unitRaw * (unitSuffix === 'cl' ? 100 : unitSuffix === 'g' ? 1000 : 1);
      unitPriceUnit = unitSuffix === 'l' || unitSuffix === 'cl' ? 'L' : 'kg';
      break;
    }
    return {
      name: (
        (tileData?.name && tileData.name !== 'unknown' ? tileData.name : null) ||
        node.querySelector('h2, h3, h4, [itemprop="name"], [class*="title" i]')?.textContent ||
        link?.textContent ||
        text
      ).trim().slice(0, 500),
      ...(tileData?.brand ? { brand: String(tileData.brand).trim().slice(0, 200) } : {}),
      // Clé de contrôle GS1 exigée sur les deux sources (voir
      // extension/shared/barcode.js) : `text` est le texte complet de la
      // carte, et l'ancien `text.match(/\b\d{8,14}\b/)` y retenait la
      // première suite de chiffres venue. Un EAN inventé de cette façon vaut
      // correspondance PARFAITE dans chooseCoursesUProduct (matchScore 1,
      // scoring par nom court-circuité) — donc potentiellement le mauvais
      // produit ajouté au panier réel.
      barcode: normalizeEanLocal(tileData?.EAN) || findEanInTextLocal(text),
      externalProductId: node.getAttribute('data-product-id') || tileNode?.getAttribute('data-product-id') || undefined,
      externalStoreId: document.documentElement.getAttribute('data-store-id') || 'courses-u-store',
      priceEuro: match ? Number(`${match[1]}.${match[2] || match[3]}`) : NaN,
      ...(unitPriceEuro !== undefined ? { unitPriceEuro, unitPriceUnit } : {}),
      available:
        !/indisponible|rupture/i.test(text) &&
        !Boolean(node.querySelector('button[disabled][aria-label*="ajouter" i], button[aria-label*="indisponible" i]')),
      ...(() => {
        const promotion = node.querySelector(
          '.promotion-label, [class*="promotion" i], [class*="promo-" i], [data-testid*="promotion" i]'
        )?.textContent?.replace(/\s+/g, ' ').trim();
        return promotion ? { promotionLabel: promotion.slice(0, 300) } : {};
      })(),
      productUrl: link?.href || ''
    };
  });
  const mergedByIdentity = new Map();
  for (const candidate of candidates) {
    const identity = candidate.externalProductId
      ? `id:${candidate.externalProductId}`
      : candidate.barcode
        ? `ean:${candidate.barcode}`
        : candidate.productUrl
          ? `url:${candidate.productUrl}`
          : `name-price:${candidate.name}|${candidate.priceEuro}`;
    const existing = mergedByIdentity.get(identity);
    if (!existing) {
      mergedByIdentity.set(identity, candidate);
      continue;
    }
    for (const [field, value] of Object.entries(candidate)) {
      if ((existing[field] === undefined || existing[field] === '') && value !== undefined && value !== '') {
        existing[field] = value;
      }
    }
  }
  return [...mergedByIdentity.values()];
}

export function parseCoursesUDisplayedPrice(text) {
  const matches = [...String(text || '').matchAll(/(\d{1,4})(?:[,.](\d{2})\s*€|\s*€\s*(\d{2}))/gi)];
  const match = /prix r[ée]duit/i.test(text) && matches.length > 1 ? matches[1] : matches[0];
  return match ? Number(`${match[1]}.${match[2] || match[3]}`) : NaN;
}

function inspectCoursesUResults() {
  const text = document.body?.innerText || '';
  return {
    pathKind: location.pathname.split('/').filter(Boolean).slice(-1)[0] || 'home',
    resultCardCount: document.querySelectorAll('[data-product-id], [itemtype*="Product"], article').length,
    euroNodeCount: [...document.querySelectorAll('article, li, [data-product-id]')].filter((node) => (node.textContent || '').includes('€')).length,
    hasCaptcha: /captcha|pas un robot|accès refusé/i.test(text)
  };
}
