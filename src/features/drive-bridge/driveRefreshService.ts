import { db } from '../../db/db';
import {
  type ComparisonUnit,
  type DriveSearchMemoryEntry,
  type DriveSearchStage,
  type PriceSnapshot,
  type ProductCandidate,
  type StoreKey,
  type UserStore
} from '../../types/domain';
import { type ShoppingListRow } from '../shopping-list/shoppingListService';
import { checkPriceCoherence } from '../comparison/priceCoherence';
import { listSelectedStores } from '../stores/storeLocatorService';
import { isVerboseDiagnosticsEnabled } from './verboseDiagnostics';
import {
  getExtensionBridge,
  type DriveLivePickExtensionResponse,
  type DriveRefreshExtensionResponse,
  type DriveRefreshProgressEvent
} from './extensionBridge';
import {
  DRIVE_PROTOCOL_VERSION,
  type DriveJobProductV1,
  type DriveKnownProductUrlsV1,
  type DriveKnownUnavailableV1,
  type DriveLivePickJobV1,
  type DriveManualUrlOverridesV1,
  type DrivePriceObservationV1,
  type DriveProductUnit,
  type DriveRefreshJobV1,
  type DriveSearchHintsV1,
  type DriveStageAttemptV1
} from './driveProtocol';

// How long a "not sold at this store" memory entry is trusted before the
// collector searches for that product there again — a store's assortment
// does change over time, so this must eventually expire rather than hide a
// newly-listed product forever. Lowered from 14 to 3 days on 2026-09-04
// (user report) : "introuvable" ne veut pas dire "n'existe pas" — un produit
// en rupture de stock disparaît souvent des résultats de recherche Leclerc/
// Hyper U comme s'il n'existait pas, et un réassort peut survenir en
// quelques jours seulement. 14 jours masquait donc un retour en rayon
// pendant deux semaines. 3 jours reste un compromis (pas une valeur
// mesurée) : assez court pour retrouver un réassort rapide, assez long pour
// ne pas relancer une recherche vouée à l'échec à chaque rafraîchissement
// quotidien.
const NOT_FOUND_MEMORY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// Nombre maximal de quasi-matchs persistés par produit/magasin en échec —
// doit rester en phase avec `findLeclercNearMissCandidates`'s `limit` côté
// extension (actuellement 3), mais un excédent éventuel est simplement
// ignoré ici plutôt que de faire planter le traitement du rapport.
const NEAR_MISS_LIMIT = 3;

function nearMissCandidateId(storeKey: string, productId: string, index: number) {
  return `price-${storeKey}-${productId}-nearmiss-${index}`;
}

// Un quasi-match n'a plus lieu d'être dès que ce produit/magasin obtient soit
// un vrai match, soit un nouvel échec (dont les quasi-matchs, potentiellement
// différents, sont réécrits juste après) — sans ce nettoyage, une proposition
// obsolète resterait affichée indéfiniment après avoir été résolue.
async function clearNearMissCandidates(storeKey: StoreKey, productId: string) {
  for (let index = 0; index < NEAR_MISS_LIMIT; index += 1) {
    const id = nearMissCandidateId(storeKey, productId, index);
    await db.productCandidates.delete(id);
    await db.priceSnapshots.delete(id);
  }
}

// Codes que collectLeclercManualProduct/collectCoursesUManualProduct (côté
// extension) réservent exclusivement à l'échec de relecture d'une URL
// manuelle enregistrée par l'utilisateur — jamais produits par la cascade de
// recherche automatique (PRODUCT_NOT_FOUND, PRODUCT_SEARCH_TIMEOUT...). Leur
// présence dans report.errors prouve que la FICHE PRÉCISE choisie par
// l'utilisateur n'est plus valide, pas qu'une recherche de secours a échoué.
const MANUAL_URL_CONFIRMED_INVALID_CODES = new Set([
  'MANUAL_URL_PAGE_INVALID',
  'MANUAL_URL_PAGE_NOT_FOUND',
  'MANUAL_URL_PAGE_NOT_READY',
  'MANUAL_URL_PRICE_NOT_FOUND',
  'MANUAL_URL_NAVIGATION_FAILED'
]);

// Marque `available: false` (jamais de suppression : l'historique reste
// consultable) sur le prix du candidat auto-matché pour ce produit/magasin,
// quand la collecte la plus récente a échoué à le reconfirmer. Le
// comparisonEngine exclut déjà tout snapshot `available: false` des totaux
// automatiques — il ne reste qu'à effectivement poser ce drapeau ici.
export async function markMatchedPriceUnavailable(
  storeKey: StoreKey,
  productId: string,
  manualUrlConfirmedInvalid = false
) {
  const candidateId = `price-${storeKey}-${productId}`;
  const [candidate, snapshot] = await Promise.all([
    db.productCandidates.get(candidateId),
    db.priceSnapshots.get(candidateId)
  ]);
  // Même contrat que persistDriveObservation (voir son commentaire juste
  // au-dessus de skipAutomaticOverwrite) : une correction manuelle ne doit
  // jamais être rétrogradée par une recherche automatique ultérieure — y
  // compris quand celle-ci échoue purement et simplement (timeout, produit
  // introuvable via la cascade...). Bug réel confirmé le 31/08 (diagnostic
  // live) : un candidat manual_override se retrouvait figé à
  // available:false après un seul échec passager de recherche automatique,
  // sans jamais pouvoir se rétablir tout seul — persistDriveObservation
  // protège déjà le chemin succès via skipAutomaticOverwrite, mais ce
  // chemin échec n'avait aucune protection équivalente.
  //
  // Exception volontaire : `manualUrlConfirmedInvalid` (posé par l'appelant
  // uniquement quand l'échec vient de la RELECTURE DE L'URL MANUELLE
  // elle-même — codes MANUAL_URL_*, voir la boucle sur report.errors) est une
  // preuve directe que la fiche pointée par ce choix humain n'existe plus
  // (produit retiré du catalogue, page renumérotée...), pas une simple
  // absence de résultat de la recherche automatique de secours. Bug réel
  // confirmé le 01/09 : sans cette exception, un candidat manual_override
  // dont l'URL enregistrée devient invalide reste figé indéfiniment à
  // confiance 100 % avec son ancien prix, jamais revalidé ni jamais signalé
  // indisponible, alors même que le système vient de constater sa page
  // morte (cas réel : Purée Mousline, URL manuelle 31/08 devenue
  // MANUAL_URL_PAGE_INVALID le 01/09, remplacée en silence par un nouveau
  // candidat automatique jamais affiché).
  if (candidate?.matchType === 'manual_override' && !manualUrlConfirmedInvalid) return;
  if (snapshot && snapshot.available) {
    await db.priceSnapshots.put({ ...snapshot, available: false });
  }
}

