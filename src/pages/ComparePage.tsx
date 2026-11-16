import { ListAlreadyUsedNotice } from '../features/shopping-list/ListAlreadyUsedNotice';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadActiveComparison, setProductCandidateRejected, type ActiveComparison } from '../features/comparison/comparisonService';
import { compareShoppingList, type ComparisonDecision } from '../features/comparison/comparisonEngine';
import { type StoreKey } from '../types/domain';
import { grantCartAutomationConsent, hasCurrentCartAutomationConsent } from '../features/add-to-cart/cartAutomationConsent';
import { downloadDriveDiagnostic, runDriveRefresh, type DriveRefreshDiagnostic } from '../features/drive-bridge/driveRefreshService';
import { type DriveRefreshProgressEvent } from '../features/drive-bridge/extensionBridge';
import { clearActiveShoppingList, setShoppingListItemCandidateOverride, setShoppingListItemStoreOverride, setShoppingListItemWarningsAcknowledged } from '../features/shopping-list/shoppingListService';
import { updateSettings } from '../features/settings/settingsService';
import { listValidatedBaskets, recordValidatedBasket, updateValidatedBasketCartFillJobId, updateValidatedBasketCartFillStatus } from '../features/basket-history/basketHistoryService';
import { fetchCartReport, isDriveExtensionAvailable, runCartFill, type CartFillOutcome, type CartFillResultLine } from '../features/drive-bridge/cartFillService';
import { type ValidatedBasketItem } from '../types/domain';
import { buildCalculationProof } from '../features/comparison/calculationProof';
import { computeBasketSavings } from '../features/comparison/basketSavings';
import { roundMoney } from '../features/comparison/unitNormalization';
import { storeLabels } from '../features/stores/storeLabels';
import { withFinalPeriod, groupDecisionsByStore, getStoreGap, formatRecommendation, formatLastSync, DRIVE_ERROR_LABELS, summarizeDriveErrors, formatDriveProgress, formatCoverageDetail, formatMoney, countOf, splitCartFillTotal } from './compare/compareFormat';
import { downloadCalculationProof } from './compare/cartFillDiagnostics';
import { Metric, TrustSummaryPanel, CoverageBreakdown, FormatNoticesPanel } from './compare/CoveragePanels';
import { StoreDecisionList } from './compare/StoreDecisionList';
import { ValidationPanel } from './compare/ValidationPanel';

type LoadStatus = 'loading' | 'ready' | 'error';
type DriveRefreshStatus = 'idle' | 'refreshing' | 'done' | 'error';
type ValidateStatus = 'idle' | 'validating' | 'done' | 'error';

