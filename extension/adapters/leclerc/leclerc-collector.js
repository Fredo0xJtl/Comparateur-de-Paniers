import { validateDriveObservation } from '../../shared/drive-protocol.js';
import { runCookieConsentDismissal } from '../../shared/cookie-consent.js';
import { executeScriptWithTimeout } from '../../shared/scripting-timeout.js';
import { stripPackagingNoiseFromSearchName, dedupeBrandFromSearchName } from '../../shared/search-query.js';
import { parseQuantityFromName, normalizeQuantity, quantitiesMatch } from '../../shared/quantity-parser.js';
import { probeLeclercTab } from './leclerc-probe.js';
import { chooseLeclercDriveChoice } from './leclerc-store-selection.js';
import {
  readKnownLeclercFarms,
  rememberLeclercFarm,
  resolveLeclercTransactionalUrl
} from './leclerc-farm-resolver.js';
import { isVerboseDiagnosticsEnabled } from '../../shared/verbose-diagnostics.js';

// Order the staged fallback cascade runs in. A remembered "matchStage" hint
// from a prior successful refresh lets a product skip straight to the stage
// that worked instead of redoing every earlier (previously-failed) stage —
// if the hinted stage no longer finds it (store's search results changed),
// the cascade still falls through to whatever stages come after it.
// `ean` est volontairement absent : Leclerc n'indexe pas les codes-barres
// comme requêtes texte. Le protocole continue d'accepter cette ancienne
// valeur pour relire les données historiques, mais elle n'est pas une étape
// opérationnelle de ce collecteur.
const SEARCH_STAGE_ORDER = ['name', 'simplified_name', 'name_only', 'brand_only'];

// Structured logging for debugging (no external deps). Contient des noms de
// produits/requêtes de recherche — désactivé par défaut (audit sécurité du
// 30/08, MEDIUM #6), voir extension/shared/verbose-diagnostics.js.
function debugLog(stage, data) {
  if (!isVerboseDiagnosticsEnabled()) return;
  const msg = {
    timestamp: new Date().toISOString(),
    stage,
    ...data
  };
  console.log(`[Leclerc] ${JSON.stringify(msg)}`);
}

// Prologue partagé : amène l'onglet jusqu'au catalogue transactionnel du
// magasin (dismiss cookies, résolution "ferme"/farm, sélection du Drive
// officiel si besoin, entrée catalogue). Extrait de collectLeclercStore pour
// être réutilisé tel quel par livePickLeclercProduct (sélection manuelle en
// direct) sans dupliquer cette logique délicate.
async function ensureLeclercCatalogReady({ scripting, tabId, store, signal, farmStore = null }) {
  // Diagnostic (29/08) : deux exports réels consécutifs montrent Leclerc à
  // 0 observation avec pour seule trace un SCRIPT_EXECUTION_TIMEOUT — signe
  // que le blocage a lieu ICI, avant même le parcmier produit (la boucle par
  // produit a son propre try/catch qui, lui, conserve déjà les résultats
  // partiels — mais un blocage dans ce prologue n'a par définition aucun
  // résultat partiel à perdre). Sans contexte, ce timeout était totalement
  // muet sur l'étape réellement bloquée. `phase` trace la dernière étape
  // engagée pour qu'un futur export de diagnostic le dise explicitement au
  // lieu de forcer à deviner entre cookies/probe/résolution ferme/sélection
  // magasin/entrée catalogue.
  let phase = 'cookie_consent';
  try {
    const consent = await runCookieConsentDismissal(scripting, tabId);
    // Fail-closed (audit sécurité du 30/08, MEDIUM #7) : on ne clique plus
    // "Tout accepter" à la place de l'utilisateur quand aucun bouton de
    // refus n'est reconnu — voir extension/shared/cookie-consent.js. Le
    // magasin échoue ici avec un code explicite plutôt que de continuer sur
    // une page potentiellement toujours bloquée par la bannière.
    if (consent?.code === 'CONSENT_REJECT_UNAVAILABLE') {
      return { ready: false, code: 'COOKIE_CONSENT_BLOCKED' };
    }
    await wait(600, signal);
    phase = 'initial_probe';
    let probe = await probeLeclercTab({ scripting, tabId });
    if (
      !isTransactionalLeclercHost(probe.snapshot?.hostname) &&
      isLeclercInformationPath(probe.snapshot?.pathname)
    ) {
      phase = 'farm_resolution';
      const discovery = await runPageAction(scripting, tabId, findLeclercTransactionalLinkOnPage, []);
      // La découverte sur la page est le chemin normal ; la table apprise ne
      // sert que lorsqu'elle échoue (page publique sans lien vers le
      // catalogue). Elle est vide au premier usage, ce qui est sans
      // conséquence tant que la découverte fonctionne.
      const knownFarms = discovery?.url ? {} : await readKnownLeclercFarms(farmStore);
      const transactionalUrl =
        discovery?.url ?? resolveLeclercTransactionalUrl(probe.snapshot?.pathname, knownFarms);
      if (!transactionalUrl) {
        return {
          ready: false,
          code: 'LECLERC_FARM_NOT_RESOLVED',
          details: { pathKind: probe.snapshot?.pathname ?? 'unknown' }
        };
      }
      const navigation = await runPageAction(scripting, tabId, navigateToLeclercUrlOnPage, [transactionalUrl]);
      if (!navigation?.started) return { ready: false, code: 'LECLERC_CATALOG_NAVIGATION_FAILED' };
      await wait(2_500, signal);
      probe = await probeLeclercTab({ scripting, tabId });
      // La correspondance n'est retenue qu'une fois la page réellement
      // atteinte : on enregistre ce qui a marché, jamais une hypothèse.
      if (isTransactionalLeclercHost(probe.snapshot?.hostname)) {
        await rememberLeclercFarm(farmStore, transactionalUrl);
      }
    }
    // L'utilisateur peut aussi arriver directement sur le catalogue de son
    // magasin, sans passer par la résolution ci-dessus : c'est le cas courant,
    // et c'est ce qui permet à la table d'être renseignée dès la première
    // collecte, avant même d'avoir eu besoin du repli.
    if (isTransactionalLeclercHost(probe.snapshot?.hostname) && probe.snapshot?.pathname) {
      await rememberLeclercFarm(
        farmStore,
        `https://${probe.snapshot.hostname}${probe.snapshot.pathname}`
      );
    }
    if (probe.state === 'blocked') return { ready: false, code: probe.code };

    if (probe.state === 'store_required') {
      phase = 'store_selection';
      const selection = await selectOfficialLeclercDrive({ scripting, tabId, store, signal });
      if (!selection.started) {
        if (selection.code === 'DRIVE_RESULT_NOT_FOUND' && selection.details?.candidateCount === 0) {
          return { ready: false, code: 'DRIVE_SETUP_REQUIRED', details: selection.details, keepTabOpen: true };
        }
        return { ready: false, code: selection.code, details: selection.details, keepTabOpen: true };
      }
      await wait(2_000, signal);
      probe = await probeLeclercTab({ scripting, tabId });
    }
    const transactionalHost = isTransactionalLeclercHost(probe.snapshot?.hostname);
    if (probe.state !== 'catalog_ready' && !transactionalHost) {
      return { ready: false, code: probe.code ?? 'CATALOG_NOT_READY' };
    }

    if (!transactionalHost) {
      phase = 'catalog_entry';
      const catalogEntry = await runPageAction(scripting, tabId, enterCatalogOnPage, []);
      if (!catalogEntry?.ready && !catalogEntry?.started) {
        return { ready: false, code: catalogEntry?.code ?? 'CATALOG_ENTRY_NOT_FOUND', details: catalogEntry?.details };
      }
      if (catalogEntry.started) {
        await wait(2_500, signal);
        const verification = await runPageAction(scripting, tabId, inspectCatalogOnPage, []);
        if (!verification?.ready) {
          return { ready: false, code: 'CATALOG_NOT_READY_AFTER_ENTRY', details: verification?.details };
        }
      }
    }
    return { ready: true };
  } catch (error) {
    if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') {
      error.details = { phase };
    }
    throw error;
  }
}

// `tabs` (02/09/2026) : manquait à cette signature depuis que ce collecteur
// sait relire une fiche produit par son URL (31/08). Le paramètre était bien
// transmis à collectLeclercManualProduct, mais n'existait dans aucun scope :
// chaque relecture de fiche partait donc en ReferenceError, avalée par le
// catch du bloc appelant, et retombait systématiquement sur la recherche —
// une correction manuelle Leclerc n'a jamais été relue en pratique. Symptôme
// visible côté utilisateur : le comparatif refaisait toutes les recherches,
// y compris pour des produits déjà validés à la main.
export async function collectLeclercStore({
  scripting,
  tabs,
  tabId,
  job,
  store,
  products,
  searchHints = {},
  signal,
  farmStore = null,
  onProgress = () => undefined
}) {
  const prologue = await ensureLeclercCatalogReady({ scripting, tabId, store, signal, farmStore });
  if (!prologue.ready) return failed(store, prologue.code, prologue.details, prologue.keepTabOpen === true);

  const observations = [];
  const errors = [];
  let isFirstProduct = true;
  let productIndex = 0;
  // Mémorise la route catalogue/recherche AVANT le parcmier produit : une
  // navigation vers une fiche standalone (chemin de correction manuelle
  // ci-dessous) laisse l'onglet sur un sous-domaine sans zone de recherche,
  // dont ensureLeclercCatalogReady ne sait pas ressortir seul — même piège
  // que celui déjà documenté dans addToCartLeclercStore (28/08).
  // Cette route de retour n'est utilisée que si une correction manuelle doit
  // ouvrir une fiche standalone puis échoue. La lire pour une collecte 100 %
  // automatique ajoutait une injection sans utilité et transformait son
  // éventuel timeout en échec global avant le parcmier produit.
  const needsManualRouteFallback = products.some(
    (product) =>
      Boolean(job.manualUrlOverrides?.leclerc?.[product.productId]) ||
      // Un permalien appris ouvre lui aussi une fiche standalone, et son repli
      // (fiche périmée ou devenue fausse) a exactement le même besoin de
      // revenir sur la route de recherche.
      Boolean(job.knownProductUrls?.leclerc?.[product.productId])
  );
  const routeBeforeProducts = needsManualRouteFallback
    ? await runPageAction(scripting, tabId, readCurrentLeclercUrlOnPage, [])
    : null;
  const searchRouteUrl = routeBeforeProducts?.href ?? null;
  // Vrai dès qu'une navigation a posé l'onglet sur une fiche produit standalone
  // (raccourci manuel ou permalien appris), qu'elle ait réussi ou non. Une
  // fiche Leclerc est une page ASP.NET complète, SANS aucune zone de
  // recherche : tant qu'on ne l'a pas quittée, toute recherche lancée depuis
  // là échoue en PRODUCT_SEARCH_INPUT_NOT_FOUND. Constaté en réel le 02/09 sur
  // un produit dont le prédécesseur venait d'être lu par permalien AVEC
  // SUCCÈS — le retour de route n'était alors fait que sur les chemins
  // d'échec. Il est désormais fait à un seul endroit : juste avant la
  // cascade de recherche, et seulement si l'onglet en a réellement besoin.
  let tabIsOnProductPage = false;
  // Empreinte de la dernière liste de cartes lue avec succès (tous produits et
  // étages confondus). Sert à détecter une contamination croisée : si la
  // soumission d'une nouvelle recherche échoue en silence (page pas encore
  // repeinte, clic raté), `readProductCandidatesOnPage` peut relire les cartes
  // du produit/étage précédent — qui matcheraient alors le produit courant
  // contre un résultat qui n'a rien à voir. Une empreinte identique entre deux
  // lectures consécutives, alors que la requête a changé entre les deux, est
  // un signal fort que la seconde lecture n'a pas vu de nouvelle page.
  let lastReadFingerprint = null;
  // Régression réelle (30/08, cas "Emmental râpé" -> escalade jusqu'à
  // 'brand_only' alors que le produit était déjà visible dès l'étage 'name')
  // puis 2e itération (revue de code) : une 1ère version de ce correctif
  // réinitialisait `lastReadFingerprint` à chaque nouveau produit, ce qui
  // réglait ce cas mais désactivait aussi la détection cross-produit pour la
  // toute première recherche d'un produit — perdant la protection d'origine
  // (27/08) contre une soumission de recherche silencieusement ratée qui
  // relit les cartes du produit précédent. Le vrai signal manquant n'était
  // pas la portée (magasin entier vs par produit) mais `routeVerified` :
  // désormais réparé pour fonctionner aussi sur la route mobile (voir
  // inspectLeclercSearchNavigationOnPage), il confirme positivement — via
  // l'URL, indépendamment du contenu — qu'une NOUVELLE recherche a bien
  // abouti. Une lecture dont le contenu est identique à la précédente n'est
  // donc traitée comme périmée que si cette confirmation indépendante a
  // échoué ; si la route confirme la nouvelle requête, un contenu identique
  // par coïncidence (repli générique Leclerc sur une requête peu
  // spécifique) est accepté tel quel plutôt qu'effacé à tort.
  function applyStaleReadGuard(candidates, routeVerified) {
    const fingerprint = fingerprintCandidates(candidates);
    const isStale = Boolean(fingerprint) && fingerprint === lastReadFingerprint && routeVerified !== true;
    if (fingerprint) lastReadFingerprint = fingerprint;
    return isStale ? [] : candidates;
  }
  // Nombre de rejeux accordés à un produit dont la collecte a été coupée par
  // un SCRIPT_EXECUTION_TIMEOUT ALORS QUE la sonde confirmait un onglet sain
  // (voir le bloc de rattrapage plus bas). Diagnostic réel du 01/09 : 4 des
  // 5 échecs Leclerc étaient de ce type, sur des produits que Hyper U
  // trouvait sans peine au même moment — l'onglet allait bien, seul l'appel
  // injecté avait calé. Un seul rejeu suffit à les récupérer sans rallonger
  // sensiblement le job quand le site est vraiment en difficulté.
  const PRODUCT_TIMEOUT_RETRIES = 1;
  const timeoutRetriesLeft = new Map();
  // Produits dont le hint de mémoire de recherche a déjà été mis de côté
  // après un échec (voir le filet de sécurité dans le bloc `if (!best)`) :
  // leur rejeu repart de la cascade complète, et ne peut pas se rejouer une
  // seconde fois.
  const hintDisabledFor = new Set();
  for (let productCursor = 0; productCursor < products.length; productCursor += 1) {
    const product = products[productCursor];
    if (signal.aborted) break;
    productIndex += 1;
    // A fixed-interval search-after-search pattern is an easy automation
    // signal for bot detection (Datadome is active on this site). A small
    // randomized gap between products reads more like a human pausing to
    // read results than a script hammering the search box. Distribution:
    // 80% short (page nav), 20% long (reading results)
    if (!isFirstProduct) {
      const delayMs = Math.random() < 0.8
        ? randomJitterMs(100, 300)  // Quick page nav
        : randomJitterMs(800, 2_500); // Reading time
      await wait(delayMs, signal);
    }
    isFirstProduct = false;
    // Correction manuelle déjà validée pour ce produit : on relit sa fiche
    // directement plutôt que de relancer la cascade de recherche — c'est le
    // SEUL moyen de rafraîchir un candidat 'manual_override', que
    // persistDriveObservation refuse d'écraser depuis une recherche
    // automatique. Voir collectLeclercManualProduct. En cas d'échec (URL
    // périmée, fiche supprimée, page bloquée), on ne s'arrête pas : la
    // recherche normale reprend juste en dessous, inchangée.
    const manualUrl = job.manualUrlOverrides?.leclerc?.[product.productId];
    if (manualUrl) {
      let manual = null;
      tabIsOnProductPage = true;
      try {
        manual = await collectLeclercManualProduct({ scripting, tabs, tabId, signal, manualUrl });
      } catch (error) {
        // Une annulation de job doit remonter telle quelle, pas être traitée
        // comme un simple échec de lecture de fiche (même distinction que
        // dans le chemin Hyper U, tester #14 de l'audit du 30/08).
        if (error instanceof Error && error.message === 'DRIVE_JOB_CANCELLED') throw error;
        manual = null;
      }
      if (manual?.ok) {
        observations.push(
          validateDriveObservation({
            protocolVersion: 1,
            jobId: job.jobId,
            productId: product.productId,
            storeKey: 'leclerc',
            localStoreId: store.localStoreId,
            externalStoreId: store.localStoreId,
            observedName: manual.name,
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
          })
        );
        continue;
      }
      // Échec non bloquant : on le journalise pour que l'utilisateur sache que
      // sa correction manuelle n'a pas pu être relue, puis on retombe sur la
      // recherche (le retour sur la route de recherche est assuré plus bas,
      // avant la cascade — ensureLeclercCatalogReady ne suffit pas à sortir
      // d'une fiche, même piège que pour le remplissage du panier, 28/08).
      errors.push({
        storeKey: store.storeKey,
        productId: product.productId,
        code: manual?.code ?? 'MANUAL_URL_PAGE_INVALID'
      });
    }
    // Raccourci "permalien appris" (02/09/2026) : ce produit a déjà été
    // trouvé chez Leclerc lors d'un rafraîchissement précédent, et l'adresse
    // exacte de sa fiche a été mémorisée (job.knownProductUrls — voir
    // buildKnownProductUrls côté PWA). On relit cette fiche directement au
    // lieu de rejouer la cascade name→simplified_name→name_only→brand_only :
    // c'est plus rapide, et surtout ça supprime le risque de retomber sur un
    // AUTRE produit parce que le catalogue du magasin a changé de contenu.
    //
    // Différence essentielle avec le bloc manuel ci-dessus : un permalien
    // appris n'a aucune valeur de preuve humaine. On vérifie donc que la
    // fiche atteinte correspond toujours au produit demandé, et on renvoie le
    // score RÉELLEMENT mesuré (jamais 1). Sous le seuil, on ne retient rien :
    // la cascade normale reprend juste en dessous, inchangée.
    const knownUrl = job.knownProductUrls?.leclerc?.[product.productId];
    if (knownUrl && isLeclercStandaloneProductUrl(knownUrl)) {
      let known = null;
      tabIsOnProductPage = true;
      try {
        known = await collectLeclercManualProduct({ scripting, tabs, tabId, signal, manualUrl: knownUrl });
      } catch (error) {
        // Même distinction que dans le bloc manuel : une annulation de job
        // remonte telle quelle, elle n'est pas un simple échec de lecture.
        if (error instanceof Error && error.message === 'DRIVE_JOB_CANCELLED') throw error;
        known = null;
      }
      const knownScore = known?.ok ? scoreLeclercProductPageName(product, known.name) : 0;
      if (known?.ok && knownScore >= KNOWN_URL_MIN_NAME_SCORE) {
        observations.push(
          validateDriveObservation({
            protocolVersion: 1,
            jobId: job.jobId,
            productId: product.productId,
            storeKey: 'leclerc',
            localStoreId: store.localStoreId,
            externalStoreId: store.localStoreId,
            observedName: known.name,
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
          })
        );
        continue;
      }
      // Pas une erreur pour l'utilisateur : le raccourci a juste échoué, la
      // recherche normale parcnd le relais. Trace quand même, sinon un
      // permalien devenu systématiquement faux resterait invisible.
      debugLog('known_url_fallback', {
        product: product.name,
        reason: known?.ok ? 'name_mismatch' : (known?.code ?? 'page_unreadable'),
        ...(known?.ok ? { pageName: known.name, nameScore: Number(knownScore.toFixed(2)) } : {})
      });
    }

    // Point de sortie unique des fiches standalone : à partir d'ici, ce
    // produit va forcément passer par la zone de recherche du catalogue.
    if (tabIsOnProductPage) {
      const returned = await returnToLeclercSearchRoute({ scripting, tabId, signal, searchRouteUrl });
      // Si le retour a échoué, on laisse le drapeau levé : le produit suivant
      // retentera plutôt que de partir du principe que l'onglet est bon.
      tabIsOnProductPage = !returned;
    }

    // Régression silencieuse trouvée à l'audit du 02/09 : ces quatre drapeaux
    // comparaient `hintIndex` à 1/2/3/4, valeurs calées sur un
    // SEARCH_STAGE_ORDER qui commençait alors par 'ean' (name valait 1,
    // simplified_name 2, ...). Depuis le retrait de l'étage EAN mort, 'name'
    // vaut 0 : tout le mécanisme était décalé d'un cran et ne sautait donc
    // jamais l'étage qu'il était censé sauter — un produit dont l'étage
    // gagnant mémorisé était 'simplified_name' rejouait quand même 'name' à
    // chaque comparatif, et un 'brand_only' rejouait 'name_only'. Soit une
    // recherche entière perdue par produit et par comparatif, exactement ce
    // que la mémoire de recherche devait éviter. Comparaison désormais faite
    // sur la position réelle des étages, sans constante à resynchroniser si
    // la cascade change encore. Un hint inconnu (ancien 'ean' d'un profil
    // historique) donne -1 et laisse la cascade complète, comme avant.
    const hintStage = hintDisabledFor.has(product.productId) ? undefined : searchHints[product.productId];
    const hintIndex = hintStage ? SEARCH_STAGE_ORDER.indexOf(hintStage) : -1;
    const isStageAllowed = (stage) => hintIndex < 0 || SEARCH_STAGE_ORDER.indexOf(stage) >= hintIndex;
    const tryName = isStageAllowed('name');
    const trySimplified = isStageAllowed('simplified_name');
    const tryNameOnly = isStageAllowed('name_only');
    const tryBrandOnly = isStageAllowed('brand_only');
    // Étages déjà soumis pour CE produit, sous la forme exacte tapée dans le
    // champ de recherche. Mesuré sur le vrai site le 02/09
    // (tools/bench-leclerc-stages.mjs) : quand le nom Open Food Facts commence
    // déjà par la marque ("HERTA LE BON PARIS Jambon..."), l'étage 'name_only'
    // se réduit au premier mot significatif du nom — soit "HERTA", c'est-à-dire
    // MOT POUR MOT la requête de l'étage 'brand_only' joué juste après. Deux
    // recherches identiques à la suite, le second étage entièrement gaspillé
    // (5 à 15 s par produit concerné) pour un résultat déjà connu et déjà jugé
    // insuffisant. Rejouer une requête déjà envoyée ne peut rien apprendre de
    // neuf : on la saute.
    const attemptedQueries = new Set();
    // Enregistre ce QUE CET ÉTAGE A DEMANDÉ, recomposé localement à partir du
    // couple (nom, marque) envoyé — délibérément pas la `query` que la page
    // renvoie. Les deux doivent coïncider, mais mélanger les deux sources
    // rendrait la comparaison bancale : il suffirait que la page rende une
    // requête tronquée pour qu'un étage encore utile soit sauté à tort. Avec
    // une source unique, deux étages ne se confondent que s'ils partent
    // vraiment du même couple (nom, marque).
    const rememberQuery = (name, brand) => {
      const normalized = buildLeclercSubmittedQuery(name, brand).toLowerCase();
      if (normalized) attemptedQueries.add(normalized);
    };
    let matchStage = null;
    // Leclerc n'indexe pas les EAN comme texte : la cascade active commence
    // directement par le nom. Le code-barres extrait d'une carte reste en
    // revanche une preuve forte pour confirmer le candidat après recherche.
    onProgress({
      storeKey: store.storeKey,
      state: 'product_search',
      productIndex,
      productTotal: products.length,
      productName: product.name,
      searchStage: 'name'
    });
    try {
      let best = null;
      // Meilleur candidat trouvé dont la marque ne correspond PAS à celle
      // attendue (ex: Andros retenu alors que le produit est un Tropicana).
      // Sert uniquement de filet de secours si aucun étage de la cascade ne
      // trouve un candidat de la bonne marque — jamais utilisé tant qu'un
      // `best` valide existe. Voir needsLeclercBrandEscalation.
      let fallbackBest = null;
      let fallbackStage = null;
      let lastSearchDiag = null;
      let winningCandidates = [];
      // Cumul de TOUS les candidats vus à travers toute la cascade (name →
      // simplified_name → name_only → brand_only), contrairement à
      // `winningCandidates` qui est écrasé à chaque étage. Sans ça, un
      // quasi-match réellement visible à l'étage `name` (ex: une autre
      // marque de boisson au soja, score insuffisant pour être retenu comme
      // `best`) disparaît silencieusement si l'étage suivant tenté ne lit
      // aucune carte (recherche vide, lazy-load raté...) — l'utilisateur se
      // retrouve alors sans aucune alternative alors qu'il en existait une
      // sous les yeux du scraper un instant plus tôt.
      let allSeenCandidates = [];
      // Trace de CHAQUE étage tenté (pas seulement le dernier) : sans ceci,
      // un rapport final ne conserve que `lastSearchDiag` de l'étage où la
      // cascade s'est arrêtée, masquant totalement ce qui s'est passé à un
      // étage antérieur — impossible alors de distinguer "l'étage 'name' n'a
      // vu aucun candidat pertinent" de "l'étage 'name' avait déjà le bon
      // candidat sous les yeux mais l'a laissé passer" (signalé par
      // l'utilisateur sur un cas réel : Lipton Ice Tea visible dès la
      // première recherche, cascade poursuivie jusqu'à la marque seule).
      const stageAttempts = [];
      // minScore: -1 (au lieu du seuil par défaut 0.15 utilisé pour les
      // quasi-matchs affichés à l'utilisateur) — ce diagnostic doit toujours
      // révéler le meilleur candidat brut vu à cette étape, même à score nul,
      // sinon un cas comme "candidates trouvés mais tous à score ~0" reste
      // invisible dans l'export (cause exacte non identifiable sans ça,
      // confirmé sur 3 échecs du 30/08 où candidateCount>0 mais aucun
      // topMatchName n'apparaissait).
      const recordStageAttempt = (stage, candidates, timing) => {
        const top = findLeclercNearMissCandidates(product, candidates ?? [], 1, -1)[0];
        stageAttempts.push({
          stage,
          candidateCount: candidates?.length ?? 0,
          ...(top ? { topMatchName: top.name, topMatchScore: top.matchScore } : {}),
          ...(timing ? { timing } : {})
        });
      };
      // The transactional site used to be a classic .aspx catalog where a
      // direct recherche.aspx?TexteRecherche=... URL worked; it's now an
      // Angular SPA and that URL 404s internally (silent "page not found"
      // component, easy to mistake for bot-blocking). Always drive the real
      // on-page search input instead of guessing at a URL scheme.
      // Un produit à marque distributeur concurrente (ex: "Lait des
      // campagnes Carrefour") voit sa marque exclue de la requête dès cet
      // étage — même raison que pour l'étage brand_only plus bas
      // (hasRealLeclercBrand) : "Carrefour" dans la requête garantit un
      // "Aucun résultat" chez Leclerc, alors que le nom seul ("Lait des
      // campagnes") a une vraie chance de faire remonter un produit
      // comparable (ou au moins un quasi-match affiché en validation) — le
      // scoring reste fait contre le nom+marque ORIGINAL, seule la requête
      // envoyée au moteur de recherche change. Même raison pour
      // sanitizeLeclercSearchText (retrait du '%', voir sa définition) —
      // appliqué dès cet étage, pas seulement au repli 'simplified_name',
      // puisque c'est CET étage qui plantait en premier sur le nom brut.
      // Un nom Open Food Facts embarque fréquemment la marque telle quelle
      // ("Emmental râpé fondant PRESIDENT" + marque "Président") : l'ajouter
      // une seconde fois à la requête ne sert à rien — voir
      // dedupeBrandFromSearchName.
      const nameStageProductName = sanitizeLeclercSearchText(product.name);
      const nameStageProduct = {
        ...product,
        brand: hasRealLeclercBrand(product.brand)
          ? dedupeBrandFromSearchName(nameStageProductName, product.brand)
          : '',
        name: nameStageProductName
      };
      const search =
        best || !tryName
          ? null
          : await runPageActionWithTimeoutRetry(scripting, tabId, startProductSearchOnPage, [nameStageProduct], signal);
      if (!best && tryName && !search?.started) {
        errors.push({
          storeKey: store.storeKey,
          productId: product.productId,
          code: search?.code ?? 'PRODUCT_SEARCH_NOT_STARTED',
          ...(search?.details ? { details: search.details } : {})
        });
        continue;
      }
      if (!best && search) {
        rememberQuery(nameStageProduct.name, nameStageProduct.brand);
        debugLog('search_name_start', { product: product.name, query: search.query });
        const { candidates: nameCandidatesRaw, routeVerified: nameRouteVerified, diag: nameDiag } = await waitForProductCandidates({
          scripting,
          tabId,
          reader: readProductCandidatesOnPage,
          signal,
          expectedQuery: search.query,
          requireSearchRoute: true
          // No timeoutMs override: this is the real name-search path (not a
          // speculative dead-end try), so it needs the full 15s default —
          // confirmed via a real diagnostic export where the matching card
          // rendered a few hundred ms after this tier had already given up
          // at the old 10s cutoff.
        });
        const candidates = applyStaleReadGuard(nameCandidatesRaw, nameRouteVerified);
        const nameStageBest = chooseLeclercProductCandidate(product, candidates ?? []);
        recordStageAttempt('name', candidates, nameDiag);
        debugLog('search_name_done', { product: product.name, found: !!nameStageBest, candidateCount: candidates?.length ?? 0 });
        if (nameStageBest && needsLeclercBrandEscalation(product, nameStageBest)) {
          if (!fallbackBest) {
            fallbackBest = nameStageBest;
            fallbackStage = 'name';
          }
        } else if (nameStageBest) {
          best = nameStageBest;
          matchStage = 'name';
        }
        lastSearchDiag = { ...search.diag, routeVerified: nameRouteVerified };
        winningCandidates = candidates ?? [];
        allSeenCandidates = allSeenCandidates.concat(winningCandidates);
      }
      if (!best && trySimplified) {
        // Product names sourced from Open Food Facts often carry packaging
        // noise ("6x74g", "en sachet 5x 2 personnes", "30%MG") that Leclerc's
        // own search doesn't tokenize the same way, returning zero results
        // for an otherwise real product. One retry with that noise stripped
        // recovers a meaningful share of these without ever touching the
        // matching logic itself (still scored against the ORIGINAL name).
        const simplifiedName = sanitizeLeclercSearchText(simplifyLeclercSearchQuery(product.name));
        const simplifiedBrand = hasRealLeclercBrand(product.brand)
          ? dedupeBrandFromSearchName(simplifiedName, product.brand)
          : '';
        if (
          simplifiedName &&
          simplifiedName.toLowerCase() !== product.name.trim().toLowerCase() &&
          !attemptedQueries.has(buildLeclercSubmittedQuery(simplifiedName, simplifiedBrand).toLowerCase())
        ) {
          onProgress({
            storeKey: store.storeKey,
            state: 'product_search',
            productIndex,
            productTotal: products.length,
            productName: product.name,
            searchStage: 'simplified_name'
          });
          const retrySearch = await runPageActionWithTimeoutRetry(
            scripting,
            tabId,
            startProductSearchOnPage,
            [
              {
                ...product,
                name: simplifiedName,
                // Même exclusion de marque concurrente qu'à l'étage 'name' —
                // sinon la 2e chance offerte par le nom simplifié brûle son
                // essai sur la même requête vouée à zéro résultat — et même
                // dédoublonnage marque/nom qu'à l'étage 'name'.
                brand: simplifiedBrand
              }
            ],
            signal
          );
          if (retrySearch?.started) {
            rememberQuery(simplifiedName, simplifiedBrand);
            const { candidates: retryCandidatesRaw, routeVerified: retryRouteVerified, diag: retryDiag } = await waitForProductCandidates({
              scripting,
              tabId,
              reader: readProductCandidatesOnPage,
              signal,
              expectedQuery: retrySearch.query,
              requireSearchRoute: true
            });
            const retryCandidates = applyStaleReadGuard(retryCandidatesRaw, retryRouteVerified);
            const simplifiedStageBest = chooseLeclercProductCandidate(product, retryCandidates ?? []);
            recordStageAttempt('simplified_name', retryCandidates, retryDiag);
            if (simplifiedStageBest && needsLeclercBrandEscalation(product, simplifiedStageBest)) {
              if (!fallbackBest) {
                fallbackBest = simplifiedStageBest;
                fallbackStage = 'simplified_name';
              }
            } else if (simplifiedStageBest) {
              best = simplifiedStageBest;
              matchStage = 'simplified_name';
            }
            lastSearchDiag = { ...retrySearch.diag, routeVerified: retryRouteVerified };
            winningCandidates = retryCandidates ?? [];
            allSeenCandidates = allSeenCandidates.concat(winningCandidates);
          }
        }
      }
      if (!best && tryNameOnly) {
        // Bug réel confirmé par diagnostic (30/08, "Emmental râpé
        // PRÉSIDENT") : le moteur de recherche Leclerc applique un ET
        // strict sur tous les mots de la requête — une requête nom+marque
        // échoue à 0 résultat dès que CETTE combinaison exacte n'existe pas
        // au catalogue du magasin visé, même quand un équivalent générique
        // du même produit existe sous un nom proche ("Emmental râpé" seul :
        // 17 résultats plausibles réels ; avec "PRÉSIDENT" ajouté : 0
        // résultat). Les étages précédents ('name', 'simplified_name')
        // incluent pourtant la marque dès qu'elle est réelle et non déjà
        // présente dans le nom (hasRealLeclercBrand + dedupeBrandFromSearchName) —
        // cet étage reprend le nom déjà simplifié (ou l'original, sanitizé)
        // SANS aucune marque, pour n'importe quel produit dont la marque a
        // effectivement été ajoutée à la requête, pas seulement les cas vus
        // en diagnostic. Le scoring final reste fait contre le nom+marque
        // ORIGINAL du produit (chooseLeclercProductCandidate) : cet étage ne
        // change que la requête envoyée au moteur de recherche, jamais le
        // critère d'acceptation d'un candidat.
        //
        // Second cas, sans marque du tout (bug réel confirmé 30/08, "Mousse
        // aux fruits" : marque distributeur concurrente déjà exclue dès
        // l'étage 'name' — voir hasRealLeclercBrand — donc AUCUN repli
        // n'était jamais tenté ensuite : cascade réduite à un seul essai,
        // échec sec dès que le seul résultat trouvé est en rupture de stock
        // alors qu'une alternative disponible existe peut-être sous un nom
        // proche). On retente alors avec le parcmier mot-clé significatif du
        // nom (hors mots vides et quantités — extractLeclercCoreKeyword),
        // une requête plus large qu'aucun étage précédent n'a essayée.
        // Toujours scoré contre le nom+marque ORIGINAL, jamais accepté sur
        // la seule base de ce mot-clé large.
        const hasBrandForNameOnly = Boolean(nameStageProduct.brand);
        const nameOnlyText = hasBrandForNameOnly
          ? sanitizeLeclercSearchText(simplifyLeclercSearchQuery(product.name)) || nameStageProductName
          : extractLeclercCoreKeyword(nameStageProductName);
        // Sans marque, ne retente que si cette requête diffère réellement de
        // celle déjà envoyée à l'étage 'name' — sinon appel redondant inutile
        // (et signal anti-bot superflu) pour un résultat déjà connu.
        const isRedundantCoreKeyword =
          !hasBrandForNameOnly &&
          (!nameOnlyText || nameOnlyText.toLowerCase() === nameStageProductName.trim().toLowerCase());
        if (
          nameOnlyText &&
          !isRedundantCoreKeyword &&
          !attemptedQueries.has(buildLeclercSubmittedQuery(nameOnlyText, '').toLowerCase())
        ) {
          onProgress({
            storeKey: store.storeKey,
            state: 'product_search',
            productIndex,
            productTotal: products.length,
            productName: product.name,
            searchStage: 'name_only'
          });
          const nameOnlySearch = await runPageActionWithTimeoutRetry(
            scripting,
            tabId,
            startProductSearchOnPage,
            [{ ...product, name: nameOnlyText, brand: '' }],
            signal
          );
          if (nameOnlySearch?.started) {
            rememberQuery(nameOnlyText, '');
            const { candidates: nameOnlyCandidatesRaw, routeVerified: nameOnlyRouteVerified, diag: nameOnlyDiag } = await waitForProductCandidates({
              scripting,
              tabId,
              reader: readProductCandidatesOnPage,
              signal,
              expectedQuery: nameOnlySearch.query,
              requireSearchRoute: true
            });
            const nameOnlyCandidates = applyStaleReadGuard(nameOnlyCandidatesRaw, nameOnlyRouteVerified);
            const nameOnlyStageBest = chooseLeclercProductCandidate(product, nameOnlyCandidates ?? []);
            recordStageAttempt('name_only', nameOnlyCandidates, nameOnlyDiag);
            if (nameOnlyStageBest && needsLeclercBrandEscalation(product, nameOnlyStageBest)) {
              if (!fallbackBest) {
                fallbackBest = nameOnlyStageBest;
                fallbackStage = 'name_only';
              }
            } else if (nameOnlyStageBest) {
              best = nameOnlyStageBest;
              matchStage = 'name_only';
            }
            lastSearchDiag = { ...nameOnlySearch.diag, routeVerified: nameOnlyRouteVerified };
            winningCandidates = nameOnlyCandidates ?? [];
            allSeenCandidates = allSeenCandidates.concat(winningCandidates);
          }
        }
      }
      const brandOnlyText = sanitizeLeclercSearchText(simplifyLeclercBrandQuery(product.brand));
      if (
        !best &&
        tryBrandOnly &&
        hasRealLeclercBrand(product.brand) &&
        !attemptedQueries.has(buildLeclercSubmittedQuery(brandOnlyText, '').toLowerCase())
      ) {
        // A verbose, fully descriptive query sometimes makes Leclerc's own
        // fuzzy search surface an entirely different family of products
        // instead of the exact one (confirmed against real fiche-produit
        // pages that DO exist for the store: the item is genuinely in stock,
        // Leclerc's search just never returned it for the longer query).
        // A brand-only query is blunter but much more likely to include the
        // real product among its results — the existing scoring against the
        // full original product name/brand still guards against a wrong pick.
        onProgress({
          storeKey: store.storeKey,
          state: 'product_search',
          productIndex,
          productTotal: products.length,
          productName: product.name,
          searchStage: 'brand_only'
        });
        const brandOnlySearch = await runPageActionWithTimeoutRetry(
          scripting,
          tabId,
          startProductSearchOnPage,
          [{ ...product, name: brandOnlyText, brand: '' }],
          signal
        );
        if (brandOnlySearch?.started) {
          const { candidates: brandOnlyCandidatesRaw, routeVerified: brandOnlyRouteVerified, diag: brandOnlyDiag } = await waitForProductCandidates({
            scripting,
            tabId,
            reader: readProductCandidatesOnPage,
            signal,
            expectedQuery: brandOnlySearch.query,
            requireSearchRoute: true
          });
          const brandOnlyCandidates = applyStaleReadGuard(brandOnlyCandidatesRaw, brandOnlyRouteVerified);
          const brandOnlyStageBest = chooseLeclercProductCandidate(product, brandOnlyCandidates ?? []);
          recordStageAttempt('brand_only', brandOnlyCandidates, brandOnlyDiag);
          if (brandOnlyStageBest && needsLeclercBrandEscalation(product, brandOnlyStageBest)) {
            if (!fallbackBest) {
              fallbackBest = brandOnlyStageBest;
              fallbackStage = 'brand_only';
            }
          } else if (brandOnlyStageBest) {
            best = brandOnlyStageBest;
            matchStage = 'brand_only';
          }
          lastSearchDiag = { ...brandOnlySearch.diag, routeVerified: brandOnlyRouteVerified };
          winningCandidates = brandOnlyCandidates ?? [];
          allSeenCandidates = allSeenCandidates.concat(winningCandidates);
        }
      }
      // Aucun candidat de la bonne marque trouvé après toute la cascade :
      // on retombe alors, en dernier recours seulement, sur le meilleur
      // candidat d'une autre marque repéré en cours de route (ex: Andros
      // pour un Tropicana introuvable dans ce format) plutôt que de
      // déclarer le produit introuvable.
      if (!best && fallbackBest) {
        best = fallbackBest;
        matchStage = fallbackStage;
      }
      if (!best) {
        const details = await inspectProductResults(scripting, tabId, inspectLeclercResultsOnPage);
        // Un captcha bloque TOUTE recherche sur ce tab, pas seulement ce
        // produit — continuer à chercher les produits suivants ne ferait
        // que multiplier les PRODUCT_NOT_FOUND et prolonger l'exposition au
        // système anti-bot pour rien. Remonter l'échec immédiatement laisse
        // le job-runner classer l'erreur, éviter un retry inutile dans ce
        // job, et alimenter le circuit breaker pour laisser le magasin se
        // reposer avant le prochain essai.
        if (details?.hasCaptcha) {
          throw new Error('CAPTCHA_DETECTED');
        }
        // Filet de sécurité du saut d'étages (02/09) : le hint de mémoire de
        // recherche a fait démarrer la cascade plus loin que 'name', et aucun
        // des étages restants n'a rien trouvé. Avant de déclarer le produit
        // introuvable, on le rejoue UNE fois avec la cascade complète. Sans
        // ce filet, un étage gagnant devenu obsolète (catalogue du magasin
        // modifié entre deux comparatifs) transformerait en PRODUCT_NOT_FOUND
        // un produit qu'un étage antérieur retrouvait encore — puis en « non
        // trouvé » mémorisé 14 jours côté PWA, donc en produit purement et
        // simplement sauté aux comparatifs suivants. Même motif de rejeu que
        // celui des SCRIPT_EXECUTION_TIMEOUT plus bas, et payé uniquement
        // dans ce cas d'échec : un hint qui fonctionne ne coûte jamais rien.
        if (hintIndex > 0 && !hintDisabledFor.has(product.productId)) {
          hintDisabledFor.add(product.productId);
          debugLog('search_hint_fallback', { product: product.name, hintStage });
          productIndex -= 1;
          productCursor -= 1;
          continue;
        }
        // Aucun candidat n'a franchi le seuil d'acceptation, mais la
        // dernière recherche tentée a peut-être quand même lu des cartes
        // proches (mauvaise marque, format très différent, faute de frappe
        // dans le nom Open Food Facts...). Les remonter permet à
        // l'utilisateur de choisir manuellement plutôt que de se retrouver
        // sans aucune piste sur un produit réellement en rayon.
        // Déduplication par productUrl : la même carte peut avoir été lue à
        // plusieurs étages de la cascade (ex: présente aussi bien au tri
        // 'name' qu'au tri 'simplified_name'), son score serait identique
        // aux deux endroits — inutile de la laisser apparaître deux fois
        // dans le top des quasi-matchs proposés à l'utilisateur.
        const dedupedSeenCandidates = [
          ...new Map(allSeenCandidates.map((candidate) => [candidate?.productUrl, candidate])).values()
        ];
        const nearMisses = findLeclercNearMissCandidates(product, dedupedSeenCandidates);
        errors.push({
          storeKey: store.storeKey,
          productId: product.productId,
          code: 'PRODUCT_NOT_FOUND',
          details: {
            ...details,
            searchDiag: lastSearchDiag,
            stageAttempts,
            ...(nearMisses.length > 0 ? { nearMisses } : {})
          }
        });
        continue;
      }
      const alternates = findLeclercAlternateCandidates(product, winningCandidates, best);
      observations.push(
        validateDriveObservation({
          protocolVersion: 1,
          jobId: job.jobId,
          productId: product.productId,
          storeKey: 'leclerc',
          localStoreId: store.localStoreId,
          externalStoreId: best.externalStoreId || store.localStoreId,
          ...(best.externalProductId ? { externalProductId: best.externalProductId } : {}),
          observedName: best.name,
          ...(best.brand ? { observedBrand: best.brand } : {}),
          ...(best.barcode ? { observedBarcode: best.barcode } : {}),
          ...(best.observedQuantity !== undefined ? { observedQuantity: best.observedQuantity } : {}),
          ...(best.observedUnit ? { observedUnit: best.observedUnit } : {}),
          matchScore: best.matchScore,
          priceEuro: best.priceEuro,
          ...(best.unitPriceEuro !== undefined ? { unitPriceEuro: best.unitPriceEuro } : {}),
          ...(best.unitPriceUnit ? { unitPriceUnit: best.unitPriceUnit } : {}),
          available: best.available !== false,
          ...(best.promotionLabel ? { promotionLabel: best.promotionLabel } : {}),
          productUrl: best.productUrl,
          observedAt: new Date().toISOString(),
          evidence: 'official_drive_page',
          ...(matchStage ? { matchStage } : {}),
          // Exporté même sur un succès (pas seulement dans errors.details
          // pour PRODUCT_NOT_FOUND) — sinon aucune preuve exploitable ne
          // reste pour un produit trouvé après plusieurs étages de la
          // cascade (cf. commentaire sur `stageAttempts` plus haut).
          ...(stageAttempts.length > 0 ? { stageAttempts } : {}),
          ...(alternates.length > 0
            ? {
                alternates: alternates.map((alternate) => ({
                  ...(alternate.externalProductId ? { externalProductId: alternate.externalProductId } : {}),
                  observedName: alternate.name,
                  ...(alternate.brand ? { observedBrand: alternate.brand } : {}),
                  ...(alternate.barcode ? { observedBarcode: alternate.barcode } : {}),
                  matchScore: alternate.matchScore,
                  priceEuro: alternate.priceEuro,
                  ...(alternate.unitPriceEuro !== undefined ? { unitPriceEuro: alternate.unitPriceEuro } : {}),
                  ...(alternate.unitPriceUnit ? { unitPriceUnit: alternate.unitPriceUnit } : {}),
                  ...(alternate.observedQuantity !== undefined ? { observedQuantity: alternate.observedQuantity } : {}),
                  ...(alternate.observedUnit ? { observedUnit: alternate.observedUnit } : {}),
                  productUrl: alternate.productUrl,
                  ...(alternate.quantityDiffers ? { quantityDiffers: true } : {})
                }))
              }
            : {})
        })
      );
    } catch (error) {
      // CAPTCHA_DETECTED (thrown deliberately above) must abort the whole
      // store collection, not just this one product — a generic catch-all
      // here would swallow it into a per-product PRODUCT_SEARCH_FAILED and
      // let the loop keep hammering a page that's actively blocking it.
      if (error instanceof Error && error.message === 'CAPTCHA_DETECTED') {
        error.partialObservations = observations;
        error.partialErrors = errors;
        throw error;
      }
      // SCRIPT_EXECUTION_TIMEOUT — un unique appel injecté qui ne répond pas
      // en 10s. Jusqu'ici traité EXACTEMENT comme CAPTCHA_DETECTED (abandon
      // de tout le magasin), sur l'hypothèse qu'un appel figé signifie
      // l'onglet entier mort/déchargé. Diagnostic réel (29/08, 3 exports
      // consécutifs) : ce timeout frappe systématiquement le TOUT PREMIER
      // produit ("phase": "product_search", productIndex 1), alors même que
      // le magasin Hyper U tourne sans souci dans l'autre onglet au même
      // moment — rien n'indique que CET onglet Leclerc soit réellement mort,
      // plutôt un blocage ponctuel (site lent, micro-vérification DataDome)
      // sur cette seule requête. L'ancien comportement perdait alors TOUS les
      // produits suivants pour un seul accroc — signalé par l'utilisateur
      // comme "la plupart des produits ne sont pas trouvés chez Leclerc".
      // Sonde rapide (budget réduit : on veut juste un oui/non, pas la pleine
      // fenêtre de 10s) : si l'onglet répond encore normalement, ce n'est
      // qu'UN produit à sauter, pas tout le magasin à abandonner — seul un
      // onglet qui ne répond PAS non plus à cette sonde confirme un vrai
      // blocage global et justifie encore l'abandon complet.
      if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') {
        const health = await probeLeclercTab({ scripting, tabId, timeoutMs: 5_000 }).catch(() => null);
        if (health && health.state !== 'blocked') {
          // L'onglet répond encore : cet appel figé est un accroc ponctuel
          // (site lent, micro-vérification DataDome), pas une raison de
          // perdre le produit. On le rejoue une fois avant de le déclarer en
          // échec — sans ce rejeu, un unique hoquet de 10s condamnait le
          // produit alors que la sonde venait de confirmer un onglet sain.
          const retriesLeft = timeoutRetriesLeft.get(product.productId) ?? PRODUCT_TIMEOUT_RETRIES;
          if (retriesLeft > 0) {
            timeoutRetriesLeft.set(product.productId, retriesLeft - 1);
            debugLog('product_search_timeout_retry', { product: product.name, retriesLeft });
            // productIndex sert uniquement à la progression affichée : le
            // rejeu ne doit pas la faire avancer deux fois.
            productIndex -= 1;
            productCursor -= 1;
            continue;
          }
          errors.push({
            storeKey: store.storeKey,
            productId: product.productId,
            code: 'PRODUCT_SEARCH_TIMEOUT'
          });
          continue;
        }
        // Les produits déjà trouvés avant ce blocage ne doivent pas
        // disparaître silencieusement : job-runner les récupère via ces
        // champs et les garde SEULEMENT s'il n'y a plus de nouvelle
        // tentative derrière (sinon un retry sur onglet neuf les
        // redemanderait et dupliquerait l'observation).
        error.partialObservations = observations;
        error.partialErrors = errors;
        // Même logique que le marquage `phase` du prologue (voir
        // ensureLeclercCatalogReady) : sans ceci, un timeout ici ressort
        // identique à un timeout dans le prologue dans le diagnostic exporté,
        // alors que l'un a des observations partielles et l'autre non.
        if (!error.details) {
          error.details = { phase: 'product_search', productIndex, productName: product.name };
        }
        throw error;
      }
      errors.push({ storeKey: store.storeKey, productId: product.productId, code: 'PRODUCT_SEARCH_FAILED' });
    }
  }
  return { observations, errors };
}