// Débranchement PERMANENT (et non plus temporaire) de la mémoire de
// recherche en dev — décision utilisateur du 01/09, confirmée le 01/09 avec
// la mise en place de deux lancements séparés (serveur de développement et
// version compilée servie en local, sur deux ports distincts donc deux bases
// IndexedDB) : `import.meta.env.DEV` vaut `true` uniquement pour le serveur
// de dev (`vite`) et pour les tests, jamais pour le build de production
// (`vite build`, servi par `vite preview`) — le flag est statique et
// disparaît du bundle prod par élimination de code mort. Chaque
// rafraîchissement en dev retente donc réellement toute la cascade depuis
// zéro (sans avoir à vider la mémoire à la main avant chaque test), tandis
// que la version publique utilise la vraie mémoire de recherche comme prévu.
// Rien à rebrancher manuellement : le bon comportement est déjà sélectionné
// par le lanceur utilisé.
//
// Neutralisée EN LECTURE **ET EN ÉCRITURE** : couper la seule lecture ne
// suffirait pas, chaque rafraîchissement de mise au point continuerait à
// écrire un état ("non trouvé", stage gagnant) qui resservirait tel quel,
// obsolète, à la prochaine ouverture de la version publique.
const SEARCH_MEMORY_DISABLED = import.meta.env.DEV;

async function buildSearchMemoryHints(
  productIds: string[],
  storeKeys: StoreKey[]
): Promise<{ knownUnavailable: DriveKnownUnavailableV1; searchHints: DriveSearchHintsV1 }> {
  // En dev (`vite dev`, jamais le build prod — flag statique éliminé du
  // bundle), la mémoire de recherche est entièrement débranchée EN LECTURE :
  // ni "non trouvé" (knownUnavailable) ni le stage gagnant précédent
  // (searchHints). Un guard partiel limité à `not_found` restait en place
  // jusqu'ici, mais laissait `searchHints` orienter quand même la cascade
  // (retenter en priorité le seul stage qui avait gagné la dernière fois) —
  // en dev, où on veut valider un changement de logique de recherche à froid,
  // ça pouvait masquer une régression sur un stage que ce hint évitait de
  // retenter. Chaque rafraîchissement en dev retente donc réellement toute la
  // cascade depuis zéro, sans avoir à vider la mémoire à la main avant
  // chaque test. Voir SEARCH_MEMORY_DISABLED juste au-dessus : l'écriture est
  // débranchée en même temps que la lecture.
  if (SEARCH_MEMORY_DISABLED) return { knownUnavailable: {}, searchHints: {} };
  const knownUnavailable: DriveKnownUnavailableV1 = {};
  const searchHints: DriveSearchHintsV1 = {};
  const now = Date.now();
  for (const storeKey of storeKeys) {
    const entries = await db.driveSearchMemory
      .where('storeKey')
      .equals(storeKey)
      .filter((entry) => productIds.includes(entry.productId))
      .toArray();
    for (const entry of entries) {
      if (entry.outcome === 'not_found') {
        if (now - Date.parse(entry.updatedAt) > NOT_FOUND_MEMORY_TTL_MS) continue;
        knownUnavailable[storeKey] = [...(knownUnavailable[storeKey] ?? []), entry.productId];
      } else if (entry.stage) {
        searchHints[storeKey] = { ...(searchHints[storeKey] ?? {}), [entry.productId]: entry.stage };
      }
    }
  }
  return { knownUnavailable, searchHints };
}

// Corrections manuelles en attente (voir DriveManualOverrideEntry), pour les
// deux magasins. Longtemps limité à Hyper U, faute de permalien produit connu
// côté Leclerc — c'est faux depuis le 31/08 : la carte de résultat porte l'id
// de fiche (`v-produit-<id>`), et l'URL `fiche-produits-<id>-<slug>.aspx`
// qu'on en dérive est stable (le slug est décoratif). Sans cette levée, un
// candidat Leclerc corrigé à la main gardait son prix figé pour toujours :
// skipAutomaticOverwrite interdit à la recherche automatique de le réécrire,
// et le chemin manuel (collectLeclercManualProduct côté extension) ne
// recevait jamais d'URL. C'était la cause des "produits sautés" au
// rafraîchissement.
async function buildManualUrlOverrides(
  productIds: string[],
  storeKeys: StoreKey[]
): Promise<DriveManualUrlOverridesV1> {
  const overrides: DriveManualUrlOverridesV1 = {};
  for (const storeKey of storeKeys) {
    const entries = await db.driveManualOverrides
      .where('storeKey')
      .equals(storeKey)
      .filter((entry) => productIds.includes(entry.productId))
      .toArray();
    if (entries.length === 0) continue;
    overrides[storeKey] = Object.fromEntries(entries.map((entry) => [entry.productId, entry.productUrl]));
  }
  return overrides;
}