export function ComparePage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshMessage, setRefreshMessage] = useState('');
  const [comparison, setComparison] = useState<ActiveComparison | null>(null);
  const [savingThresholdEuro, setSavingThresholdEuro] = useState(3);
  // The threshold field saves on every valid keystroke with no button at
  // all — without this, there was zero visible feedback that anything had
  // happened, which read as "does the field even do anything". A brief
  // inline confirmation after each successful save closes that gap.
  const [thresholdSaved, setThresholdSaved] = useState(false);
  // Kept separate from savingThresholdEuro so the field can sit empty while
  // the user is retyping it — binding the input directly to the numeric
  // state forced a "0" back in as soon as the last digit was deleted,
  // making it impossible to clear the field before typing a new value.
  const [thresholdText, setThresholdText] = useState('3');
  const [driveRefreshStatus, setDriveRefreshStatus] = useState<DriveRefreshStatus>('idle');
  const [driveMessage, setDriveMessage] = useState('');
  const [driveDiagnostic, setDriveDiagnostic] = useState<DriveRefreshDiagnostic | null>(null);
  const [driveProgress, setDriveProgress] = useState<DriveRefreshProgressEvent | null>(null);
  const [validateStatusByStore, setValidateStatusByStore] = useState<Record<StoreKey, ValidateStatus>>({
    leclerc: 'idle',
    hyperu: 'idle'
  });
  const [validateMessageByStore, setValidateMessageByStore] = useState<Partial<Record<StoreKey, string>>>({});
  const [cartFillResultsByStore, setCartFillResultsByStore] = useState<
    Partial<Record<StoreKey, CartFillResultLine[]>>
  >({});
  // Popup automatique juste après un rafraîchissement Drive : affiché une
  // seule fois par rafraîchissement (l'utilisateur peut le fermer et revoir
  // les mêmes produits plus bas sur la page, dans le panneau permanent).
  //
  // La liste des itemId est figée à l'ouverture (plutôt que dérivée en direct
  // de result.productsToValidate) : sans ça, choisir "Choisir sur la page
  // Leclerc" pour un produit recharge la comparaison, ce produit devient
  // fiable et sort de productsToValidate — sa carte disparaît du popup avant
  // que l'utilisateur ait pu faire pareil côté Hyper U (retour explicite du
  // 31/08). Un null ferme le popup ; un tableau (même vide) le garde ouvert
  // tant que l'utilisateur ne l'a pas fermé lui-même.
  const [validationPopupItemIds, setValidationPopupItemIds] = useState<string[] | null>(null);
  // Proposition de vider la liste active une fois qu'un panier a été rempli
  // automatiquement en magasin (retour explicite : une fois les courses
  // remplies, la liste doit pouvoir repartir de zéro pour les prochaines
  // sans repasser par la page Liste). Confirmation à part, comme sur la page
  // Liste, pour ne jamais vider par un clic accidentel.
  const [confirmClearAfterFill, setConfirmClearAfterFill] = useState(false);
  const [clearListMessage, setClearListMessage] = useState('');

  async function handleClearListAfterFill() {
    await clearActiveShoppingList();
    setConfirmClearAfterFill(false);
    setClearListMessage('Liste vidée. Ajoute tes prochains produits depuis la page Liste ou Produits.');
  }

  useEffect(() => {
    let ignore = false;

    async function load() {
      try {
        const loadedComparison = await loadActiveComparison({ refreshPrices: true });
        if (!ignore) {
          setComparison(loadedComparison);
          setSavingThresholdEuro(loadedComparison.settings.savingThresholdEuro);
          setThresholdText(String(loadedComparison.settings.savingThresholdEuro));
          setStatus('ready');
        }
      } catch {
        if (!ignore) {
          setStatus('error');
          setRefreshMessage('Impossible de mettre à jour la comparaison. Les derniers prix connus sont conservés.');
        }
      }
    }

    void load();

    return () => {
      ignore = true;
    };
  }, []);

  // Reprise après un rechargement de page pendant un remplissage de panier en
  // cours (Android déchargeant l'onglet PWA pendant l'attente, cf. le rapport
  // n°3 : "Validé le panier hyperu, mais pas exporter le rapport, comme si
  // c'était toujours en cours"). Un panier resté "in_progress" avec un jobId
  // connu a peut-être fini côté extension entre-temps — on va vérifier plutôt
  // que de laisser l'utilisateur bloqué sans jamais voir le vrai résultat.
  useEffect(() => {
    let ignore = false;

    async function recoverPendingCartFills() {
      const baskets = await listValidatedBaskets();
      const seenStores = new Set<StoreKey>();
      for (const basket of baskets) {
        if (ignore) return;
        // `listValidatedBaskets` trie du plus récent au plus ancien : seule la
        // tentative la plus récente par magasin compte encore.
        if (seenStores.has(basket.storeKey)) continue;
        seenStores.add(basket.storeKey);
        if (basket.cartFillStatus === 'in_progress' && basket.cartFillJobId) {
          const outcome = await fetchCartReport(basket.cartFillJobId);
          if (ignore) return;
          if (outcome) {
            await applyCartFillOutcome(basket.storeKey, basket.id, basket.total, basket.items, outcome);
          } else {
            // Rapport introuvable : le connecteur ne connaît plus ce
            // remplissage. Le cas se produit réellement quand Firefox
            // redémarre en cours de route (Android récupère la mémoire), car
            // le connecteur est installé en module temporaire et disparaît
            // avec lui. Sans ce message, l'écran restait muet : le panier
            // gardait le statut « en cours » indéfiniment et rien ne disait à
            // l'utilisateur que son panier réel pouvait être à moitié rempli.
            setValidateStatusByStore((current) => ({ ...current, [basket.storeKey]: 'error' }));
            setValidateMessageByStore((current) => ({
              ...current,
              [basket.storeKey]: `Un remplissage du panier ${storeLabels[basket.storeKey]} avait été lancé, mais son résultat est introuvable (le connecteur a probablement été coupé entre-temps). Le panier peut être partiellement rempli : vérifie-le directement sur le site de ${storeLabels[basket.storeKey]} avant de commander.`
            }));
          }
        }
        if (seenStores.size === 2) break;
      }
    }

    void recoverPendingCartFills();

    return () => {
      ignore = true;
    };
  }, []);

  // Traduit un résultat de remplissage en état affiché + mise à jour du
  // panier en base — factorisé pour être appelé aussi bien juste après un
  // clic "Valider le panier" qu'après une récupération de rapport (voir
  // l'effet de reprise ci-dessus), qui doivent aboutir au même affichage.
  async function applyCartFillOutcome(
    storeKey: StoreKey,
    basketId: string,
    total: number,
    items: ValidatedBasketItem[],
    outcome: CartFillOutcome
  ) {
    setCartFillResultsByStore((current) => ({
      ...current,
      [storeKey]: outcome.ran ? outcome.results : []
    }));

    if (!outcome.ran) {
      await updateValidatedBasketCartFillStatus(basketId, 'failed', outcome.reason);
      setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'error' }));
      setValidateMessageByStore((current) => ({
        ...current,
        [storeKey]:
          outcome.code === 'CART_LOGIN_REQUIRED'
            ? `Panier enregistré (${formatMoney(total)}). Tu n'es pas connecté(e) à ton compte ${storeLabels[storeKey]} . Connecte-toi sur le site du magasin, resté affiché, puis reviens ici et touche à nouveau « Remplir mon panier ${storeLabels[storeKey]} » pour lancer le remplissage.`
            : `Panier enregistré (${formatMoney(total)}), mais l'ajout automatique a échoué : ${withFinalPeriod((outcome.code && DRIVE_ERROR_LABELS[outcome.code]) ?? outcome.reason)}`
      }));
      return;
    }

    const cartFillStatus = outcome.failedCount === 0 ? 'done' : outcome.addedCount > 0 ? 'partial' : 'failed';
    await updateValidatedBasketCartFillStatus(
      basketId,
      cartFillStatus,
      `${countOf(outcome.addedCount, 'ajouté', 'ajoutés')}, ${countOf(outcome.failedCount, 'échec', 'échecs')}.`
    );
    setValidateStatusByStore((current) => ({ ...current, [storeKey]: cartFillStatus === 'failed' ? 'error' : 'done' }));
    setValidateMessageByStore((current) => ({
      ...current,
      [storeKey]:
        outcome.failedCount === 0
          ? `Panier enregistré (${formatMoney(total)}). ${countOf(outcome.addedCount, 'produit ajouté', 'produits ajoutés')} automatiquement chez ${storeLabels[storeKey]}. Il ne reste plus qu'à payer sur le site.`
          : (() => {
              // Remplissage partiel : on annonce le montant réellement attendu
              // dans le panier du site, pas celui des produits non ajoutés.
              const { addedTotal, missingTotal } = splitCartFillTotal(items, outcome.results);
              return (
                `${countOf(outcome.addedCount, 'produit ajouté', 'produits ajoutés')} automatiquement chez ${storeLabels[storeKey]} : ` +
                `ton panier sur le site doit afficher environ ${formatMoney(addedTotal)}. ` +
                `${countOf(outcome.failedCount, 'produit à ajouter', 'produits à ajouter')} toi-même ou à remplacer (${formatMoney(missingTotal)}, détail ci-dessous). ` +
                `Panier complet prévu : ${formatMoney(total)}.`
              );
            })()
    }));
  }

  // Enregistre le seuil saisi et le confirme à l'écran. Le classement, lui,
  // est déjà recalculé à chaque frappe (le useMemo de `result` dépend de
  // savingThresholdEuro) : ce bouton ne déclenche donc aucun traitement, il
  // rend visible un enregistrement qui, sur mobile, se faisait sans que rien
  // ne bouge — le champ garde le focus derrière le clavier virtuel, et
  // l'événement `blur` qui affichait « ✓ Enregistré » n'arrivait jamais.
  function handleApplyThreshold() {
    const raw = thresholdText.trim();
    const parsed = raw === '' ? 0 : Number(raw);
    const normalized = Number.isNaN(parsed) ? savingThresholdEuro : Math.max(0, parsed);

    setThresholdText(String(normalized));
    setSavingThresholdEuro(normalized);
    void updateSettings({ savingThresholdEuro: normalized });
    setThresholdSaved(true);
    setTimeout(() => setThresholdSaved(false), 2000);
  }

  async function handleDriveRefresh() {
    if (!comparison) return;
    setDriveRefreshStatus('refreshing');
    setDriveMessage('');
    setDriveDiagnostic(null);
    setDriveProgress(null);
    setValidationPopupItemIds(null);
    try {
      const outcome = await runDriveRefresh(comparison.rows, setDriveProgress);
      setDriveProgress(null);
      if (!outcome.ran) {
        setDriveRefreshStatus('error');
        setDriveMessage(outcome.reason);
        return;
      }
      setDriveDiagnostic(outcome.diagnostic);
      setDriveRefreshStatus('done');
      setDriveMessage(
        `Prix mis à jour : ${outcome.diagnostic.summary.updated} prix relus sur les sites des magasins.` +
          // Rien d'inquiétant à annoncer quand tout a été relu (16/11) : « 0 produit(s)
          // non relus : leur ancien prix n'est plus utilisé » se lisait comme une panne.
          (outcome.diagnostic.summary.failed > 0
            ? ` ${countOf(outcome.diagnostic.summary.failed, 'produit non relu', 'produits non relus')} : ancien prix écarté, relance l’actualisation ou vérifie plus bas.`
            : '')
      );
      const loadedComparison = await loadActiveComparison({ refreshPrices: false });
      setComparison(loadedComparison);

      // Le `result` du rendu (calculé par useMemo) ne sera à jour qu'au
      // prochain rendu — on rappelle ici la même fonction pure avec les
      // données fraîches pour savoir tout de suite s'il faut ouvrir le popup.
      if (loadedComparison.rows.length > 0) {
        const freshResult = compareShoppingList({
          rows: loadedComparison.rows,
          candidates: loadedComparison.candidates,
          priceSnapshots: loadedComparison.priceSnapshots,
          savingThresholdEuro,
          autoDecisionMinConfidence: loadedComparison.settings.autoDecisionMinConfidence,
          maxPriceAgeDays: loadedComparison.settings.maxPriceAgeDays
        });
        if (freshResult.productsToValidate.length > 0) {
          setValidationPopupItemIds(freshResult.productsToValidate.map((decision) => decision.itemId));
        }
      }
    } catch (error) {
      setDriveProgress(null);
      setDriveRefreshStatus('error');
      setDriveMessage(error instanceof Error ? error.message : 'L’actualisation des prix a échoué. Réessaie dans un instant.');
    }
  }

  const result = useMemo(() => {
    if (!comparison || comparison.rows.length === 0) {
      return null;
    }

    return compareShoppingList({
      rows: comparison.rows,
      candidates: comparison.candidates,
      priceSnapshots: comparison.priceSnapshots,
      savingThresholdEuro,
      autoDecisionMinConfidence: comparison.settings.autoDecisionMinConfidence,
      maxPriceAgeDays: comparison.settings.maxPriceAgeDays
    });
  }, [comparison, savingThresholdEuro]);

  const forcedStoreKeyByItemId = useMemo(() => {
    return new Map(comparison?.rows.map((row) => [row.item.id, row.item.forcedStoreKey ?? null]) ?? []);
  }, [comparison]);

  // Un forcedCandidateId posé (choix volontaire d'un alternate, ou verrou
  // résiduel d'un ancien pick manuel avant le passage à onCandidateConfirmed)
  // n'a aujourd'hui aucun moyen d'être retiré depuis l'UI — voir
  // ManualCandidateOverrideControl.
  const forcedCandidateIdByItemId = useMemo(() => {
    return new Map(comparison?.rows.map((row) => [row.item.id, row.item.forcedCandidateId ?? null]) ?? []);
  }, [comparison]);

  async function handleForceStore(itemId: string, storeKey: StoreKey | null) {
    await setShoppingListItemStoreOverride(itemId, storeKey);
    const loadedComparison = await loadActiveComparison({ refreshPrices: false });
    setComparison(loadedComparison);
  }

  // Le conseil « fais tout chez X » ne servait à rien tant que les paniers
  // affichés restaient répartis entre les deux magasins : ce bouton applique
  // le conseil, en plaçant chaque produit dans le magasin conseillé.
  async function handleGroupInStore(storeKey: StoreKey) {
    const toMove = (result?.decisions ?? []).filter(
      (decision) => !decision.requiresValidation && decision.selectedStoreKey && decision.selectedStoreKey !== storeKey
    );
    for (const decision of toMove) {
      await setShoppingListItemStoreOverride(decision.itemId, storeKey);
    }
    const loadedComparison = await loadActiveComparison({ refreshPrices: false });
    setComparison(loadedComparison);
  }

  async function handleForceCandidate(itemId: string, candidateId: string | null) {
    await setShoppingListItemCandidateOverride(itemId, candidateId);
    const loadedComparison = await loadActiveComparison({ refreshPrices: false });
    setComparison(loadedComparison);
  }

  // Seule sortie possible pour « prix incohérent » et « format à confirmer » :
  // ces deux alertes viennent d'une comparaison entre deux valeurs lues sur la
  // même fiche, donc actualiser relit la même fiche et retrouve le même écart.
  // Sans cette levée, un seul produit concerné rendait le panier entier
  // définitivement non validable (audit du 02/09, F-01/F-02).
  async function handleAcknowledgeWarnings(itemId: string) {
    await setShoppingListItemWarningsAcknowledged(itemId, true);
    const loadedComparison = await loadActiveComparison({ refreshPrices: false });
    setComparison(loadedComparison);
  }

  // Un pick manuel (ManualCorrectionControls) a déjà persisté son candidat en
  // base avec matchType 'manual_override' (voir driveRefreshService) — pas
  // besoin d'écrire un forcedCandidateId ici, juste recharger pour que le
  // moteur retrie avec ce nouveau candidat fiable.
  async function handleCandidateConfirmed(_itemId: string) {
    const loadedComparison = await loadActiveComparison({ refreshPrices: false });
    setComparison(loadedComparison);
  }

  // "Aucun de ceux-là" : le candidat proposé (format différent ou quasi-match
  // incertain) ne correspond pas au produit réellement recherché — le
  // rejeter l'exclut définitivement de la comparaison (jusqu'au prochain
  // refresh qui, s'il retrouve la même carte, la proposera à nouveau).
  async function handleRejectCandidate(candidateId: string) {
    await setProductCandidateRejected(candidateId, true);
    const loadedComparison = await loadActiveComparison({ refreshPrices: false });
    setComparison(loadedComparison);
  }

  const candidateById = useMemo(() => {
    return new Map(comparison?.candidates.map((candidate) => [candidate.id, candidate]) ?? []);
  }, [comparison]);

  const productNameById = useMemo(() => {
    return new Map(comparison?.rows.map((row) => [row.product.id, row.product.name]) ?? []);
  }, [comparison]);

  // Utilisé par la correction manuelle Hyper U/Leclerc (voir
  // ManualCorrectionControls) : une preuve EAN valide la fiche trouvée plutôt
  // que de se fier au seul recouvrement de noms.
  const productBarcodeById = useMemo(() => {
    return new Map(comparison?.rows.map((row) => [row.product.id, row.product.barcode]) ?? []);
  }, [comparison]);

  const decisionsByStore = useMemo(() => groupDecisionsByStore(result), [result]);
  const storeGap = getStoreGap(result);

  // Recalcule le contenu du popup à chaque rendu à partir des itemId figés à
  // l'ouverture (voir validationPopupItemIds) + de toutes les décisions
  // actuelles (pas seulement productsToValidate, qui rétrécit dès qu'UN SEUL
  // magasin devient fiable) : la carte d'un produit reste visible et à jour
  // tant qu'il manque encore un magasin. Elle ne disparaît qu'une fois les
  // DEUX magasins couverts (storeCandidateIds.leclerc ET .hyperu présents) —
  // demande explicite du 31/08 : "si Hyper U est déjà bon, ferme la carte dès
  // que j'ai renseigné Leclerc, plus besoin de fermer le popup à la main".
  // Un magasin où le produit n'existe simplement pas (jamais de candidat,
  // recherche automatique ou manuelle) garde volontairement la carte
  // ouverte : le bouton "Choisir sur la page ..." y reste une action utile.
  const validationPopupDecisions = useMemo(() => {
    if (!validationPopupItemIds || !result) return [];
    const decisionByItemId = new Map(result.decisions.map((decision) => [decision.itemId, decision]));
    return validationPopupItemIds
      .map((itemId) => decisionByItemId.get(itemId))
      .filter((decision): decision is ComparisonDecision => decision !== undefined)
      .filter((decision) => !(decision.storeCandidateIds.leclerc && decision.storeCandidateIds.hyperu));
  }, [validationPopupItemIds, result]);

  // Au moins un produit de la liste a été trouvé dans un magasin. Tant que ce
  // n'est pas le cas, la page ne montre que le bouton de recherche.
  const hasAnyPrice = useMemo(
    () =>
      result !== null &&
      [...result.coverage.leclerc.lines, ...result.coverage.hyperu.lines].some((line) => line.status !== 'notFound'),
    [result]
  );

  // Au moins un prix sûr : sans cela, les totaux et le conseil n'affichent
  // que des « À vérifier ».
  const hasPricedLine =
    result !== null &&
    (result.coverage.leclerc.covered + result.coverage.hyperu.covered > 0 ||
      // Produit choisi à la main : il compte dans « prix sûrs » même quand
      // la vue par magasin le classe encore « à vérifier ». Sans cette
      // seconde condition, son panier restait invisible.
      result.trustReport.summary.trustedDecisionCount > 0);

  // Retour après plusieurs jours : la majorité des prix a dépassé l'âge
  // maximal. Plutôt qu'une liste d'erreurs produit par produit, un seul
  // message et un seul bouton — les totaux périmés restent masqués.
  const pricesOutdated = useMemo(() => {
    if (!result || result.decisions.length === 0) return false;
    const staleCount = result.decisions.filter((decision) =>
      decision.signals.some((signal) => signal.code === 'STALE_PRICE')
    ).length;
    return staleCount * 2 > result.decisions.length;
  }, [result]);

  async function handleNewList() {
    setComparison(await loadActiveComparison({ refreshPrices: false }));
  }

  // Magasin conseillé quand des produits sont encore rangés dans l'autre.
  const storeToGroupIn = useMemo<StoreKey | null>(() => {
    if (!result || result.recommendation.kind !== 'single_store') return null;
    const target = result.recommendation.storeKey;
    return result.decisions.some(
      (decision) => !decision.requiresValidation && decision.selectedStoreKey && decision.selectedStoreKey !== target
    )
      ? target
      : null;
  }, [result]);

  const lastSyncByStore = useMemo(() => {
    const latest: Partial<Record<StoreKey, string>> = {};
    // Seulement les prix des produits de la liste : la base contient aussi
    // des prix d'exemple, dont la date n'a aucun sens pour l'utilisateur.
    const listProductIds = new Set((comparison?.rows ?? []).map((row) => row.item.productId));
    const listCandidateIds = new Set(
      (comparison?.candidates ?? [])
        .filter((candidate) => listProductIds.has(candidate.productId))
        .map((candidate) => candidate.id)
    );
    for (const snapshot of comparison?.priceSnapshots ?? []) {
      if (!listCandidateIds.has(snapshot.candidateId)) continue;
      const current = latest[snapshot.storeKey];
      if (!current || snapshot.checkedAt > current) {
        latest[snapshot.storeKey] = snapshot.checkedAt;
      }
    }
    return latest;
  }, [comparison]);

  async function handleValidateBasket(storeKey: StoreKey) {
    if (!result) return;
    if (!result.trustReport.canValidateBasket) {
      const blockingIssue = result.trustReport.issues.find((issue) => issue.severity === 'blocking');
      setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'error' }));
      setValidateMessageByStore((current) => ({
        ...current,
        [storeKey]: blockingIssue
          ? `Panier bloqué : ${blockingIssue.message} Règle ce problème (encadré « Un problème empêche de remplir le panier », plus haut) avant de continuer.`
          : 'Panier bloqué : règle d’abord les problèmes indiqués plus haut.'
      }));
      return;
    }
    const decisions = decisionsByStore[storeKey];
    if (decisions.length === 0) return;

    setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'validating' }));
    setValidateMessageByStore((current) => ({ ...current, [storeKey]: '' }));

    // Économie mesurée contre le meilleur magasin seul, comme le chiffre
    // affiché plus haut sur cette page (voir basketSavings.ts).
    const savings = computeBasketSavings(result, decisions);
    const items: ValidatedBasketItem[] = [];
    for (const decision of decisions) {
      if (decision.price === undefined) continue;
      const candidate = decision.selectedCandidateId ? candidateById.get(decision.selectedCandidateId) : undefined;
      items.push({
        productId: decision.productId,
        productName: productNameById.get(decision.productId) ?? 'Produit inconnu',
        candidateId: decision.selectedCandidateId,
        storeProductId: candidate?.storeProductId,
        brand: candidate?.brand,
        barcode: candidate?.barcode,
        productUrl: candidate?.productUrl,
        quantity: decision.quantityToBuy,
        unitPrice: decision.unitPrice,
        lineTotal: decision.price
      });
    }
    const total = roundMoney(items.reduce((sum, item) => sum + item.lineTotal, 0));

    try {
      const calculationProof = buildCalculationProof({
        result,
        rows: comparison?.rows ?? [],
        candidates: comparison?.candidates ?? [],
        snapshots: comparison?.priceSnapshots ?? []
      });
      // La clé dépend des preuves de prix (dont checkedAt), pas de l'heure du
      // clic : double clic/reprise = même panier, nouveau relevé = nouvel achat.
      const operationKey = JSON.stringify({
        version: calculationProof.engineVersion,
        storeKey,
        lines: calculationProof.lines
          .filter((line) => line.selectedStoreKey === storeKey)
          .map((line) => [line.itemId, line.candidate?.id, line.quantityToBuy, line.lineTotal, line.priceEvidence?.checkedAt])
      });
      const basket = await recordValidatedBasket({
        storeKey,
        items,
        total,
        savings,
        operationKey,
        calculationProof
      });

      let available = false;
      try {
        available = await isDriveExtensionAvailable();
      } catch {
        available = false;
      }

      if (!available) {
        setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'done' }));
        setValidateMessageByStore((current) => ({
          ...current,
          [storeKey]: `Panier enregistré (${formatMoney(total)}). Le connecteur Firefox ne répond pas : ajoute les produits toi-même avec les liens « Voir sur le site » ci-dessous pour remplir ton panier ${storeLabels[storeKey]}.`
        }));
        return;
      }

      if (!comparison || !hasCurrentCartAutomationConsent(comparison.settings)) {
        const accepted = window.confirm(
          `Autoriser le remplissage automatique chez ${storeLabels[storeKey]} ?\n\n` +
          `Le connecteur va ouvrir le Drive, rechercher les produits et cliquer sur « Ajouter au panier ». ` +
          `Il ne valide aucune commande et n’accède pas au paiement.`
        );
        if (!accepted) {
          setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'done' }));
          setValidateMessageByStore((current) => ({
            ...current,
            [storeKey]: `Panier enregistré (${formatMoney(total)}), sans remplissage automatique.`
          }));
          return;
        }
        const consent = grantCartAutomationConsent();
        const settings = await updateSettings(consent);
        setComparison((current) => current ? { ...current, settings } : current);
      }

      const outcome = await runCartFill(storeKey, items, {
        // Persisté immédiatement (avant la fin, potentiellement longue, du
        // remplissage) — sans ça un rechargement de page pendant l'attente
        // perd le jobId en même temps que tout le reste et rend le rapport
        // final irrécupérable (voir l'effet de reprise plus haut).
        onJobStart: (jobId) => {
          void updateValidatedBasketCartFillJobId(basket.id, jobId);
        }
      });
      await applyCartFillOutcome(storeKey, basket.id, total, items, outcome);
    } catch {
      setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'error' }));
      setValidateMessageByStore((current) => ({ ...current, [storeKey]: 'Impossible de remplir ce panier. Réessaie dans un instant.' }));
    }
  }

  return (
    <section className="pageStack" aria-labelledby="compare-title">
      {validationPopupItemIds && validationPopupDecisions.length > 0 && (
        <div
          className="modalOverlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="validation-popup-title"
          onClick={() => setValidationPopupItemIds(null)}
        >
          <div className="modalContent" onClick={(event) => event.stopPropagation()}>
            <div className="modalHeader">
              <h3 id="validation-popup-title">Prix à jour — quelques produits à vérifier</h3>
              <button
                type="button"
                className="modalCloseButton"
                onClick={() => setValidationPopupItemIds(null)}
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
            <ValidationPanel
              decisions={validationPopupDecisions}
              productNameById={productNameById}
              productBarcodeById={productBarcodeById}
              candidateById={candidateById}
              forcedStoreKeyByItemId={forcedStoreKeyByItemId}
              forcedCandidateIdByItemId={forcedCandidateIdByItemId}
              onForceStore={handleForceStore}
              onForceCandidate={handleForceCandidate}
              onCandidateConfirmed={handleCandidateConfirmed}
              onRejectCandidate={handleRejectCandidate}
            />
          </div>
        </div>
      )}

      <div className="pageTitle">
        <h2 id="compare-title">Comparer les prix</h2>
        <p className="lead">
          Pour chaque produit de ta liste, l’application cherche le prix dans tes deux magasins et retient le moins
          cher. Elle peut ensuite remplir ton panier, avec ton accord ; elle ne passe jamais la commande.
        </p>
      </div>

      {status === 'loading' && <p className="panelText">Chargement de ta liste…</p>}
      {status === 'error' && (
        <p className="panelText panelTextDanger">Impossible de charger ta liste. Recharge la page pour réessayer.</p>
      )}

      {status === 'ready' && comparison?.rows.length === 0 && (
        <div className="settingsPanel">
          <div>
            <h3>Ta liste est vide</h3>
            <p>Ajoute au moins un produit à ta liste : tu pourras ensuite comparer ses prix ici.</p>
          </div>
          <div className="cardActions">
            <Link className="buttonLink" to="/scan">
              Ajouter un produit
            </Link>
            <Link className="buttonLink" to="/produits">
              Choisir parmi mes produits
            </Link>
          </div>
        </div>
      )}

      {status === 'ready' && comparison && result && (
        <>
          {comparison.rows.length > 0 && <ListAlreadyUsedNotice onNewList={handleNewList} />}

          <div className="settingsPanel">
            <div>
              <h3>
                {pricesOutdated ? 'Tes prix ne sont plus à jour' : hasAnyPrice ? 'Prix de ta liste' : 'Pas encore de prix'}
              </h3>
              {pricesOutdated && (
                <p>
                  Les prix changent souvent : ceux-ci ont plus de {comparison.settings.maxPriceAgeDays} jours.
                  Actualise-les pour retrouver les totaux et le conseil.
                </p>
              )}
              {hasAnyPrice ? (
                <p>
                  Dernière lecture des prix —{' '}
                  {(Object.keys(storeLabels) as StoreKey[])
                    .map((storeKey) => `${storeLabels[storeKey]} : ${formatLastSync(lastSyncByStore[storeKey])}`)
                    .join(' · ')}
                </p>
              ) : (
                <>
                  <p>
                    Lance la recherche : l’application ouvre les sites Leclerc Drive et Courses U grâce au
                    connecteur Firefox, puis lit le prix de chaque produit de ta liste. Cela peut prendre quelques
                    minutes.
                  </p>
                  <p className="panelText">
                    Avant de commencer : choisis tes deux magasins sur la page <Link to="/">Accueil</Link> et
                    installe le connecteur Firefox (bouton « Aide » en haut de l’écran).
                  </p>
                </>
              )}
            </div>
            {/* Seul message encore posté ici : l'échec du chargement initial. */}
            {refreshMessage && <p className="panelText panelTextDanger">{refreshMessage}</p>}
            <div className="cardActions">
              <button
                className={hasAnyPrice && !pricesOutdated ? 'secondaryButton' : 'primaryButton'}
                type="button"
                onClick={() => void handleDriveRefresh()}
                disabled={driveRefreshStatus === 'refreshing'}
              >
                {driveRefreshStatus === 'refreshing'
                  ? 'Lecture des prix en cours…'
                  : hasAnyPrice
                    ? 'Actualiser les prix'
                    : 'Chercher les prix'}
              </button>
              {driveDiagnostic && (
                <button
                  className="secondaryButton"
                  type="button"
                  onClick={() => downloadDriveDiagnostic(driveDiagnostic)}
                  title="Fichier technique utile pour signaler un problème"
                >
                  Télécharger le rapport technique
                </button>
              )}
            </div>
            {driveRefreshStatus === 'refreshing' && (
              <p className="panelText">{formatDriveProgress(driveProgress)}</p>
            )}
            {driveMessage && (
              <p className={driveRefreshStatus === 'error' ? 'panelText panelTextDanger' : 'panelText'}>
                {driveMessage}
              </p>
            )}
            {driveDiagnostic && driveDiagnostic.summary.failed > 0 && (
              <ul className="warningList">
                {summarizeDriveErrors(driveDiagnostic).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </div>

          {hasAnyPrice && !pricesOutdated && (
            <>
          <TrustSummaryPanel
            report={result.trustReport}
            onRefresh={() => void handleDriveRefresh()}
            onAcknowledgeWarnings={(itemId) => void handleAcknowledgeWarnings(itemId)}
            productNameById={productNameById}
          />

          {/* Seulement s'il y a un gain : un « -0.07 € » en grand, suivi de
              « là où il est le moins cher », disait le contraire de ce qu'il
              affichait. */}
          {result.recommendation.kind === 'split' &&
            result.savingsVsBestSingleStore !== null &&
            result.savingsVsBestSingleStore > 0 && (
            <div className="savingsHero" role="status" aria-label="Économie possible en partageant tes courses">
              <p className="savingsHeroLabel">Économie possible</p>
              <p className="savingsHeroAmount">{formatMoney(result.savingsVsBestSingleStore)}</p>
              <div className="savingsHeroDivider" />
              <p className="savingsHeroSub">en achetant chaque produit là où il est le moins cher, plutôt que tout dans un seul magasin</p>
            </div>
          )}

          {hasPricedLine && (
            <>
          <div className="comparisonMetrics" aria-label="Totaux comparés">
            <Metric
              label="Si tout est acheté chez Leclerc"
              value={formatMoney(result.totals.leclerc)}
              detail={formatCoverageDetail('Leclerc', result.coverage.leclerc)}
            />
            <Metric
              label="Si tout est acheté chez Hyper U"
              value={formatMoney(result.totals.hyperu)}
              detail={formatCoverageDetail('Hyper U', result.coverage.hyperu)}
            />
            <Metric
              label="En partageant entre les 2 magasins"
              value={formatMoney(result.totals.optimized)}
              detail="Chaque produit est pris là où il est le moins cher : ce total additionne des achats chez Leclerc et chez Hyper U."
            />
            <Metric
              label={
                result.savingsVsBestSingleStore !== null && result.savingsVsBestSingleStore < 0
                  ? 'Surcoût en partageant'
                  : 'Économie en partageant'
              }
              value={formatMoney(
                result.savingsVsBestSingleStore === null ? null : Math.abs(result.savingsVsBestSingleStore)
              )}
              detail={
                result.savingsVsBestSingleStore !== null && result.savingsVsBestSingleStore < 0
                  ? 'Partager coûte plus cher ici : pour certains produits, le format retenu est plus grand (meilleur prix au kilo ou au litre), donc plus cher à l’achat.'
                  : result.coverage.leclerc.covered < result.coverage.leclerc.total &&
                      result.coverage.hyperu.covered < result.coverage.hyperu.total
                    ? 'Aucun magasin n’a tous tes produits : il n’y a pas de total « un seul magasin » auquel comparer, donc pas d’économie calculable.'
                    : 'Ce que tu gagnes par rapport au magasin unique le moins cher.'
              }
            />
            <Metric
              label="Différence entre les 2 magasins"
              value={formatMoney(storeGap)}
              detail="Écart entre tout acheter chez Leclerc et tout acheter chez Hyper U."
            />
          </div>

          <div className="comparisonMetrics" aria-label="Détail des prix par magasin">
            <CoverageBreakdown
              storeKey="leclerc"
              storeLabel="Leclerc"
              coverage={result.coverage.leclerc}
              productNameById={productNameById}
              productBarcodeById={productBarcodeById}
              candidateById={candidateById}
              onCandidateConfirmed={handleCandidateConfirmed}
            />
            <CoverageBreakdown
              storeKey="hyperu"
              storeLabel="Hyper U"
              coverage={result.coverage.hyperu}
              productNameById={productNameById}
              productBarcodeById={productBarcodeById}
              candidateById={candidateById}
              onCandidateConfirmed={handleCandidateConfirmed}
            />
          </div>

          <FormatNoticesPanel notices={result.formatNotices} productNameById={productNameById} />

          <div className="settingsPanel">
            <div>
              <h3>Notre conseil</h3>
              <p>{formatRecommendation(result, comparison.settings.savingThresholdEuro)}</p>
              {storeToGroupIn ? (
                <p>
                  Pour l’instant, chaque produit est rangé ci-dessous là où il est le moins cher. Touche le bouton
                  pour tout regrouper chez {storeLabels[storeToGroupIn]}.
                </p>
              ) : (
                <p>
                  Ci-dessous, la liste de ce qu’il faut acheter. Quand tout te convient, touche « Remplir mon
                  panier » sous le magasin concerné.
                </p>
              )}
            </div>
            {storeToGroupIn && (
              <div className="cardActions">
                <button
                  className="primaryButton"
                  type="button"
                  onClick={() => void handleGroupInStore(storeToGroupIn)}
                >
                  Tout acheter chez {storeLabels[storeToGroupIn]}
                </button>
              </div>
            )}
          </div>

          <StoreDecisionList
            decisions={decisionsByStore.leclerc}
            experimentalAddToCart={comparison.settings.experimentalAddToCart}
            productNameById={productNameById}
            productBarcodeById={productBarcodeById}
            candidateById={candidateById}
            forcedStoreKeyByItemId={forcedStoreKeyByItemId}
            forcedCandidateIdByItemId={forcedCandidateIdByItemId}
            onForceStore={handleForceStore}
            onForceCandidate={handleForceCandidate}
            onCandidateConfirmed={handleCandidateConfirmed}
            onRejectCandidate={handleRejectCandidate}
            storeKey="leclerc"
            onValidate={handleValidateBasket}
            validateStatus={validateStatusByStore.leclerc}
            validateMessage={validateMessageByStore.leclerc}
            cartFillFailures={cartFillResultsByStore.leclerc}
            trustAllowsActions={result.trustReport.canValidateBasket}
          />

          <StoreDecisionList
            decisions={decisionsByStore.hyperu}
            experimentalAddToCart={comparison.settings.experimentalAddToCart}
            productNameById={productNameById}
            productBarcodeById={productBarcodeById}
            candidateById={candidateById}
            forcedStoreKeyByItemId={forcedStoreKeyByItemId}
            forcedCandidateIdByItemId={forcedCandidateIdByItemId}
            onForceStore={handleForceStore}
            onForceCandidate={handleForceCandidate}
            onCandidateConfirmed={handleCandidateConfirmed}
            onRejectCandidate={handleRejectCandidate}
            storeKey="hyperu"
            onValidate={handleValidateBasket}
            validateStatus={validateStatusByStore.hyperu}
            validateMessage={validateMessageByStore.hyperu}
            cartFillFailures={cartFillResultsByStore.hyperu}
            trustAllowsActions={result.trustReport.canValidateBasket}
          />

            </>
          )}

          {(validateStatusByStore.leclerc === 'done' || validateStatusByStore.hyperu === 'done') && (
            <div className="settingsPanel">
              <div>
                <h3>Panier rempli</h3>
                <p>
                  {clearListMessage ||
                    'Les produits ci-dessus ont été ajoutés à ton panier sur le site du magasin. Il te reste à vérifier ton panier et à payer sur ce site. Tu peux ensuite vider ta liste pour tes prochaines courses.'}
                </p>
              </div>
              {!clearListMessage && (
                <div className="cardActions">
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => setConfirmClearAfterFill(true)}
                  >
                    Vider la liste de courses
                  </button>
                </div>
              )}
              {confirmClearAfterFill && (
                <div className="confirmPanel">
                  <p>Vider ta liste de courses ? Tes produits restent enregistrés dans « Produits ».</p>
                  <button className="dangerButton" type="button" onClick={() => void handleClearListAfterFill()}>
                    Oui, vider la liste
                  </button>
                  <button
                    className="secondaryButton"
                    type="button"
                    onClick={() => setConfirmClearAfterFill(false)}
                  >
                    Annuler
                  </button>
                </div>
              )}
            </div>
          )}

          <ValidationPanel
            decisions={result.productsToValidate}
            probableMatchCount={result.decisions.filter((decision) => decision.price !== undefined && decision.confidenceScore < 100).length}
            productNameById={productNameById}
            productBarcodeById={productBarcodeById}
            candidateById={candidateById}
            forcedStoreKeyByItemId={forcedStoreKeyByItemId}
            forcedCandidateIdByItemId={forcedCandidateIdByItemId}
            onForceStore={handleForceStore}
            onForceCandidate={handleForceCandidate}
            onCandidateConfirmed={handleCandidateConfirmed}
            onRejectCandidate={handleRejectCandidate}
          />
            </>
          )}

          {/* Réglage et fichier technique : utiles, mais pas pour une première
              visite — repliés en bas de page. */}
          <details className="settingsPanel storeUrlDetails">
            <summary>Options de la comparaison</summary>
            <div>
              <h3>Économie minimale pour aller dans les deux magasins</h3>
              <p>
                L’application ne te conseille de partager tes courses entre Leclerc et Hyper U que si tu économises
                au moins ce montant. Sinon, elle te conseille un seul magasin.
              </p>
            </div>
            <label className="thresholdControl">
              <span>Montant minimal (en €)</span>
              <input
                id="saving-threshold-euro"
                name="savingThresholdEuro"
                min="0"
                step="0.1"
                type="number"
                value={thresholdText}
                onChange={(event) => {
                  const raw = event.target.value;
                  setThresholdText(raw);
                  if (raw.trim() === '') {
                    return;
                  }
                  const parsed = Number(raw);
                  if (!Number.isNaN(parsed)) {
                    const normalized = Math.max(0, parsed);
                    setSavingThresholdEuro(normalized);
                    // Was only ever kept in local component state before —
                    // navigating away lost the value entirely. Persist it to
                    // db.settings on every valid keystroke (cheap local
                    // write, no network round trip).
                    void updateSettings({ savingThresholdEuro: normalized });
                  }
                }}
                onBlur={() => {
                  if (thresholdText.trim() === '') {
                    setThresholdText('0');
                    setSavingThresholdEuro(0);
                    void updateSettings({ savingThresholdEuro: 0 });
                  }
                  setThresholdSaved(true);
                  setTimeout(() => setThresholdSaved(false), 2000);
                }}
              />
              {thresholdSaved && (
                <span className="panelText" role="status">
                  ✓ Enregistré
                </span>
              )}
            </label>
            {/* Ce bouton n'interroge aucun magasin : il enregistre le seuil et
                le confirme. Il déclenchait auparavant une « vérification
                locale » qui ne consultait que les prix de démonstration
                (mockAdapterFactory) — donc sur une vraie liste, toujours
                « 0 prix mis à jour, N non disponible(s) », lu comme une panne.
                Le seul rafraîchissement réel est « Actualiser les prix
                Drive », plus bas. */}
            <div className="cardActions">
              <button className="secondaryButton" type="button" onClick={handleApplyThreshold}>
                Enregistrer ce montant
              </button>
            </div>
          <div className="cardActions">
            <button
              className="secondaryButton"
              type="button"
              onClick={() => downloadCalculationProof(buildCalculationProof({
                result,
                rows: comparison.rows,
                candidates: comparison.candidates,
                snapshots: comparison.priceSnapshots
              }))}
              title="Fichier détaillé de tous les prix utilisés, pour vérifier le calcul"
            >
              Télécharger le détail du calcul
            </button>
          </div>

          </details>
        </>
      )}
    </section>
  );
}