// Correction manuelle "en direct" : Leclerc n'a pas d'URL produit stable à
// coller (voir le commentaire sur le repli `href` de
// readProductCandidatesOnPage plus bas) — la seule façon fiable de laisser
// l'utilisateur corriger un mauvais match est de lui laisser l'onglet et de
// le laisser taper directement sur le bon produit. Réutilise le même
// prologue que collectLeclercStore, lance la recherche en best-effort (pour
// préremplir la page de résultats si elle fonctionne) sans jamais bloquer
// dessus — sinon un simple "0 résultat" empêcherait ce chemin de correction
// de servir précisément là où il est le plus utile. L'utilisateur peut
// ensuite se balader librement dans l'onglet (nouvelle recherche, catégories,
// fiche produit) : un bouton flottant "✓ Valider ce produit" apparaît
// uniquement une fois arrivé sur la fiche produit précise (jamais sur la
// grille de résultats — voir le garde-fou de page dans
// armLeclercFloatingPickButtonOnPage plus bas), pour éviter tout risque de
// valider le mauvais produit depuis une liste.
export async function livePickLeclercProduct({
  scripting,
  tabs,
  tabId,
  job,
  store,
  products,
  signal,
  farmStore = null,
  onProgress = () => undefined
}) {
  const [product] = products;
  const prologue = await ensureLeclercCatalogReady({ scripting, tabId, store, signal, farmStore });
  if (!prologue.ready) return failed(store, prologue.code, prologue.details, true);

  // Aucune recherche automatique : `ensureLeclercCatalogReady` a déjà amené
  // l'onglet sur l'accueil catalogue du bon magasin (Drive officiel
  // préenregistré) — l'utilisateur navigue ensuite entièrement librement
  // (recherche tapée à la main, catégories, fiche produit). Ancien
  // comportement : une recherche auto pré-remplissait la page, ce qui
  // pouvait bloquer sur "aucun produit trouvé" et empêcher justement la
  // correction manuelle dans ce cas précis. waitForLeclercPick réarme les
  // boutons de sélection (par carte + flottant) à chaque cycle, quelle que
  // soit la page affichée.
  // job.startUrl (retour explicite du 31/08) : un candidat est déjà connu
  // (lien "Voir le produit" du détail par magasin) — mieux vaut y amener
  // l'onglet plutôt que l'accueil vide, l'utilisateur repart alors des
  // résultats déjà pertinents plutôt que de retaper sa recherche. Best-effort
  // (navigateToLeclercUrlOnPage refuse tout ce qui n'est pas
  // *.leclercdrive.fr) : un échec ne bloque jamais ce chemin, l'utilisateur
  // garde l'accueil catalogue comme point de départ.
  if (job.startUrl) {
    const navigation = await runPageAction(scripting, tabId, navigateToLeclercUrlOnPage, [job.startUrl]);
    if (navigation?.started) await wait(600, signal);
  }
  onProgress({
    storeKey: store.storeKey,
    state: 'awaiting_pick',
    productIndex: 1,
    productTotal: 1,
    productName: product.name
  });
  const pick = await waitForLeclercPick({ scripting, tabs, tabId, signal, onProgress, store, product });
  if (!pick) {
    return {
      observations: [],
      errors: [{ storeKey: store.storeKey, productId: product.productId, code: 'PICK_TIMEOUT' }],
      // Onglet laissé ouvert : l'utilisateur était peut-être encore en train
      // de regarder / sur le point de taper au moment du timeout.
      keepTabOpen: true
    };
  }

  return {
    observations: [
      validateDriveObservation({
        protocolVersion: 1,
        jobId: job.jobId,
        productId: product.productId,
        storeKey: 'leclerc',
        localStoreId: store.localStoreId,
        externalStoreId: store.localStoreId,
        observedName: pick.name,
        matchScore: 1,
        priceEuro: pick.priceEuro,
        ...(pick.unitPriceEuro !== undefined
          ? { unitPriceEuro: pick.unitPriceEuro, unitPriceUnit: pick.unitPriceUnit }
          : {}),
        available: true,
        productUrl: pick.productUrl,
        observedAt: new Date().toISOString(),
        evidence: 'official_drive_page',
        matchStage: 'manual'
      })
    ],
    errors: [],
    keepTabOpen: false
  };
}