// Permaliens APPRIS (02/09/2026) : la fiche déjà retenue pour ce produit au
// rafraîchissement précédent. Le collecteur la relit directement au lieu de
// rejouer toute la cascade de recherche — c'est le gain de temps demandé, et
// surtout la fin des recherches qui repartaient à zéro et pouvaient retomber
// sur un autre produit.
//
// Trois filtres, tous nécessaires :
//   - un produit qui a déjà une correction manuelle est ignoré : son URL
//     passe par manualUrlOverrides, qui a plus de valeur (choix humain) ;
//   - un candidat rejeté ou de correspondance 'uncertain' n'est PAS mémorisé.
//     Sinon on figerait l'erreur : le raccourci ramènerait chaque fois la
//     même mauvaise fiche, alors qu'une nouvelle recherche a au moins une
//     chance de trouver mieux si le catalogue du magasin a bougé ;
//   - l'URL doit être un vrai permalien de fiche (isRefreshableProductUrl) ;
//     une URL de page de résultats relirait un produit quelconque.
//
// Contrairement à la mémoire de recherche (SEARCH_MEMORY_DISABLED), ce
// raccourci reste actif en dev : ce n'est pas une heuristique qui pourrait
// masquer une régression de la cascade, mais une adresse exacte que le
// collecteur revérifie systématiquement avant de retenir le prix.
async function buildKnownProductUrls(
  productIds: string[],
  storeKeys: StoreKey[],
  manualUrlOverrides: DriveManualUrlOverridesV1
): Promise<DriveKnownProductUrlsV1> {
  const known: DriveKnownProductUrlsV1 = {};
  for (const storeKey of storeKeys) {
    const urlsByProductId: Record<string, string> = {};
    const candidates = await db.productCandidates
      .where('storeKey')
      .equals(storeKey)
      .filter((candidate) => productIds.includes(candidate.productId))
      .toArray();
    // Un même produit/magasin peut porter plusieurs candidats : celui retenu,
    // plus les "quasi-matchs" gardés pour proposition manuelle (isAlternate,
    // autre format). Sans ce tri, le dernier lu l'emportait — on aurait pu
    // mémoriser le permalien d'un format que le comparateur ne choisit jamais.
    const bestByProductId = new Map<string, ProductCandidate>();
    for (const candidate of candidates) {
      if (candidate.isAlternate) continue;
      const best = bestByProductId.get(candidate.productId);
      if (!best || candidate.confidenceScore > best.confidenceScore) {
        bestByProductId.set(candidate.productId, candidate);
      }
    }
    for (const [productId, candidate] of bestByProductId) {
      if (manualUrlOverrides[storeKey]?.[productId]) continue;
      if (candidate.isRejected) continue;
      if (candidate.matchType === 'uncertain') continue;
      if (!candidate.productUrl || !isRefreshableProductUrl(candidate.productUrl, storeKey)) continue;
      urlsByProductId[productId] = candidate.productUrl;
    }
    if (Object.keys(urlsByProductId).length > 0) known[storeKey] = urlsByProductId;
  }
  return known;
}

// Enregistre l'URL produit confirmée par l'utilisateur pour un prochain
// rafraîchissement — voir runManualUrlCheck pour la vérification immédiate.
export async function saveManualUrlOverride(productId: string, storeKey: StoreKey, productUrl: string) {
  await db.driveManualOverrides.put({ productId, storeKey, productUrl, updatedAt: new Date().toISOString() });
}

export async function clearManualUrlOverride(productId: string, storeKey: StoreKey) {
  await db.driveManualOverrides
    .where('[productId+storeKey]')
    .equals([productId, storeKey])
    .delete();
}

// Vide entièrement la mémoire "produit non trouvé chez ce magasin" (voir
// buildSearchMemoryHints / NOT_FOUND_MEMORY_TTL_MS) — utile quand cette
// mémoire retient à tort un échec obsolète (ex. corrigé après un bug de
// détection côté extension) et fait sauter certains produits d'un
// rafraîchissement Drive alors qu'ils sont en réalité disponibles. Purge
// globale volontaire plutôt que ciblée par magasin/produit : plus simple à
// exposer côté réglages, et le pire coût d'un vidage trop large est juste
// quelques recherches refaites inutilement au prochain rafraîchissement.
export async function clearDriveSearchMemory() {
  await db.driveSearchMemory.clear();
}

const DIAGNOSTIC_FORMAT = 'drive-price-splitter-diagnostic';
const DIAGNOSTIC_FORMAT_VERSION = 1;

export type DriveRefreshDiagnostic = {
  format: typeof DIAGNOSTIC_FORMAT;
  formatVersion: number;
  protocolVersion: number;
  connectorVersion?: string;
  createdAt: string;
  summary: {
    attempted: number;
    updated: number;
    failed: number;
    // Products filtered out before the collector ran because they were
    // already known "not_found" at that store within the last 3 days —
    // included so attempted/updated/failed don't look like they're missing
    // a chunk of the shopping list for no reason.
    skipped: number;
    refreshedAt: string | null;
  };
  errors: string[];
  diagnostics: Array<{
    storeKey: string;
    code: string;
    [key: string]: unknown;
  }>;
  // Per-product prices actually collected — absent from the diagnostic
  // before this, which only ever listed failures. Without this, the only
  // way to spot-check a collected price against the real site was to open
  // the app itself; this lets the exported JSON be checked on its own.
  observations: Array<{
    productId: string;
    productName: string;
    storeKey: string;
    observedName: string;
    priceEuro?: number;
    unitPriceEuro?: number;
    available: boolean;
    promotionLabel?: string;
    productUrl?: string;
    matchScore?: number;
    // Étage de la cascade qui a réellement fourni ce prix ('name',
    // 'simplified_name', 'name_only', 'brand_only'), ou le chemin qui a
    // court-circuité la recherche ('manual', 'known_url').
    matchStage?: DrivePriceObservationV1['matchStage'];
    // Détail de chaque étage de la cascade Leclerc réellement tenté, même
    // sur un succès — voir DriveStageAttemptV1.
    stageAttempts?: DriveStageAttemptV1[];
  }>;
};

export type DriveRefreshOutcome = {
  ran: true;
  diagnostic: DriveRefreshDiagnostic;
} | {
  ran: false;
  reason: string;
};

async function acquireWakeLock(): Promise<WakeLockSentinel | null> {
  try {
    return (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

// The Screen Wake Lock is released automatically whenever the document goes
// to background (app switch, screen off) and does NOT come back on its own
// once the page is visible again — a collection left running while the user
// briefly checks something else would silently lose the lock for the rest
// of the run. Re-acquire it on every visibility return for as long as the
// caller hasn't torn this down.
function keepWakeLockAlive(initial: WakeLockSentinel | null) {
  let current = initial;
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && !current) {
      void acquireWakeLock().then((lock) => {
        current = lock;
      });
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  return {
    stop: async () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      await current?.release().catch(() => undefined);
    }
  };
}

// Cœur de la persistance d'une observation Drive en candidat + prix comparés
// — extrait pour être réutilisé à la fois par la boucle de rafraîchissement
// normale (ci-dessous) et par les deux mécanismes de correction manuelle
// (runManualUrlCheck pour Hyper U, runLivePick pour Leclerc), qui produisent
// chacun une observation isolée avec `matchStage: 'manual'` hors de toute
// boucle multi-produits.
// Exportée uniquement pour le test unitaire du comportement isRejected sur
// une confirmation manuelle (voir driveRefreshService.test.ts) — pas
// appelée directement ailleurs dans le code.
// 'L'/'kg' côté protocole (ce que la fiche affiche) → ComparisonUnit côté
// base, le vocabulaire déjà utilisé par PriceSnapshot.comparisonUnit.
function toComparisonUnit(unit: 'L' | 'kg'): ComparisonUnit {
  return unit === 'L' ? 'liter' : 'kilogram';
}

// Ne retient que les étages qui appartiennent réellement à la cascade de
// recherche — le type stocké (DriveSearchStage) est volontairement plus
// étroit que celui du protocole, qui admet aussi 'manual' et 'known_url'.
const CASCADE_STAGES: DriveSearchStage[] = ['ean', 'name', 'simplified_name', 'name_only', 'brand_only'];

function toCascadeStage(stage: DrivePriceObservationV1['matchStage']): DriveSearchStage | undefined {
  return CASCADE_STAGES.find((candidate) => candidate === stage);
}

// Comparaison de marques insensible à la casse et aux accents — sert
// uniquement à décider d'une étiquette, jamais à accepter ou refuser un
// candidat (l'acceptation est déjà tranchée côté collecteur).
function sameBrand(left: string | undefined, right: string | undefined) {
  const normalize = (value: string | undefined) =>
    String(value ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .trim()
      .toLocaleLowerCase('fr');
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

// Étiquette de correspondance d'un candidat, à partir de ce qu'on sait de lui.
//
// Le point délicat : `private_label` veut dire « marque de distributeur », et
// getCandidateConfidence (scoring.ts) lui applique une règle très sévère —
// confiance forcée à 0 tant que l'utilisateur n'a pas accepté les marques de
// distributeur POUR CE PRODUIT. Cette étiquette était pourtant posée sur le
// seul critère du score de recouvrement de noms (entre 0,7 et 0,9), sans
// jamais regarder la marque : un produit de la bonne marque, correctement
// trouvé, se retrouvait donc étiqueté « marque de distributeur », ramené à une
// confiance de 0, et redemandé en validation manuelle à chaque comparatif.
// C'est le motif dominant des « fiches à valider alors que c'est la bonne
// fiche » signalé le 02/09.
//
// Correction volontairement étroite : quand la marque observée correspond à la
// marque demandée, ce n'est pas une marque de distributeur — l'étiquette
// devient `equivalent_brand`, dont le plafond de confiance (89) reste sous le
// 100 réservé à une preuve réelle (code-barres ou confirmation humaine). Rien
// n'est relâché en amont : le collecteur applique toujours son seuil
// d'acceptation (deux tiers des mots attendus + recouvrement de catégorie), et
// un candidat de marque réellement différente reste `private_label`.
function classifyMatchType(input: {
  matchStage: DrivePriceObservationV1['matchStage'];
  barcodeConfirmed: boolean;
  matchScore: number;
  productBrand?: string;
  observedBrand?: string;
}): ProductCandidate['matchType'] {
  if (input.matchStage === 'manual') return 'manual_override';
  if (input.barcodeConfirmed || input.matchStage === 'ean') return 'exact_barcode';
  if (input.matchScore >= 0.9) return 'equivalent_brand';
  if (input.matchScore >= 0.7) {
    return sameBrand(input.productBrand, input.observedBrand) ? 'equivalent_brand' : 'private_label';
  }
  return 'uncertain';
}

export async function persistDriveObservation(
  observation: DrivePriceObservationV1,
  productBarcode: string | undefined,
  replaceInvalidManualOverride = false
): Promise<string> {
  const candidateId = `price-${observation.storeKey}-${observation.productId}`;
  const existingCandidate = await db.productCandidates.get(candidateId);
  const now = new Date().toISOString();

  // Un candidat déjà confirmé manuellement (clic direct sur la page
  // produit) ne doit jamais être rétrogradé ni remplacé par une recherche
  // automatique ultérieure qui retrouverait un match différent (souvent de
  // moins bonne qualité — l'ID candidat est déterministe par
  // produit/magasin, donc un refresh auto écrit sur la même ligne) : c'est
  // le contrat déjà documenté sur CandidateMatchType ("Never downgraded by
  // a subsequent automatic search", domain.ts). On ignore alors le
  // prix/nom observés automatiquement, mais le produit reste marqué résolu
  // pour ce magasin plus bas afin que le refresh automatique n'insiste pas.
  const skipAutomaticOverwrite =
    existingCandidate?.matchType === 'manual_override' &&
    observation.matchStage !== 'manual' &&
    !replaceInvalidManualOverride;

  if (!skipAutomaticOverwrite) {
    const snapshot: PriceSnapshot = {
      id: candidateId,
      candidateId,
      storeKey: observation.storeKey,
      price: observation.priceEuro,
      currency: 'EUR',
      unitPrice: observation.unitPriceEuro,
      // Sans son unité, un prix au litre ne se distingue pas d'un prix au
      // kilo : le comparateur ne pourrait plus s'en servir pour départager
      // deux magasins qui ne vendent pas le même format (voir
      // unitPriceArbitration.ts).
      ...(observation.unitPriceUnit ? { comparisonUnit: toComparisonUnit(observation.unitPriceUnit) } : {}),
      priceCoherence: checkPriceCoherence({
        priceEuro: observation.priceEuro,
        unitPriceEuro: observation.unitPriceEuro,
        unitPriceUnit: observation.unitPriceUnit,
        observedQuantity: observation.observedQuantity,
        observedUnit: observation.observedUnit
      }),
      available: observation.available,
      promoLabel: observation.promotionLabel,
      checkedAt: observation.observedAt,
      source: 'adapter'
    };
    await db.priceSnapshots.put(snapshot);
    const matchScore = observation.matchScore ?? 0;
    const barcodeConfirmed = Boolean(
      productBarcode && observation.observedBarcode && productBarcode === observation.observedBarcode
    );
    // Une correction manuelle (URL collée ou tap direct sur la page) est un
    // choix humain explicite : elle prime sur toute déduction automatique par
    // score, quel que soit le recouvrement de noms observé.
    const matchType = classifyMatchType({
      matchStage: observation.matchStage,
      barcodeConfirmed,
      matchScore,
      productBrand: (await db.products.get(observation.productId))?.brand,
      observedBrand: observation.observedBrand
    });
    const confidenceReasons = [
      observation.matchStage === 'manual'
        ? 'Confirmé manuellement par l’utilisateur'
        : barcodeConfirmed
          ? 'Code-barres confirmé'
          : `Recouvrement de noms ${Math.round(matchScore * 100)}%`,
      ...(observation.matchStage && observation.matchStage !== 'manual'
        ? [`Trouvé via recherche : ${observation.matchStage}`]
        : [])
    ];
    const candidate: ProductCandidate = {
      id: candidateId,
      productId: observation.productId,
      storeKey: observation.storeKey,
      storeProductId: observation.externalProductId,
      name: observation.observedName,
      brand: observation.observedBrand,
      barcode: observation.observedBarcode,
      productUrl: observation.productUrl,
      // Format extrait par le collecteur du nom du candidat retenu (voir
      // extension/shared/quantity-parser.js) — undefined quand le nom n'a
      // rien de reconnaissable. Sert à comparisonEngine.ts pour signaler
      // quand Leclerc et Hyper U retiennent deux formats différents pour la
      // même ligne (cas réel 31/08 : Purée Mousline 375g/1040g).
      quantity: observation.observedQuantity,
      unit: observation.observedUnit,
      matchType,
      confidenceScore: Math.round(matchScore * 100),
      confidenceReasons,
      // Un rejet précédent ("Aucun de ceux-là") doit survivre à un refresh
      // automatique ultérieur — sinon le candidat rejeté réapparaîtrait tout
      // seul. Mais une confirmation manuelle explicite (pick direct sur la
      // page) doit au contraire toujours lever ce rejet : c'est justement
      // l'utilisateur qui vient de désigner ce candidat comme le bon.
      isRejected: observation.matchStage === 'manual' ? false : (existingCandidate?.isRejected ?? false),
      createdAt: existingCandidate?.createdAt ?? now,
      updatedAt: now
    };
    await db.productCandidates.put(candidate);
  }

  // 'manual' (pick direct par l'utilisateur sur la page) et 'known_url'
  // (relecture d'un permalien appris) ne sont pas des étages de la cascade
  // name→simplified_name→name_only→brand_only : il n'y a rien à "sauter
  // direct" au prochain refresh automatique. Même distinction déjà faite
  // juste au-dessus pour confidenceReasons.
  // On conserve alors l'étage déjà mémorisé au lieu de l'effacer : si le
  // permalien devient un jour périmé, la cascade repart au bon étage plutôt
  // que de tout rejouer depuis le début.
  const cascadeStage = toCascadeStage(observation.matchStage);
  const previousMemory = cascadeStage
    ? undefined
    : await db.driveSearchMemory
        .where('[productId+storeKey]')
        .equals([observation.productId, observation.storeKey])
        .first();
  const carriedStage = cascadeStage ?? previousMemory?.stage;
  const memoryEntry: DriveSearchMemoryEntry = {
    productId: observation.productId,
    storeKey: observation.storeKey,
    outcome: 'matched',
    ...(carriedStage ? { stage: carriedStage } : {}),
    updatedAt: now
  };
  if (!SEARCH_MEMORY_DISABLED) await db.driveSearchMemory.put(memoryEntry);
  // Un vrai match résout ce produit/magasin — un quasi-match hérité d'un
  // refresh précédent n'a plus lieu d'être proposé.
  await clearNearMissCandidates(observation.storeKey, observation.productId);
  return candidateId;
}

export async function runDriveRefresh(
  rows: ShoppingListRow[],
  onProgress?: (event: DriveRefreshProgressEvent) => void
): Promise<DriveRefreshOutcome> {
  const stores = await listSelectedStores();
  if (isVerboseDiagnosticsEnabled()) {
    console.log('[driveRefreshService] Stores loaded:', stores.map((s) => ({ storeKey: s.storeKey, driveUrl: s.driveUrl })));
  }
  if (stores.length === 0) {
    return { ran: false, reason: "Aucun magasin configuré dans les réglages." };
  }
  const productIds = [...new Set(rows.map((row) => row.product.id))];
  if (productIds.length === 0) {
    return { ran: false, reason: 'Aucun produit dans la liste active.' };
  }

  const bridge = getExtensionBridge();
  try {
    await bridge.detectDriveExtension();
  } catch {
    return { ran: false, reason: 'Extension Drive indisponible.' };
  }

  const jobProducts = rows
    .map((row) => row.product)
    .filter((product, index, all) => all.findIndex((candidate) => candidate.id === product.id) === index);
  const { knownUnavailable, searchHints } = await buildSearchMemoryHints(
    jobProducts.map((product) => product.id),
    stores.map((store) => store.storeKey)
  );
  const manualUrlOverrides = await buildManualUrlOverrides(
    jobProducts.map((product) => product.id),
    stores.map((store) => store.storeKey)
  );
  const knownProductUrls = await buildKnownProductUrls(
    jobProducts.map((product) => product.id),
    stores.map((store) => store.storeKey),
    manualUrlOverrides
  );

  const job: DriveRefreshJobV1 = {
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    jobId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    stores: stores.map(toDriveJobStore),
    products: jobProducts.map(toDriveJobProduct),
    ...(Object.keys(knownUnavailable).length > 0 ? { knownUnavailable } : {}),
    ...(Object.keys(searchHints).length > 0 ? { searchHints } : {}),
    ...(Object.keys(manualUrlOverrides).length > 0 ? { manualUrlOverrides } : {}),
    ...(Object.keys(knownProductUrls).length > 0 ? { knownProductUrls } : {})
  };

  const wakeLockKeeper = keepWakeLockAlive(await acquireWakeLock());
  let response: DriveRefreshExtensionResponse;
  try {
    response = await bridge.startDriveRefresh(job, onProgress);
  } catch (error) {
    return {
      ran: false,
      reason: error instanceof Error ? error.message : 'La collecte Drive a échoué.'
    };
  } finally {
    await wakeLockKeeper.stop();
  }

  if (!response.accepted || !response.report) {
    return { ran: false, reason: response.reason ?? 'La collecte Drive a échoué.' };
  }

  const report = response.report;
  const localStoreById = new Map(stores.map((store) => [store.id, store]));
  const productNameById = new Map(job.products.map((product) => [product.productId, product.name]));
  const productBarcodeById = new Map(job.products.map((product) => [product.productId, product.barcode]));
  const productBrandById = new Map(job.products.map((product) => [product.productId, product.brand]));
  const outcomeKey = (storeKey: string, productId: string) => `${storeKey}:${productId}`;
  const observedOutcomeKeys = new Set(
    report.observations.map((observation) => outcomeKey(observation.storeKey, observation.productId))
  );
  // Une URL manuelle peut échouer puis la cascade automatique réussir pour le
  // même produit pendant CE MÊME job. Dans ce cas l'erreur est une tentative
  // intermédiaire récupérée, pas l'issue finale : l'ancien verrou manuel est
  // retiré et l'observation fraîche doit pouvoir le remplacer.
  const recoveredManualOutcomeKeys = new Set(
    report.errors
      .filter((error) =>
        Boolean(error.productId) &&
        MANUAL_URL_CONFIRMED_INVALID_CODES.has(error.code) &&
        observedOutcomeKeys.has(outcomeKey(error.storeKey, error.productId!))
      )
      .map((error) => outcomeKey(error.storeKey, error.productId!))
  );
  const effectiveErrors = report.errors.filter((error) =>
    !error.productId || !recoveredManualOutcomeKeys.has(outcomeKey(error.storeKey, error.productId))
  );
  for (const key of recoveredManualOutcomeKeys) {
    const separator = key.indexOf(':');
    const storeKey = key.slice(0, separator) as StoreKey;
    const productId = key.slice(separator + 1);
    await clearManualUrlOverride(productId, storeKey);
  }

  let updated = 0;
  for (const observation of report.observations) {
    const store = localStoreById.get(observation.localStoreId);
    if (!store) continue;
    const productBarcode = productBarcodeById.get(observation.productId);
    const candidateId = await persistDriveObservation(
      observation,
      productBarcode,
      recoveredManualOutcomeKeys.has(outcomeKey(observation.storeKey, observation.productId))
    );
    const now = new Date().toISOString();
    updated += 1;

    for (const [index, alternate] of (observation.alternates ?? []).entries()) {
      const alternateId = `${candidateId}-alt-${index}`;
      const alternateScore = alternate.matchScore ?? 0;
      const existingAlternate = await db.productCandidates.get(alternateId);
      // `best` était lui-même incertain : cet alternate peut être un autre
      // format du même produit (`quantityDiffers`) ou un candidat distinct
      // qui a franchi le seuil sans être retenu — les deux méritent d'être
      // montrés, mais pas avec le même motif ni le même plafond de confiance.
      // Un alternate n'est PAS un quasi-match : le collecteur ne le remonte
      // que s'il a franchi le même seuil d'acceptation que le candidat retenu
      // (deux tiers des mots attendus + recouvrement de catégorie, voir
      // rankLeclercCandidates). L'étiqueter `uncertain` en dur le plafonnait
      // pourtant à 64 % de confiance quel que soit son score : relevé sur le
      // téléphone le 02/09, des alternates à 100 % de recouvrement de noms
      // étaient marqués incertains, donc « à valider » à chaque comparatif.
      // Ils suivent désormais exactement la même règle que le candidat
      // principal. Les quasi-matchs proposés faute de correspondance fiable
      // (`nearMisses`, plus bas) restent, eux, `uncertain` : ceux-là méritent
      // vraiment une validation humaine.
      const alternateMatchType: ProductCandidate['matchType'] = alternate.quantityDiffers
        ? 'same_brand_different_format'
        : classifyMatchType({
            // Volontairement sans étage : un alternate n'est jamais ni une
            // confirmation humaine ni un rapprochement par code-barres, même
            // quand le candidat principal de la même observation en est un.
            matchStage: undefined,
            barcodeConfirmed: false,
            matchScore: alternateScore,
            productBrand: productBrandById.get(observation.productId),
            observedBrand: alternate.observedBrand
          });
      await db.productCandidates.put({
        id: alternateId,
        productId: observation.productId,
        storeKey: observation.storeKey,
        storeProductId: alternate.externalProductId,
        name: alternate.observedName,
        brand: alternate.observedBrand,
        barcode: alternate.observedBarcode,
        productUrl: alternate.productUrl,
        matchType: alternateMatchType,
        confidenceScore: Math.round(alternateScore * 100),
        confidenceReasons: [
          alternate.quantityDiffers
            ? 'Format différent trouvé en magasin'
            : 'Autre candidat valide non retenu comme meilleure correspondance'
        ],
        isRejected: existingAlternate?.isRejected ?? false,
        isAlternate: true,
        createdAt: existingAlternate?.createdAt ?? now,
        updatedAt: now
      });
      await db.priceSnapshots.put({
        id: alternateId,
        candidateId: alternateId,
        storeKey: observation.storeKey,
        price: alternate.priceEuro,
        currency: 'EUR',
        unitPrice: alternate.unitPriceEuro,
        ...(alternate.unitPriceUnit ? { comparisonUnit: toComparisonUnit(alternate.unitPriceUnit) } : {}),
        // Même contrôle que sur le prix principal : un alternate est un prix
        // que l'utilisateur peut retenir à la place de celui proposé, il doit
        // donc être vérifié de la même façon. Il ne l'était pas, alors que
        // son prix unitaire traversait déjà le protocole.
        priceCoherence: checkPriceCoherence({
          priceEuro: alternate.priceEuro,
          unitPriceEuro: alternate.unitPriceEuro,
          unitPriceUnit: alternate.unitPriceUnit,
          observedQuantity: alternate.observedQuantity,
          observedUnit: alternate.observedUnit
        }),
        available: true,
        checkedAt: observation.observedAt,
        source: 'adapter'
      });
    }
    // Le candidat, le prix, la mémoire de recherche et le nettoyage des
    // quasi-matchs sont déjà posés par persistDriveObservation ci-dessus —
    // seuls les alternates (propres à ce chemin multi-produits) restent à
    // traiter ici.
  }

  for (const error of effectiveErrors) {
    if (!error.productId) continue;
    const storeKey = error.storeKey as StoreKey;
    // Toute collecte qui échoue pour ce produit/magasin précis (introuvable,
    // recherche jamais lancée, champ de recherche absent...) invalide le
    // dernier prix connu — sans ceci, un produit retiré du catalogue
    // garderait indéfiniment son dernier prix dans les totaux, silencieusement.
    // Codes émis UNIQUEMENT par la relecture d'une URL manuelle enregistrée
    // (jamais par la cascade de recherche automatique, voir leclerc-collector.js
    // et courses-u-collector.js) : preuve directe que cette fiche précise
    // n'existe plus, à distinguer d'un simple échec de recherche générale
    // (voir le commentaire de markMatchedPriceUnavailable).
    const manualUrlConfirmedInvalid = MANUAL_URL_CONFIRMED_INVALID_CODES.has(error.code);
    await markMatchedPriceUnavailable(storeKey, error.productId, manualUrlConfirmedInvalid);

    if (error.code !== 'PRODUCT_NOT_FOUND') continue;
    if (!SEARCH_MEMORY_DISABLED) {
      await db.driveSearchMemory.put({
        productId: error.productId,
        storeKey,
        outcome: 'not_found',
        updatedAt: new Date().toISOString()
      });
    }

    // Aucun candidat n'a franchi le seuil d'acceptation, mais le collecteur a
    // pu remonter quelques quasi-matchs (`nearMisses`) — les persister comme
    // candidats `isAlternate` + `matchType: 'uncertain'` donne à l'utilisateur
    // une proposition cliquable dans le panneau de validation plutôt qu'un
    // échec sans aucune issue.
    //
    // Un même produit peut ne pas réapparaître au même index d'un refresh à
    // l'autre (l'ordre des quasi-matchs dépend du classement du moment) —
    // retrouver un rejet déjà posé se fait donc par `productUrl` (l'identité
    // réelle de la fiche), jamais par l'id positionnel `-nearmiss-N`.
    const existingNearMissRejectedByUrl = new Map<string, boolean>();
    for (let index = 0; index < NEAR_MISS_LIMIT; index += 1) {
      const existing = await db.productCandidates.get(nearMissCandidateId(storeKey, error.productId, index));
      if (existing?.productUrl) {
        existingNearMissRejectedByUrl.set(existing.productUrl, existing.isRejected ?? false);
      }
    }
    await clearNearMissCandidates(storeKey, error.productId);
    const nearMisses = error.details?.nearMisses ?? [];
    const nearMissNow = new Date().toISOString();
    for (const [index, nearMiss] of nearMisses.slice(0, NEAR_MISS_LIMIT).entries()) {
      if (!nearMiss.productUrl || nearMiss.priceEuro === undefined) continue;
      const nearMissId = nearMissCandidateId(storeKey, error.productId, index);
      const nearMissScore = nearMiss.matchScore ?? 0;
      await db.productCandidates.put({
        id: nearMissId,
        productId: error.productId,
        storeKey,
        name: nearMiss.name,
        brand: nearMiss.brand,
        barcode: nearMiss.barcode,
        productUrl: nearMiss.productUrl,
        matchType: 'uncertain',
        confidenceScore: Math.round(nearMissScore * 100),
        confidenceReasons: ['Quasi-match proposé faute de correspondance fiable'],
        isRejected: existingNearMissRejectedByUrl.get(nearMiss.productUrl) ?? false,
        isAlternate: true,
        createdAt: nearMissNow,
        updatedAt: nearMissNow
      });
      await db.priceSnapshots.put({
        id: nearMissId,
        candidateId: nearMissId,
        storeKey,
        price: nearMiss.priceEuro,
        currency: 'EUR',
        available: true,
        checkedAt: nearMissNow,
        source: 'adapter'
      });
    }
  }

  const skippedCount = (report.skipped ?? []).reduce((sum, entry) => sum + entry.count, 0);
  const diagnostic: DriveRefreshDiagnostic = {
    format: DIAGNOSTIC_FORMAT,
    formatVersion: DIAGNOSTIC_FORMAT_VERSION,
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    connectorVersion: response.extensionVersion,
    createdAt: new Date().toISOString(),
    summary: {
      attempted: job.products.length * job.stores.length - skippedCount,
      updated,
      failed: effectiveErrors.length,
      skipped: skippedCount,
      refreshedAt: report.observations[0]?.observedAt ?? null
    },
    errors: effectiveErrors.map((error) => `${error.storeKey}: ${error.code}`),
    // productId/productName manquaient ici : chaque entrée n'était traçable
    // que par `pathKind` (le texte recherché) dans `details`, souvent
    // insuffisant pour relier une erreur à un produit précis de la liste
    // (ex. deux produits différents dont la requête finale coïncide après
    // simplification). Sans ça, diagnostiquer un cas précis signalé par
    // l'utilisateur obligeait à deviner plutôt qu'à vérifier.
    diagnostics: effectiveErrors.map((error) => ({
      storeKey: error.storeKey,
      code: error.code,
      ...(error.productId
        ? { productId: error.productId, productName: productNameById.get(error.productId) ?? error.productId }
        : {}),
      ...(error.details ?? {})
    })),
    observations: report.observations.map((observation) => ({
      productId: observation.productId,
      productName: productNameById.get(observation.productId) ?? observation.productId,
      storeKey: observation.storeKey,
      observedName: observation.observedName,
      priceEuro: observation.priceEuro,
      unitPriceEuro: observation.unitPriceEuro,
      available: observation.available,
      promotionLabel: observation.promotionLabel,
      productUrl: observation.productUrl,
      matchScore: observation.matchScore,
      // Étage réellement retenu (02/09) : `stageAttempts` disait quels étages
      // avaient été tentés, jamais lequel avait gagné. Le déduire du dernier
      // étage tenté est faux dès qu'un repli de marque est retenu (le
      // fallbackBest d'un étage antérieur — voir collectLeclercStore), et
      // impossible pour 'manual'/'known_url', qui ne tentent aucun étage.
      // Sans cette valeur, aucune mesure fiable de « quel étage trouve le
      // plus souvent » n'est possible depuis les exports — voir
      // tools/analyse-cascade.mjs.
      ...(observation.matchStage ? { matchStage: observation.matchStage } : {}),
      ...(observation.stageAttempts ? { stageAttempts: observation.stageAttempts } : {})
    }))
  };

  return { ran: true, diagnostic };
}

export type ManualCorrectionOutcome =
  | {
      ok: true;
      candidateId: string;
      observedName: string;
      priceEuro: number;
      // Format lu sur la fiche (« 250 g », « 1 L »). Remonté jusqu'à
      // l'appelant parce qu'un produit créé depuis un simple texte tapé n'a
      // aucun format cible : sans lui, la comparaison au kilo entre les deux
      // magasins ne peut pas se faire (voir unitPriceArbitration.ts).
      observedQuantity?: number;
      observedUnit?: DriveProductUnit;
    }
  | { ok: false; reason: string };

// Correction manuelle (Leclerc et Hyper U) : ouvre le catalogue du magasin
// pour ce seul produit et attend que l'utilisateur navigue jusqu'à la bonne
// fiche/carte directement sur la page réelle (voir DriveLivePickJobV1).
export async function runLivePick(
  productId: string,
  productName: string,
  productBarcode: string | undefined,
  storeKey: StoreKey,
  onProgress?: (event: DriveRefreshProgressEvent) => void,
  // Retour explicite du 31/08 : quand un candidat est déjà connu (lien "Voir
  // le produit" du détail par magasin), y amène directement l'onglet plutôt
  // que l'accueil catalogue — voir le commentaire sur DriveLivePickJobV1.
  startUrl?: string,
  // Mots tapés par l'utilisateur dans l'écran d'ajout pour un produit tout
  // neuf : sans candidat connu il n'y a pas de startUrl, et l'onglet
  // s'ouvrirait sur un catalogue vide. L'extension saisit alors cette
  // requête dans le champ de recherche du site avant de rendre la main
  // (voir DriveJobProductV1.searchQuery).
  searchQuery?: string
): Promise<ManualCorrectionOutcome> {
  const stores = await listSelectedStores();
  const store = stores.find((candidate) => candidate.storeKey === storeKey);
  if (!store) {
    return { ok: false, reason: `Magasin ${storeKey} non configuré dans les réglages.` };
  }

  const bridge = getExtensionBridge();
  try {
    await bridge.detectDriveExtension();
  } catch {
    return { ok: false, reason: 'Extension Drive indisponible.' };
  }

  const job: DriveLivePickJobV1 = {
    protocolVersion: DRIVE_PROTOCOL_VERSION,
    jobId: crypto.randomUUID(),
    requestedAt: new Date().toISOString(),
    store: toDriveJobStore(store),
    product: toDriveJobProduct({
      id: productId,
      name: productName,
      barcode: productBarcode,
      ...(searchQuery ? { searchQuery } : {})
    }),
    ...(startUrl ? { startUrl } : {})
  };

  const wakeLockKeeper = keepWakeLockAlive(await acquireWakeLock());
  let response: DriveLivePickExtensionResponse;
  try {
    response = await bridge.startLivePick(job, onProgress);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'La sélection manuelle a échoué.' };
  } finally {
    await wakeLockKeeper.stop();
  }
  if (!response.accepted || !response.report) {
    return { ok: false, reason: response.reason ?? 'La sélection manuelle a échoué.' };
  }
  const observation = response.report.observations[0];
  if (!observation) {
    const error = response.report.errors[0];
    return {
      ok: false,
      reason: error ? `Sélection non aboutie (${error.code}).` : 'Aucun produit sélectionné.'
    };
  }
  const candidateId = await persistDriveObservation(observation, productBarcode);
  // Une sélection en direct produit un candidat `manual_override`, que la
  // recherche automatique n'a plus le droit de réécrire
  // (skipAutomaticOverwrite) : sans permalien mémorisé, son prix resterait
  // figé indéfiniment. On enregistre donc l'URL de la fiche remontée par le
  // collecteur pour que le prochain rafraîchissement relise cette fiche
  // exacte (voir buildManualUrlOverrides).
  if (isRefreshableProductUrl(observation.productUrl, storeKey)) {
    await saveManualUrlOverride(productId, storeKey, observation.productUrl);
  }
  return {
    ok: true,
    candidateId,
    observedName: observation.observedName,
    priceEuro: observation.priceEuro,
    ...(observation.observedQuantity !== undefined ? { observedQuantity: observation.observedQuantity } : {}),
    ...(observation.observedUnit ? { observedUnit: observation.observedUnit } : {})
  };
}

// Toutes les URLs produit ne sont pas rafraîchissables telles quelles : côté
// Leclerc, quand l'id de fiche n'a pas pu être lu sur la carte, le collecteur
// retombe volontairement sur l'URL de la grille de recherche. La mémoriser
// comme "fiche produit" ferait relire un résultat quelconque au prochain
// rafraîchissement — pire que de ne rien mémoriser. On ne retient donc que
// les formes de permalien connues : `fiche-produits-<id>` (Leclerc) et
// `/p/<slug>.html` (Hyper U).
function isRefreshableProductUrl(productUrl: string, storeKey: StoreKey): boolean {
  try {
    const { pathname } = new URL(productUrl);
    if (storeKey === 'leclerc') return /\/fiche-produits-\d+/i.test(pathname);
    if (storeKey === 'hyperu') return pathname.startsWith('/p/');
    return false;
  } catch {
    return false;
  }
}

export function downloadDriveDiagnostic(diagnostic: DriveRefreshDiagnostic) {
  const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `diagnostic-drive-${diagnostic.createdAt.replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toDriveJobStore(store: UserStore) {
  return {
    storeKey: store.storeKey,
    localStoreId: store.id,
    displayName: store.displayName,
    ...(store.address ? { address: store.address } : {}),
    ...(store.city ? { city: store.city } : {}),
    ...(store.postalCode ? { postalCode: store.postalCode } : {}),
    ...(store.latitude !== undefined ? { latitude: store.latitude } : {}),
    ...(store.longitude !== undefined ? { longitude: store.longitude } : {}),
    ...(store.driveUrl ? { driveUrl: store.driveUrl } : {})
  };
}

function toDriveJobProduct(product: {
  id: string;
  name: string;
  brand?: string;
  barcode?: string;
  baseQuantity?: number;
  baseUnit?: string;
  searchQuery?: string;
}): DriveJobProductV1 {
  return {
    productId: product.id,
    name: product.name,
    ...(product.brand ? { brand: product.brand } : {}),
    ...(product.barcode ? { barcode: product.barcode } : {}),
    ...(product.baseQuantity !== undefined ? { baseQuantity: product.baseQuantity } : {}),
    ...(product.baseUnit ? { baseUnit: product.baseUnit as DriveJobProductV1['baseUnit'] } : {}),
    ...(product.searchQuery ? { searchQuery: product.searchQuery } : {})
  };
}