// Bouton flottant unique (position:fixed, bottom-right), seul mécanisme de
// pick manuel. Ne s'affiche QUE sur une vraie fiche produit standalone
// ("/fiche-produits-<id>-<slug>.aspx"), jamais sur une page de résultats de
// recherche/catégorie. Avant ce garde-fou, un bouton "✓ C'est celui-ci" était
// en plus injecté sur CHAQUE carte de la grille de résultats (une fonction
// séparée, supprimée ici) : signalé par l'utilisateur comme trompeur ("il y
// en a plein sur toutes les pages, à tous les produits") et risqué — le
// bouton flottant lui-même, non gardé, aurait pu silencieusement lire le
// premier produit de la grille (querySelector prend le parcmier élément
// trouvé) au lieu du produit réellement voulu si l'utilisateur cliquait
// dessus par erreur depuis une page de liste. Réarmé à chaque cycle de 500ms
// par waitForLeclercPick, donc apparaît/disparaît automatiquement en suivant
// la navigation réelle de l'utilisateur (recherche → fiche produit → retour).
export function armLeclercFloatingPickButtonOnPage() {
  const ID = 'drive-price-splitter-float-pick';
  const isProductDetailPage = /\/fiche-produits?-/i.test(location.pathname);
  if (!isProductDetailPage) {
    document.getElementById(ID)?.remove();
    return;
  }
  // ⚠️ Doit rester imbriquée ICI (pas une fonction séparée du module) :
  // scripting.executeScript sérialise uniquement le code de la fonction
  // passée à `func` (son toString()) et l'exécute dans le monde de la page —
  // toute fonction du module référencée par NOM depuis l'extérieur de ce
  // corps n'existe pas dans ce contexte et lève un ReferenceError silencieux
  // au moment du clic (aucune closure externe capturée, voir le commentaire
  // sur runPageAction plus haut).
  function readGenericLeclercProductOnPage() {
    // Une fiche produit Leclerc porte DEUX <h1> : celui du bandeau de
    // navigation (.pWCSD347_Titre, "Purée Mousline") et le vrai titre du
    // produit (.titre-fiche, "Purée Mousline x3 - 375g"). Le bandeau vient en
    // premier dans le DOM, et querySelector avec une liste de sélecteurs rend
    // le parcmier ÉLÉMENT du document correspondant à l'un d'eux — pas le
    // premier sélecteur de la liste : réordonner la liste ne changerait donc
    // rien, il faut des appels successifs.
    //
    // Le nom retenu était par conséquent amputé de son grammage, sur tous les
    // produits passés par la fiche (URL manuelle, sélection en direct). Or le
    // format vient de parseQuantityFromName(nom) : sans grammage, pas de
    // format, donc ni comparaison de format entre magasins ni contrôle croisé
    // prix / prix au litre. Cas relevé le 31/08 : une purée Leclerc 375 g à
    // 2,56 € (6,83 €/kg) comparée telle quelle à un lot Hyper U de 1 040 g à
    // 4,56 € (4,39 €/kg) — l'application désignait Leclerc comme moins cher
    // alors que c'était l'inverse.
    const heading =
      document.querySelector('.titre-fiche') ||
      document.querySelector('[itemprop="name"]') ||
      document.querySelector('.pWCRS310_Desc, .vignette-descriptif') ||
      document.querySelector('h1');
    const nameText = heading?.textContent?.trim();
    if (!nameText) return null;

    const unitPriceElement = [...document.querySelectorAll('[class*="prix" i]')]
      .find((element) => !element.closest('.crossell') && /€?\s*\/\s*(l|kg|cl|g)\b/i.test(element.textContent || ''));
    const unitPriceMatch = unitPriceElement?.textContent?.match(/(\d{1,4})[,.]\s*(\d{1,2})\s*€?\s*\/\s*(l|kg|cl|g)\b/i);
    const unitPriceRaw = unitPriceMatch ? Number(`${unitPriceMatch[1]}.${unitPriceMatch[2].padEnd(2, '0')}`) : NaN;
    const unitPriceSuffix = unitPriceMatch?.[3]?.toLowerCase();
    const unitPriceEuro =
      Number.isFinite(unitPriceRaw) && unitPriceSuffix
        ? unitPriceRaw * (unitPriceSuffix === 'cl' ? 100 : unitPriceSuffix === 'g' ? 1000 : 1)
        : undefined;
    const unitPriceDetails =
      unitPriceEuro !== undefined
        ? { unitPriceEuro, unitPriceUnit: unitPriceSuffix === 'l' || unitPriceSuffix === 'cl' ? 'L' : 'kg' }
        : {};

    // Prix total de l'article : mêmes paliers que readProductCandidatesOnPage
    // (régression réelle 2026-08-27, même bug que sur Hyper U signalé par
    // l'utilisateur — prix au litre/kg retenu au lieu du prix de l'article).
    // L'ancien scan large `[class*="prix"]` pris dans l'ordre du DOM tombait
    // en premier sur pWCRS310_PrixUniteMesure ("1,05 € / l") avant le prix
    // total, éclaté sur 3 éléments distincts (partie entière / € / décimale)
    // qui ne matchent pas seuls le regex — vérifié en direct sur une vraie
    // fiche produit leclercdrive.fr le 2026-08-27.
    // Palier 1 : balise schema.org, si présente.
    const itemPropPrice = document.querySelector('[itemprop="price"]');
    const itemPropText = itemPropPrice?.getAttribute('content') || itemPropPrice?.textContent || '';
    const itemPropMatch = itemPropText.match(/(\d{1,4})[,.]\s*(\d{2})/);
    if (itemPropMatch) {
      return {
         name: nameText.slice(0, 500),
         priceEuro: Number(`${itemPropMatch[1]}.${itemPropMatch[2]}`),
         ...unitPriceDetails,
         productUrl: location.href
      };
    }
    // Palier 2 : .vignette-prix (template Angular 16).
    const vignetteText = document.querySelector('.vignette-prix-ajout .vignette-prix p, .vignette-prix p')?.textContent || '';
    const vignetteMatch = vignetteText.match(/(\d{1,4})[,.]\s*(\d{2})/);
    if (vignetteMatch) {
      return {
         name: nameText.slice(0, 500),
         priceEuro: Number(`${vignetteMatch[1]}.${vignetteMatch[2]}`),
         ...unitPriceDetails,
         productUrl: location.href
      };
    }
    // Palier 3 : fiche produit standalone du template classique
    // (.prix-actuel-partie-entiere / .prix-actuel-partie-decimale), distinct
    // de .prix-reduction / .prix-detail (prix au litre/kg, ex. "0,99 € / l").
    // Régression réelle 2026-08-27 (bug signalé par l'utilisateur, lait
    // Délisse affiché à 5,94€ mais capturé à 4,65€) : une vraie fiche produit
    // standalone (URL /fiche-produits-*.aspx) contient un carrousel "produits
    // de substitution" (#ulCrossell.crossell-produits) juste en dessous, dont
    // CHAQUE carte réutilise les classes pWCRS310_PrixUnitairePartieEntiere/
    // Decimale du palier suivant — un document.querySelector large tombait
    // alors sur le parcmier substitut au lieu du produit principal (qui, sur
    // ce gabarit-là, n'utilise jamais ces classes) — vérifié en direct sur
    // une vraie fiche produit leclercdrive.fr le 2026-08-27.
    const standaloneIntegerPart = document
      .querySelector('.prix-actuel-partie-entiere')
      ?.textContent?.match(/\d{1,4}/)?.[0];
    const standaloneDecimalPart = document
      .querySelector('.prix-actuel-partie-decimale')
      ?.textContent?.match(/\d{2}/)?.[0];
    if (/^\d{1,4}$/.test(standaloneIntegerPart || '') && /^\d{2}$/.test(standaloneDecimalPart || '')) {
      return {
         name: nameText.slice(0, 500),
         priceEuro: Number(`${standaloneIntegerPart}.${standaloneDecimalPart}`),
         ...unitPriceDetails,
         productUrl: location.href
      };
    }
    // Palier 4 : partie entière + partie décimale du template classique
    // (pWCRS310_*, cartes de listing/recherche), distinct de
    // pWCRS310_PrixUniteMesure (prix au litre/kg). Exclut explicitement le
    // carrousel de substituts (voir palier 3 ci-dessus) : sur une fiche
    // produit standalone, ces classes n'existent QUE dans ce carrousel.
    const integerPart = [...document.querySelectorAll('.pWCRS310_PrixUnitairePartieEntiere')]
      .find((element) => !element.closest('.crossell'))
      ?.textContent?.match(/\d{1,4}/)?.[0];
    const decimalPart = [...document.querySelectorAll('.pWCRS310_PrixUnitairePartieDecimale')]
      .find((element) => !element.closest('.crossell'))
      ?.textContent?.match(/\d{2}/)?.[0];
    if (/^\d{1,4}$/.test(integerPart || '') && /^\d{2}$/.test(decimalPart || '')) {
      return {
         name: nameText.slice(0, 500),
         priceEuro: Number(`${integerPart}.${decimalPart}`),
         ...unitPriceDetails,
         productUrl: location.href
      };
    }
    // Palier 5, dernier recours : scan large [class*="prix"], en excluant
    // explicitement tout élément de prix au litre/kg (classe "UniteMesure" ou
    // texte suffixé "/L" ou "/kg") et tout élément du carrousel de substituts
    // (même risque de faux positif que le palier 4 ci-dessus).
    const priceElements = [...document.querySelectorAll('[class*="prix" i]')];
    for (const element of priceElements) {
      if (/unitemesure/i.test(element.className || '')) continue;
      if (element.closest('.crossell')) continue;
      const text = element.getAttribute('content') || element.textContent || '';
      if (/\/\s*(l|kg)\b/i.test(text)) continue;
      const priceMatch = text.match(/(\d{1,4})[,.]\s*(\d{2})/);
      if (!priceMatch) continue;
      const price = Number(`${priceMatch[1]}.${priceMatch[2]}`);
      if (Number.isFinite(price)) {
        return { name: nameText.slice(0, 500), priceEuro: price, ...unitPriceDetails, productUrl: location.href };
      }
    }
    return null;
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
    const result = readGenericLeclercProductOnPage();
    if (!result) {
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

// Retire le bouton flottant injecté par armLeclercFloatingPickButtonOnPage —
// appelé une fois le choix récupéré (succès ou timeout) pour ne pas laisser
// la page polluée par un bouton devenu inerte si l'onglet reste ouvert.
function disarmLeclercPickButtonsOnPage() {
  document.getElementById('drive-price-splitter-float-pick')?.remove();
}

function readLeclercPickOnPage() {
  return window.__drivePriceSplitterPick ?? null;
}

// Sonde toutes les 500ms (même cadence que waitForProductCandidates) : ré-arme
// le bouton flottant à chaque passage (apparaît/disparaît en suivant la
// navigation réelle — voir le garde-fou de page dans
// armLeclercFloatingPickButtonOnPage) et vérifie si l'utilisateur a cliqué
// dessus. 4 minutes de délai — nettement plus long que les recherches
// automatiques : il s'agit ici d'attendre un humain qui doit regarder son
// téléphone et choisir, pas une page qui charge.
async function waitForLeclercPick({ scripting, tabs, tabId, signal, onProgress, store, product, timeoutMs = 4 * 60 * 1_000 }) {
  const deadline = Date.now() + timeoutMs;
  let tick = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      await runPageAction(scripting, tabId, armLeclercFloatingPickButtonOnPage, []);
      const pick = await runPageAction(scripting, tabId, readLeclercPickOnPage, []);
      if (pick && Number.isFinite(pick.priceEuro)) {
        await runPageAction(scripting, tabId, disarmLeclercPickButtonsOnPage, []);
        return pick;
      }
    } catch {
      // Contexte injecté temporairement invalide (navigation en cours) —
      // sans incidence dans le cas normal, le prochain cycle réessaiera.
      // Mais si l'utilisateur a carrément FERMÉ l'onglet, ce même catch
      // avalait l'échec en silence et continuait de sonder pendant les 4
      // minutes complètes — l'app restait affichée "en attente sur la page
      // Leclerc" et, le runner de pick manuel étant partagé entre les deux
      // magasins (voir livePickRunner dans service-worker.js), personne ne
      // pouvait valider un produit chez l'autre magasin tant que ce délai
      // n'était pas écoulé. On vérifie ici si l'onglet existe encore : si
      // non, on abandonne tout de suite au lieu d'attendre le timeout.
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

// Adds each item to the real Leclerc Drive cart. Every result card in the
// search list carries its own inline "ajouter au panier" control
// (.vignette-ajout), and `item.productUrl` stored from a PRICE REFRESH is
// usually just the *search results page* URL (shared by every product of
// that search), since collectLeclercStore has no real per-product link to
// fall back on there — navigating straight to that kind of URL either 404s
// or lands back on a generic search page (confirmed via a real cart-fill
// diagnostic: ADD_TO_CART_CONTROL_NOT_FOUND everywhere). This function's
// default path is therefore still to re-run the same search-and-match flow
// as collectLeclercStore, then click the matched card's own inline control.
//
// Exception confirmée le 2026-08-28 (pick manuel utilisateur sur "Boisson
// soja nature") : `item.productUrl` PEUT aussi être une vraie fiche produit
// standalone ("/fiche-produits-<id>-<slug>.aspx"), quand l'utilisateur l'a
// validée via le bouton "✓ Valider ce produit" (livePickLeclercProduct) —
// ce cas a bien un lien direct stable et un bouton d'ajout propre. Voir
// isLeclercStandaloneProductUrl / tryAddToCartLeclercViaProductUrl : ce
// chemin est tenté en premier UNIQUEMENT quand l'URL matche ce motif précis,
// avec repli automatique sur la recherche par nom en cas d'échec (URL
// périmée, nom qui ne correspond plus, bouton introuvable).
export async function addToCartLeclercStore({
  scripting,
  tabId,
  job,
  store,
  items,
  signal,
  farmStore = null,
  onProgress = () => undefined
}) {
  // Rebranché ici (2026-08-27) : cette fonction attaquait directement la
  // recherche sans jamais vérifier que l'onglet était bien sur une page de
  // recherche exploitable (contrairement à collectLeclercStore et
  // livePickLeclercProduct, qui appellent toujours ce prologue en premier).
  // Un onglet resté sur une fiche produit, un écran de sélection de Drive,
  // ou un hôte non transactionnel faisait échouer CART_SEARCH_NOT_STARTED
  // sur la totalité des produits d'affilée — un motif déjà observé en réel
  // (voir job-runner.js, note sur la remise à resolveStoreStartUrl).
  const prologue = await ensureLeclercCatalogReady({ scripting, tabId, store, signal, farmStore });
  if (!prologue.ready) return failed(store, prologue.code, prologue.details, true);

  // Vérification de connexion, une seule fois pour tout le job (un état
  // d'onglet global, pas une propriété par produit), AVANT toute recherche
  // produit : si l'utilisateur n'est pas connecté, aucun clic "ajouter"
  // n'aboutira jamais, quel que soit le produit. Contrôle unique et
  // immédiat, sans sondage — voir le commentaire au-dessus de cette fonction
  // (décision utilisateur du 2026-08-28, revue après test réel). Exigence
  // stricte : seule une confirmation EXPLICITE (signedIn === true) laisse
  // passer, y compris quand le signal reste indéterminé plutôt que
  // franchement "déconnecté".
  const session = await runPageAction(scripting, tabId, readLeclercSessionStateOnPage, []);
  if (session?.signedIn !== true) {
    return failed(store, 'CART_LOGIN_REQUIRED', { evidence: session?.evidence ?? null }, true);
  }

  // Mémorise la page de recherche/catalogue courante AVANT tout produit, pour
  // pouvoir y revenir explicitement après une navigation directe vers une
  // fiche produit standalone (item.productUrl) — voir plus bas dans la
  // boucle, et le commentaire sur ce même sujet au-dessus de cette fonction.
  const currentTabUrl = await runPageAction(scripting, tabId, readCurrentLeclercUrlOnPage, []);
  const searchTabUrl = currentTabUrl?.href ?? null;

  const results = [];
  let itemIndex = 0;
  for (const item of items) {
    if (signal.aborted) break;
    itemIndex += 1;
    if (itemIndex > 1) await wait(randomJitterMs(700, 1_600), signal);
    onProgress({
      storeKey: store.storeKey,
      state: 'product_search',
      productIndex: itemIndex,
      productTotal: items.length,
      productName: item.name
    });
    try {
      // Décision utilisateur (2026-08-28, après pick manuel confirmé sur
      // "Boisson soja nature") : quand l'utilisateur a validé une vraie fiche
      // produit standalone Leclerc via le bouton "✓ Valider ce produit"
      // (livePickLeclercProduct), on retente la navigation directe vers
      // item.productUrl en PREMIER — voir tryAddToCartLeclercViaProductUrl.
      //
      // Revu le 2026-09-01 (bug réel signalé par l'utilisateur : produit
      // ajouté au panier différent de celui validé côté comparatif) : un
      // échec de ce chemin direct (URL périmée, nom qui ne correspond plus,
      // bouton introuvable) NE retombe PLUS sur la recherche par nom
      // ci-dessous. La recherche de secours matche par nom/marque flous et
      // peut légitimement retenir un autre conditionnement ou une autre
      // marque proche (voir chooseLeclercProductCandidate) — cliquer "ajouter"
      // dessus revient à mettre au panier un produit que l'utilisateur n'a
      // jamais validé. Un item porteur d'une productUrl exige donc désormais
      // CETTE fiche précise ou rien : tout échec du chemin direct devient un
      // échec sec et explicite (voir directUrlFailureCode ci-dessous), plutôt
      // qu'un ajout silencieux d'un produit de substitution.
      if (item.productUrl && isLeclercStandaloneProductUrl(item.productUrl)) {
        const direct = await tryAddToCartLeclercViaProductUrl({ scripting, tabId, signal, item });
        if (direct.captcha) throw new Error('CAPTCHA_DETECTED');
        // Bug réel confirmé le 2026-08-28 (diagnostic exporté + inspection en
        // direct de la vraie fiche encore ouverte) : que la navigation
        // directe réussisse ou échoue, elle laisse toujours l'onglet sur la
        // fiche produit standalone — un sous-domaine différent
        // (fdNN-courses.leclercdrive.fr) de celui de la recherche
        // (m-courses.leclercdrive.fr), qui n'a AUCUNE zone de recherche ni
        // bouton d'ouverture exploitable. `ensureLeclercCatalogReady` ne
        // suffit PAS à en sortir : un hôte transactionnel suffit déjà à le
        // déclarer "prêt" sans jamais renaviguer nulle part. Sans ce retour
        // explicite, TOUT produit suivant de la boucle (même sans son propre
        // productUrl) échouait en CART_SEARCH_NOT_STARTED. `searchTabUrl` a
        // été mémorisé avant le tout premier produit (voir plus haut).
        if (searchTabUrl) {
          const back = await runPageAction(scripting, tabId, navigateToLeclercUrlOnPage, [searchTabUrl]);
          if (back?.started) await wait(2_500, signal);
        }
        if (direct.added) {
          results.push({
            protocolVersion: 1,
            jobId: job.jobId,
            productId: item.productId,
            storeKey: 'leclerc',
            added: true,
            matchedName: direct.matchedName,
            matchedPriceEuro: direct.matchedPriceEuro
          });
        } else {
          results.push({
            protocolVersion: 1,
            jobId: job.jobId,
            productId: item.productId,
            storeKey: 'leclerc',
            added: false,
            code: direct.code ?? 'CART_DIRECT_URL_FAILED',
            // Sans cette propagation, les détails produits par la garde de
            // cohérence et par la confirmation de clic mouraient ici : le
            // diagnostic exporté ne portait que le code, donc rien
            // d'exploitable pour comprendre POURQUOI un ajout a été refusé.
            ...(direct.details ? { details: direct.details } : {})
          });
        }
        continue;
      }
      // Même nettoyage/dédoublonnage marque ET bruit de formulation que pour
      // la recherche d'analyse (voir nameStageProduct plus haut) — le
      // scoring plus bas continue de comparer contre `item.name`/`item.brand`
      // ORIGINAUX. simplifyLeclercSearchQuery manquait ici (bug réel confirmé
      // le 01/09) : un nom de liste de courses non nettoyé ("Riz Basmati en
      // Sachet 5x 2 Personnes") donnait 0 résultat sur ce chemin de secours,
      // alors que le scraping normal l'aurait retrouvé dès l'étage
      // simplified_name.
      const cartSearchName = sanitizeLeclercSearchText(simplifyLeclercSearchQuery(item.name)) || sanitizeLeclercSearchText(item.name);
      const search = await runPageAction(scripting, tabId, startProductSearchOnPage, [
        { name: cartSearchName, brand: dedupeBrandFromSearchName(cartSearchName, item.brand ?? '') }
      ]);
      if (!search?.started) {
        results.push({
          protocolVersion: 1,
          jobId: job.jobId,
          productId: item.productId,
          storeKey: 'leclerc',
          added: false,
          code: 'CART_SEARCH_NOT_STARTED'
        });
        continue;
      }
      const { candidates } = await waitForProductCandidates({
        scripting,
        tabId,
        reader: readProductCandidatesOnPage,
        signal,
        expectedQuery: search.query,
        requireSearchRoute: false
      });
      // brand/barcode viennent du candidat validé par l'utilisateur dans le
      // panneau de comparaison (voir ValidatedBasketItem) : sans eux, ce
      // matching ne pouvait départager qu'au nom seul, ce qui pouvait
      // retenir un produit différent de celui réellement choisi — bug
      // rapporté en conditions réelles (2026-08-28, le lait ajouté au panier
      // n'était pas celui sélectionné dans la liste).
      const best = chooseLeclercProductCandidate(
        { name: item.name, brand: item.brand ?? '', barcode: item.barcode },
        candidates ?? []
      );
      if (!best) {
        const details = await inspectProductResults(scripting, tabId, inspectLeclercProductPageOnPage);
        // Même logique que collectLeclercStore (scraping de prix) : un
        // captcha bloque TOUTE recherche sur ce tab, pas seulement ce
        // produit — continuer à enchaîner les produits suivants ne ferait
        // que multiplier les échecs et prolonger l'exposition au système
        // anti-bot pour rien. Point mort corrigé le 2026-08-27 : ce chemin
        // d'ajout au panier ne vérifiait jamais ce signal, contrairement au
        // scraping.
        if (details?.hasCaptcha) {
          throw new Error('CAPTCHA_DETECTED');
        }
        results.push({
          protocolVersion: 1,
          jobId: job.jobId,
          productId: item.productId,
          storeKey: 'leclerc',
          added: false,
          code: 'CART_PRODUCT_NOT_FOUND',
          details
        });
        continue;
      }
      const outcome = await runPageAction(scripting, tabId, clickAddToCartOnMatchedLeclercCardOnPage, [
        best.name,
        best.priceEuro,
        item.quantity
      ]);
      const details = outcome?.added
        ? undefined
        : await inspectProductResults(scripting, tabId, inspectLeclercProductPageOnPage);
      results.push({
        protocolVersion: 1,
        jobId: job.jobId,
        productId: item.productId,
        storeKey: 'leclerc',
        added: Boolean(outcome?.added),
        // matchedName/matchedPriceEuro remontent la carte RÉELLEMENT cliquée
        // (best, déjà validée par chooseLeclercProductCandidate) même en cas
        // de succès -- seul moyen de repérer après coup un clic parti sur la
        // mauvaise carte quand le score de matching l'a quand même accepté.
        ...(outcome?.added
          ? {
              matchedName: best.name,
              matchedPriceEuro: best.priceEuro
            }
          : { code: outcome?.code ?? 'ADD_TO_CART_CONTROL_NOT_FOUND', details })
      });
    } catch (error) {
      // CAPTCHA_DETECTED (levé volontairement ci-dessus) doit interrompre
      // tout le job d'ajout au panier, pas seulement ce produit — un
      // catch-all générique ici l'aurait avalé en ADD_TO_CART_FAILED par
      // produit et laissé la boucle continuer à marteler une page qui
      // bloque activement (même raisonnement que collectLeclercStore).
      // SCRIPT_EXECUTION_TIMEOUT (voir executeScriptWithTimeout) reçoit le
      // même traitement : un onglet figé compromet tout le job d'ajout, pas
      // seulement cet item.
      if (error instanceof Error && (error.message === 'CAPTCHA_DETECTED' || error.message === 'SCRIPT_EXECUTION_TIMEOUT')) {
        throw error;
      }
      results.push({ protocolVersion: 1, jobId: job.jobId, productId: item.productId, storeKey: 'leclerc', added: false, code: 'ADD_TO_CART_FAILED' });
    }
  }
  // Reuses job-runner's generic `observations`/`errors` aggregation (it just
  // concatenates whatever each store call returns) — these aren't price
  // observations, but the pipeline never inspects their shape.
  // keepTabOpen: true unconditionally — unlike a price refresh, the user
  // needs the tab to still be there afterward to review the real cart and
  // pay. Without this the job-runner's default (close on success) yanked the
  // tab shut the instant the job finished, confirmed by a live report of the
  // Hyper U tab closing itself right after a successful add.
  return { observations: results, errors: [], keepTabOpen: true };
}

// Navigue directement vers la fiche produit standalone validée manuellement
// par l'utilisateur (item.productUrl, enregistrée via le bouton
// "✓ Valider ce produit" — voir livePickLeclercProduct /
// armLeclercFloatingPickButtonOnPage) et y clique sur le bouton PRINCIPAL
// « Ajouter au panier » — jamais un bouton du carrousel de produits de
// substitution affiché sur la même page (voir
// clickAddToCartOnLeclercProductPageOnPage). Avant tout clic, vérifie que la
// fiche réellement atteinte correspond bien au produit attendu : Leclerc
// n'affiche aucun EAN en texte brut sur cette fiche (contrairement à Hyper
// U), donc toujours un recouvrement de nom suffisamment strict — un lien
// périmé peut être silencieusement redirigé vers une page de résultats de
// recherche générique plutôt qu'un 404, auquel cas
// readLeclercProductPageOnPage lirait le nom du premier résultat de cette
// page comme s'il s'agissait de la bonne fiche.
// Rafraîchissement direct d'une fiche produit Leclerc dont l'URL est connue
// (job.manualUrlOverrides.leclerc) — même rôle que
// collectCoursesUManualProduct côté Hyper U.
//
// Longtemps impossible : les cartes de résultats Leclerc n'exposent aucun
// lien produit, donc aucun candidat n'avait d'URL de fiche stable à
// mémoriser (voir le commentaire de DriveManualUrlOverridesV1). Conséquence
// mesurée le 31/08 : un candidat corrigé à la main (matchType
// 'manual_override') n'était plus JAMAIS rafraîchi — persistDriveObservation
// jette l'observation d'une recherche automatique pour ne pas dégrader un
// choix humain (skipAutomaticOverwrite), et rien ne venait la remplacer. Sur
// une liste réelle, 6 produits sur 11 gardaient ainsi un prix figé,
// présenté comme certain. Un prix figé faux est exactement ce qu'un
// comparateur ne doit pas faire.
//
// Désormais les fiches ont une URL stable des deux côtés (pick manuel, et
// depuis la 0.5.73 les candidats de recherche eux-mêmes, cf.
// buildLeclercFicheUrl) : on y navigue directement, ce qui rafraîchit le
// prix ET reste plus fiable qu'une recherche (aucune ambiguïté de matching).
// L'observation porte matchStage 'manual', donc elle a le droit d'écraser le
// candidat manuel existant sans le dégrader.
// Ramène l'onglet sur la route depuis laquelle les recherches fonctionnent,
// après une navigation directe vers une fiche produit qui n'a rien donné.
// Indispensable : une fiche standalone Leclerc n'a aucune zone de recherche,
// donc startProductSearchOnPage y échoue en PRODUCT_SEARCH_INPUT_NOT_FOUND
// (même piège que pour le remplissage du panier, 28/08).
//
// Une simple attente fixe de 2 s ne suffisait pas (constaté en réel le
// 02/09 : 2 produits perdus sur un rafraîchissement) — la fiche .aspx est un
// rechargement de page complet, auquel DataDome ajoute un délai variable. On
// attend donc que l'URL courante confirme le retour, plutôt que de parier sur
// une durée.
async function returnToLeclercSearchRoute({ scripting, tabId, signal, searchRouteUrl }) {
  if (!searchRouteUrl) return false;
  const navigation = await runPageAction(scripting, tabId, navigateToLeclercUrlOnPage, [searchRouteUrl]);
  if (!navigation?.started) return false;

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    await wait(500, signal);
    let current = null;
    try {
      current = await runPageAction(scripting, tabId, readCurrentLeclercUrlOnPage, []);
    } catch {
      current = null;
    }
    // Critère volontairement large : ce qu'on veut vérifier n'est pas d'être
    // arrivé sur CETTE adresse exacte (le site redirige souvent vers une
    // variante de la même route), mais d'avoir quitté la fiche produit — la
    // seule forme de page qui n'a pas de zone de recherche.
    if (current?.href && !isLeclercStandaloneProductUrl(current.href)) return true;
  }
  return false;
}

async function collectLeclercManualProduct({ scripting, tabs, tabId, signal, manualUrl }) {
  const navigation = await runPageAction(scripting, tabId, navigateToLeclercUrlOnPage, [manualUrl]);
  if (!navigation?.started) return { ok: false, code: 'MANUAL_URL_NAVIGATION_FAILED' };
  await wait(600, signal);

  // Même budget de relecture que tryAddToCartLeclercViaProductUrl : une fiche
  // .aspx est un vrai rechargement complet, plus lent qu'un changement de
  // route SPA, et DataDome y ajoute un délai variable.
  const deadline = Date.now() + 15_000;
  let page = null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      page = await runPageAction(scripting, tabId, readLeclercProductPageOnPage, []);
    } catch {
      page = null;
    }
    if (page?.ok) break;
    // Une page bloquée ou introuvable ne s'améliorera pas en attendant :
    // ressortir tout de suite plutôt que de brûler 15 s (et l'appelant
    // retombera sur la recherche normale).
    if (page?.code === 'SITE_BLOCKED') return { ok: false, code: 'SITE_BLOCKED' };
    if (page?.code === 'MANUAL_URL_PAGE_NOT_FOUND') return { ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' };
    await wait(500, signal);
  }
  if (!page?.ok) return { ok: false, code: page?.code ?? 'MANUAL_URL_PAGE_NOT_READY' };
  return page;
}

// Recouvrement entre le nom demandé (celui de la LISTE DE COURSES, qui porte
// le bruit de formulation déjà neutralisé pour la recherche : "Riz Basmati en
// Sachet 5x 2 Personnes") et le nom lu sur la fiche réellement atteinte.
// Partagé par les deux chemins de navigation directe — ajout au panier et
// raccourci "permalien appris" — pour qu'ils ne puissent pas diverger : une
// fiche jugée bonne à la collecte doit l'être aussi au moment de l'ajout.
function scoreLeclercProductPageName(product, pageName) {
  const expectedName = simplifyLeclercSearchQuery(product.name) || product.name;
  const expected = stripQuantityTokens(tokens(`${expectedName} ${product.brand ?? ''}`));
  const actual = stripQuantityTokens(tokens(pageName || ''));
  return tokenScore(expected, actual);
}

// Seuil du chemin panier : volontairement bas, car la fiche visée a DÉJÀ été
// validée à la collecte — il ne s'agit ici que de repérer une fiche périmée
// ou remplacée. Trop haut, il refusait des fiches correctes et laissait le
// panier vide (cas réel du 01/09).
const CART_DIRECT_URL_MIN_NAME_SCORE = 0.5;

// Seuil du raccourci "permalien appris" : plus exigeant, parce qu'ici le
// score mesuré devient le score de confiance du candidat. En dessous de 0.7,
// la PWA classerait la correspondance en 'uncertain' — autant laisser la
// recherche normale reprendre la main et produire son propre résultat plutôt
// que de dégrader un candidat sur une simple différence de formulation.
const KNOWN_URL_MIN_NAME_SCORE = 0.7;

async function tryAddToCartLeclercViaProductUrl({ scripting, tabId, signal, item }) {
  const navigation = await runPageAction(scripting, tabId, navigateToLeclercUrlOnPage, [item.productUrl]);
  if (!navigation?.started) return { added: false, code: 'CART_DIRECT_URL_NAVIGATION_FAILED' };
  await wait(600, signal);

  // Même logique de relecture que collectLeclercStore : la fiche peut mettre
  // un instant à hydrater après le chargement du document. Budget aligné sur
  // celui de waitForProductCandidates (15s, cf. son commentaire sur le délai
  // variable ajouté par le anti-bot DataDome) — cette navigation est en plus
  // un VRAI rechargement de page complète (fiche .aspx classique), plus lourd
  // qu'un simple changement de route SPA.
  const deadline = Date.now() + 15_000;
  let page = null;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      page = await runPageAction(scripting, tabId, readLeclercProductPageOnPage, []);
    } catch {
      page = null;
    }
    if (page?.ok) break;
    if (page?.code === 'SITE_BLOCKED') return { added: false, captcha: true };
    if (page?.code === 'MANUAL_URL_PAGE_NOT_FOUND') return { added: false, code: 'CART_DIRECT_URL_PAGE_NOT_FOUND' };
    await wait(500, signal);
  }
  if (!page?.ok) return { added: false, code: 'CART_DIRECT_URL_PAGE_NOT_READY' };

  // Canari de structure AJOUTÉ (2026-08-28) : purement observationnel, il ne
  // change aucune décision. Si le prix a dû être lu par le palier de dernier
  // recours, c'est le signe que les classes attendues ont disparu de la page
  // — donc que le site a changé et que la lecture est en mode dégradé, bien
  // avant qu'elle ne renvoie un prix faux.
  if (page.priceSource === 'scan_large') {
    debugLog('price_source_degraded', { product: item.name, priceSource: page.priceSource });
  }

  // Le nom comparé ici vient de la LISTE DE COURSES de l'utilisateur, pas du
  // catalogue : il porte le même bruit de formulation que celui déjà neutralisé
  // pour la recherche ("Riz Basmati en Sachet 5x 2 Personnes"). Sans le même
  // nettoyage, cette garde était PLUS stricte que le matching qui avait retenu
  // ce produit à la collecte : une fiche validée à 0.9 côté comparatif
  // ressortait ici en CART_DIRECT_URL_MISMATCH, et comme le chemin direct est
  // désormais sans repli, le panier restait vide (cas réel du 01/09).
  const expectedName = simplifyLeclercSearchQuery(item.name) || item.name;
  const nameScore = scoreLeclercProductPageName(item, page.name);
  if (nameScore < CART_DIRECT_URL_MIN_NAME_SCORE) {
    // Détails indispensables : sans eux, ce refus ressortait dans le
    // diagnostic exporté sans la moindre trace de CE qui n'a pas correspondu,
    // donc sans moyen de distinguer une vraie fiche périmée d'une lecture de
    // nom partie sur le mauvais élément de la page.
    return {
      added: false,
      code: 'CART_DIRECT_URL_MISMATCH',
      details: {
        expectedName,
        pageName: page.name || '',
        nameScore: Number(nameScore.toFixed(2))
      }
    };
  }

  const outcome = await runPageAction(scripting, tabId, clickAddToCartOnLeclercProductPageOnPage, [item.quantity]);
  // matchedName/matchedPriceEuro sur succès (pas seulement en cas de rejet
  // de mismatch ci-dessus) : sans ça, un diagnostic d'ajout au panier ne
  // permettait de repérer une mauvaise carte cliquée que quand le score de
  // cohérence rejetait déjà le candidat — jamais quand le clic a réussi sur
  // la MAUVAISE carte (cas réel confirmé 01/09 : jambon ajouté dans deux
  // conditionnements alors qu'un seul était demandé).
  return outcome?.added
    ? { added: true, matchedName: page.name, matchedPriceEuro: page.priceEuro }
    : { added: false, code: outcome?.code ?? 'ADD_TO_CART_CONTROL_NOT_FOUND', details: outcome?.details };
}

// Runs in the page world (voir la contrainte d'isolation d'injection
// documentée en tête de fichier — aucune fonction du module ne peut être
// appelée depuis ici). Relit la fiche produit standalone Leclerc atteinte
// via une navigation directe (item.productUrl) — voir
// tryAddToCartLeclercViaProductUrl. Duplique délibérément les mêmes paliers
// de lecture de prix que readGenericLeclercProductOnPage (imbriquée dans
// armLeclercFloatingPickButtonOnPage, injectée séparément).
export function readLeclercProductPageOnPage() {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  if (/captcha|v[ée]rifier que vous [êe]tes humain/i.test(text)) {
    return { ok: false, code: 'SITE_BLOCKED' };
  }

  // Priorité identique à readGenericLeclercProductOnPage, et pour la même
  // raison : une fiche Leclerc porte deux <h1>, celui du bandeau de
  // navigation (sans grammage) venant en premier dans le DOM. Voir le
  // commentaire détaillé sur l'autre lecteur — les deux doivent rester
  // alignés, la duplication étant imposée par la sérialisation des fonctions
  // injectées.
  const heading =
    document.querySelector('.titre-fiche') ||
    document.querySelector('[itemprop="name"]') ||
    document.querySelector('.pWCRS310_Desc, .vignette-descriptif') ||
    document.querySelector('h1');
  const nameText = heading?.textContent?.trim();
  if (!nameText) return { ok: false, code: 'MANUAL_URL_PAGE_NOT_FOUND' };

  const unitPriceElement = [...document.querySelectorAll('[class*="prix" i]')]
    .find((element) => !element.closest('.crossell') && /€?\s*\/\s*(l|kg|cl|g)\b/i.test(element.textContent || ''));
  const unitPriceMatch = unitPriceElement?.textContent?.match(/(\d{1,4})[,.]\s*(\d{1,2})\s*€?\s*\/\s*(l|kg|cl|g)\b/i);
  const unitPriceRaw = unitPriceMatch ? Number(`${unitPriceMatch[1]}.${unitPriceMatch[2].padEnd(2, '0')}`) : NaN;
  const unitPriceSuffix = unitPriceMatch?.[3]?.toLowerCase();
  const unitPriceEuro =
    Number.isFinite(unitPriceRaw) && unitPriceSuffix
      ? unitPriceRaw * (unitPriceSuffix === 'cl' ? 100 : unitPriceSuffix === 'g' ? 1000 : 1)
      : undefined;
  const unitPriceDetails =
    unitPriceEuro !== undefined
      ? { unitPriceEuro, unitPriceUnit: unitPriceSuffix === 'l' || unitPriceSuffix === 'cl' ? 'L' : 'kg' }
      : {};

  // Palier 1 : balise schema.org, si présente.
  const itemPropPrice = document.querySelector('[itemprop="price"]');
  const itemPropText = itemPropPrice?.getAttribute('content') || itemPropPrice?.textContent || '';
  const itemPropMatch = itemPropText.match(/(\d{1,4})[,.]\s*(\d{2})/);
  if (itemPropMatch) {
    return {
      ok: true,
      name: nameText.slice(0, 500),
      priceEuro: Number(`${itemPropMatch[1]}.${itemPropMatch[2]}`),
      ...unitPriceDetails,
      priceSource: 'itemprop'
    };
  }
  // Palier 2 : .vignette-prix (template Angular 16).
  const vignetteText =
    document.querySelector('.vignette-prix-ajout .vignette-prix p, .vignette-prix p')?.textContent || '';
  const vignetteMatch = vignetteText.match(/(\d{1,4})[,.]\s*(\d{2})/);
  if (vignetteMatch) {
    return {
      ok: true,
      name: nameText.slice(0, 500),
      priceEuro: Number(`${vignetteMatch[1]}.${vignetteMatch[2]}`),
      ...unitPriceDetails,
      priceSource: 'vignette_prix'
    };
  }
  // Palier 3 : fiche produit standalone du template classique
  // (.prix-actuel-partie-entiere / .prix-actuel-partie-decimale), distinct
  // de .prix-reduction / .prix-detail (prix au litre/kg).
  const standaloneIntegerPart = document
    .querySelector('.prix-actuel-partie-entiere')
    ?.textContent?.match(/\d{1,4}/)?.[0];
  const standaloneDecimalPart = document
    .querySelector('.prix-actuel-partie-decimale')
    ?.textContent?.match(/\d{2}/)?.[0];
  if (/^\d{1,4}$/.test(standaloneIntegerPart || '') && /^\d{2}$/.test(standaloneDecimalPart || '')) {
    return {
      ok: true,
      name: nameText.slice(0, 500),
      priceEuro: Number(`${standaloneIntegerPart}.${standaloneDecimalPart}`),
      ...unitPriceDetails,
      priceSource: 'standalone_classique'
    };
  }
  // Palier 4 : partie entière + partie décimale du template classique
  // (cartes de listing), en excluant le carrousel de produits de
  // substitution (mêmes classes réutilisées par chaque carte du carrousel).
  const integerPart = [...document.querySelectorAll('.pWCRS310_PrixUnitairePartieEntiere')]
    .find((element) => !element.closest('.crossell'))
    ?.textContent?.match(/\d{1,4}/)?.[0];
  const decimalPart = [...document.querySelectorAll('.pWCRS310_PrixUnitairePartieDecimale')]
    .find((element) => !element.closest('.crossell'))
    ?.textContent?.match(/\d{2}/)?.[0];
  if (/^\d{1,4}$/.test(integerPart || '') && /^\d{2}$/.test(decimalPart || '')) {
    return {
      ok: true,
      name: nameText.slice(0, 500),
      priceEuro: Number(`${integerPart}.${decimalPart}`),
      ...unitPriceDetails,
      priceSource: 'listing_classique'
    };
  }
  // Palier 5, dernier recours : scan large [class*="prix"], en excluant le
  // prix au litre/kg et le carrousel de substituts.
  const priceElements = [...document.querySelectorAll('[class*="prix" i]')];
  for (const element of priceElements) {
    if (/unitemesure/i.test(element.className || '')) continue;
    if (element.closest('.crossell')) continue;
    const priceText = element.getAttribute('content') || element.textContent || '';
    if (/\/\s*(l|kg)\b/i.test(priceText)) continue;
    const priceMatch = priceText.match(/(\d{1,4})[,.]\s*(\d{2})/);
    if (!priceMatch) continue;
    const price = Number(`${priceMatch[1]}.${priceMatch[2]}`);
    if (Number.isFinite(price)) {
      // Palier de DERNIER RECOURS : le prix ne vient plus d'aucune classe
      // connue mais d'un scan large. priceSource sert de canari — voir
      // tryAddToCartLeclercViaProductUrl, qui le journalise.
      return { ok: true, name: nameText.slice(0, 500), priceEuro: price, ...unitPriceDetails, priceSource: 'scan_large' };
    }
  }
  return { ok: false, code: 'MANUAL_URL_PRICE_NOT_FOUND' };
}

// Runs in the page world. Clique sur le bouton PRINCIPAL « Ajouter au
// panier » d'une fiche produit standalone Leclerc — jamais un bouton du
// carrousel de produits de substitution affiché plus bas sur la même page.
// La classe "aWCRS310_Add_Produit_Fiche" est propre au produit de la fiche
// elle-même ; le carrousel utilise "aWCRS310_Add" (sans le suffixe
// "_Produit_Fiche") — confirmé en direct (2026-08-28) sur une vraie fiche
// produit standalone leclercdrive.fr. Même logique de vérification post-clic
// et de gestion de quantité (stepper "+") que
// clickAddToCartOnMatchedLeclercCardOnPage ci-dessus.
export async function clickAddToCartOnLeclercProductPageOnPage(quantity) {
  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const isInCrossell = (element) => Boolean(element.closest('.crossell, [class*="crossell" i], [id*="crossell" i]'));

  // Le "+" de la fiche n'est pas toujours un <button> : sur la barre d'ajout
  // servie au téléphone, le stepper est un bloc "ajouterAuPanier-counter-bloc"
  // (relevé dans cartCandidates du diagnostic réel du 01/09) dont les
  // contrôles sont des <a>/<span>. Chercher uniquement des <button> laissait
  // donc le stepper invisible côté extension : la confirmation d'ajout la plus
  // fiable de cette page passait à côté.
  // Ce que le site appelle réellement son stepper, relevé sur la page de
  // l'utilisateur (diagnostic du 01/09) : <a href="#plus"
  // class="aWCRS310_More_Produit_Fiche">, à côté d'un "#moins" symétrique, le
  // tout dans un bloc "ajouterAuPanier-counter-bloc". Aucun de ces contrôles
  // ne porte le texte "+" en clair (l'icône est en CSS) ni "augmenter" : le
  // motif d'origine ne les voyait donc PAS. C'est toute la cause du bug —
  // faute de reconnaître le stepper, l'ajout réussi passait pour un échec.
  const isStepperControl = (element) => {
    const href = String(element.getAttribute('href') || '');
    const className = String(element.className || '');
    return (
      /^#(plus|moins|more|less)$/i.test(href) ||
      /More_Produit|Less_Produit|Moins_Produit/i.test(className) ||
      Boolean(element.closest('[class*="counter" i], [class*="stepper" i]'))
    );
  };

  const findStepper = () =>
    [...document.querySelectorAll('a, button, span, [role="button"]')].find((element) => {
      if (isInCrossell(element) || !isVisible(element)) return false;
      const href = String(element.getAttribute('href') || '');
      const signal = `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.className || ''}`;
      // Uniquement le "+" : ce stepper sert aussi à INCRÉMENTER plus bas, et
      // renvoyer le "-" ferait retirer des unités au lieu d'en ajouter.
      return /^#(plus|more)$/i.test(href) || /More_Produit/i.test(signal) || /^\+$|augmenter|increment/i.test(signal.trim());
    });

  // Renforcement AJOUTÉ (2026-08-28) : un clic sur "+" peut être absorbé par
  // le site (stepper re-rendu pendant la mise à jour du panier), et rien ne
  // le détectait — le panier réel se retrouvait alors avec moins d'unités que
  // demandé, silencieusement. On relit donc le compteur affiché après chaque
  // clic et on retente au plus 2 fois s'il n'a pas bougé. Deux garde-fous :
  // si le compteur n'est pas lisible on garde EXACTEMENT le comportement
  // d'origine (un clic par unité, sans vérification), et on s'arrête dès que
  // la cible est atteinte — cette fonction ne peut qu'ajouter des unités,
  // jamais en retirer. Dupliqué dans chaque fonction injectée (isolation
  // d'injection).
  const readStepperValue = (stepper) => {
    const scope =
      stepper.closest?.(
        '[class*="counter" i], [class*="quantity" i], [class*="stepper" i], [class*="qty" i]'
      ) || stepper.parentElement;
    const field = scope?.querySelector('input[type="number"], input[data-quantity], [data-quantity-value]');
    if (!field) {
      // Repli sur la quantité AFFICHÉE : sur cette fiche, le compteur du bloc
      // "ajouterAuPanier-counter-bloc" est un simple texte entre "-" et "+",
      // pas un champ de saisie. Sans ce repli, la quantité restait illisible
      // et les clics "+" partaient sans le moindre contrôle — c'est ce
      // manque de vérification qui a laissé passer les quantités doublées
      // du 01/09 sans que rien ne s'en aperçoive.
      const shown = String(scope?.textContent ?? '').match(/\d+/);
      const value = shown ? Number(shown[0]) : NaN;
      return Number.isFinite(value) && value > 0 ? value : undefined;
    }
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

  // Signal de confirmation le plus fiable de cette page, et le seul qui ne
  // dépende pas du re-rendu du bouton : la zone panier de l'en-tête, qui
  // affiche un total en euros ("Panier 0 — Drive : 0,00 €").
  //
  // La 1re version ne visait que les classes relevées sur la version bureau
  // du site (divWCRS319_CartouchePanier…) et ne trouvait rien sur le
  // téléphone (diagnostic du 01/09 : cartSignatureRead false partout) : le
  // site sert m-courses.leclercdrive.fr aux mobiles, avec d'autres classes.
  // D'où une recherche large sur "panier" dans la classe ou l'id, restreinte
  // aux zones qui affichent réellement un montant — sans ce filtre, un simple
  // libellé "Panier" figerait la signature et masquerait tout changement.
  const readCartSignature = () => {
    const zones = [...document.querySelectorAll('[class*="panier" i], [id*="panier" i]')].filter((zone) =>
      /\d[\d\s.,]*\s*€/.test(zone.textContent || '')
    );
    const text = zones
      .map((zone) => zone.textContent || '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? text.slice(0, 160) : null;
  };

  // Signal de confirmation propre à CETTE page, et le seul qui se soit avéré
  // lisible sur le téléphone : la barre fixe du bas. Elle porte le prix et le
  // bouton "Ajouter au panier" tant que le produit n'est pas au panier, et
  // bascule ensuite sur le stepper -/+. Le diagnostic réel du 01/09 en a
  // remonté la structure : un bloc "divWCRS310_Panier" porteur de la classe
  // "masquerPlusUnMoinsUn..." (= stepper masqué, donc produit ABSENT du
  // panier) et un bloc "ajouterAuPanier-counter-bloc" (le stepper lui-même).
  // On signe donc l'état par les CLASSES de ces blocs : l'ajout retire
  // "masquerPlusUnMoinsUn", ce qui fait bouger la signature à coup sûr.
  //
  // Pourquoi ne pas se contenter du cartouche panier de l'en-tête : il n'est
  // tout simplement pas rendu dans cette vue (cartSignatureRead false sur les
  // 5 produits du diagnostic, confirmé visuellement — l'en-tête bleu n'affiche
  // que le titre du produit).
  const readAddBarState = () => {
    const blocs = [...document.querySelectorAll('[class*="ajouterAuPanier" i], [class*="WCRS310_Panier" i]')].filter(
      (bloc) => !isInCrossell(bloc)
    );
    if (blocs.length === 0) return null;
    return blocs
      .slice(0, 8)
      .map((bloc) => String(bloc.className || ''))
      .join('|')
      .slice(0, 240);
  };

  // Un vrai appui tactile, pas un clic de souris. Sur mobile, un navigateur
  // émet pointerdown → touchstart → pointerup → touchend, PUIS seulement les
  // événements souris de compatibilité. Un site mobile peut n'écouter que la
  // partie tactile : la séquence souris seule ne déclenche alors rien, ce qui
  // correspond exactement au symptôme observé (bon bouton, page complètement
  // chargée, aucun effet). Reproduire la séquence complète est aussi ce qui
  // protège du double ajout : c'est celle qu'un vrai appui produit, donc
  // celle que le site sait déjà ne compter qu'une fois.
  const tapElement = (element) => {
    const rect = element.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const common = { bubbles: true, cancelable: true, view: window, clientX, clientY };

    const firePointer = (type) => {
      try {
        element.dispatchEvent(new PointerEvent(type, { ...common, pointerId: 1, pointerType: 'touch', isPrimary: true }));
      } catch {
        element.dispatchEvent(new MouseEvent(type, common));
      }
    };
    const fireTouch = (type) => {
      try {
        const touch = new Touch({ identifier: 1, target: element, clientX, clientY });
        const active = type === 'touchend' ? [] : [touch];
        element.dispatchEvent(
          new TouchEvent(type, { ...common, touches: active, targetTouches: active, changedTouches: [touch] })
        );
      } catch {
        // Pas de support tactile (poste de travail, jsdom) : la séquence
        // souris ci-dessous suffit, c'est ce que le navigateur ferait aussi.
      }
    };

    firePointer('pointerdown');
    fireTouch('touchstart');
    firePointer('pointerup');
    fireTouch('touchend');
    for (const type of ['mousedown', 'mouseup', 'click']) {
      element.dispatchEvent(new MouseEvent(type, common));
    }
  };

  // CAUSE RACINE du panier resté vide (diagnostic réel du 01/09 : 5 produits
  // sur 5 en CART_ADD_NOT_CONFIRMED, bouton toujours présent après 6s).
  // La fiche produit standalone est une page WebForms servie ENTIÈREMENT par
  // le serveur : son <h1>, son prix et son bouton "Ajouter au panier" sont
  // déjà dans le HTML initial. L'appelant n'attendait que ça pour considérer
  // la page prête, et cliquait alors que les scripts du site n'étaient pas
  // encore exécutés. Or ce bouton est un <a href="#"> SANS handler propre :
  // le site écoute en délégation jQuery sur `document` (jQuery 1.8.3,
  // vérifié en direct le 01/09). Tant que ce handler n'est pas attaché, le
  // clic ne déclenche strictement rien — exactement le symptôme observé.
  const waitForPageScripts = async () => {
    const readyDeadline = Date.now() + 1_800;
    while (document.readyState !== 'complete' && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Petite marge après 'complete' : les handlers délégués s'attachent au
    // $(document).ready du site, qui s'exécute dans la foulée.
    await new Promise((resolve) => setTimeout(resolve, 300));
  };

  // CAUSE RACINE CONFIRMÉE EN DIRECT sur le téléphone de l'utilisateur
  // (2026-09-01, fiche Nutella réelle, captures à l'appui) : le site affiche
  // en bas de page un bandeau "Dernière connexion le ..." (le
  // divWCTD224_PopinManager que le diagnostic remontait dans overlayShown) et
  // ce bandeau RECOUVRE INTÉGRALEMENT la barre fixe qui porte le prix et le
  // bouton "Ajouter au panier". Il a fallu le fermer à la main pour que le
  // bouton redevienne atteignable ; tant qu'il est là, un appui réel n'atteint
  // jamais le bouton, et le PopinManager du site retient les interactions.
  // On refait donc d'abord ce que fait un humain : fermer le bandeau.
  //
  // Périmètre volontairement étroit : on ne clique QUE sur un contrôle de
  // fermeture (croix, "fermer", aria-label explicite) situé DANS la popin.
  // Jamais sur un bouton d'action, jamais sur un bouton de consentement —
  // accepter des conditions à la place de l'utilisateur reste exclu.
  const findVisiblePopin = () =>
    [...document.querySelectorAll('[class*="popin" i], [id*="popin" i], [class*="modal" i], [role="dialog"]')].find(
      (element) => isVisible(element) && (element.textContent || '').trim().length > 0
    );

  const dismissBlockingPopins = async () => {
    const steps = [];
    for (let round = 0; round < 3; round += 1) {
      const popin = findVisiblePopin();
      if (!popin) break;

      const closeControl = [...popin.querySelectorAll('a, button, span, i, div, [role="button"]')].find((element) => {
        if (!isVisible(element)) return false;
        const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.className || ''} ${element.id || ''}`;
        const text = (element.textContent || '').trim();
        // "×", "✕", "X" seuls, ou un libellé/classe de fermeture explicite.
        return /ferm|close|croix|dismiss/i.test(label) || /^[x×✕✖]$/i.test(text);
      });

      if (closeControl) {
        tapElement(closeControl);
        steps.push('close_control');
      } else {
        // Pas de croix identifiable : Échap est le geste standard pour une
        // modale, et il laisse le site gérer sa propre fermeture.
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        steps.push('escape');
      }

      const deadline = Date.now() + 700;
      while (Date.now() < deadline && findVisiblePopin() === popin) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (findVisiblePopin() === popin) {
        // Dernier recours : la popin résiste. On la neutralise visuellement
        // pour dégager la barre d'ajout. On ne touche à rien d'autre de la
        // page, et l'échec reste tracé dans le diagnostic.
        popin.style.setProperty('display', 'none', 'important');
        popin.style.setProperty('pointer-events', 'none', 'important');
        steps.push('force_hidden');
        break;
      }
    }
    return steps;
  };

  await waitForPageScripts();
  const popinSteps = await dismissBlockingPopins();

  // Recherche réutilisable : le site re-rend sa fiche après un ajout, ce qui
  // DÉTACHE le bouton cliqué du document. Surveiller indéfiniment cette
  // référence morte revenait à ne jamais voir la confirmation arriver.
  // BUG RÉEL CORRIGÉ (diagnostic du 01/09, quantités doublées dans le panier
  // de l'utilisateur) : le repli générique ci-dessous matche sur "ajout", et
  // le "+" du stepper vit dans un bloc "ajouterAuPanier-counter-bloc" — il
  // ressortait donc comme "bouton d'ajout" dès que le vrai bouton disparaissait
  // après un ajout réussi. L'extension re-cliquait alors sur "+", ajoutant une
  // unité de plus à chaque tentative. Un contrôle de stepper n'est JAMAIS un
  // bouton d'ajout : il est exclu sans condition.
  const findAddButton = () =>
    [...document.querySelectorAll('a.aWCRS310_Add_Produit_Fiche')].find(isVisible) ||
    [...document.querySelectorAll('a, button, [role="button"]')].find((element) => {
      if (!isVisible(element) || isInCrossell(element) || isStepperControl(element)) return false;
      const signal = `${element.textContent} ${element.getAttribute('aria-label')} ${element.getAttribute('title')} ${element.className || ''}`;
      return /ajout/i.test(signal);
    });

  // Le produit peut déjà être dans le panier (remplissage précédent
  // interrompu puis repris) : la fiche n'affiche alors plus de bouton
  // "Ajouter", seulement le stepper +/-.
  //
  // Le stepper SEUL ne suffit pas à l'affirmer : ses contrôles existent dans
  // le DOM avant tout ajout (simplement masqués), et une détection de
  // visibilité prise en défaut ferait alors répondre "déjà au panier" pour un
  // produit jamais ajouté — un échec silencieux, le pire des cas ici. La
  // disparition du bouton "Ajouter au panier" est la contrepartie qui rend la
  // conclusion sûre : les deux états ne coexistent jamais sur cette fiche.
  const productIsInCart = () => Boolean(findStepper()) && !findAddButton();

  const alreadyInCartStepper = productIsInCart() ? findStepper() : null;
  if (alreadyInCartStepper) {
    if (quantity > 1) {
      await increaseTo(alreadyInCartStepper, quantity);
    }
    return { added: true };
  }

  let addButton = findAddButton();
  if (!addButton) {
    return { added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' };
  }

  const cartBefore = readCartSignature();
  const addBarBefore = readAddBarState();
  const elementCountBefore = document.getElementsByTagName('*').length;

  // Fenêtres de surveillance décroissantes. La première est large : l'ajout
  // fait un aller-retour serveur, et sur mobile (réseau lent + vérification
  // DataDome) 2s ne suffisaient pas. Les suivantes accompagnent un NOUVEAU
  // clic, pour le cas où le parcmier est parti trop tôt ou a été absorbé par
  // un re-rendu du site. Total tenu volontairement SOUS le budget de 10s par
  // appel injecté (DEFAULT_SCRIPT_TIMEOUT_MS, extension/shared/
  // scripting-timeout.js) : au-delà, l'appel entier serait tué en
  // SCRIPT_EXECUTION_TIMEOUT et on aurait juste échangé un faux négatif
  // contre un autre. Les clics du stepper qui suivent doivent tenir dans la
  // marge restante.
  //
  // GARDE-FOU contre le double ajout : on ne re-clique QUE si un état de
  // référence est lisible ET n'a pas bougé — sinon on s'en tient à un seul
  // clic, mieux vaut un échec signalé qu'un produit ajouté deux fois dans le
  // panier réel de l'utilisateur. La barre d'ajout compte désormais comme
  // état de référence au même titre que le cartouche panier : sans elle, le
  // téléphone (où le cartouche n'existe pas) restait bloqué à une seule
  // tentative, ce que le diagnostic du 01/09 montrait noir sur blanc
  // (attempts: 1 sur les 5 produits).
  const hasReferenceState = cartBefore !== null || addBarBefore !== null;
  const attemptWindowsMs = hasReferenceState ? [3_000, 1_500, 1_500] : [3_000];
  let confirmed = false;
  let attempts = 0;

  const activations = [];

  for (const windowMs of attemptWindowsMs) {
    attempts += 1;
    const initialButtonState = addButton.textContent.trim();

    // Deux modes d'activation VOLONTAIREMENT alternés, un seul par tentative.
    //
    // - "tap" : la séquence d'événements d'un doigt (pointer/touch/souris).
    // - "native_click" : element.click(), l'activation NATIVE du navigateur.
    //   Ce n'est pas la même chose qu'un MouseEvent dispatché : le navigateur
    //   exécute le comportement d'activation par défaut du contrôle (son href,
    //   son onclick, sa soumission), pas seulement la remontée d'un événement.
    //   Sur un <a href="#"> piloté par un handler délégué comme celui de cette
    //   fiche, c'est le chemin le plus proche d'un vrai appui.
    //
    // JAMAIS les deux dans la même tentative : deux activations coup sur coup,
    // c'est deux ajouts au panier réel de l'utilisateur.
    const activation = attempts === 1 ? 'tap' : 'native_click';
    if (activation === 'tap') tapElement(addButton);
    else addButton.click();
    activations.push(activation);

    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      // Le stepper +/- est le signal le plus fiable côté fiche : il ne
      // remplace le bouton qu'une fois la ligne réellement au panier. Même
      // exigence qu'à l'entrée : stepper présent ET bouton "Ajouter" parti.
      if (productIsInCart()) {
        confirmed = true;
        break;
      }
      // Le cartouche panier de l'en-tête bouge dès que le serveur a pris
      // l'ajout, même si la fiche elle-même ne se re-rend pas.
      if (cartBefore !== null && readCartSignature() !== cartBefore) {
        confirmed = true;
        break;
      }
      // La barre d'ajout du bas bascule du bouton vers le stepper : ses
      // classes changent (perte de "masquerPlusUnMoinsUn"). C'est le signal
      // disponible sur téléphone, là où le cartouche panier n'est pas rendu.
      if (addBarBefore !== null && readAddBarState() !== addBarBefore) {
        confirmed = true;
        break;
      }
      if (addButton.isConnected) {
        if (addButton.textContent.trim() !== initialButtonState) {
          confirmed = true;
          break;
        }
      } else if (!findAddButton()) {
        // Bouton détaché par un re-rendu ET plus aucun bouton "Ajouter" sur
        // la fiche : la seule lecture cohérente est que le produit est passé
        // au panier. Un simple détachement ne suffit pas — le site peut
        // aussi remplacer le bouton par un bouton équivalent, auquel cas on
        // continue simplement à surveiller.
        confirmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (confirmed) break;

    // GARDE ULTIME contre le doublon, avant toute nouvelle activation : si le
    // produit est entre-temps passé au panier, on s'arrête net. Sans elle, un
    // ajout pris en compte trop tard pour la fenêtre de surveillance
    // entraînerait un second clic — c'est-à-dire une unité de trop dans le
    // panier réel de l'utilisateur, exactement le défaut constaté le 01/09.
    if (productIsInCart()) {
      confirmed = true;
      break;
    }

    // Le bandeau peut revenir (ou en cacher un autre) entre deux tentatives :
    // re-cliquer sans l'avoir écarté referait exactement l'échec observé.
    popinSteps.push(...(await dismissBlockingPopins()));
    const stillThere = findAddButton();
    // Plus de bouton à cliquer : re-tenter n'a plus de sens, et l'absence
    // seule ne suffit pas à conclure à un ajout (cas déjà traité ci-dessus).
    if (!stillThere) break;
    addButton = stillThere;
  }

  if (!confirmed) {
    // Le site sert des pages différentes au mobile et au poste de travail :
    // sans relever ces éléments-là depuis la page RÉELLE de l'utilisateur, la
    // mise au point se fait à l'aveugle sur une structure qui n'est pas celle
    // qu'il a sous les yeux. On ne remonte que des noms de classes et des
    // compteurs — jamais de contenu de page.
    const cartCandidates = [...document.querySelectorAll('[class*="panier" i], [id*="panier" i]')]
      .slice(0, 6)
      .map((zone) => `${zone.tagName}.${String(zone.className || '').slice(0, 40)}`);
    const overlay = [...document.querySelectorAll('[class*="modal" i], [class*="popin" i], [role="dialog"]')].find(
      isVisible
    );
    return {
      added: false,
      code: 'CART_ADD_NOT_CONFIRMED',
      details: {
        attempts,
        buttonStillPresent: Boolean(findAddButton()),
        // Sans ces trois-là, impossible de distinguer à distance "le bon
        // bouton a été cliqué mais le site n'a rien fait" de "on a cliqué
        // sur autre chose" ou de "la page n'avait pas fini de charger".
        buttonId: addButton.id || '',
        buttonClass: String(addButton.className || '').slice(0, 80),
        readyState: document.readyState,
        cartSignatureRead: cartBefore !== null,
        hostname: location.hostname,
        elementCountDelta: document.getElementsByTagName('*').length - elementCountBefore,
        cartCandidates,
        overlayShown: overlay ? String(overlay.className || '').slice(0, 60) : null,
        // Ce qui a été tenté sur le bandeau qui recouvrait le bouton, et si la
        // barre d'ajout a bougé : sans ces deux-là, un échec résiduel ne
        // permettrait pas de dire si c'est la fermeture de popin qui a raté ou
        // le clic lui-même.
        popinSteps: popinSteps.slice(0, 6),
        addBarStateRead: addBarBefore !== null,
        addBarChanged: addBarBefore !== null && readAddBarState() !== addBarBefore,
        activations,
        // De quoi le bouton est RÉELLEMENT fait. Sans ça, impossible de viser
        // le mécanisme d'ajout du site plutôt que de simuler un appui : on ne
        // sait pas si l'action est portée par un href, un onclick, ou un
        // handler délégué invisible depuis le monde isolé de l'extension.
        // Uniquement de la structure (attributs techniques du bouton, tronqués)
        // — jamais de contenu de page ni de donnée de compte.
        buttonHref: String(addButton.getAttribute('href') || '').slice(0, 120),
        buttonHasOnclick: Boolean(addButton.getAttribute('onclick')),
        buttonDataAttributes: addButton
          .getAttributeNames()
          .filter((name) => name.startsWith('data-'))
          .slice(0, 8),
        buttonTag: addButton.tagName
      }
    };
  }

  if (quantity > 1) {
    const stepper = findStepper();
    if (stepper) {
      await increaseTo(stepper, quantity);
    }
  }

  return { added: true };
}

// Runs in the page world. Lecture seule du DOM, uniquement — ne cherche
// jamais de champ mot de passe, ne remplit et ne clique jamais rien. Sert
// uniquement à distinguer "le site refuse l'ajout parce que l'utilisateur
// n'est pas connecté" des autres échecs (rupture de stock, bug de
// correspondance...). Ne JAMAIS faire évoluer cette fonction pour qu'elle
// automatise la connexion elle-même — ça doit rester un geste humain
// volontaire, quel que soit le confort perdu.
export function readLeclercSessionStateOnPage() {
  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const signalOf = (element) =>
    `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''}`;
  const controls = [...document.querySelectorAll('a, button, [role="button"]')].filter(isVisible);

  // Audit sécurité du 30/08 : l'evidence exportée ne doit jamais reproduire
  // le texte réel du contrôle DOM matché — un bouton "Mon compte, Frédéric"
  // ou toute variante affichant le prénom de l'utilisateur finirait sinon
  // dans un diagnostic exportable/partagé. On ne renvoie que le code du
  // motif qui a déclenché la détection, jamais le texte source.
  const SIGNED_IN_PATTERNS = [
    { code: 'mon_compte', pattern: /mon compte/i },
    { code: 'se_deconnecter', pattern: /se d[ée]connecter/i },
    { code: 'deconnexion', pattern: /d[ée]connexion/i }
  ];
  const SIGNED_OUT_PATTERNS = [
    { code: 'se_connecter', pattern: /se connecter/i },
    { code: 's_identifier', pattern: /s'identifier/i },
    { code: 'identifiez_vous', pattern: /identifiez-vous/i },
    { code: 'creer_un_compte', pattern: /cr[ée]er un compte/i }
  ];
  const matchedPatternCode = (signal, patterns) =>
    (patterns.find(({ pattern }) => pattern.test(signal)) || {}).code || 'unspecified';

  const signedInControl = controls.find((element) =>
    SIGNED_IN_PATTERNS.some(({ pattern }) => pattern.test(signalOf(element)))
  );
  if (signedInControl) {
    return { signedIn: true, evidence: matchedPatternCode(signalOf(signedInControl), SIGNED_IN_PATTERNS) };
  }

  // Ajouté le 02/09/2026 après un faux "pas connecté" observé en réel : sur
  // l'accueil du Drive mobile, "Mon compte" et "Se déconnecter" vivent dans
  // un menu latéral qui n'est même pas dans le DOM tant qu'il n'est pas
  // ouvert. La session était pourtant bien active (bandeau "Dernière
  // connexion le ...", panier existant), et l'état indéterminé bloquait tout
  // le remplissage. Deux signaux supplémentaires, choisis parce qu'ils
  // n'existent JAMAIS sur une page déconnectée :
  //   - un lien de déconnexion, repéré par son href (le texte, lui, peut
  //     être une icône sans libellé) ;
  //   - le bandeau "Dernière connexion le ...", qui n'est affiché qu'à un
  //     visiteur authentifié.
  // Volontairement PAS retenus : les href "mon-compte"/"mes-informations",
  // présents déconnecté puisqu'ils mènent justement à l'écran de connexion.
  const SIGNED_IN_HREF_PATTERNS = [
    { code: 'lien_deconnexion', pattern: /d[ée]connexion|deconnecter|logout|signout/i }
  ];
  const signedInLink = [...document.querySelectorAll('a[href]')].find((element) =>
    SIGNED_IN_HREF_PATTERNS.some(({ pattern }) => pattern.test(String(element.getAttribute('href') || '')))
  );
  if (signedInLink) {
    return {
      signedIn: true,
      evidence: matchedPatternCode(String(signedInLink.getAttribute('href') || ''), SIGNED_IN_HREF_PATTERNS)
    };
  }

  // Même règle qu'ailleurs dans cette fonction : on teste le texte de la
  // page, mais on ne renvoie que le code du motif — jamais la date ni quoi
  // que ce soit qui identifie l'utilisateur.
  const SIGNED_IN_TEXT_PATTERNS = [{ code: 'derniere_connexion', pattern: /derni[èe]re connexion/i }];
  const pageText = String(document.body?.textContent ?? '');
  if (SIGNED_IN_TEXT_PATTERNS.some(({ pattern }) => pattern.test(pageText))) {
    return { signedIn: true, evidence: matchedPatternCode(pageText, SIGNED_IN_TEXT_PATTERNS) };
  }

  const signedOutControl = controls.find((element) =>
    SIGNED_OUT_PATTERNS.some(({ pattern }) => pattern.test(signalOf(element)))
  );
  if (signedOutControl) {
    return { signedIn: false, evidence: matchedPatternCode(signalOf(signedOutControl), SIGNED_OUT_PATTERNS) };
  }

  // Ni l'un ni l'autre signal : état indéterminé. On ne bloque jamais dessus
  // — un faux "pas connecté" empêcherait à tort un remplissage par ailleurs
  // valide, ce qui serait pire que l'absence de détection.
  return { signedIn: null, evidence: null };
}

// Runs in the page world, after a fresh search for the item (see
// addToCartLeclercStore above). Leclerc's Drive UI has no per-product page —
// each search-result card carries its own inline "ajouter au panier" link
// (.vignette-ajout) — so this re-locates the exact card that
// chooseLeclercProductCandidate picked (by name + price, same tolerant
// matching style as the rest of this file) and clicks *that card's* control,
// never a page-wide one that could belong to an unrelated product.
export async function clickAddToCartOnMatchedLeclercCardOnPage(expectedName, expectedPriceEuro, quantity) {
  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const normalize = (value) =>
    String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const tokenize = (value) => new Set(normalize(value).split(' ').filter((token) => token.length > 1));
  const expectedTokens = tokenize(expectedName);

  const allCards = [
    ...document.querySelectorAll('div[class*="liste-produit-element"]:not([class*="vide"])'),
    ...document.querySelectorAll('[data-product-id], [data-product], [itemtype*="Product"], article, li')
  ];
  let best = null;
  let bestScore = -1;
  for (const card of allCards) {
    const nameText = card.querySelector('.vignette-descriptif, [itemprop="name"]')?.textContent || card.textContent || '';
    // Prix : même repli à 2 paliers que readProductCandidatesOnPage — sert
    // uniquement à départager plusieurs cartes de même nom (ex. tailles de
    // pack différentes) via priceBoost ci-dessous, jamais stocké comme prix
    // final. Sans le palier pWCRS310_*, ce prix restait NaN en permanence sur
    // le template classique Leclerc (vérifié en direct le 2026-08-27),
    // désactivant ce départage sur toutes les fiches de ce template.
    const priceText = card.querySelector('.vignette-prix-ajout .vignette-prix p, .vignette-prix p')?.textContent || '';
    const integerPart = card.querySelector('.pWCRS310_PrixUnitairePartieEntiere')?.textContent?.match(/\d{1,4}/)?.[0];
    const decimalPart = card.querySelector('.pWCRS310_PrixUnitairePartieDecimale')?.textContent?.match(/\d{2}/)?.[0];
    const priceMatch = priceText.match(/(\d{1,4})[,.]\s*(\d{2})/);
    const price = priceMatch
      ? Number(`${priceMatch[1]}.${priceMatch[2]}`)
      : /^\d{1,4}$/.test(integerPart || '') && /^\d{2}$/.test(decimalPart || '')
        ? Number(`${integerPart}.${decimalPart}`)
        : NaN;
    const cardTokens = tokenize(nameText);
    let overlap = 0;
    for (const token of expectedTokens) if (cardTokens.has(token)) overlap += 1;
    const nameScore = expectedTokens.size > 0 ? overlap / expectedTokens.size : 0;
    const priceBoost = Number.isFinite(expectedPriceEuro) && Number.isFinite(price) && Math.abs(price - expectedPriceEuro) < 0.01 ? 1 : 0;
    const score = nameScore + priceBoost;
    if (score > bestScore) {
      bestScore = score;
      best = card;
    }
  }
  if (!best || bestScore < 0.4) {
    return { added: false, code: 'CART_CARD_NOT_FOUND' };
  }

  // aria-label est normalisé en chaîne vide (jamais concaténé tel quel) :
  // sans ça, un bouton sans aria-label produit littéralement le texte "null"
  // dans `signal`, ce qui empêche pour toujours l'ancrage strict /^\+$/ de
  // matcher un stepper "+" pourtant bien présent — bug réel trouvé par le
  // test de garde sur cette fonction (2026-08-27).
  // Même stepper que sur la fiche produit (<a href="#plus"
  // class="aWCRS310_More_Produit_Fiche">, relevé le 01/09) : sans ces deux
  // motifs, un ajout réussi n'était pas reconnu ici non plus.
  const isStepperControl = (element) => {
    const href = String(element.getAttribute('href') || '');
    const className = String(element.className || '');
    return (
      /^#(plus|moins|more|less)$/i.test(href) ||
      /More_Produit|Less_Produit|Moins_Produit/i.test(className) ||
      Boolean(element.closest('[class*="counter" i], [class*="stepper" i]'))
    );
  };

  const findStepper = () =>
    [...best.querySelectorAll('a, button, [role="button"]')].find((element) => {
      const signal = `${element.textContent} ${element.getAttribute('aria-label') || ''} ${element.className || ''}`;
      const href = String(element.getAttribute('href') || '');
      const text = String(element.textContent || '').trim();
      // Le "+" seulement : renvoyer le "-" ferait RETIRER des unités.
      return (
        isVisible(element) &&
        (/^#(plus|more)$/i.test(href) ||
          /More_Produit/i.test(signal) ||
          text === '+' ||
          /augmenter|increment|modifier-ajouter/i.test(signal))
      );
    });

  // Renforcement AJOUTÉ (2026-08-28) : un clic sur "+" peut être absorbé par
  // le site (stepper re-rendu pendant la mise à jour du panier), et rien ne
  // le détectait — le panier réel se retrouvait alors avec moins d'unités que
  // demandé, silencieusement. On relit donc le compteur affiché après chaque
  // clic et on retente au plus 2 fois s'il n'a pas bougé. Deux garde-fous :
  // si le compteur n'est pas lisible on garde EXACTEMENT le comportement
  // d'origine (un clic par unité, sans vérification), et on s'arrête dès que
  // la cible est atteinte — cette fonction ne peut qu'ajouter des unités,
  // jamais en retirer. Dupliqué dans chaque fonction injectée (isolation
  // d'injection).
  const readStepperValue = (stepper) => {
    const scope =
      stepper.closest?.('[class*="quantity" i], [class*="stepper" i], [class*="qty" i]') || stepper.parentElement;
    const field = scope?.querySelector(
      'input[type="number"], input[data-quantity], [data-quantity-value], .vignette-modifier-nombre'
    );
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
  // interrompu puis repris, ou double-clic utilisateur) : la carte n'affiche
  // alors plus aucun bouton "Ajouter", seulement le stepper +/-. Sans cette
  // détection, ce cas ressortait à tort en ADD_TO_CART_CONTROL_NOT_FOUND —
  // un succès déguisé en échec (point mort confirmé le 2026-08-27).
  //
  // Avant cette détection : même bandeau bloquant que sur la fiche produit
  // (divWCTD224_PopinManager, "Dernière connexion le ...", constaté en direct
  // le 01/09), qui recouvre le bas de page et empêche l'ajout. Ce chemin-ci
  // sert de repli pour les produits sans URL de fiche — sans la même
  // fermeture, ils resteraient exposés au bug corrigé sur l'autre chemin.
  // Code dupliqué volontairement : une fonction injectée ne peut référencer
  // aucun symbole extérieur.
  const findVisiblePopin = () =>
    [...document.querySelectorAll('[class*="popin" i], [id*="popin" i], [class*="modal" i], [role="dialog"]')].find(
      (element) => isVisible(element) && (element.textContent || '').trim().length > 0
    );
  for (let round = 0; round < 3; round += 1) {
    const popin = findVisiblePopin();
    if (!popin) break;
    const closeControl = [...popin.querySelectorAll('a, button, span, i, div, [role="button"]')].find((element) => {
      if (!isVisible(element)) return false;
      const label = `${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.className || ''} ${element.id || ''}`;
      return /ferm|close|croix|dismiss/i.test(label) || /^[x×✕✖]$/i.test((element.textContent || '').trim());
    });
    if (closeControl) closeControl.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const popinDeadline = Date.now() + 700;
    while (Date.now() < popinDeadline && findVisiblePopin() === popin) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (findVisiblePopin() === popin) {
      popin.style.setProperty('display', 'none', 'important');
      popin.style.setProperty('pointer-events', 'none', 'important');
      break;
    }
  }

  // Même garde que sur la fiche produit : le "+" du stepper vit dans un bloc
  // "ajouterAuPanier-counter-bloc" et ressortait donc sur /ajout/i, ce qui
  // faisait cliquer "+" au lieu d'"Ajouter" et doublait les quantités dans le
  // panier réel de l'utilisateur (constaté le 01/09).
  const addButton = [...best.querySelectorAll('a, button, [role="button"]')].find((element) => {
    if (!isVisible(element) || isStepperControl(element)) return false;
    const signal = `${element.textContent} ${element.getAttribute('aria-label')} ${element.getAttribute('title')} ${element.className || ''}`;
    return /ajout/i.test(signal);
  });

  // Sur une CARTE de résultat (contrairement à la fiche produit), le bouton
  // "Ajouter" et le stepper coexistent après un ajout : la présence du stepper
  // suffit donc à conclure, et l'exiger absent ferait re-cliquer "Ajouter" sur
  // un produit déjà au panier — soit le doublon qu'on corrige ici.
  const alreadyInCartStepper = findStepper();
  if (alreadyInCartStepper) {
    if (quantity > 1) {
      await increaseTo(alreadyInCartStepper, quantity);
    }
    return { added: true };
  }
  if (!addButton) {
    return { added: false, code: 'ADD_TO_CART_CONTROL_NOT_FOUND' };
  }

  const initialButtonState = addButton.textContent.trim();

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    addButton.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // After clicking, wait for the UI to update and verify that the item was
  // actually added to the cart. Leclerc's card state changes when an item is
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
    // Also check if the stepper appeared (indicating the item is in the cart).
    if (findStepper()) {
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

  // Leclerc's card-level control has no quantity field — it only adds one
  // unit per click. A "+" stepper appears on the card once the item is in
  // the cart; click it (quantity - 1) more times, best-effort.
  if (quantity > 1) {
    const stepper = findStepper();
    if (stepper) {
      await increaseTo(stepper, quantity);
    }
  }

  return { added: true };
}

export function isLeclercInformationPath(pathname) {
  const firstSegment = String(pathname || '').split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
  return firstSegment.startsWith('magasin-') || firstSegment.startsWith('region-');
}

function isTransactionalLeclercHost(hostname) {
  return /^(?:fd\d+|m)-courses\.leclercdrive\.fr$/i.test(hostname || '');
}

// En dessous de deux tiers des mots d'identité attendus, un résultat de la
// même famille est trop ambigu pour devenir automatiquement le prix du
// produit demandé. Il reste disponible via findLeclercNearMissCandidates,
// donc ce durcissement évite les faux positifs sans supprimer la piste
// manuelle proposée à l'utilisateur.
const MIN_LECLERC_MATCH_SCORE = 2 / 3;

// Shared ranking used both to pick the single best candidate and to surface
// same-family alternates (different pack size) for manual user validation.
// Returns entries sorted best-first; each carries `quantityDiffers` so
// callers can tell an exact-format match from a same-family one.
function rankLeclercCandidates(product, candidates) {
  const valid = candidates.filter(
    (candidate) =>
      candidate &&
      typeof candidate.name === 'string' &&
      Number.isFinite(candidate.priceEuro) &&
      candidate.priceEuro >= 0 &&
      !(candidate.dataConflicts?.length > 0) &&
      isOfficialLeclercUrl(candidate.productUrl)
  );
  // Bug généralisable confirmé par diagnostic (30/08, "Mousse aux fruits"
  // marque "CARREFOUR KIDS") : une marque non pertinente pour Leclerc
  // (concurrente, générique "U", vide...) était déjà exclue de la REQUÊTE de
  // recherche (voir hasRealLeclercBrand plus bas dans collectLeclercStore),
  // mais restait comptée dans le SCORE attendu ici — ses tokens ("carrefour",
  // "kids") ne matcheront jamais aucun produit Leclerc, ce qui gonfle
  // artificiellement le dénominateur et fait rater le seuil d'acceptation à
  // n'importe quel produit à marque distributeur concurrente, pas seulement
  // celui-ci. Même critère que la requête, pour rester cohérent.
  const brand = hasRealLeclercBrand(product.brand) ? product.brand : '';
  const expected = tokens(`${product.name} ${brand}`);
  // Pack size ("500g", "1l", "6x74g") must never sink an otherwise-correct
  // match — the same product in a different format is still the same
  // product (the user opts into accepting it via allowDifferentFormat at
  // the comparison stage; this collector's job is just to surface it
  // rather than silently drop it because a size token didn't line up).
  const expectedCore = stripNoiseTokens(stripQuantityTokens(expected));
  // Brand tokens alone (e.g. a brand-only fallback search flooding results
  // with every product from that brand) must never be enough to accept a
  // match: require at least one non-quantity, non-brand token to overlap,
  // so a "Riz basmati Lustucru" search can't silently accept a Lustucru pasta.
  const brandTokens = tokens(brand);
  const nonBrandExpected = [...expectedCore].filter((token) => !brandTokens.has(token));
  const expectedQuantity = [...expected].filter(isQuantityToken);
  // Format cible transmis par la PWA (Open Food Facts au moment du scan —
  // voir src/features/scan/openFoodFactsClient.ts) : absent pour un produit
  // ajouté manuellement ou quand OFF n'a pas cette info, auquel cas
  // targetFormat reste null et le tri ci-dessous retombe exactement sur le
  // comportement précédent (score de nom seul).
  const targetFormat = normalizeQuantity(product.baseQuantity, product.baseUnit);
  return valid
    .map((candidate) => {
      const actual = tokens(`${candidate.name} ${candidate.brand ?? ''}`);
      const actualCore = stripNoiseTokens(stripQuantityTokens(actual));
      const actualQuantity = [...actual].filter(isQuantityToken);
      const quantityDiffers =
        expectedQuantity.length > 0 &&
        actualQuantity.length > 0 &&
        !expectedQuantity.some((token) => actualQuantity.includes(token));
      const coreScore = tokenScore(expectedCore, actualCore);
      // Extrait indépendamment de targetFormat : même sans format cible connu
      // pour ce produit, le format du candidat retenu doit remonter dans
      // l'observation pour permettre le signalement cross-store côté PWA
      // (comparisonEngine.ts compare les formats Leclerc/Hyper U retenus,
      // pas seulement leur conformité à un format cible).
      const candidateFormat = parseQuantityFromName(candidate.name);
      // Sans marque attendue connue, la notion "bonne marque" ne s'applique
      // pas — matchesBrand reste true pour ne changer aucun comportement
      // existant sur ces produits (voir needsBrandEscalation plus bas, qui
      // n'agit que si hasRealLeclercBrand(product.brand) est vrai).
      const matchesBrand = brandTokens.size === 0 || [...brandTokens].some((token) => actual.has(token));
      return {
        candidate,
        // A different pack size is a real signal worth keeping (it's how
        // downstream confidence scoring distinguishes an exact match from
        // a same-brand-different-format one) — cap it just under a perfect
        // score rather than erasing the distinction entirely.
        score: quantityDiffers ? Math.min(coreScore, 0.9) : coreScore,
        hasCategoryOverlap: nonBrandExpected.length === 0 || nonBrandExpected.some((token) => actualCore.has(token)),
        quantityDiffers,
        matchesBrand,
        matchesTargetFormat: Boolean(targetFormat && quantitiesMatch(targetFormat, candidateFormat)),
        observedQuantity: candidateFormat?.quantity,
        observedUnit: candidateFormat?.unit
      };
    })
    .filter((entry) => entry.score >= MIN_LECLERC_MATCH_SCORE && entry.hasCategoryOverlap)
    // Parmi les candidats déjà valides sur le nom (filtre ci-dessus), fait
    // toujours passer un candidat au format cible EXACT devant les autres —
    // sans ça, "Purée Mousline 375g" et "Purée Mousline 1kg" matchent aussi
    // bien l'un que l'autre par le nom seul, et le parcmier arrivé dans les
    // résultats du site l'emporte arbitrairement (cas réel 31/08 : 375g chez
    // Leclerc, 1040g chez Hyper U — comparatif de deux formats différents,
    // jamais signalé). N'affecte jamais l'ACCEPTATION (déjà tranchée par le
    // filtre précédent), seulement l'ORDRE parmi des candidats déjà valides.
    .sort((left, right) => {
      if (left.matchesTargetFormat !== right.matchesTargetFormat) {
        return left.matchesTargetFormat ? -1 : 1;
      }
      return right.score - left.score;
    });
}

export function chooseLeclercProductCandidate(product, candidates) {
  const barcodeMatch =
    product.barcode &&
    candidates.find(
      (candidate) =>
        candidate &&
        typeof candidate.name === 'string' &&
        Number.isFinite(candidate.priceEuro) &&
        candidate.priceEuro >= 0 &&
        isOfficialLeclercUrl(candidate.productUrl) &&
        candidate.barcode === product.barcode
    );
  if (barcodeMatch) {
    const format = parseQuantityFromName(barcodeMatch.name);
    // Correspondance par code-barres : preuve la plus forte possible, la
    // marque est par définition la bonne quel que soit le texte affiché.
    return { ...barcodeMatch, matchScore: 1, matchesBrand: true, observedQuantity: format?.quantity, observedUnit: format?.unit };
  }

  const match = rankLeclercCandidates(product, candidates)[0];
  return match
    ? {
        ...match.candidate,
        matchScore: match.score,
        matchesBrand: match.matchesBrand,
        observedQuantity: match.observedQuantity,
        observedUnit: match.observedUnit
      }
    : null;
}

// Vrai seulement quand le produit a une marque connue réelle mais que le
// meilleur candidat retenu jusqu'ici ne la porte pas (ex: Andros retenu à la
// place de Tropicana) : dans ce cas précis, la cascade doit continuer à
// chercher un candidat de la bonne marque plutôt que de s'arrêter sur ce
// premier match. Sans marque connue, retourne toujours false (aucun
// changement de comportement pour ces produits).
function needsLeclercBrandEscalation(product, candidate) {
  return Boolean(hasRealLeclercBrand(product.brand) && candidate && candidate.matchesBrand === false);
}

// Other valid candidates found alongside `best` — a different pack size of
// the same product, but also any other candidate that cleared the
// acceptance threshold (e.g. `best` itself only scored in the 'uncertain'
// range). Surfaced so the user can manually pick one instead of silently
// trusting a low-confidence auto-pick with no visible alternative.
export function findLeclercAlternateCandidates(product, candidates, best, limit = 2) {
  if (!best) return [];
  return rankLeclercCandidates(product, candidates)
    .filter((entry) => entry.candidate.productUrl !== best.productUrl)
    .slice(0, limit)
    // observedQuantity/observedUnit sont posés par rankLeclercCandidates sur
    // l'ENTRÉE, pas sur `entry.candidate` : les omettre ici les jetait juste
    // après les avoir calculés, et privait les alternates du contrôle croisé
    // prix / prix au litre côté PWA (priceCoherence.ts) alors que leur prix
    // unitaire, lui, était bien transmis.
    .map((entry) => ({
      ...entry.candidate,
      matchScore: entry.score,
      quantityDiffers: entry.quantityDiffers,
      observedQuantity: entry.observedQuantity,
      observedUnit: entry.observedUnit
    }));
}

// Quasi-matchs : contrairement à `rankLeclercCandidates`, n'applique NI le
// seuil d'acceptation (score >= 2/3) NI la garde de recouvrement de
// catégorie — c'est précisément ce qu'on veut voir ici, puisque cette
// fonction ne sert qu'à peupler `PRODUCT_NOT_FOUND` avec "voici ce qu'on a
// trouvé de plus proche, mais on n'était pas assez sûr pour l'accepter",
// afin que l'utilisateur ait toujours une piste actionnable plutôt qu'un
// échec sec. Un score plancher très bas (0.15) écarte seulement le bruit
// pur (aucun mot en commun), pas les quasi-matchs légitimement faibles.
export function findLeclercNearMissCandidates(product, candidates, limit = 3, minScore = 0.15) {
  const valid = (candidates ?? []).filter(
    (candidate) =>
      candidate &&
      typeof candidate.name === 'string' &&
      Number.isFinite(candidate.priceEuro) &&
      candidate.priceEuro >= 0 &&
      isOfficialLeclercUrl(candidate.productUrl)
  );
  // Même correction que rankLeclercCandidates ci-dessus : une marque non
  // pertinente pour Leclerc ne doit pas non plus fausser le score des
  // quasi-matchs affichés à l'utilisateur.
  const brand = hasRealLeclercBrand(product.brand) ? product.brand : '';
  const expectedCore = stripNoiseTokens(stripQuantityTokens(tokens(`${product.name} ${brand}`)));
  return valid
    .map((candidate) => {
      const actualCore = stripNoiseTokens(stripQuantityTokens(tokens(`${candidate.name} ${candidate.brand ?? ''}`)));
      return { candidate, score: tokenScore(expectedCore, actualCore) };
    })
    .filter((entry) => entry.score > minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => ({ ...entry.candidate, matchScore: entry.score }));
}

async function runPageAction(scripting, tabId, func, args) {
  const results = await executeScriptWithTimeout(scripting, { target: { tabId }, func, args });
  return results?.[0]?.result;
}

// Diagnostic réel (29/08, run après le correctif de sonde de survie) : un
// SCRIPT_EXECUTION_TIMEOUT sur la soumission de recherche (startProductSearchOnPage)
// a frappé 4 produits DIFFÉRENTS dans une même collecte, sans lien avec le
// contenu de leurs requêtes (noms simples, sans accent piégeux ni caractère
// spécial) — ce timeout couvre l'appel `scripting.executeScript` lui-même,
// pas la logique de recherche en page : il se déclenche quand le pont
// d'injection ne répond pas, typiquement un bref gel du fil principal de
// l'onglet (vérification anti-bot Datadome active sur ce site, cf.
// `botProtectionHint` des diagnostics). C'est donc un aléa ponctuel côté
// navigateur/site, pas un bug de recherche — une seule nouvelle tentative
// après une courte pause absorbe la plupart de ces accrocs avant d'abandonner
// ce produit (repli existant : sonde de survie puis passage au produit
// suivant si la 2e tentative échoue aussi).
async function runPageActionWithTimeoutRetry(scripting, tabId, func, args, signal) {
  try {
    return await runPageAction(scripting, tabId, func, args);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'SCRIPT_EXECUTION_TIMEOUT') throw error;
    await wait(randomJitterMs(500, 1_200), signal);
    return await runPageAction(scripting, tabId, func, args);
  }
}

// Empreinte d'une liste de cartes lues, utilisée pour détecter qu'une lecture
// retombe sur les mêmes cartes qu'une lecture précédente alors qu'une
// nouvelle recherche a été soumise entre les deux — signe qu'elle a
// probablement échoué en silence plutôt que qu'elle a légitimement renvoyé
// les mêmes résultats.
//
// Volontairement basée sur nom+prix, PAS sur `productUrl` : comme documenté
// dans readProductCandidatesOnPage() ci-dessous, une vraie carte résultat
// Leclerc n'a jamais de lien direct vers sa fiche produit ("Ajouter au
// panier" l'ajoute en JS, pas de <a href>) — `productUrl` y retombe donc
// presque toujours sur le lien "voir le rayon" (souvent identique pour
// toutes les cartes d'une même page) ou sur `location.href` (strictement
// identique pour TOUTES les cartes). Une empreinte basée là-dessus se
// répétait alors massivement entre deux lectures réellement différentes
// (étage suivant du même produit, produit suivant), et ce garde-fou
// effaçait à tort des résultats bien réels et visibles à l'écran —
// confirmé par un diagnostic réel où `candidateCount` restait à 0 à tous
// les étages malgré 27 à 33 cartes visibles sur la page.
function fingerprintCandidates(candidates) {
  return (candidates ?? [])
    .map((candidate) => `${candidate.name || ''}::${candidate.priceEuro ?? ''}`)
    .sort()
    .join('|');
}

function leclercCandidateIdentity(candidate) {
  return candidate?.externalProductId
    ? `id:${candidate.externalProductId}`
    : candidate?.barcode
      ? `ean:${candidate.barcode}`
      : candidate?.productUrl
        ? `url:${candidate.productUrl}`
        : `name-price:${candidate?.name || ''}|${candidate?.priceEuro ?? ''}`;
}

// Une grille Leclerc virtualisée peut rendre la même carte plusieurs fois :
// d'abord son squelette partiellement hydraté, puis ses métadonnées complètes.
// On conserve une seule identité et on complète uniquement les champs absents ;
// une valeur déjà observée n'est jamais remplacée silencieusement.
export function mergeLeclercCandidateSnapshots(existingCandidates, newCandidates) {
  const conflictSensitiveFields = new Set(['barcode', 'priceEuro', 'unitPriceEuro', 'unitPriceUnit']);
  const mergedByIdentity = new Map(
    (existingCandidates || []).map((candidate) => [leclercCandidateIdentity(candidate), { ...candidate }])
  );
  for (const candidate of newCandidates || []) {
    if (!candidate) continue;
    const identity = leclercCandidateIdentity(candidate);
    const existing = mergedByIdentity.get(identity);
    if (!existing) {
      mergedByIdentity.set(identity, { ...candidate });
      continue;
    }
    for (const [field, value] of Object.entries(candidate)) {
      if (value === undefined || value === null || value === '') continue;
      if (existing[field] === undefined || existing[field] === null || existing[field] === '') {
        existing[field] = value;
      } else if (
        conflictSensitiveFields.has(field) &&
        existing[field] !== value
      ) {
        existing.dataConflicts = [...new Set([...(existing.dataConflicts || []), field])];
      }
    }
  }
  return [...mergedByIdentity.values()];
}

async function waitForProductCandidates({
  scripting,
  tabId,
  reader,
  signal,
  expectedQuery,
  requireSearchRoute,
  timeoutMs = 15_000,
  // Budget dédié, distinct du budget total : si la route de recherche n'a
  // jamais pu être confirmée dans ce délai (pattern d'URL différent selon le
  // contexte desktop/mobile, ou SPA qui ne pousse pas d'URL dédiée), on
  // continue quand même à lire les cartes plutôt que de brûler tout le
  // timeout à attendre une confirmation qui ne viendra jamais — mais
  // `routeVerified` reste `false` pour le signaler dans le diagnostic.
  routeCheckBudgetMs = 4_000
}) {
  // 15s: reduced from 22s after fixing card matching logic (2026-07-29).
  // DataDome's bot-check adds variable delay, but improved matching means
  // we find cards faster. Still accounts for lazy-render + consent widget.
  // Callers with a speculative, likely-empty query (e.g. searching by raw
  // EAN text, which Leclerc's search box may not index at all) can pass a
  // shorter timeoutMs so a dead-end doesn't cost every product a full 15s
  // before falling through to the real name-based search tiers.
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const routeCheckDeadline = startedAt + Math.min(routeCheckBudgetMs, timeoutMs);
  let routeVerified = requireSearchRoute ? false : undefined;
  let routeCheckExhausted = !requireSearchRoute;
  // Instrumentation légère (30/08, 2e passage) : le parcmier correctif du
  // scroll (stableRounds prématuré) n'a RIEN changé pour "Emmental râpé"
  // (candidateCount identique, 8/23, avant/après sur 3 runs) — preuve que le
  // vrai facteur limitant n'était pas celui-là. Plutôt que reformuler une
  // nouvelle hypothèse à l'aveugle, ces quelques champs remontent jusqu'au
  // diagnostic exporté (recordStageAttempt) de quoi trancher entre les
  // causes candidates sans repasser par une session de debug complète :
  // combien de tours la boucle a réellement faits, combien de temps a été
  // consommé par la vérification de route avant de basculer sur le
  // scroll/lecture, et s'il restait encore des cartes non chargées au
  // moment où on a rendu la main (signe que c'est bien le budget total qui
  // a manqué, pas un vrai plateau).
  let roundCount = 0;
  let routeCheckElapsedMs = requireSearchRoute ? null : 0;
  let lastRemainingPlaceholders = null;
  // Bug racine confirmé par cette même instrumentation (30/08, 3e passage,
  // diagnostic réel "Mousse aux fruits") : sur une page Datadome dégradée
  // (container résultat resté vide, ni carte ni placeholder ni bandeau
  // "aucun résultat ne correspond" — juste un DOM figé), la boucle a tourné
  // 20 fois pendant les 15s COMPLÈTES du budget du stage sans jamais rien
  // détecter, alors que 0 placeholder ET 0 candidat étaient déjà visibles
  // dès le tout premier tour. Ni la garde "no results confirmed" ni la garde
  // "remaining === 0" (qui suppose qu'il y a EU des candidats) ne couvrent
  // ce cas : une page qui ne charge jamais rien n'est ni "vide confirmée"
  // ni "en cours de chargement". Sans détection dédiée, ce budget entier est
  // gaspillé sur un stage qui n'aboutira jamais, retardant d'autant les
  // étages suivants de la cascade pour ce même produit (et donc tous les
  // produits suivants de la collecte). Seuil volontairement généreux (5
  // tours consécutifs, ~2,5-3,5s au rythme observé de ~500-750ms/tour sur
  // une page vide) pour ne jamais couper une page légitimement lente à
  // monter son composant Angular — seulement une page qui reste
  // structurellement figée sur plusieurs tours d'affilée.
  const STUCK_EMPTY_ROUNDS_THRESHOLD = 5;
  let consecutiveEmptyRounds = 0;
  // Bug généralisable identifié le 30/08 (diagnostics réels : Panzani/Emmental
  // ne remontant que 3 candidats un run, quand une recherche comparable en
  // trouve 17-21 un autre) : triggerLeclercLazyLoadOnPage a son propre budget
  // dur de 2500ms — sur une longue liste (20+ résultats) ou un rendu ralenti
  // (Datadome), il peut rendre la main avant d'avoir tout chargé. Sans garde,
  // la boucle ci-dessous retournait dès le PREMIER candidat non-vide lu, même
  // partiel, sans jamais redonner sa chance au lazy-load de continuer — le
  // bon produit pouvait être juste en dessous, encore un placeholder vide.
  //
  // Root cause confirmée par une inspection en direct sur le vrai site (30/08,
  // recherche "PRÉSIDENT", 23 résultats) : la liste Leclerc VIRTUALISE son DOM
  // — Angular décharge (revide) les cartes déjà rendues dès qu'on scroll loin
  // d'elles, pour les recharger seulement si on y revient. Un scroll cumulatif
  // qui parcourt toute la liste une fois (voir triggerLeclercLazyLoadOnPage)
  // charge donc bien chaque carte AU PASSAGE, mais le compte de placeholders
  // vides "remainingPlaceholders" observé À LA FIN d'un tour n'est PAS
  // monotone décroissant : des cartes déjà vues peuvent redevenir vides dès
  // qu'on avance plus loin dans la liste. Se fier à ce compte pour juger de la
  // complétude (comme faisait la version précédente) sous-estime donc combien
  // de candidats ont réellement été vus. On accumule à la place, à travers les
  // tours de cette boucle, TOUS les candidats jamais lus (dédupliqués par
  // barcode/id externe/nom+prix) — un candidat déjà vu puis reviedé par la
  // virtualisation n'est jamais perdu — et on juge la stabilité sur la TAILLE
  // de cet accumulateur plutôt que sur le compte de placeholders vides.
  let previousCandidateCount = 0;
  // Tolère 2 tours consécutifs sans nouveau candidat accumulé avant
  // d'abandonner, plutôt que de rendre la main au tout premier plateau.
  // Régression réelle confirmée en conditions de terrain (30/08,
  // "Orangensaft" — recherche "Tropicana", bandeau "6 résultats affichés") :
  // le chargement par IntersectionObserver avance par à-coups (3 cartes
  // remplies, un tour entier sans qu'aucune carte de plus n'apparaisse — le
  // scroll n'avait pas encore atteint leur zone —, puis les 3 restantes se
  // chargent au tour suivant). Couper dès le parcmier plateau retournait un
  // jeu de 3 candidats sur 6, dont aucun n'était le bon produit — celui-ci
  // était systématiquement parmi les 3 placeholders qui restaient à charger.
  let stableRounds = 0;
  let bestCandidatesSoFar = null;
  let accumulatedCandidates = [];
  const mergeCandidates = (newCandidates) => {
    accumulatedCandidates = mergeLeclercCandidateSnapshots(accumulatedCandidates, newCandidates);
    return accumulatedCandidates;
  };
  while (Date.now() < deadline) {
    roundCount += 1;
    if (signal.aborted) throw new Error('DRIVE_JOB_CANCELLED');
    try {
      // The cookie banner can reappear after a client-side route change
      // (fresh SPA navigation to recherche.aspx) and re-cover the results;
      // re-dismissing here is a cheap no-op once it's already gone.
      await runCookieConsentDismissal(scripting, tabId);
      if (requireSearchRoute && !routeVerified && !routeCheckExhausted) {
        const navigation = await runPageAction(
          scripting,
          tabId,
          inspectLeclercSearchNavigationOnPage,
          [expectedQuery]
        );
        if (navigation?.ready) {
          routeVerified = true;
          routeCheckElapsedMs = Date.now() - startedAt;
        } else if (navigation?.doubleEncoded || Date.now() >= routeCheckDeadline) {
          // URL double-encodée détectée (voir inspectLeclercSearchNavigationOnPage) :
          // route-check n'a aucune chance d'aboutir tant que l'URL n'est pas
          // corrigée. Ne pas attendre routeCheckDeadline (4s) pour rien —
          // tomber tout de suite au reader ci-dessous, qui corrige l'URL
          // (location.assign) en un seul appel.
          routeCheckExhausted = true;
          routeCheckElapsedMs = Date.now() - startedAt;
        } else {
          await wait(500, signal);
          continue;
        }
      }
      // Leclerc renders every result as an empty placeholder
      // (class="liste-produit-element-vide v-produit-NNNN") and only fills
      // in the name/price once that placeholder scrolls into view
      // (IntersectionObserver-driven lazy render). Without this, the DOM
      // genuinely has zero product content even when the page banner says
      // "27 résultats affichés" — confirmed via diagnostic HTML dump.
      //
      // Budget volontairement raccourci (1000ms au lieu des 2500ms par
      // défaut de triggerLeclercLazyLoadOnPage) : retour explicite
      // utilisateur du 31/08 — sous virtualisation, une carte peut se
      // charger PUIS se décharger avant même d'avoir été lue une seule fois,
      // puisque `reader` (juste en dessous) n'est appelé qu'APRÈS la fin du
      // scroll. Un budget plus court fait boucler ce même tour plus souvent
      // (la boucle `while` de ce bloc reste inchangée) — donc `reader` lit
      // plus fréquemment, plus tôt après le chargement de chaque carte, sans
      // rien changer à la logique de sortie (remaining_zero/stable_plateau)
      // ni dupliquer le lecteur dans la fonction de scroll elle-même.
      const lazyLoadResult = await runPageAction(scripting, tabId, triggerLeclercLazyLoadOnPage, [1000]);
      const remainingThisRound = lazyLoadResult?.remainingPlaceholders ?? null;
      lastRemainingPlaceholders = remainingThisRound ?? lastRemainingPlaceholders;
      const candidatesThisRound = await runPageAction(scripting, tabId, reader, []);
      if (Array.isArray(candidatesThisRound) && candidatesThisRound.length > 0) {
        const candidates = mergeCandidates(candidatesThisRound);
        bestCandidatesSoFar = candidates;
        // `remaining === 0` reste un signal de retour rapide fiable pour le
        // cas courant (liste courte, pas de virtualisation en jeu) — mais
        // n'est PAS garanti d'être atteint sur une liste longue virtualisée
        // (voir commentaire plus haut) : dans ce cas, on se rabat sur la
        // stabilité du nombre de candidats ACCUMULÉS.
        const remaining = lazyLoadResult?.remainingPlaceholders ?? 0;
        if (remaining === 0) {
          return { candidates, routeVerified, diag: { roundCount, routeCheckElapsedMs, elapsedMs: Date.now() - startedAt, lastRemainingPlaceholders, routeVerified, exitReason: 'remaining_zero' } };
        }
        stableRounds = candidates.length > previousCandidateCount ? 0 : stableRounds + 1;
        previousCandidateCount = candidates.length;
        if (stableRounds >= 2) {
          return { candidates, routeVerified, diag: { roundCount, routeCheckElapsedMs, elapsedMs: Date.now() - startedAt, lastRemainingPlaceholders, routeVerified, exitReason: 'stable_plateau' } };
        }
        // On redonne un tour à la boucle pour laisser triggerLeclercLazyLoadOnPage
        // charger les cartes restantes (toujours dans la limite du budget
        // total `deadline`) — `continue` explicite pour ne PAS retomber dans
        // le check "aucun résultat" juste en dessous : il ne concerne que le
        // cas candidates vide, pas "on a des candidats mais on en attend
        // encore" (sans lui, un objet `{dismissed: false}` de cookie-consent,
        // toujours truthy, serait mal interprété comme "aucun résultat
        // confirmé" au prochain appel réellement destiné à ce check).
        //
        // Réduit de 500ms à 200ms le 31/08, en cohérence avec le budget de
        // scroll par tour désormais raccourci (voir triggerLeclercLazyLoadOnPage
        // ci-dessus, appelé avec 1000ms) : ce tour boucle maintenant bien plus
        // souvent, une attente fixe de 500ms entre chaque aurait annulé une
        // bonne partie du gain de fréquence de lecture. 200ms reste le même
        // ordre de grandeur que le délai de settling déjà utilisé entre
        // paliers de scroll interne (voir plus bas).
        await wait(200, signal);
        continue;
      }
      // A genuinely empty search (the "Aucun résultat ne correspond" banner)
      // is otherwise indistinguishable from "results are still loading" —
      // both read as an empty candidates array — so without this check every
      // dead-end search burned the FULL timeoutMs polling every 500ms before
      // giving up, even though the page had already conclusively said "no
      // results" on the very first poll. Confirmed in a real diagnostic
      // export: a brand-only fallback search for "U" (a private-label brand
      // name, not a real search term — see hasRealLeclercBrand below) sat on
      // an "Aucun résultat" page for the full 15s before moving on, for every
      // affected product.
      if (await runPageAction(scripting, tabId, isLeclercNoResultsConfirmedOnPage, [])) {
        return { candidates: [], routeVerified, diag: { roundCount, routeCheckElapsedMs, elapsedMs: Date.now() - startedAt, lastRemainingPlaceholders, routeVerified, exitReason: 'no_results_confirmed' } };
      }
      consecutiveEmptyRounds = remainingThisRound === 0 ? consecutiveEmptyRounds + 1 : 0;
      if (consecutiveEmptyRounds >= STUCK_EMPTY_ROUNDS_THRESHOLD) {
        return { candidates: [], routeVerified, diag: { roundCount, routeCheckElapsedMs, elapsedMs: Date.now() - startedAt, lastRemainingPlaceholders, routeVerified, exitReason: 'stuck_empty_page' } };
      }
    } catch (error) {
      // Tester #13 (audit 30/08) : un SCRIPT_EXECUTION_TIMEOUT ici (un appel
      // injecté figé, pas juste "pas encore de résultats") était avalé
      // silencieusement comme les autres erreurs transitoires de ce catch
      // (contexte d'exécution invalidé par une navigation en cours) — la
      // boucle continuait à sonder jusqu'à épuiser tout le budget, puis
      // renvoyait `{ candidates: [] }` comme un simple "aucun résultat", sans
      // jamais déclencher la sonde de survie/l'abandon de magasin que le même
      // timeout déclenche partout ailleurs dans ce fichier (voir
      // collectLeclercStore). Repropagé pour que l'appelant le traite
      // exactement comme un timeout survenu n'importe où ailleurs.
      if (error instanceof Error && error.message === 'SCRIPT_EXECUTION_TIMEOUT') throw error;
      // Toute autre erreur reste ignorée : navigation en cours qui invalide
      // temporairement le contexte d'exécution injecté.
    }
    // Réduit de 500ms à 200ms le 31/08 — même raison que le wait() jumeau
    // plus haut dans cette boucle (budget de scroll par tour raccourci).
    await wait(200, signal);
  }
  // Budget total épuisé pendant qu'on attendait plus de cartes (voir
  // bestCandidatesSoFar ci-dessus) : mieux vaut rendre le dernier jeu partiel
  // déjà lu que repartir bredouille, exactement comme le comportement
  // d'origine pour tout candidat trouvé au tout premier passage.
  return {
    candidates: bestCandidatesSoFar ?? [],
    routeVerified,
    diag: { roundCount, routeCheckElapsedMs, elapsedMs: Date.now() - startedAt, lastRemainingPlaceholders, routeVerified, exitReason: 'deadline_exhausted' }
  };
}

function isLeclercNoResultsConfirmedOnPage() {
  return /aucun résultat ne correspond/i.test(document.body?.textContent || '');
}

function inspectLeclercSearchNavigationOnPage(expectedQuery) {
  let url;
  try { url = new URL(location.href); } catch { return { ready: false }; }
  const expected = String(expectedQuery || '').trim().toLowerCase();
  // Bug réel du SPA Leclerc (confirmé en direct le 30/08, un simple clic
  // isolé suffit à le produire, sans aucune redondance de soumission côté
  // extension — voir le commentaire dans startProductSearchOnPage) : l'URL
  // de résultat peut être poussée double-encodée (`%2520` au lieu de
  // `%20`). Un `decodeURIComponent` unique laisse alors des "%20" littéraux
  // dans le texte, qui ne correspondront JAMAIS à `expected` : sans ce
  // garde, `ready` reste `false` indéfiniment et la boucle appelante
  // (waitForProductCandidates) brûle tout `routeCheckBudgetMs` (4s) à
  // republic sonder une route qui ne se corrigera jamais toute seule côté
  // route-check, alors que le reader (readProductCandidatesOnPage) sait déjà
  // corriger cette même URL en un seul appel. Signaler `doubleEncoded` permet
  // à l'appelant de court-circuiter l'attente et de laisser le reader agir
  // immédiatement plutôt que d'épuiser le budget pour rien.
  if (url.pathname.includes('%25') || url.search.includes('%25')) {
    return { ready: false, doubleEncoded: true };
  }
  // Route desktop historique : /recherche.aspx?TexteRecherche=<query>.
  if (/\/recherche\.aspx$/i.test(url.pathname)) {
    const actualQuery = url.searchParams.get('TexteRecherche') || '';
    return { ready: actualQuery.trim().toLowerCase() === expected };
  }
  // Route mobile (m-courses.leclercdrive.fr) : la requête est un SEGMENT de
  // chemin encodé URL, pas un paramètre de requête — confirmé via export
  // diagnostic réel (30/08) : ".../magasin-123456-123456/recherche/PR%C3%89SIDENT".
  // Sans ce cas, `ready` ne passait JAMAIS à true sur mobile (seule route
  // vue en pratique dans tous les diagnostics de cette session) : le budget
  // `routeCheckBudgetMs` était systématiquement épuisé pour rien, et
  // `routeVerified` restait toujours `false` — y compris pour une recherche
  // qui avait pourtant parfaitement abouti.
  const mobileMatch = url.pathname.match(/\/recherche\/([^/?#]+)\/?$/i);
  if (mobileMatch) {
    let actualQuery = mobileMatch[1];
    try {
      actualQuery = decodeURIComponent(actualQuery);
    } catch {
      // Segment déjà décodé ou malformé : comparer tel quel plutôt que
      // planter cette vérification, purement diagnostique.
    }
    return { ready: actualQuery.trim().toLowerCase() === expected };
  }
  return { ready: false };
}

async function inspectProductResults(scripting, tabId, inspector) {
  try {
    return (await runPageAction(scripting, tabId, inspector, [])) ?? {};
  } catch {
    return { inspectionFailed: true };
  }
}

function failed(store, code, details, keepTabOpen = false) {
  return {
    observations: [],
    errors: [{ storeKey: store.storeKey, code, ...(details ? { details } : {}) }],
    keepTabOpen
  };
}

async function selectOfficialLeclercDrive({ scripting, tabId, store, signal }) {
  const submission = await runPageAction(scripting, tabId, submitPostalOnPage, [store]);
  if (!submission?.started) {
    return {
      started: false,
      code: submission?.code ?? 'DRIVE_SELECTION_FAILED',
      ...(submission?.details ? { details: submission.details } : {})
    };
  }
  await wait(1_500, signal);
  const choices = (await runPageAction(scripting, tabId, readDriveChoicesOnPage, [store.postalCode])) ?? [];
  const decision = chooseLeclercDriveChoice(store, choices);
  if (!decision.choice) {
    return {
      started: false,
      code: decision.code,
      details: {
        candidateCount: decision.ranked.length,
        topScores: decision.ranked.slice(0, 3).map((choice) => choice.score)
      }
    };
  }
  const click = await runPageAction(scripting, tabId, clickDriveChoiceOnPage, [
    decision.choice.actionIndex,
    decision.choice.text ?? ''
  ]);
  return click?.clicked
    ? { started: true, code: null }
    : { started: false, code: click?.code ?? 'DRIVE_RESULT_NOT_CLICKABLE' };
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timeout);
      reject(new Error('DRIVE_JOB_CANCELLED'));
    }, { once: true });
  });
}

function randomJitterMs(minMs, maxMs) {
  return minMs + Math.random() * (maxMs - minMs);
}

// Marques de distributeur d'enseignes concurrentes : quand un produit scanné
// (Open Food Facts) porte comme "marque" le nom d'une enseigne concurrente
// (ex. un lait "Carrefour"), une recherche par marque chez Leclerc ne peut
// STRUCTURELLEMENT jamais rien trouver — ce n'est pas un problème de
// scraping mais de données, aucun scroll/matching plus malin n'y changera
// rien. Confirmé sur un cas réel (2026-08-27) : deux produits à marque
// "Carrefour" ont chacun brûlé un étage de recherche complet sur la requête
// "Carrefour", pour un "Aucun résultat" garanti d'avance.
const COMPETING_RETAILER_BRANDS = new Set([
  'carrefour',
  'auchan',
  'intermarche',
  'casino',
  'monoprix',
  'cora',
  'lidl',
  'aldi',
  'super u',
  'hyper u',
  'systeme u',
  'leader price',
  'franprix'
]);

export function hasRealLeclercBrand(brand) {
  // "U" is Leclerc's own generic private-label brand (not a real,
  // distinguishing brand name) — confirmed via a real diagnostic export
  // where a brand-only search literally submitted "U" as the query and sat
  // on Leclerc's own "Aucun résultat ne correspond à votre recherche 'U'"
  // page every time. A single-character query is also too generic for any
  // retailer's search box to return anything useful.
  if (!brand || brand.trim().length <= 1 || /^(?:marque habituelle|sans marque|u)$/i.test(brand)) return false;
  const normalized = brand.trim().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  // Bug réel confirmé par diagnostic (30/08, "Mousse aux fruits" marque
  // "CARREFOUR KIDS") : `COMPETING_RETAILER_BRANDS.has(normalized)` est une
  // égalité STRICTE sur toute la chaîne — "carrefour kids" ne matche jamais
  // l'entrée "carrefour" du Set, donc une sous-marque distributeur
  // concurrente ("Carrefour Kids", "Carrefour Bio", "Auchan Bébé"...) n'est
  // JAMAIS reconnue comme concurrente : sa requête 'name' inclut alors à
  // tort le nom du concurrent, un "Aucun résultat" garanti d'avance, alors
  // que le nom du produit SEUL aurait pu faire remonter un équivalent
  // générique chez Leclerc. Comparaison par MOTS (limites de mots, pas une
  // sous-chaîne brute) : chaque mot d'une entrée du Set doit apparaître tel
  // quel parmi les mots de la marque testée.
  const brandWords = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  for (const competitor of COMPETING_RETAILER_BRANDS) {
    const competitorWords = competitor.split(' ');
    if (competitorWords.every((word) => brandWords.includes(word))) return false;
  }
  return true;
}

function tokens(value) {
  const rawTokens = String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
  const normalizedTokens = [];
  for (const token of rawTokens) {
    // Les noms Open Food Facts peuvent être étrangers alors que le catalogue
    // du magasin est français. En allemand, les jus sont couramment des mots
    // composés "<fruit>saft" (Orangensaft, Apfelsaft...). Décomposer le
    // suffixe de façon morphologique est généralisable et reste prudent : le
    // fruit doit encore recouper le candidat, "jus" seul ne franchit pas le
    // seuil d'acceptation.
    const germanJuice = token.match(/^(.{3,})saft$/);
    if (germanJuice) {
      // Les composés allemands insèrent souvent un `n` de liaison
      // (Orange -> Orangen-saft). Le retirer du radical permet de retrouver
      // le nom international du fruit sans dictionnaire produit par produit.
      normalizedTokens.push(germanJuice[1].replace(/n$/, ''), 'jus');
    } else {
      normalizedTokens.push(token);
    }
  }
  return new Set(normalizedTokens);
}

function tokenScore(expected, actual) {
  if (expected.size === 0) return 0;
  let common = 0;
  for (const token of expected) if (actual.has(token)) common += 1;
  return common / expected.size;
}

// Matches a pack-size/quantity token as produced by tokens() above: a bare
// number ("500"), a unit-suffixed number ("500g", "1l"), or a multiplier
// pattern ("6x74g", "6x", "x74g"). Used to keep pack-size differences from
// sinking an otherwise-correct brand/name match.
function isQuantityToken(token) {
  return (
    /^\d+(?:[.,]\d+)?(?:g|kg|ml|cl|l)?$/.test(token) ||
    /^\d+x\d*(?:[.,]\d+)?(?:g|kg|ml|cl|l)?$/.test(token) ||
    /^x\d+(?:[.,]\d+)?(?:g|kg|ml|cl|l)?$/.test(token)
  );
}

function stripQuantityTokens(tokenSet) {
  return new Set([...tokenSet].filter((token) => !isQuantityToken(token)));
}

// Mots de formulation/conditionnement de liste de courses ("en sachet",
// "5x 2 personnes"...) qui ne figurent jamais dans le nom produit tel que
// publié par le marchand. Comptés dans `expected` (voir rankLeclercCandidates),
// ils gonflent le dénominateur du score sans jamais pouvoir matcher, ce qui
// fait chuter artificiellement le score d'un match par ailleurs parfait.
// Bug confirmé le 31/08 : "Riz basmati en sachet 5x 2 personnes" vs candidat
// réel "Riz basmati Lustucru 10min - 5x180g" — seuls riz/basmati/lustucru
// comptent vraiment pour l'identité du produit, mais en/sachet/personnes
// restaient dans le dénominateur → score 3/6 = 0.5 (statut "incertain",
// validation manuelle exigée) au lieu de 3/3 = 1 (match exact). Même
// mécanisme déjà corrigé pour les tokens de marque non pertinente
// (commentaire plus haut dans rankLeclercCandidates), appliqué ici aux mots
// de conditionnement. Volontairement séparé de stripPackagingNoiseFromSearchName
// (utilisée pour construire la requête de recherche) pour ne pas toucher au
// texte tapé dans la barre de recherche, ni à la détection de format
// différent (`quantityDiffers`) qui continue de raisonner sur les tokens de
// quantité bruts.
const MATCH_NOISE_TOKENS = new Set([
  // Articles, prépositions et conjonctions ne décrivent jamais l'identité du
  // produit. Les compter créait notamment un faux recouvrement "mousse AUX
  // fruits" ↔ "mousse AUX oeufs".
  'le', 'la', 'les', 'un', 'une', 'de', 'du', 'des', 'au', 'aux', 'et',
  // Formulation/conditionnement propre aux listes de courses.
  'en', 'sachet', 'sachets', 'pour', 'personne', 'personnes', 'portion', 'portions',
  // Qualificatifs marketing présents côté Open Food Facts mais absents du
  // libellé catalogue Leclerc pour le même produit (bug réel confirmé par
  // diagnostic 01/09 : "Tropicana 100% oranges PRESSÉES sans pulpe 1 L" vs
  // fiche Leclerc "Jus Tropicana Orange sans pulpe - 90cl" — même produit,
  // même marque, mais score 3/5=0.6 au lieu de 3/4=0.75 à cause du seul mot
  // "pressées", jamais repris par le nom court du site marchand). Comme pour
  // les autres entrées de ce Set, ne retire ces mots QUE du calcul de score,
  // jamais de la requête envoyée au moteur de recherche.
  'presse', 'presses', 'pressee', 'pressees'
]);

function stripNoiseTokens(tokenSet) {
  return new Set([...tokenSet].filter((token) => !MATCH_NOISE_TOKENS.has(token)));
}

function isOfficialLeclercUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'leclercdrive.fr' || url.hostname.endsWith('.leclercdrive.fr'))
    );
  } catch {
    return false;
  }
}

// Une URL Leclerc n'est un lien direct exploitable que si elle pointe vers
// une vraie fiche produit standalone — motif confirmé en direct (2026-08-28,
// pick manuel utilisateur sur "Boisson soja nature") :
// "/fiche-produits-<id>-<slug>.aspx". L'URL d'une simple page de résultats
// de recherche ("/recherche/<query>") est, elle, PARTAGÉE par tous les
// produits de cette recherche — la retenter directement comme si elle était
// propre à ce produit reproduirait le bug historique déjà documenté sur
// addToCartLeclercStore (aucun bouton d'ajout propre à trouver dessus).
function isLeclercStandaloneProductUrl(value) {
  if (!isOfficialLeclercUrl(value)) return false;
  try {
    return /\/fiche-produits?-/i.test(new URL(value).pathname);
  } catch {
    return false;
  }
}

export async function submitPostalOnPage(store) {
  const findPostalInput = () => [...document.querySelectorAll('input')].find((input) => {
    const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : '';
    const containerText = input.closest('label, form, fieldset, [role="dialog"]')?.textContent || '';
    const signal = `${input.name} ${input.id} ${input.placeholder} ${input.autocomplete} ${input.getAttribute('aria-label')} ${label} ${containerText}`;
    return /postal|zip|code.{0,12}postal|où souhaitez-vous|ville|localis|récupérer vos courses/i.test(signal);
  });

  let postalInput = findPostalInput();
  if (!postalInput) {
    const opener = [...document.querySelectorAll('button, a, [role="button"]')].find((element) =>
      /choisir|sélectionner|selectionner|changer|trouver/i.test(element.textContent || '') &&
      /magasin|drive|retrait|livraison/i.test(element.textContent || '')
    );
    if (opener?.removeAttribute) opener.removeAttribute('target');
    opener?.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
    postalInput = findPostalInput();
  }

  const query = String(store.postalCode || store.city || '').trim();
  if (!postalInput || !query) return { started: false, code: 'POSTAL_INPUT_NOT_FOUND' };

  postalInput.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(postalInput, query);
  else postalInput.value = query;
  postalInput.dispatchEvent(new Event('input', { bubbles: true }));
  postalInput.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 1_800));

  const normalize = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const postalCode = String(store.postalCode || '').trim();
  const city = normalize(store.city);
  const options = [...document.querySelectorAll('[role="option"]')]
    .map((option) => {
      const text = (option.textContent || '').replace(/\s+/g, ' ').trim();
      let score = 0;
      if (postalCode && text.includes(postalCode)) score += 10;
      if (city && normalize(text).includes(city)) score += 5;
      return { option, text, score };
    })
    .filter(({ text }) => text.length > 0)
    .sort((left, right) => right.score - left.score);
  const choice = options[0];
  if (!choice) return { started: false, code: 'POSTAL_AUTOCOMPLETE_NOT_FOUND', details: { query, optionCount: 0 } };

  // The autocomplete is a React (HeadlessUI) combobox: a bare .click() does not
  // trigger its selection handler, so dispatch the full pointer sequence.
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    choice.option.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  return { started: true, query, selectedLocation: choice.text };
}

export function collectLeclercStoreBlocks() {
  // Current leclercdrive.fr renders each nearby store as a clickable block
  // tagged data-track-libelle="Clic bloc magasin <name> (<postal>)".
  const trackBlocks = [...document.querySelectorAll('[data-track-libelle]')].filter((el) =>
    /clic bloc magasin/i.test(el.getAttribute('data-track-libelle') || '')
  );
  if (trackBlocks.length > 0) {
    return trackBlocks.map((block) => ({
      element: block,
      controlText: (block.getAttribute('data-track-libelle') || '').replace(/^clic bloc magasin\s*/i, '').trim(),
      text: (block.textContent || '').replace(/\s+/g, ' ').trim()
    }));
  }
  // Legacy layout: service/store cards headed by an h2/h3.
  return [...document.querySelectorAll('h2, h3')]
    .map((heading) => heading.parentElement)
    .filter((card) => card && /drive|retrait piéton|livraison à domicile/i.test(card.textContent || ''))
    .map((card) => ({
      element: card,
      controlText: (card.querySelector('h2, h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
      text: (card.textContent || '').replace(/\s+/g, ' ').trim()
    }));
}

// Duplique la logique de collectLeclercStoreBlocks() (exportée plus haut,
// pour ses propres tests unitaires) DIRECTEMENT DANS CHACUNE des deux
// fonctions ci-dessous, plutôt que de l'appeler ou de la factoriser dans un
// helper partagé : chacune est injectée isolément dans l'onglet via
// `scripting.executeScript({ func })`, qui ne sérialise QUE le code source de
// la fonction ciblée — tout appel vers une autre fonction du module (même
// exportée, même un helper local juste au-dessus) lève une ReferenceError à
// l'exécution dans l'onglet, puisqu'il n'existe plus une fois isolé. Même
// bug, même mécanisme que celui corrigé sur readProductCandidatesOnPage /
// fixDoubleEncodedLeclercUrl (voir son commentaire) : latent ici (pas prouvé
// actif sur le diagnostic du 2026-08-27, car la sélection du Drive avait déjà
// une session existante ce jour-là et n'est pas repassée par ce chemin), mais
// romprait la sélection du Drive officiel dès qu'elle est réellement
// nécessaire (premier lancement, cookies/session effacés, autre appareil).
export function readDriveChoicesOnPage(postalCode) {
  const trackBlocks = [...document.querySelectorAll('[data-track-libelle]')].filter((el) =>
    /clic bloc magasin/i.test(el.getAttribute('data-track-libelle') || '')
  );
  const blocks = trackBlocks.length > 0
    ? trackBlocks.map((block) => ({
        controlText: (block.getAttribute('data-track-libelle') || '').replace(/^clic bloc magasin\s*/i, '').trim(),
        text: (block.textContent || '').replace(/\s+/g, ' ').trim()
      }))
    : [...document.querySelectorAll('h2, h3')]
        .map((heading) => heading.parentElement)
        .filter((card) => card && /drive|retrait piéton|livraison à domicile/i.test(card.textContent || ''))
        .map((card) => ({
          controlText: (card.querySelector('h2, h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
          text: (card.textContent || '').replace(/\s+/g, ' ').trim()
        }));
  return blocks.map((block, actionIndex) => ({
    actionIndex,
    text: block.text,
    controlText: block.controlText,
    postalMatch: Boolean(postalCode && block.text.includes(postalCode))
  }));
}

// `actionIndex` est une POSITION dans le DOM, capturée par
// readDriveChoicesOnPage lors d'une injection précédente. Entre les deux
// injections, la page de résultats a pu se re-rendre (résultats affinés,
// bannière de consentement refermée, bloc magasin chargé en différé) : la
// même position désigne alors un autre magasin, et on validerait
// silencieusement le mauvais drive — donc tous les prix comparés ensuite.
// `expectedText` (le texte du bloc au moment du choix) est donc revérifié
// avant le clic ; une divergence ressort en DRIVE_RESULT_STALE, comme un
// index devenu hors limites.
export async function clickDriveChoiceOnPage(actionIndex, expectedText) {
  const collectStoreBlocks = () => {
    const trackBlocks = [...document.querySelectorAll('[data-track-libelle]')].filter((el) =>
      /clic bloc magasin/i.test(el.getAttribute('data-track-libelle') || '')
    );
    if (trackBlocks.length > 0) {
      return trackBlocks.map((block) => ({
        element: block,
        text: (block.textContent || '').replace(/\s+/g, ' ').trim()
      }));
    }
    return [...document.querySelectorAll('h2, h3')]
      .map((heading) => heading.parentElement)
      .filter((card) => card && /drive|retrait piéton|livraison à domicile/i.test(card.textContent || ''))
      .map((card) => ({
        element: card,
        text: (card.textContent || '').replace(/\s+/g, ' ').trim()
      }));
  };
  const block = collectStoreBlocks()[actionIndex];
  if (!block?.element) return { clicked: false, code: 'DRIVE_RESULT_STALE' };
  if (expectedText && block.text !== expectedText) return { clicked: false, code: 'DRIVE_RESULT_STALE' };

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    block.element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  if (/^(?:fd\d+|m)-courses\.leclercdrive\.fr$/i.test(location.hostname)) return { clicked: true };

  const startControl = [...document.querySelectorAll('a, button, [role="button"]')].find((control) =>
    /commencer mes courses|faire mes courses|accéder au catalogue|acceder au catalogue/i.test(control.textContent || '')
  );
  if (!startControl) return { clicked: false, code: 'DRIVE_START_CONTROL_NOT_FOUND' };
  if (startControl.removeAttribute) startControl.removeAttribute('target');
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    startControl.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  return { clicked: true };
}

function findLeclercTransactionalLinkOnPage() {
  const transactionalHostPattern = /^(?:fd\d+|m)-courses\.leclercdrive\.fr$/i;
  const links = [...document.querySelectorAll('a[href]')];
  for (const link of links) {
    let url;
    try {
      url = new URL(link.href, location.href);
    } catch {
      continue;
    }
    if (url.protocol === 'https:' && transactionalHostPattern.test(url.hostname)) {
      return { url: url.href };
    }
  }
  return { url: null };
}

// Generic page snapshot for add-to-cart diagnostics — deliberately not tied
// to the search-results markup (unlike inspectLeclercResultsOnPage above),
// since this runs on whatever page the site actually redirected to.
function inspectLeclercProductPageOnPage() {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  const scriptSrcs = [...document.querySelectorAll('script[src]')].map((s) => s.src).join(' ');
  const botProtectionHint =
    (/datadome/i.test(scriptSrcs) && 'datadome') ||
    (/akamai|_abck/i.test(scriptSrcs) && 'akamai') ||
    (/perimeterx|px-captcha|_px/i.test(scriptSrcs) && 'perimeterx') ||
    (/cloudflare|cf-chl/i.test(scriptSrcs) && 'cloudflare') ||
    null;
  return {
    url: location.href,
    pathname: location.pathname,
    pageTitle: document.title,
    bodyTextSnippet: text.slice(0, 500),
    botProtectionHint,
    hasCaptcha: /captcha|v[ée]rifier que vous [êe]tes humain/i.test(text)
  };
}

// Runs in the page world. Lecture triviale de l'URL courante — utilisée par
// addToCartLeclercStore pour mémoriser la page de recherche/catalogue sur
// laquelle se trouvait l'onglet avant toute navigation directe vers une
// fiche produit standalone (item.productUrl), afin d'y revenir explicitement
// ensuite : cette fiche vit sur un sous-domaine sans aucune zone de
// recherche exploitable (voir le commentaire dans addToCartLeclercStore).
function readCurrentLeclercUrlOnPage() {
  return { href: location.href };
}

function navigateToLeclercUrlOnPage(targetUrl) {
  let url;
  try {
    url = new URL(targetUrl);
  } catch {
    return { started: false };
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.leclercdrive.fr')) {
    return { started: false };
  }
  setTimeout(() => location.assign(url.href), 0);
  return { started: true };
}

async function enterCatalogOnPage() {
  const browserKind =
    navigator.brave && (await navigator.brave.isBrave().catch(() => false)) ? 'brave' : 'chromium';
  const pathKind = location.pathname.split('/').filter(Boolean)[0] || 'home';
  const isStoreInformationPage = pathKind.toLowerCase().startsWith('magasin-');
  const hasSearchInput = [...document.querySelectorAll('input')].some((input) => {
    const signal = `${input.type} ${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label')}`;
    return input.type === 'search' || /recherch|search/i.test(signal);
  });
  if (hasSearchInput && !isStoreInformationPage) return { ready: true, started: false };

  const control = [...document.querySelectorAll('button, a[href], [role="button"]')].find((element) => {
    const signal = `${element.textContent} ${element.getAttribute('aria-label')} ${element.getAttribute('title')}`;
    return /faire.{0,12}courses|commencer.{0,12}courses|acc[eé]der.{0,12}(?:au )?drive|commander en ligne|voir le catalogue/i.test(signal);
  });
  if (!control) {
    return {
      ready: false,
      started: false,
      code: 'CATALOG_ENTRY_NOT_FOUND',
      details: {
        inputCount: document.querySelectorAll('input').length,
        pathKind,
        hasSearchControl: false,
        browserKind
      }
    };
  }
  control.removeAttribute?.('target');
  const form = control.closest('form');
  if (form) form.target = '_self';
  setTimeout(() => control.click(), 0);
  return { ready: false, started: true };
}

async function inspectCatalogOnPage() {
  const browserKind =
    navigator.brave && (await navigator.brave.isBrave().catch(() => false)) ? 'brave' : 'chromium';
  const inputs = [...document.querySelectorAll('input')];
  const pathKind = location.pathname.split('/').filter(Boolean)[0] || 'home';
  const isStoreInformationPage = pathKind.toLowerCase().startsWith('magasin-');
  const ready = !isStoreInformationPage && inputs.some((input) => {
    const signal = `${input.type} ${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label')}`;
    return input.type === 'search' || /recherch|search/i.test(signal);
  });
  return {
    ready,
    details: {
      inputCount: inputs.length,
      pathKind,
      hasSearchControl: ready,
      browserKind
    }
  };
}

// Exportée pour être testable directement (extension/adapters/leclerc/leclerc-search-input.test.js)
// plutôt que seulement à travers tout le mock d'orchestration de collectLeclercStore.
//
// Historique important : il existait ici deux implémentations concurrentes et non
// synchronisées — un bloc ajouté le 2026-07-31 spécifique à `leclercdrive.fr`
// (mobile-first, écrit sans reprendre les correctifs ci-dessous) qui court-
// circuitait TOUJOURS le second bloc, plus ancien et plus robuste, sur le vrai
// site (le hostname contient systématiquement "leclercdrive.fr" en production).
// Le bloc mort n'a jamais bénéficié des fixs suivants, et le bloc vivant a
// réintroduit des régressions déjà corrigées par le passé — notamment un bouton
// "ok" matché par regex qui peut être un bandeau de cookies. Fusionné en un seul
// chemin ci-dessous, qui reprend tous les correctifs acquis.
export async function startProductSearchOnPage(product) {
  // A third-party tag-manager/vendor script injects its own hidden input
  // (seen in the wild as id="vendor-search-handler") that also matches the
  // generic /recherch|search/i heuristic below — it was winning the .find()
  // before the real, visible Leclerc search field ever got a chance,
  // silently swallowing every query into a dead end. Visibility + excluding
  // "vendor" filters that out.
  const isVisible = (element) => element.offsetParent !== null || element.getClientRects().length > 0;
  const findSearchInput = () => {
    // Desktop: real Leclerc search field (id="saisieTexte")
    const known = document.getElementById('saisieTexte');
    if (known instanceof HTMLInputElement && isVisible(known)) return known;

    // Mobile: id observé en prod sur m-courses.leclercdrive.fr ("WRSL301" =
    // composant Angular de recherche produit).
    const mobileById = document.getElementById('inputWRSL301_rechercheTexte');
    if (mobileById instanceof HTMLInputElement && isVisible(mobileById)) return mobileById;

    // Mobile (m-courses.leclercdrive.fr): search input with different structure
    // Look for input[type="search"] or input with placeholder containing "recherch"
    const mobileSearch = [...document.querySelectorAll('input')].find((input) => {
      if (!isVisible(input) || /vendor/i.test(input.id || '')) return false;
      // Mobile often uses type="search" or data-testid/placeholder hints
      if (input.type === 'search') return true;
      const placeholder = (input.placeholder || '').toLowerCase();
      if (placeholder.includes('recherch') || placeholder.includes('search') || placeholder.includes('produit') || placeholder.includes('marque')) return true;
      const testId = input.getAttribute('data-testid') || '';
      if (/recherch|search/i.test(testId)) return true;
      return false;
    });
    if (mobileSearch) return mobileSearch;

    // Fallback: generic search signal matching (works for both)
    return [...document.querySelectorAll('input')].find((input) => {
      if (!isVisible(input) || /vendor/i.test(input.id || '')) return false;
      const signal = `${input.type} ${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label')}`;
      return input.type === 'search' || /recherch|search/i.test(signal);
    });
  };
  // The Leclerc Angular app renders its search trigger as a plain
  // tabindex-focusable <div> ("recherche-home"), not a real <button>/<a>
  // — clicking only real interactive tags silently missed it and left the
  // collector stuck on the home page. Widen the opener search accordingly.
  const openerSelector =
    'button, a, [role="button"], [tabindex], [class*="recherche" i], [class*="search" i]';
  const isSearchOpener = (element) =>
    /recherch|search|loupe/i.test(
      // The search-results page's opener is an icon-only <a class="header-recherche">
      // with no text/aria-label at all — the class name is the only signal.
      `${element.textContent} ${element.getAttribute('aria-label')} ${element.getAttribute('title')} ${element.className || ''}`
    );
  let searchInput = findSearchInput();
  let attempt = 'immediate';
  let openerUsed = null;
  if (!searchInput) {
    // First attempt: wait longer for JS-rendered content (Angular/React on mobile)
    await new Promise((resolve) => setTimeout(resolve, 500));
    searchInput = findSearchInput();
    attempt = 'after_delay';
  }
  if (!searchInput) {
    // Second attempt: look for and click search opener
    const opener = [...document.querySelectorAll(openerSelector)].find(isSearchOpener);
    opener?.removeAttribute?.('target');
    opener?.click();
    openerUsed = opener?.className || null;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    searchInput = findSearchInput();
    attempt = 'after_opener';
  }
  if (!searchInput) {
    // Collect detailed diagnostics for debugging mobile vs desktop
    const allInputs = [...document.querySelectorAll('input')];
    const inputDetails = allInputs.map(i => ({
      type: i.type,
      id: i.id || null,
      name: i.name || null,
      class: i.className || null,
      placeholder: i.placeholder || null,
      visible: isVisible(i)
    })).slice(0, 10); // First 10 inputs

    return {
      started: false,
      code: 'PRODUCT_SEARCH_INPUT_NOT_FOUND',
      details: {
        inputCount: allInputs.length,
        pathKind: location.pathname.split('/').filter(Boolean)[0] || 'home',
        hasSearchControl: [...document.querySelectorAll(openerSelector)].some(isSearchOpener),
        inputDetails,
        hostname: location.hostname,
        url: location.href.slice(0, 100),
        attempt,
        openerUsed
      }
    };
  }
  const brand = /^(?:marque habituelle|sans marque)$/i.test(product.brand || '') ? '' : product.brand || '';
  const query = `${product.name} ${brand}`.trim();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(searchInput, query);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  const form = searchInput.closest('form');
  if (form) form.target = '_self';
  // The real Leclerc search form's confirm control is
  // <input type="button" value="ok" class="bouton-recherche"> — deliberately
  // type="button", not "submit", because the Angular app wires the search
  // to the button's click handler instead of a form submit event (avoids a
  // native page reload that would drop the SPA state). form.requestSubmit()
  // silently did nothing here; the button itself must be clicked.
  //
  // Restreint volontairement à /recherch|search/i (jamais "ok"/"go"/"loupe") :
  // un bandeau de cookies réapparu contient très souvent un bouton "OK" qui
  // matcherait un regex plus large et serait cliqué à la place du vrai bouton
  // de recherche, laissant la recherche jamais soumise.
  const submitControl = [...(form || document).querySelectorAll('button, input[type="button"], input[type="submit"]')].find(
    (element) =>
      /recherch|search/i.test(element.className || '') ||
      /recherch|search/i.test(`${element.textContent || ''} ${element.value || ''} ${element.getAttribute('aria-label') || ''}`)
  );
  const valueAfterSet = searchInput.value;
  // Régression réelle (30/08) : le retry sur SCRIPT_EXECUTION_TIMEOUT
  // (runPageActionWithTimeoutRetry) relance cette fonction dans une NOUVELLE
  // injection `scripting.executeScript` sans jamais annuler la précédente —
  // `Promise.race` ne fait qu'arrêter d'ATTENDRE la 1ère injection, elle
  // continue de tourner en page. Or son clic ci-dessous est lui-même différé
  // (voir commentaire suivant) : si le pont d'injection était juste lent (pas
  // vraiment mort), ce clic différé de la 1ère tentative peut se déclencher
  // en RETARD, PENDANT que la 2e tentative est déjà en train de naviguer —
  // deux soumissions concurrentes sur la même page, confirmé en conditions
  // réelles (RDP sur le vrai site) : la 2e navigation se superpose à la 1ère
  // avant qu'elle ait fini, l'URL de résultat accumule un double encodage
  // (`%2520` au lieu de `%20`) et la page peut retomber sur un état
  // incohérent (ex. contenu Accueil sous un titre de recherche). `window`
  // (partagé par toutes les injections dans la même page, contrairement au
  // contexte JS de chaque appel) sert de jeton : seule la soumission la plus
  // récente est autorisée à cliquer, un clic périmé par une soumission plus
  // récente est annulé silencieusement au lieu de doubler la navigation.
  const searchGeneration = (window.__leclercSearchGeneration = (window.__leclercSearchGeneration || 0) + 1);
  // Hypothèse initialement retenue ici ("change" navigue déjà seul, cliquer
  // quand même double la navigation et double-encode l'URL) et son fix
  // (différer le clic derrière une fenêtre d'attente sur location.href) ont
  // été INVALIDÉS par un test en conditions réelles (30/08, RDP sur le vrai
  // site) : sur cette route mobile, 'change' seul NE navigue PAS de façon
  // fiable (aucune navigation observée dans les 4s suivant le dispatch), et
  // un clic ISOLÉ (sans navigation préalable) produit À LUI SEUL une URL déjà
  // double-encodée (`%2520`) dès sa toute première navigation. Le double
  // encodage n'est donc pas causé par une redondance de soumission côté
  // extension : c'est un bug propre au SPA Leclerc lui-même, qui touche
  // n'importe quelle recherche mobile, y compris une saisie humaine normale.
  // Le vrai correctif est donc ailleurs (voir inspectLeclercSearchNavigationOnPage
  // et le garde `%25` dans readProductCandidatesOnPage, qui corrige déjà l'URL
  // a posteriori) : ici, un simple clic différé au prochain tick suffit.
  setTimeout(() => {
    if (window.__leclercSearchGeneration !== searchGeneration) return;
    if (submitControl) submitControl.click();
    else if (form?.requestSubmit) form.requestSubmit();
    else searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    // triggerLeclercLazyLoadOnPage (appelée en boucle par
    // waitForProductCandidates pendant CETTE recherche) ne remet plus le
    // scroll à 0 entre ses appels, pour laisser sa progression s'accumuler
    // sur une longue liste (voir son commentaire). Sans reset ICI, au
    // DÉMARRAGE d'une nouvelle recherche, l'étage suivant de la cascade
    // (simplified_name / name_only / brand_only) hériterait donc du scroll
    // résiduel laissé par l'étage précédent — la navigation Angular est une
    // route SPA, pas un rechargement de page, le scroll du document persiste
    // à travers le changement de route.
    window.scrollTo(0, 0);
  }, 0);
  return {
    started: true,
    query,
    diag: {
      inputId: searchInput.id || null,
      valueAfterSet,
      submitControlFound: Boolean(submitControl),
      submitControlClass: submitControl?.className || null,
      attempt,
      openerUsed
    }
  };
}

// Exportée (comme d'autres fonctions injectées de ce fichier) pour que le banc
// de mesure tools/bench-leclerc-stages.mjs déclenche le MÊME chargement paresseux
// que la production : sans lui, une liste virtualisée ne rend presque rien et la
// mesure conclurait à tort qu'une recherche n'a aucun résultat.
export async function triggerLeclercLazyLoadOnPage(budgetMs = 2500) {
  // Angular 16 lazy-loads products via IntersectionObserver on a scroll
  // container (overflow: auto). The observer is rooted on the viewport, but
  // the list is in a nested scroll container, so scrollIntoView on items
  // alone doesn't trigger intersection. Solution: scroll the container itself.
  const listContainer = document.querySelector('.liste-produit, [class*="liste-produit"]');
  const startTime = Date.now();
  const countVide = () => document.querySelectorAll('[class*="-vide"], [class*="_vide"]').length;
  // Budget dur PARTAGÉ par toute la fonction (scroll-container + fallback par
  // placeholder), pas juste par section. Régression réelle du 2026-08-27 :
  // une première version bornait seulement le scroll-container à 3s mais
  // laissait le fallback par placeholder sans aucune limite de temps — sur
  // une longue liste (29-33 résultats) à 150ms/placeholder, ce fallback seul
  // pouvait dépasser 4-5s. `waitForProductCandidates` appelle cette fonction
  // PUIS lit les candidats seulement après qu'elle ait fini : si elle parcnd
  // plus de temps que le budget de recherche total, le lecteur n'est jamais
  // atteint et `stageAttempts` remonte candidateCount=0 à tous les étages,
  // alors que le bandeau du site annonçait bien des résultats (diagnostic
  // réel confirmé : "29 résultats affichés" mais 0 candidat jamais lu).
  //
  // Paramétrable (défaut 2500ms inchangé) depuis le 31/08 : retour explicite
  // utilisateur — sur une longue liste virtualisée, une carte peut se
  // charger PUIS se décharger (voir le gros commentaire de
  // waitForProductCandidates plus bas) avant même la toute première lecture,
  // puisque `readProductCandidatesOnPage` n'est appelé par l'appelant
  // qu'UNE FOIS APRÈS ce scroll complet — jamais pendant. `waitForProductCandidates`
  // appelle désormais cette fonction avec un budget plus court et répété
  // (au lieu d'un seul gros appel), pour que la lecture intervienne plus tôt
  // après le chargement de chaque carte, sans dupliquer la lourde logique de
  // lecture ici (contrainte d'isolation d'injection : voir son commentaire).
  const hardDeadline = startTime + budgetMs;

  // Cible réellement scrollable : certaines routes (ex. le SPA mobile
  // m-courses.leclercdrive.fr/.../recherche/<query>) n'ont AUCUN container
  // interne en overflow:auto — le scroll qui compte est alors celui du
  // document/fenêtre lui-même. Diagnostic réel confirmé (2026-08-28,
  // "Boisson soja nature") : listContainer.scrollHeight === clientHeight
  // (aucun scroll interne détecté) alors que
  // document.documentElement.scrollHeight dépassait largement clientHeight.
  // Sans ce repli, ce bloc entier était sauté et seul le fallback
  // placeholder ci-dessous (scrollIntoView + délai fixe, non adaptatif)
  // tournait — insuffisant pour laisser le temps aux appels réseau Angular
  // de charger les vraies cartes avant l'abandon de
  // waitForProductCandidates (échec réel : le lecteur ne trouvait alors
  // qu'un candidat parasite, un lien "Rappel produit" du pied de page).
  const scrollTarget = (listContainer && listContainer.scrollHeight > listContainer.clientHeight)
    ? listContainer
    : document.documentElement;

  // Limite de scroll (retour explicite du 31/08 : "tu te retrouves
  // directement tout en bas de la page où il y a les CGU, un rappel
  // produit... là où il n'y a plus de produits") : quand scrollTarget est le
  // DOCUMENT entier (route mobile sans container interne, voir ci-dessus),
  // son scrollHeight couvre aussi le footer (CGU, rappel produit...) situé
  // sous la liste — le scroller intégralement gaspille une partie du budget
  // dur (2500ms) sur du contenu qui ne contient aucun produit, réduisant
  // d'autant la marge laissée à l'IntersectionObserver pour charger les
  // dernières cartes réelles. On borne donc la cible au bas de la LISTE
  // elle-même (dernier élément carte/placeholder), avec repli sur le
  // comportement d'origine (scrollHeight complet) si la liste est
  // introuvable — jamais moins de couverture qu'avant en cas de structure
  // DOM inattendue.
  let scrollLimit = scrollTarget.scrollHeight;
  if (scrollTarget === document.documentElement) {
    const listItems = document.querySelectorAll('[class*="liste-produit-element"]');
    const lastItem = listItems[listItems.length - 1];
    if (lastItem) {
      // Marge de sécurité : laisse la dernière carte franchement dans le
      // viewport au dernier palier plutôt que pile à sa limite haute —
      // l'IntersectionObserver a besoin d'une intersection réelle, pas d'un
      // simple contact au pixel près.
      scrollLimit = Math.min(
        scrollTarget.scrollHeight,
        window.scrollY + lastItem.getBoundingClientRect().bottom + scrollTarget.clientHeight * 0.5
      );
    }
  }

  if (scrollTarget.scrollHeight > scrollTarget.clientHeight) {
    // Scroll progressif par paliers (une hauteur de viewport à la fois),
    // avec attente adaptative sur le nombre de placeholders "-vide" restants,
    // au lieu d'un nombre fixe de passages à délai fixe. Un saut direct au
    // bas de la liste (ou trop peu de passages) ne laisse l'observer
    // détecter que la zone finale, ratant les cartes intermédiaires sur une
    // longue liste — constaté en conditions réelles sur un vrai téléphone
    // (plus lent qu'un test local) : le produit ciblé "défilait"
    // visuellement à l'écran sans que sa carte ait fini de se rendre, donc
    // sans être repéré par le lecteur. On s'arrête dès que la liste se
    // stabilise (0 placeholder restant, ou plus aucun progrès), jamais après
    // un nombre de passages arbitraire — rapide sur une liste courte,
    // patient sur une longue, dans la limite du budget dur partagé ci-dessus.
    //
    // Bug racine identifié le 30/08 (diagnostics réels : Emmental râpé,
    // Lait UHT, Mousse aux fruits, Riz basmati — candidateCount très
    // inférieur au nombre de résultats annoncé, malgré plusieurs tours de
    // waitForProductCandidates) : cette fonction est rappelée en boucle par
    // waitForProductCandidates tant qu'il reste des placeholders, mais
    // repartait TOUJOURS du haut de la liste à chaque appel (reset explicite
    // à `scrollTop = 0` une fois arrivée en bas, et de nouveau à la fin de la
    // fonction). Avec un budget de 2500ms/appel (~12 paliers max), une liste
    // de 17-23 résultats n'était donc jamais scrollée au-delà de ses toutes
    // premières cartes, peu importe le nombre de tentatives — chaque appel
    // regaspillait son budget à re-parcourir les cartes déjà chargées. On ne
    // remet plus le scroll à 0 : la position persiste entre les appels
    // successifs (le DOM reste le même page), donc chaque tour prolonge
    // réellement la descente au lieu de la recommencer. Si le bas visible
    // actuel est atteint alors qu'il reste des placeholders, on y reste :
    // scrollHeight grandira une fois les cartes suivantes rendues par
    // l'IntersectionObserver, et le prochain tour reprendra sa progression.
    // Bug racine identifié le 30/08, second passage (diagnostics réels
    // v0.5.60, 2 runs consécutifs : "Emmental râpé" plafonne à candidateCount=8
    // sur 23 résultats annoncés, de façon IDENTIQUE bit pour bit sur les 2
    // runs — signe d'un plafond structurel, pas d'un aléa Datadome) :
    // `stableRounds` ci-dessous coupait la boucle dès que le compte de
    // placeholders vides restait identique sur 2 passages de 200ms, y
    // compris quand on n'avait PAS encore atteint le bas de la liste. Sous
    // virtualisation (voir le gros commentaire plus haut : Angular revide les
    // cartes déjà rendues dès qu'on scroll loin d'elles), ce compte est
    // structurellement quasi-STABLE en régime de croisière — de nouvelles
    // cartes se chargent en bas pendant que d'anciennes se déchargent en
    // haut, à un rythme comparable — donc `stableRounds >= 2` se déclenchait
    // à tort en PLEIN MILIEU du scroll, bien avant le bas réel de la liste,
    // et coupait court à la progression pour le reste du budget de 2500ms.
    // Le signal de "plus aucun progrès" doit porter sur le fait d'être
    // RÉELLEMENT arrivé en bas (atBottom), pas sur un compte de placeholders
    // que la virtualisation rend trompeur : tant qu'on n'est pas en bas, on
    // continue à scroller jusqu'au budget dur, quoi qu'indique ce compte.
    const step = Math.max(scrollTarget.clientHeight * 0.8, 200);
    let previousVideCount = countVide();
    let stableRounds = 0;
    while (Date.now() < hardDeadline) {
      const atBottom = scrollTarget.scrollTop + scrollTarget.clientHeight >= scrollLimit - 2;
      if (!atBottom) {
        scrollTarget.scrollTop = Math.min(scrollTarget.scrollTop + step, scrollLimit);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 200));
      const currentVideCount = countVide();
      if (currentVideCount === 0) break;
      if (atBottom) {
        // Ici seulement le compte de placeholders redevient un signal fiable
        // d'arrêt : on ne peut plus avancer, donc s'il ne bouge plus non plus
        // c'est qu'il ne reste vraiment rien à charger dans ce budget.
        stableRounds = currentVideCount === previousVideCount ? stableRounds + 1 : 0;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
      }
      previousVideCount = currentVideCount;
    }
  }
  // Fallback: re-scroll ciblé sur chaque placeholder encore vide, mais
  // toujours dans le budget dur partagé — jamais un temps proportionnel au
  // nombre de placeholders sans plafond. S'il en reste après épuisement du
  // budget, ils seront couverts aux appels suivants (waitForProductCandidates
  // rappelle cette fonction toutes les ~500-700ms tant qu'aucun candidat
  // n'est trouvé).
  const placeholders = [...document.querySelectorAll('[class*="-vide"], [class*="_vide"]')];
  for (const placeholder of placeholders) {
    if (Date.now() >= hardDeadline) break;
    placeholder.scrollIntoView({ block: 'center' });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (placeholders.length > 0 && Date.now() < hardDeadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, hardDeadline - Date.now())));
  }
  const loadedCards = document.querySelectorAll('div[class*="liste-produit-element"]:not([class*="vide"])').length;
  const remainingPlaceholders = countVide();
  console.log(`[Leclerc LazyLoad] duration=${Date.now() - startTime}ms, loaded=${loadedCards}, placeholders=${remainingPlaceholders}`);
  // Remonté à waitForProductCandidates : sur une longue liste, ce budget dur
  // (2500ms) peut s'épuiser avant que toutes les cartes ne soient rendues —
  // sans ce signal, l'appelant retournait dès qu'UN SEUL candidat était lu,
  // même si de nombreux placeholders restaient vides juste en dessous (le
  // bon produit pouvait très bien s'y trouver). Voir son usage pour le détail.
  return { remainingPlaceholders };
}

export function readProductCandidatesOnPage() {
  // Copie locale de normalizeEan/findEanInText (extension/shared/barcode.js),
  // pour la même raison d'isolation d'injection que fixDoubleEncodedLeclercUrl
  // ci-dessous : aucune fonction externe du module n'est appelable ici.
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

  // Duplique délibérément la logique de fixDoubleEncodedLeclercUrl() (définie
  // plus bas, exportée pour ses propres tests unitaires) au lieu de l'appeler :
  // cette fonction est injectée telle quelle dans l'onglet via
  // `scripting.executeScript({ func: readProductCandidatesOnPage })`, qui ne
  // sérialise QUE le code source de cette fonction — aucune closure ni aucune
  // référence vers une autre fonction du module ne survit à l'injection. Un
  // appel à fixDoubleEncodedLeclercUrl(href) ici levait une ReferenceError à
  // CHAQUE carte, donc systématiquement pour CHAQUE recherche Leclerc — cause
  // racine confirmée du bug "5/5 produits introuvables, candidateCount:0
  // partout" alors que le DOM contenait bien des cartes remplies (diagnostic
  // réel du 2026-08-27) : l'erreur était avalée par le catch générique de
  // waitForProductCandidates ("Navigation can temporarily invalidate..."),
  // qui continuait donc à retenter indéfiniment sans jamais rien lire.
  const fixDoubleEncodedUrl = (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      if (url.pathname.includes('%25')) url.pathname = url.pathname.replace(/%25/g, '%');
      if (url.search.includes('%25')) url.search = url.search.replace(/%25/g, '%');
      return url.href;
    } catch {
      return rawUrl;
    }
  };
  // Diagnostic réel confirmé (2026-08-28, ajout au panier Leclerc, "Boisson
  // soja nature") : le même bug de double encodage que ci-dessus peut aussi
  // toucher location.href ELLE-MÊME (pas seulement le lien de repli d'une
  // carte) — le SPA m-courses.leclercdrive.fr pousse alors une page de
  // résultats dont le pathname contient "%2520" au lieu de "%20", et cette
  // page n'affiche AUCUNE carte ni bannière "Aucun résultat" (contenu
  // générique de catégorie à la place). Sans ce garde, la boucle
  // waitForProductCandidates épuisait tout le budget de 15s à relire une
  // page qui ne changera jamais d'elle-même, avant d'abandonner en
  // CART_PRODUCT_NOT_FOUND. Une correction et un rechargement suffisent
  // à faire résoudre la vraie page de résultats côté SPA.
  if (location.pathname.includes('%25')) {
    const fixedHref = fixDoubleEncodedUrl(location.href);
    if (fixedHref && fixedHref !== location.href) location.assign(fixedHref);
    return [];
  }
  // The "no results" banner text ("Aucun résultat ne correspond à votre
  // recherche \"<EAN>\"") echoes the searched EAN verbatim. Without this
  // guard, the generic selector below can pick up a huge nav/footer <li> or
  // <article> whose text happens to contain "€" (e.g. the "0,00 €" cart
  // total, present on every page including this one) plus that echoed EAN —
  // the barcode regex then extracts it, matches product.barcode exactly, and
  // chooseLeclercProductCandidate reports a perfect false-positive match on
  // what is actually a failed search. Confirmed against a real diagnostic
  // export where every Leclerc "success" was this error page scraped as a
  // €0.00 "Rappel produit" match.
  if (/aucun résultat ne correspond/i.test(document.body?.textContent || '')) return [];

  // Helper: search in a document (can be main or iframe)
  const searchInDocument = (doc) => {
    // Sélecteur par CLASSE exacte : `[class*="liste-produit-element"]`
    // capturait aussi les wrappers `liste-produit-element-presentation-*`,
    // qui concatènent plusieurs produits. Quand le template Angular connu est
    // présent, ses cartes feuilles sont la source canonique et le fallback
    // générique ne doit pas réintroduire leurs <li> parents en doublon.
    const angularCards = [...doc.querySelectorAll('.liste-produit-element:not(.liste-produit-element-vide)')]
      // Le DOM réel peut imbriquer un composant portant lui aussi la classe
      // de carte autour de la vignette produit finale. Ne conserver que les
      // feuilles évite de concaténer le nom/prix du parent avec ceux de son
      // enfant et garantit que v-produit-* identifie bien la fiche lue.
      .filter((card) => !card.querySelector('.liste-produit-element:not(.liste-produit-element-vide)'));
    if (angularCards.length > 0) return angularCards;
    return [...doc.querySelectorAll('[data-product-id], [data-product], [itemtype*="Product"], article, li')];
  };

  // Bug racine confirmé par diagnostic réel (30/08, "Purée instantanée" et
  // "Boisson soja nature" sur une page dégradée Datadome) : `.textContent`
  // sur un élément inclut TOUJOURS le contenu texte de n'importe quel
  // <script>/<style> descendant (spécification DOM standard, pas un cas
  // limite) — quand Datadome injecte son script de challenge quelque part
  // dans la page pendant qu'elle est encore en train de se dégrader/charger,
  // n'importe quel ancêtre englobant ce script (remonté par les boucles de
  // repli plus bas, ou même par le sélecteur générique 'li'/'article' du
  // fallback ci-dessous) voit son texte contaminé par le code source JS
  // entier de ce script. Résultat observé : le contenu brut de
  // `window.ddjskey = "..."; window.ddoptions = {...}` remonté comme "nom de
  // produit" d'un candidat — en plus d'être un faux résultat inutile, un tel
  // candidat parasite empêche à tort la détection "page bloquée"
  // (STUCK_EMPTY_ROUNDS_THRESHOLD ci-dessus) de se déclencher, puisqu'il
  // compte comme "1 candidat trouvé" à chaque tour. Une vraie carte produit
  // Leclerc ne contient jamais de <script>/<style> en enfant — ce garde
  // élimine la source du problème plutôt que de tenter de reconnaître le
  // motif JS a posteriori dans le texte extrait.
  const hasEmbeddedScriptOrStyle = (element) => Boolean(element.querySelector?.('script, style'));

  // Hôte qui sert les fiches produit standalone (.aspx). Le SPA de recherche
  // vit sur m-courses.leclercdrive.fr, mais les fiches sont servies par un
  // hôte "fdNN-courses" — vérifié en conditions réelles (31/08) :
  // m-courses.../fiche-produits-208750-....aspx retombe sur une page
  // générique, fd7-courses.../fiche-produits-208750-....aspx renvoie bien
  // la fiche. Le préfixe fdNN est un fragment d'infrastructure propre au
  // magasin : jamais codé en dur, il est lu dans la page de résultats
  // elle-même, qui le cite déjà (lien "espace client", et à défaut l'hôte
  // fdNN-photos des visuels produit, qui partage toujours le même préfixe).
  const findLeclercFicheOrigin = () => {
    const html = document.documentElement?.outerHTML || '';
    const direct = html.match(/(fd\d+-courses\.leclercdrive\.fr)/i);
    if (direct) return `https://${direct[1].toLowerCase()}`;
    const photos = html.match(/(fd\d+)-photos\.leclercdrive\.fr/i);
    if (photos) return `https://${photos[1].toLowerCase()}-courses.leclercdrive.fr`;
    return null;
  };
  const leclercFicheOrigin = findLeclercFicheOrigin();
  // Les cartes de résultats Leclerc n'exposent aucun lien vers la fiche (le
  // nom est un <a> sans href, "Ajouter au panier" passe par JS) — mais
  // l'identifiant de fiche EST déjà sur la page, dans une classe CSS du
  // conteneur de chaque carte : "liste-produit-element v-produit-208750".
  // Le slug qui suit l'identifiant dans l'URL est purement décoratif
  // (vérifié : "fiche-produits-208750-x.aspx" et "fiche-produits-208750-.aspx"
  // renvoient tous deux la bonne fiche en HTTP 200), on le construit donc à
  // partir du nom lu pour garder une URL lisible sans en dépendre.
  // Sans ça, "Voir chez Leclerc" renvoyait sur l'URL de recherche et
  // obligeait à retrouver le produit à la main dans la grille.
  const readVProduitId = (element) =>
    String(element?.className || '').match(/(?:^|\s)v-produit-(\d+)(?:\s|$)/)?.[1] || null;
  const buildLeclercFicheUrl = (card, name) => {
    if (!leclercFicheOrigin) return null;
    let ficheId = null;
    // La carte lue peut aussi bien être le conteneur porteur de l'identifiant
    // que l'un de ses descendants (.vignette-produit) ou l'un de ses parents
    // (<li>, ou un ancêtre reconstruit par l'escalade de parents plus haut) :
    // on remonte d'abord, puis on redescend.
    for (let node = card, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
      ficheId = readVProduitId(node);
      if (ficheId) break;
    }
    if (!ficheId) {
      // En redescendant, n'accepter l'identifiant que si la carte n'en
      // contient qu'UN SEUL : une carte élargie qui en couvre plusieurs
      // n’identifie plus un produit précis, et un lien pointant sur le
      // mauvais produit serait pire que pas de lien du tout.
      const inner = [...card.querySelectorAll('[class*="v-produit-"]')]
        .map(readVProduitId)
        .filter(Boolean);
      const uniques = [...new Set(inner)];
      if (uniques.length !== 1) return null;
      ficheId = uniques[0];
    }
    const storeSegment = location.pathname.split('/').filter(Boolean)[0];
    if (!storeSegment || !/^magasin-/i.test(storeSegment)) return null;
    const slug = String(name || '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    return `${leclercFicheOrigin}/${storeSegment}/fiche-produits-${ficheId}-${slug}.aspx`;
  };
  const cards = [
    ...searchInDocument(document),
    // Also search in iframes (Leclerc sometimes wraps search results in an iframe)
    ...[...document.querySelectorAll('iframe')].flatMap((iframe) => {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;
        return iframeDoc ? searchInDocument(iframeDoc) : [];
      } catch {
        return [];
      }
    })
  ]
    .filter((element) => !hasEmbeddedScriptOrStyle(element))
    .filter((element) => /€|\beur\b/i.test(element.textContent || ''))
    // A genuine product card is compact; nav/footer chrome that merely
    // contains "€" somewhere tends to be much larger — mirrors the same
    // 2000-char cap already used for the link-climbing loop below.
    .filter((element) => (element.textContent || '').length <= 2_000);
  // Diagnostic réel confirmé (2026-08-28, "Boisson soja nature") : sur la
  // route mobile /magasin-.../recherche/<query>, ce fallback scannait TOUT le
  // document, en-tête et pied de page compris. Un simple lien de pied de
  // page ("Rappel produit", obligation légale) contient "produit" dans son
  // href ; en remontant ses ancêtres à la recherche d'un prix, la boucle
  // finissait par atteindre un ancêtre commun englobant l'en-tête — qui
  // affiche toujours le total panier (ex. "0,00 €") — d'où un faux positif
  // retourné comme UNIQUE candidat, avant même que les vraies cartes (encore
  // en lazy-load) n'apparaissent. waitForProductCandidates considérait alors
  // la recherche terminée dès ce premier candidat non-vide et abandonnait la
  // boucle d'attente sans jamais laisser sa chance au lazy-load. On
  // restreint donc ce fallback (et le suivant) à la zone de résultats
  // identifiée quand elle existe, avec repli sur tout le document sinon
  // (comportement inchangé pour les autres routes/formats).
  const resultsScope = document.querySelector('.liste-produit, [class*="liste-produit"]') || document;

  for (const link of resultsScope.querySelectorAll('a[href*="produit" i], a[href*="product" i]')) {
    let container = link;
    for (let depth = 0; depth < 8 && container.parentElement; depth += 1) {
      const parent = container.parentElement;
      const text = (parent.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 3_000) break;
      container = parent;
      if (/\d\s*(?:[,.]\s*\d{2}\s*€|€\s*\d{2})/i.test(text)) break;
    }
    if (/€|\beur\b/i.test(container.textContent || '') && !hasEmbeddedScriptOrStyle(container)) cards.push(container);
  }
  // Confirmed via a real diagnostic (2026-07-29): the mobile subdomain
  // (m-courses.leclercdrive.fr, reached after submitting the search box)
  // renders a full-page "/magasin-.../recherche/<query>" results route whose
  // card markup didn't match either the primary "liste-produit-element"
  // class or the href-based fallback above — the page's plain-text (visible
  // via document.body.innerText) clearly listed matching products with real
  // prices, but zero DOM elements were picked up as candidates, so the whole
  // search silently came back empty every time on that route. As a last
  // resort, scan every element for a bare price pattern and climb to a
  // reasonably small ancestor — the same class-agnostic strategy already
  // used for Hyper U, which has no stable card class name either.
  if (cards.length === 0) {
    const priceLeaves = [...resultsScope.querySelectorAll('*')].filter((element) => {
      if (element.children.length > 2) return false;
      return /\d{1,4}[,.]\s*\d{2}\s*€/.test(element.textContent || '');
    });
    for (const leaf of priceLeaves.slice(0, 80)) {
      let container = leaf;
      for (let depth = 0; depth < 6 && container.parentElement; depth += 1) {
        const parent = container.parentElement;
        const text = (parent.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 2_000) break;
        container = parent;
      }
      if (/€|\beur\b/i.test(container.textContent || '') && !hasEmbeddedScriptOrStyle(container)) cards.push(container);
    }
  }
  const uniqueCards = [...new Set(cards)].slice(0, 50);
  return uniqueCards
    .map((card) => {
    const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
    const link = card.querySelector('a[href*="produit" i], a[href*="product" i]');
    // Real Leclerc search result cards never link to a per-product page (the
    // product name is a plain <a> with no href, "Ajouter au panier" adds it
    // via JS). Fall back to the card's category link, then the current
    // (already verified official) page URL, so a legitimate candidate is
    // never dropped just for lacking a permalink.
    const categoryLink = card.querySelector('a.aWCRS310_VoirRayon[href], a[href*="rayon" i]');
    const href = link?.href || categoryLink?.href || location.href;
    const priceMatches = [...text.matchAll(/(\d{1,4})(?:[,.]\s*(\d{2})\s*(?:€|eur)|\s*€\s*(\d{2}))/gi)];

    // Essayer les sélecteurs CSS Leclerc d'abord (Angular 16: .vignette-prix > p)
    const vignettePrice = card.querySelector('.vignette-prix-ajout .vignette-prix p, .vignette-prix p')?.textContent?.trim();
    const integerPart = card.querySelector('.pWCRS310_PrixUnitairePartieEntiere, [class*="prix"][class*="entiere"]')?.textContent?.match(/\d{1,4}/)?.[0];
    const decimalPart = card.querySelector('.pWCRS310_PrixUnitairePartieDecimale, [class*="prix"][class*="decimal"]')?.textContent?.match(/\d{2}/)?.[0];

    // Chercher aussi les prix dans les éléments strong ou em
    const strongPrice = card.querySelector('strong[class*="prix" i], em[class*="prix" i]')?.textContent?.match(/(\d{1,4})[,.]\s*(\d{2})/);

    let price = NaN;
    // Priorité 1 : extraction directe depuis .vignette-prix (Angular 16 Leclerc)
    if (vignettePrice) {
      const vignettePriceMatch = vignettePrice.match(/(\d{1,4})[,.]\s*(\d{2})/);
      if (vignettePriceMatch) {
        price = Number(`${vignettePriceMatch[1]}.${vignettePriceMatch[2]}`);
      }
    }
    // Priorité 2 : sélecteurs anciens (compatibilité)
    if (Number.isNaN(price) && /^\d{1,4}$/.test(integerPart || '') && /^\d{2}$/.test(decimalPart || '')) {
      price = Number(`${integerPart}.${decimalPart}`);
    }
    // Priorité 3 : sélecteur strong/em
    if (Number.isNaN(price) && strongPrice) {
      price = Number(`${strongPrice[1]}.${strongPrice[2]}`);
    }
    // Priorité 4 et 5 (derniers recours, scan brut du texte de la carte) :
    // même risque que sur Hyper U (régression réelle 2026-08-27) — sans
    // filtre, le parcmier montant "X,XX €" du texte peut être un prix de
    // référence au litre/kg plutôt que le prix réel de l'article. Les
    // priorités 1 à 3 ciblent déjà des sélecteurs CSS dédiés au prix
    // (beaucoup moins exposés à ce risque) ; ce filtre ne sert qu'aux cas où
    // elles ont toutes échoué.
    // Outre le prix au litre/kg, on écarte aussi les montants introduits ou
    // suivis d'une mention qui les désigne comme AUTRE CHOSE que le prix de
    // l'article : bulle d'économie ("Soit 2,12 € d'économie"), prix barré
    // ("au lieu de 6,20 €"), seuil de livraison gratuite, cagnotte. Un prix
    // faux est pire qu'une absence de prix : il est affiché à l'utilisateur
    // comme certain et fausse toute la comparaison entre magasins.
    // Les fenêtres de contexte s'arrêtent au symbole € le plus proche :
    // sinon la mention qui qualifie un montant ("Au lieu de 6,20 €") déborde
    // sur le montant SUIVANT — le vrai prix — et le fait écarter lui aussi,
    // si bien qu'aucun candidat ne passe et que le repli `priceMatches[0]`
    // retient justement le prix barré.
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
    // Pas de \b en tête des motifs : `textContent` concatène les nœuds
    // adjacents SANS séparateur, donc le libellé peut se retrouver collé au
    // texte précédent ("…6x1lAu lieu de 6,20 €") et une frontière de mot
    // initiale ne matcherait alors jamais.
    const isUnitPriceContext = (m) =>
      /^\s*(\/\s*(l|kg|cl|g)\b|d[’']?\s*[ée]conomie|de remise|offerts?\b)/i.test(
        contextAfter(m.index + m[0].length)
      ) ||
      /(litre|au kg|le kg|au lieu de|[àa] partir de|livraison|frais de port|cagnotte)\b/i.test(
        contextBefore(m.index)
      );
    // Capture en parallèle du prix total : seuls les suffixes explicites
    // `/l`, `/kg`, `/cl` et `/g` constituent un prix unitaire exploitable.
    // Les autres contextes écartés ci-dessus (remise, cagnotte, livraison...)
    // restent de simples rejets et ne doivent jamais alimenter le contrôle.
    const unitPriceMatch = priceMatches
      .map((m) => ({ match: m, suffix: contextAfter(m.index + m[0].length).match(/^\s*\/\s*(l|kg|cl|g)\b/i) }))
      .find((entry) => entry.suffix);
    const unitPriceRaw = unitPriceMatch
      ? Number(`${unitPriceMatch.match[1]}.${unitPriceMatch.match[2] || unitPriceMatch.match[3]}`)
      : NaN;
    const unitPriceSuffix = unitPriceMatch?.suffix?.[1]?.toLowerCase();
    const unitPriceEuro =
      Number.isFinite(unitPriceRaw) && unitPriceSuffix
        ? unitPriceRaw * (unitPriceSuffix === 'cl' ? 100 : unitPriceSuffix === 'g' ? 1000 : 1)
        : undefined;
    const unitPriceUnit = unitPriceSuffix === 'l' || unitPriceSuffix === 'cl' ? 'L' : unitPriceSuffix ? 'kg' : undefined;
    // Priorité 4 : regex sur priceMatches
    if (Number.isNaN(price)) {
      const totalPriceMatch = priceMatches.find((m) => !isUnitPriceContext(m)) || priceMatches[0];
      if (totalPriceMatch) {
        price = Number(`${totalPriceMatch[1]}.${totalPriceMatch[2] || totalPriceMatch[3]}`);
      }
    }
    // Priorité 5 : dernier recours — regex globale
    if (Number.isNaN(price)) {
      const allPrices = [...text.matchAll(/€\s*(\d{1,4})[,.]\s*(\d{2})|\b(\d{1,4})[,.]\s*(\d{2})\s*€/gi)];
      const p = allPrices.find((m) => !isUnitPriceContext(m)) || allPrices[0];
      if (p) {
        price = Number(`${p[1] || p[3]}.${p[2] || p[4]}`);
      }
    }
    // Deux durcissements par rapport à la version précédente
    // (`text.match(/\b\d{8,14}\b/)?.[0] || card.getAttribute('data-ean')`) :
    //  1. l'attribut structuré data-ean passe AVANT le texte libre — il
    //     décrit à coup sûr CETTE carte, alors que `text` peut couvrir
    //     plusieurs produits concaténés quand la carte a dû être élargie en
    //     remontant les parents (voir la boucle d'escalade plus haut) ;
    //  2. les deux sources doivent passer la clé de contrôle GS1 (voir
    //     extension/shared/barcode.js) : un EAN inventé à partir d'un
    //     numéro de page vaut correspondance PARFAITE dans
    //     chooseLeclercProductCandidate (matchScore 1, scoring par nom
    //     court-circuité) et sert de critère de rejet dans
    //     tryAddToCartLeclercViaProductUrl.
    const structuredBarcodeNode = card.querySelector('[itemprop="gtin13"], [itemprop="gtin"], [data-ean]');
    const structuredBarcode =
      card.getAttribute('data-ean') ||
      structuredBarcodeNode?.getAttribute('content') ||
      structuredBarcodeNode?.getAttribute('data-ean') ||
      structuredBarcodeNode?.textContent;
    const barcode = normalizeEanLocal(structuredBarcode) || findEanInTextLocal(text) || undefined;
    const externalProductId =
      card.getAttribute('data-product-id') ||
      readVProduitId(card) ||
      card.querySelector('[class*="v-produit-"]') && readVProduitId(card.querySelector('[class*="v-produit-"]')) ||
      href.match(/(?:produit|product)[\/-]([^/?#]+)/i)?.[1] ||
      undefined;
    // Sur les vignettes Angular, le parcmier <p> descriptif est le nom du
    // produit. D'autres <p> peuvent suivre (conditionnement, variante,
    // promotion) : utiliser textContent de toute la carte les concatène et
    // fabrique un nom qui n'existe pas, comme "... 1L Végé - 200g".
    const heading = card.querySelector(
      '.vignette-descriptif > p:first-of-type, .vignette-descriptif p:first-of-type, .pWCRS310_Desc, h1, h2, h3, h4, [itemprop="name"], [class*="title" i]'
    );
    // When the card had to be widened by climbing parents to find a price
    // (see the container-climbing loop above), `text` can span several
    // sibling products concatenated together, not just this one — polluting
    // both matching (name is scored against the wanted product) and the
    // observedName shown to the user. `price` above is always taken from
    // priceMatches[0], the FIRST price in `text`; truncating the name
    // fallback to end at that same first price keeps name and price
    // describing the same (first) product instead of a multi-product blob.
    const firstPriceIndex = priceMatches[0]?.index;
    const nameFallback = Number.isInteger(firstPriceIndex) ? text.slice(0, firstPriceIndex) : text;
    const cleanObservedName = (value) =>
      String(value || '')
        // Défaut de données observé sur la fiche officielle v-produit-5870 :
        // "Végé 1L Végé - 200g" alors que document.title confirme "Végé 1L".
        // La répétition du même libellé autour de deux conditionnements est le
        // signal généralisable ; on ne retire rien si ce mot n'est pas répété.
        .replace(
          /\b([a-zà-ÿ][a-zà-ÿ'’-]{2,})\s+(\d+(?:[.,]\d+)?\s*(?:kg|cl|ml|l|g))\s+\1\s*-\s*\d+(?:[.,]\d+)?\s*(?:kg|cl|ml|l|g)\b/gi,
          '$1 $2'
        )
        .replace(/\s+/g, ' ')
        .trim();
    const observedName = cleanObservedName(heading?.textContent || link?.textContent || nameFallback).slice(0, 500);
    const brandNode = card.querySelector('[itemprop="brand"], [data-brand]');
    const brand = (
      brandNode?.getAttribute('content') ||
      brandNode?.getAttribute('data-brand') ||
      brandNode?.textContent ||
      ''
    ).replace(/\s+/g, ' ').trim().slice(0, 200);
    const promotionLabel = card.querySelector(
      '.vignette-promotion, [class*="promotion" i], [class*="promo-" i], [data-testid*="promotion" i]'
    )?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 300);
    const unavailableControl = card.querySelector(
      'button[disabled][aria-label*="ajouter" i], .vignette-ajout[disabled], [aria-label*="indisponible" i]'
    );
    // Le lien vers la vraie fiche produit prime sur les replis historiques
    // (lien rayon, puis URL de la page de recherche elle-même) : c'est ce
    // que le bouton "Voir chez Leclerc" de la PWA ouvre, et l'utilisateur
    // doit tomber directement sur le produit, pas sur une grille à
    // dépouiller. Voir buildLeclercFicheUrl plus haut.
    const ficheUrl = buildLeclercFicheUrl(card, observedName);
    return {
      name: observedName,
      ...(brand ? { brand } : {}),
      barcode,
      externalProductId,
      externalStoreId: document.documentElement.getAttribute('data-store-id') || location.pathname.split('/').filter(Boolean)[0],
      priceEuro: price,
      ...(unitPriceEuro !== undefined ? { unitPriceEuro, unitPriceUnit } : {}),
      available: !unavailableControl && !/indisponible|rupture/i.test(text),
      promotionLabel: promotionLabel || (/promo|promotion|ticket e\.leclerc/i.test(text) ? text.slice(0, 300) : undefined),
      productUrl: ficheUrl || fixDoubleEncodedUrl(href)
    };
  })
    // Diagnostic réel confirmé (30/08, v0.5.55, remontée de topMatchName=""
    // sur plusieurs produits différents une fois le plancher de visibilité
    // diagnostique retiré) : le bandeau panier flottant ("1 0,85 €", présent
    // en tête de CHAQUE page Leclerc) est capturé par le repli générique
    // ci-dessus quand son prix est le tout premier caractère du texte de la
    // carte (nameFallback = text.slice(0, 0) = ''). Il passait déjà le
    // filtre `typeof candidate.name === 'string'` de rankLeclercCandidates
    // (une chaîne vide EST une string) et ne pouvait jamais être choisi
    // comme meilleur candidat (son score est toujours 0), mais polluait
    // candidateCount et masquait le vrai signal dans stageAttempts. Un
    // candidat sans nom exploitable n'est jamais un vrai produit — l'écarter
    // ici, à la source, plutôt que de compter sur le scoring pour l'ignorer.
    .filter((candidate) => candidate.name.length > 0);
}

// The m-courses.leclercdrive.fr SPA sometimes pushes a search-page URL whose
// pathname was percent-encoded twice (e.g. "%25C3%25A9" instead of "%C3%A9"),
// so location.href — used above as a fallback productUrl when no real
// product/category link exists on the card — reproduces that double
// encoding verbatim. Opening it then just re-decodes to "%C3%A9", a broken
// path segment, and the browser lands on a generic/wrong page instead of the
// intended search result. Collapsing one level of "%25" -> "%" before
// storing the URL is enough to make it resolve correctly again.
export function fixDoubleEncodedLeclercUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.pathname.includes('%25')) {
      url.pathname = url.pathname.replace(/%25/g, '%');
    }
    if (url.search.includes('%25')) {
      url.search = url.search.replace(/%25/g, '%');
    }
    return url.href;
  } catch {
    return rawUrl;
  }
}

// Strips packaging/serving noise that Open Food Facts names frequently carry
// but Leclerc's own search index doesn't reliably match on: pack multipliers
// ("4x200ml", "6x74g"), bare weights/volumes ("500g", "80g", "1L"), fat/serving
// percentages ("30%MG", "30% de matière grasse"), and "en sachet"/"pour N
// personnes" phrasing. Pure and unit-testable on purpose — never touches the
// actual name used for scoring. Implémentation partagée avec Hyper U — voir
// extension/shared/search-query.js — cet export est conservé pour ne pas
// casser les appels/tests existants qui l'importent sous ce nom.
export function simplifyLeclercSearchQuery(name) {
  return stripPackagingNoiseFromSearchName(name);
}

// Le caractère '%' casse la recherche Leclerc de façon reproductible :
// diagnostic réel confirmé (2026-08-28) — un produit contenant "30%" dans son
// nom (issu d'Open Food Facts) faisait systématiquement atterrir l'onglet sur
// la page d'erreur technique du site (pgeWCSD002_Erreur.aspx) quelques
// secondes après le lancement de la recherche, aux DEUX tentatives du
// job-runner (tab neuf inclus), toujours sur le même produit. Reproduit en
// isolation par navigation directe : une requête contenant '%' redirige
// immédiatement vers cette page d'erreur ; la même requête sans '%'
// fonctionne normalement. Retiré de TOUTE requête envoyée en recherche (tous
// les étages) — jamais du nom ORIGINAL utilisé pour le scoring.
export function sanitizeLeclercSearchText(text) {
  return String(text || '')
    .replace(/%/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Recompose, hors de la page, la requête que `startProductSearchOnPage` va
// taper dans le champ de recherche (`${name} ${brand}`, marque générique
// écartée). Duplication assumée de ces deux lignes, pour la même raison que
// normalizeEanLocal dans readProductCandidatesOnPage : cette fonction-là est
// injectée telle quelle dans l'onglet et ne peut appeler AUCUNE fonction du
// module. Sert uniquement à reconnaître qu'un étage s'apprête à renvoyer une
// requête déjà envoyée (voir `attemptedQueries`), et elle est la SEULE source
// utilisée pour cette comparaison — jamais mélangée avec la requête que la
// page renvoie. Un test unitaire dédié vérifie que les deux compositions ne
// divergent pas.
export function buildLeclercSubmittedQuery(name, brand) {
  const cleanBrand = /^(?:marque habituelle|sans marque)$/i.test(brand || '') ? '' : brand || '';
  return `${name || ''} ${cleanBrand}`.trim();
}

export function simplifyLeclercBrandQuery(brand) {
  // Brand names sourced from Open Food Facts sometimes carry a leading
  // single-letter abbreviation ("S. Pellegrino", "E. Leclerc") that a
  // literal-text search engine tokenizes as noise around the period,
  // hurting recall for a brand-only fallback query. Strip it.
  return String(brand || '').replace(/^[a-z]\.\s*/i, '').trim();
}

// Mots vides français trop génériques pour être un mot-clé de recherche
// discriminant — utilisé uniquement par extractLeclercCoreKeyword ci-dessous,
// pas par le tokenizer de scoring (tokens()) qui doit rester permissif.
const FRENCH_SEARCH_STOPWORDS = new Set([
  'aux', 'au', 'de', 'du', 'des', 'le', 'la', 'les', 'un', 'une', 'et',
  'en', 'pour', 'avec', 'sans', 'sur', 'par', 'a'
]);

// Dernier recours de la cascade quand le produit n'a pas de marque
// exploitable (voir l'étage 'name_only' plus haut) : extrait le parcmier mot
// significatif du nom (hors mots vides et quantités), casse/accents
// d'origine conservés pour la requête envoyée au moteur de recherche.
// Contrairement à `tokens()` (utilisé pour le scoring, insensible à la
// casse), cette fonction sert à CONSTRUIRE une requête lisible par un vrai
// moteur de recherche texte.
export function extractLeclercCoreKeyword(name) {
  const rawWords = String(name || '').split(/\s+/).filter(Boolean);
  for (const word of rawWords) {
    const normalized = word
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (normalized.length > 1 && !FRENCH_SEARCH_STOPWORDS.has(normalized) && !isQuantityToken(normalized)) {
      return word;
    }
  }
  return '';
}

export function parseLeclercDisplayedPrice({ integerPart, decimalPart, text }) {
  if (/^\d{1,4}$/.test(integerPart || '') && /^\d{2}$/.test(decimalPart || '')) {
    return Number(`${integerPart}.${decimalPart}`);
  }
  const match = String(text || '').match(/(\d{1,4})(?:[,.]\s*(\d{2})\s*(?:€|eur)|\s*€\s*,?\s*(\d{2}))/i);
  return match ? Number(`${match[1]}.${match[2] || match[3]}`) : NaN;
}

// Exportée (en plus d'être passée telle quelle à scripting.executeScript)
// uniquement pour permettre un test direct de sanitizeHtmlSnippetForDiagnostics
// via JSDOM — comme les autres fonctions pures exportées de ce fichier,
// l'export n'a aucun effet sur l'injection en page (executeScript ne se sert
// que du corps sérialisé de la fonction, jamais du binding module).
export function inspectLeclercResultsOnPage() {
  // Audit sécurité du 30/08 : injectée telle quelle dans la page via
  // scripting.executeScript, donc imbriquée ici plutôt qu'appelée en tant
  // que fonction module externe (aucune closure sur le module ne survit à
  // la sérialisation de la fonction). Retire les valeurs d'attributs
  // pouvant porter un token/identifiant (href, src, data-*, style,
  // action...) d'un extrait HTML avant qu'il ne parte dans le diagnostic
  // exportable par l'utilisateur — on garde noms de balise/classe/attribut,
  // seuls signaux réellement utilisés pour diagnostiquer un changement de
  // markup Leclerc.
  function sanitizeHtmlSnippetForDiagnostics(html) {
    return String(html || '').replace(
      /\s(href|src|srcset|action|formaction|style|ping)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
      ' $1="…"'
    ).replace(/\sdata-([\w-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' data-$1="…"');
  }
  const text = document.body?.innerText || '';
  const euroNodes = [...document.querySelectorAll('article, li, [data-product-id], [data-product]')].filter(
    // "eur" alone is not a safe signal (common in French words like
    // "meilleure", "utilisateur") — restrict to the actual € symbol here,
    // this is diagnostic-only counting, not the price-parsing regexes below.
    (node) => (node.textContent || '').includes('€')
  );
  // Sample the actual DOM around the highest-level euro-bearing nodes so the
  // next diagnostic tells us what Leclerc really renders now, instead of
  // guessing at selectors blind (site has changed markup repeatedly).
  const sampleCards = euroNodes.slice(0, 6).map((node) => ({
    tag: node.tagName.toLowerCase(),
    className: (node.className || '').toString().slice(0, 200),
    hasHref: Boolean(node.querySelector('a[href]')),
    hasProductClassChild: Boolean(node.querySelector('[class*="product" i], [class*="Product" i]')),
    textSnippet: (node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  }));
  // When euroNodes is empty (the recurring case), we need to know WHY the
  // page rendered nothing at all: silent bot-detection (Datadome/Akamai/PX
  // serve a normal-looking but empty page instead of a visible captcha),
  // the SPA still loading, or a genuine empty result set. Surface raw
  // ground truth instead of guessing at another selector blind.
  const scriptSrcs = [...document.querySelectorAll('script[src]')].map((s) => s.src).join(' ');
  const botProtectionHint =
    (/datadome/i.test(scriptSrcs) && 'datadome') ||
    (/akamai|_abck/i.test(scriptSrcs) && 'akamai') ||
    (/perimeterx|px-captcha|_px/i.test(scriptSrcs) && 'perimeterx') ||
    (/cloudflare|cf-chl/i.test(scriptSrcs) && 'cloudflare') ||
    null;

  // The document-level element count barely moves whether Leclerc claims 2
  // or 28 results, hinting the result grid lives behind virtual scrolling
  // or in a subtree our blind document.body.innerHTML(0,1500) slice never
  // reaches (it was still showing filter-bar markup). Locate the actual
  // results container by its Angular attribute name and dump a much larger
  // slice starting there, plus check for iframes/shadow roots that would
  // hide content from plain querySelectorAll entirely.
  const resultsContainer =
    document.querySelector('[cwcrs304_conteneurrechercheproduits]') ||
    [...document.querySelectorAll('*')].find((el) =>
      [...el.attributes].some((attr) => /recherche|resultat/i.test(attr.name))
    );
  const iframeCount = document.querySelectorAll('iframe').length;
  const shadowHostCount = [...document.querySelectorAll('*')].filter((el) => el.shadowRoot).length;
  const virtualScrollViewportCount = document.querySelectorAll('cdk-virtual-scroll-viewport').length;

  return {
    pageTitle: document.title.slice(0, 200),
    bodyTextSnippet: text.replace(/\s+/g, ' ').trim().slice(0, 400),
    // Audit sécurité du 30/08 : un dump brut de document.body.innerHTML
    // capture aussi le header/nav du site (salutation nominative, infos
    // fidélité, panier...) — hors du périmètre "pourquoi les cartes produit
    // ne sont pas trouvées" que ce diagnostic sert, et exportable par
    // l'utilisateur (bouton "Télécharger le diagnostic") ou partagé pour
    // support. Déjà noté inadéquat pour le diagnostic lui-même (voir
    // commentaire ci-dessus : "it was still showing filter-bar markup"),
    // remplacé par resultsContainerHtmlSnippet ci-dessous qui cible le seul
    // conteneur pertinent et est assaini des valeurs d'attributs.
    resultsContainerFound: Boolean(resultsContainer),
    resultsContainerHtmlSnippet: resultsContainer
      ? sanitizeHtmlSnippetForDiagnostics(resultsContainer.innerHTML).slice(0, 4000)
      : null,
    iframeCount,
    shadowHostCount,
    virtualScrollViewportCount,
    totalElementCount: document.querySelectorAll('*').length,
    botProtectionHint,
    documentReadyState: document.readyState,
    pathKind: location.pathname.split('/').filter(Boolean).slice(-1)[0] || 'home',
    // Confirmed via a real populated results page: Leclerc's own class name
    // is French — "liste-produit-element" — not the English "product" this
    // selector used to look for, which is why both counts below sat at 0
    // even once the lazy-render fix made the cards render for real.
    resultCardCount: document.querySelectorAll('[data-product-id], [data-product], [itemtype*="Product"], article, li.liWCRS310_Product, [class*="liste-produit-element"]').length,
    euroNodeCount: euroNodes.length,
    productClassElementCount: document.querySelectorAll('[class*="product" i], [class*="Product" i], [class*="produit" i]').length,
    productHrefLinkCount: document.querySelectorAll('a[href*="produit" i], a[href*="product" i]').length,
    hasCaptcha: /captcha|pas un robot|accès refusé/i.test(text),
    sampleCards
  };
}
