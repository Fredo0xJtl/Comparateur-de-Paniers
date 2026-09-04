import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  loadActiveComparison,
  setProductCandidateRejected,
  type ActiveComparison
} from '../features/comparison/comparisonService';
import {
  compareShoppingList,
  type ComparisonDecision,
  type ComparisonResult,
  type StoreCoverage,
  type StoreCoverageLine,
  type StoreCoverageLineStatus
} from '../features/comparison/comparisonEngine';
import {
  type CandidateMatchType,
  type ProductCandidate,
  type StoreKey
} from '../types/domain';
import { type PriceRefreshReport } from '../features/comparison/priceRefreshService';
import { buildAddToCartAction } from '../features/add-to-cart/addToCartAction';
import {
  grantCartAutomationConsent,
  hasCurrentCartAutomationConsent
} from '../features/add-to-cart/cartAutomationConsent';
import {
  downloadDriveDiagnostic,
  runDriveRefresh,
  runLivePick,
  type DriveRefreshDiagnostic
} from '../features/drive-bridge/driveRefreshService';
import { type DriveRefreshProgressEvent } from '../features/drive-bridge/extensionBridge';
import {
  clearActiveShoppingList,
  setShoppingListItemCandidateOverride,
  setShoppingListItemStoreOverride,
  setShoppingListItemWarningsAcknowledged
} from '../features/shopping-list/shoppingListService';
import { updateSettings } from '../features/settings/settingsService';
import {
  listValidatedBaskets,
  recordValidatedBasket,
  updateValidatedBasketCartFillJobId,
  updateValidatedBasketCartFillStatus
} from '../features/basket-history/basketHistoryService';
import {
  fetchCartReport,
  isDriveExtensionAvailable,
  runCartFill,
  type CartFillOutcome,
  type CartFillResultLine
} from '../features/drive-bridge/cartFillService';
import { type ValidatedBasketItem } from '../types/domain';
import { buildCalculationProof } from '../features/comparison/calculationProof';
import type { TrustIssue } from '../features/comparison/trustAssessment';
import { storeLabels } from '../features/stores/storeLabels';

type LoadStatus = 'loading' | 'ready' | 'error';
type RefreshStatus = 'idle' | 'refreshing' | 'error';
type DriveRefreshStatus = 'idle' | 'refreshing' | 'done' | 'error';
type ValidateStatus = 'idle' | 'validating' | 'done' | 'error';

export function ComparePage() {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [refreshStatus, setRefreshStatus] = useState<RefreshStatus>('idle');
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
        setRefreshStatus('refreshing');
        const loadedComparison = await loadActiveComparison({ refreshPrices: true });
        if (!ignore) {
          setComparison(loadedComparison);
          setSavingThresholdEuro(loadedComparison.settings.savingThresholdEuro);
          setThresholdText(String(loadedComparison.settings.savingThresholdEuro));
          setRefreshMessage(formatRefreshReport(loadedComparison.refreshReport));
          setStatus('ready');
          setRefreshStatus('idle');
        }
      } catch {
        if (!ignore) {
          setStatus('error');
          setRefreshStatus('error');
          setRefreshMessage('Actualisation impossible. Les anciens prix locaux sont conservés.');
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
            await applyCartFillOutcome(basket.storeKey, basket.id, basket.total, outcome);
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
  async function applyCartFillOutcome(storeKey: StoreKey, basketId: string, total: number, outcome: CartFillOutcome) {
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
            ? `Panier enregistré (${formatMoney(total)}). Tu n'es pas connecté(e) à ton compte ${storeLabels[storeKey]} : connecte-toi sur l'onglet resté ouvert, puis reviens ici et re-touche « Valider le panier ${storeLabels[storeKey]} » pour lancer le remplissage.`
            : `Panier enregistré (${formatMoney(total)}), mais l'ajout automatique a échoué : ${(outcome.code && DRIVE_ERROR_LABELS[outcome.code]) ?? outcome.reason}.`
      }));
      return;
    }

    const cartFillStatus = outcome.failedCount === 0 ? 'done' : outcome.addedCount > 0 ? 'partial' : 'failed';
    await updateValidatedBasketCartFillStatus(
      basketId,
      cartFillStatus,
      `${outcome.addedCount} ajouté(s), ${outcome.failedCount} échec(s).`
    );
    setValidateStatusByStore((current) => ({ ...current, [storeKey]: cartFillStatus === 'failed' ? 'error' : 'done' }));
    setValidateMessageByStore((current) => ({
      ...current,
      [storeKey]:
        outcome.failedCount === 0
          ? `Panier enregistré (${formatMoney(total)}). ${outcome.addedCount} produit(s) ajouté(s) automatiquement chez ${storeLabels[storeKey]}. Il ne reste plus qu'à payer sur le site.`
          : `Panier enregistré (${formatMoney(total)}). ${outcome.addedCount} produit(s) ajouté(s) automatiquement chez ${storeLabels[storeKey]}, ${outcome.failedCount} à ajouter manuellement (détail ci-dessous) avant de payer.`
    }));
  }

  async function handleRefreshPrices() {
    setRefreshStatus('refreshing');
    setRefreshMessage('');
    try {
      const loadedComparison = await loadActiveComparison({ refreshPrices: true });
      setComparison(loadedComparison);
      setRefreshMessage(formatRefreshReport(loadedComparison.refreshReport));
      setStatus('ready');
      setRefreshStatus('idle');
    } catch {
      setRefreshStatus('error');
      setRefreshMessage('Actualisation impossible. Les anciens prix locaux sont conservés.');
    }
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
        `Scan en direct chez Leclerc/Hyper U terminé : ${outcome.diagnostic.summary.updated} prix vérifiés sur le site. ${outcome.diagnostic.summary.failed} erreur(s) : anciens prix concernés invalidés, à revalider.`
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
      setDriveMessage(error instanceof Error ? error.message : 'La collecte Drive a échoué.');
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

  const lastSyncByStore = useMemo(() => {
    const latest: Partial<Record<StoreKey, string>> = {};
    for (const snapshot of comparison?.priceSnapshots ?? []) {
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
      setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'error' }));
      setValidateMessageByStore((current) => ({
        ...current,
        [storeKey]: 'Panier bloqué : corrige les anomalies critiques indiquées dans le niveau de confiance.'
      }));
      return;
    }
    const decisions = decisionsByStore[storeKey];
    if (decisions.length === 0) return;

    setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'validating' }));
    setValidateMessageByStore((current) => ({ ...current, [storeKey]: '' }));

    const otherStoreKey: StoreKey = storeKey === 'leclerc' ? 'hyperu' : 'leclerc';
    // `coverage.lines` est désormais exhaustif (Sujet B) : il contient aussi
    // les lignes 'requiresValidation'/'unavailable'/'notFound', dont le prix
    // (le cas échéant) n'est PAS assez fiable pour entrer dans un calcul de
    // gain. Ne garder ici que les lignes 'priced', exactement comme avant ce
    // changement.
    const otherStoreLinesByItemId = new Map(
      result.coverage[otherStoreKey].lines
        .filter((line) => line.status === 'priced')
        .map((line) => [line.itemId, line.price])
    );

    let savings = 0;
    const items: ValidatedBasketItem[] = [];
    for (const decision of decisions) {
      if (decision.price === undefined) continue;
      const otherPrice = otherStoreLinesByItemId.get(decision.itemId);
      if (otherPrice !== undefined && otherPrice > decision.price) {
        savings += otherPrice - decision.price;
      }
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
        savings: roundMoney(savings),
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
          [storeKey]: `Panier enregistré (${formatMoney(total)}). Extension Drive indisponible : ouvre les liens produit manuellement pour remplir le panier ${storeLabels[storeKey]}.`
        }));
        return;
      }

      if (!comparison || !hasCurrentCartAutomationConsent(comparison.settings)) {
        const accepted = window.confirm(
          `Autoriser le remplissage automatique chez ${storeLabels[storeKey]} ?\n\n` +
          `L’extension va ouvrir le Drive, rechercher les produits et cliquer sur « Ajouter au panier ». ` +
          `Elle ne valide aucune commande et n’accède pas au paiement.`
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
      await applyCartFillOutcome(storeKey, basket.id, total, outcome);
    } catch {
      setValidateStatusByStore((current) => ({ ...current, [storeKey]: 'error' }));
      setValidateMessageByStore((current) => ({ ...current, [storeKey]: 'Impossible de valider ce panier.' }));
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
              <h3 id="validation-popup-title">Rafraîchissement terminé — à vérifier</h3>
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
        <h2 id="compare-title">Répartition optimisée</h2>
        <p className="lead">
          Compare la liste active avec des prix horodatés. Tu peux ouvrir les liens manuellement ou,
          après consentement, demander à l’extension de remplir un panier sans passer commande.
        </p>
      </div>

      {status === 'loading' && <p className="panelText">Chargement de la comparaison locale...</p>}
      {status === 'error' && (
        <p className="panelText panelTextDanger">Impossible de charger les données locales.</p>
      )}

      {status === 'ready' && comparison?.rows.length === 0 && (
        <div className="settingsPanel">
          <div>
            <h3>Liste active vide</h3>
            <p>Ajoute des produits depuis la liste, les produits mémorisés ou le scan manuel.</p>
          </div>
          <div className="cardActions">
            <Link className="buttonLink" to="/liste">
              Ouvrir la liste
            </Link>
            <Link className="buttonLink" to="/produits">
              Produits
            </Link>
            <Link className="buttonLink" to="/scan">
              Scan
            </Link>
          </div>
        </div>
      )}

      {status === 'ready' && comparison && result && (
        <>
          <div className="settingsPanel">
            <div>
              <h3>Seuil d’économie</h3>
              <p>
                La recommandation de division apparaît seulement si l’économie dépasse ce seuil.
              </p>
            </div>
            <label className="thresholdControl">
              <span>Seuil actuel en euros</span>
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
            <div className="cardActions">
              <button
                className="secondaryButton"
                type="button"
                onClick={() => void handleRefreshPrices()}
                disabled={refreshStatus === 'refreshing'}
              >
                {refreshStatus === 'refreshing' ? 'Mise à jour...' : 'Mettre à jour maintenant'}
              </button>
            </div>
            {refreshMessage && (
              <p className={refreshStatus === 'error' ? 'panelText panelTextDanger' : 'panelText'}>
                {refreshMessage}
              </p>
            )}
            <div className="cardActions">
              <button
                className="secondaryButton"
                type="button"
                onClick={() => void handleDriveRefresh()}
                disabled={driveRefreshStatus === 'refreshing'}
              >
                {driveRefreshStatus === 'refreshing' ? 'Collecte en cours...' : 'Actualiser les prix Drive'}
              </button>
              {driveDiagnostic && (
                <button
                  className="secondaryButton"
                  type="button"
                  onClick={() => downloadDriveDiagnostic(driveDiagnostic)}
                >
                  Télécharger le diagnostic
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

          <div className="settingsPanel" aria-label="Dernière synchronisation par magasin">
            <div>
              <h3>Fraîcheur des prix</h3>
              <p className="panelText">
                {(Object.keys(storeLabels) as StoreKey[])
                  .map((storeKey) => `${storeLabels[storeKey]} : ${formatLastSync(lastSyncByStore[storeKey])}`)
                  .join(' · ')}
              </p>
            </div>
          </div>

          <TrustSummaryPanel
            report={result.trustReport}
            onRefresh={() => void handleDriveRefresh()}
            onAcknowledgeWarnings={(itemId) => void handleAcknowledgeWarnings(itemId)}
            productNameById={productNameById}
          />

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
            >
              Télécharger la preuve du calcul
            </button>
          </div>

          {result.savingsVsBestSingleStore !== null && (
            <div className="savingsHero" role="status" aria-label="Économie réalisée avec la répartition">
              <p className="savingsHeroLabel">Économie réalisée</p>
              <p className="savingsHeroAmount">{formatMoney(result.savingsVsBestSingleStore)}</p>
              <div className="savingsHeroDivider" />
              <p className="savingsHeroSub">en répartissant entre Leclerc et Hyper U plutôt qu'un seul magasin</p>
            </div>
          )}

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
              label="Panier optimisé (réparti entre les 2 magasins)"
              value={formatMoney(result.totals.optimized)}
              detail="Chaque produit est pris au magasin le moins cher : ce total mélange Leclerc et Hyper U, ce n'est pas un total dans un seul magasin."
            />
            <Metric
              label="Économie avec répartition"
              value={formatMoney(result.savingsVsBestSingleStore)}
              detail="Économie par rapport au meilleur panier dans un seul magasin."
            />
            <Metric
              label="Écart entre magasins"
              value={formatMoney(storeGap)}
              detail="Différence entre tout Leclerc et tout Hyper U."
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

          <div className="settingsPanel">
            <div>
              <h3>Recommandation</h3>
              <p>{formatRecommendation(result.recommendation)}</p>
              <p>
                Le panier réparti correspond à la liste détaillée ci-dessous : certains produits
                peuvent aller chez Leclerc, d'autres chez Hyper U. L’économie avec répartition compare
                ce total au meilleur panier fait dans un seul magasin. L'écart entre magasins compare
                seulement les deux paniers complets.
              </p>
            </div>
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
            storeKey="hyperu"
            onValidate={handleValidateBasket}
            validateStatus={validateStatusByStore.hyperu}
            validateMessage={validateMessageByStore.hyperu}
            cartFillFailures={cartFillResultsByStore.hyperu}
            trustAllowsActions={result.trustReport.canValidateBasket}
          />

          {(validateStatusByStore.leclerc === 'done' || validateStatusByStore.hyperu === 'done') && (
            <div className="settingsPanel">
              <div>
                <h3>Panier rempli</h3>
                <p>
                  {clearListMessage ||
                    'Les produits ci-dessus ont été ajoutés au panier en ligne. Tu peux vider la liste active pour préparer les prochaines courses.'}
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
                  <p>Confirmer le vidage de la liste active ?</p>
                  <button className="dangerButton" type="button" onClick={() => void handleClearListAfterFill()}>
                    Confirmer
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
            probableMatchCount={result.decisions.filter((decision) => decision.confidenceScore < 100).length}
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
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article>
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

// Les deux alertes bloquantes qu'aucune action automatique ne peut lever :
// elles comparent deux valeurs lues sur la MÊME fiche, donc actualiser relit
// la même page et retrouve le même écart. Elles n'ont leur place ni dans le
// bouton « Actualiser » (sans effet) ni dans le lien vers « Produits à
// valider » (qui ne liste que les lignes `requiresValidation`, dont ces
// lignes-là ne font justement pas partie — le lien menait donc à un panneau
// affichant « aucun produit à valider » pendant que la validation restait
// interdite). Voir l'audit du 02/09, F-01/F-02.
const ACKNOWLEDGEABLE_ISSUE_CODES = new Set<TrustIssue['code']>(['price_mismatch', 'different_format']);

function TrustSummaryPanel({
  report,
  onRefresh,
  onAcknowledgeWarnings,
  productNameById
}: {
  report: ComparisonResult['trustReport'];
  onRefresh: () => void;
  onAcknowledgeWarnings: (itemId: string) => void;
  productNameById: Map<string, string>;
}) {
  const firstBlocking = report.issues.find((issue) => issue.severity === 'blocking');
  const labels = { trusted: 'Calcul fiable', attention: 'Calcul fiable avec réserves', blocked: 'Estimation bloquée' } as const;
  const blockingProductName = firstBlocking?.productId ? productNameById.get(firstBlocking.productId) : undefined;
  const acknowledgeableItemId =
    firstBlocking && ACKNOWLEDGEABLE_ISSUE_CODES.has(firstBlocking.code) ? firstBlocking.itemId : undefined;
  return (
    <div className="settingsPanel" aria-label="Niveau de confiance du calcul">
      <div>
        <h3>{labels[report.status]}</h3>
        <p>
          {report.status === 'blocked'
            ? `${report.blockingIssueCount} anomalie(s) critique(s) : les totaux restent visibles à titre d’estimation, mais aucune recommandation ni validation de panier n’est autorisée.`
            : `${report.summary.trustedDecisionCount}/${report.summary.itemCount} ligne(s) fiables ; ${report.warningIssueCount} réserve(s).`}
        </p>
        {firstBlocking && (
          <p className="panelText panelTextDanger">
            Priorité : {blockingProductName ? `${blockingProductName} — ` : ''}
            {firstBlocking.message}
          </p>
        )}
      </div>
      {firstBlocking?.action === 'refresh_prices' && (
        <div className="cardActions"><button className="primaryButton" type="button" onClick={onRefresh}>Actualiser les données manquantes</button></div>
      )}
      {acknowledgeableItemId && (
        <div className="cardActions">
          <button className="primaryButton" type="button" onClick={() => onAcknowledgeWarnings(acknowledgeableItemId)}>
            J’ai vérifié ce produit sur la fiche du magasin
          </button>
          <p className="panelText">
            L’avertissement restera affiché, mais il ne bloquera plus la validation de ce panier.
          </p>
        </div>
      )}
      {firstBlocking && firstBlocking.action !== 'refresh_prices' && !acknowledgeableItemId && (
        <div className="cardActions"><a className="buttonLink" href="#products-to-validate">Corriger le premier produit</a></div>
      )}
      {report.issues.length > 0 && (
        <details><summary>Voir toutes les anomalies ({report.issues.length})</summary>
          <ul className="warningList">{report.issues.map((issue: TrustIssue) => <li key={issue.id}>{issue.severity === 'blocking' ? 'Bloquant — ' : 'Attention — '}{issue.message}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

// Ordre d'affichage : les lignes au prix ferme d'abord (celles qui comptent
// dans le total), puis celles à valider, puis les indisponibles, puis les
// non trouvées — pour que l'information la plus utile remonte en premier
// dans une liste désormais exhaustive (une ligne par produit de la liste de
// courses, quel que soit le statut de ce magasin sur cette ligne).
const COVERAGE_STATUS_ORDER: Record<StoreCoverageLineStatus, number> = {
  priced: 0,
  requiresValidation: 1,
  unavailable: 2,
  notFound: 3
};

export function CoverageBreakdown({
  storeKey,
  storeLabel,
  coverage,
  productNameById,
  productBarcodeById,
  candidateById,
  onCandidateConfirmed
}: {
  storeKey: StoreKey;
  storeLabel: string;
  coverage: StoreCoverage;
  productNameById: Map<string, string>;
  productBarcodeById: Map<string, string | undefined>;
  candidateById: Map<string, ProductCandidate>;
  // Retour explicite du 31/08 : depuis ce détail par magasin, "Voir le
  // produit" ouvre la bonne page mais ne permettait pas de la valider pour ce
  // produit — voir CoverageLiveActionButton, affiché tant que le prix n'est
  // pas déjà ferme (status !== 'priced').
  onCandidateConfirmed: (itemId: string) => void;
}) {
  const sortedLines = [...coverage.lines].sort((left, right) => {
    const orderDelta = COVERAGE_STATUS_ORDER[left.status] - COVERAGE_STATUS_ORDER[right.status];
    if (orderDelta !== 0) {
      return orderDelta;
    }
    return (right.price ?? 0) - (left.price ?? 0);
  });

  return (
    <details className="coverageBreakdown">
      <summary>Détail des prix pris en compte chez {storeLabel}</summary>
      {sortedLines.length === 0 ? (
        <p className="panelText">Aucun produit dans la liste de courses.</p>
      ) : (
        <ul className="coverageBreakdownList">
          {sortedLines.map((line) => {
            const candidate = line.candidateId ? candidateById.get(line.candidateId) : undefined;
            const url = candidate?.productUrl ?? candidate?.searchUrl;
            const productName = productNameById.get(line.productId) ?? 'Produit inconnu';
            return (
              <li key={line.itemId}>
                <span className="coverageBreakdownName">{productName}</span>
                <span className={`coverageBreakdownStatus coverageBreakdownStatus--${line.status}`}>
                  {formatCoverageLineStatus(line)}
                </span>
                {/* Colonne toujours unique (3e enfant direct du <li>, même
                    arité que les 2 précédentes) même si elle peut contenir un
                    lien, un bouton, les deux, ou aucun des deux — l'alignement
                    ligne à ligne ne dépend que du nombre d'enfants directs. */}
                <span className="coverageBreakdownActions">
                  {line.status === 'priced' ? (
                    url ? (
                      <a className="buttonLink coverageBreakdownLink" href={url} rel="noreferrer" target="_blank">
                        Voir le produit
                      </a>
                    ) : (
                      <span className="coverageBreakdownLink" aria-hidden="true" />
                    )
                  ) : (
                    // Prix pas encore ferme : le lien devient l'action de
                    // validation elle-même (voir CoverageLiveActionButton) —
                    // plus de bouton séparé à côté.
                    <CoverageLiveActionButton
                      storeKey={storeKey}
                      itemId={line.itemId}
                      productId={line.productId}
                      productName={productName}
                      productBarcode={productBarcodeById.get(line.productId)}
                      productUrl={url}
                      onCandidateConfirmed={onCandidateConfirmed}
                    />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}

function formatCoverageLineStatus(line: StoreCoverageLine) {
  switch (line.status) {
    case 'priced':
      return formatMoney(line.price ?? null);
    case 'requiresValidation':
      return line.price !== undefined ? `À valider (${formatMoney(line.price)})` : 'À valider';
    case 'unavailable':
      return 'Indisponible chez ce magasin';
    case 'notFound':
      return 'Non trouvé chez ce magasin';
    default:
      return '';
  }
}

function StoreDecisionList({
  decisions,
  experimentalAddToCart,
  productNameById,
  productBarcodeById,
  candidateById,
  forcedStoreKeyByItemId,
  forcedCandidateIdByItemId,
  onForceStore,
  onForceCandidate,
  onCandidateConfirmed,
  storeKey,
  onValidate,
  validateStatus,
  validateMessage,
  cartFillFailures,
  trustAllowsActions
}: {
  decisions: ComparisonDecision[];
  experimentalAddToCart: boolean;
  productNameById: Map<string, string>;
  productBarcodeById: Map<string, string | undefined>;
  candidateById: Map<string, ProductCandidate>;
  forcedStoreKeyByItemId: Map<string, StoreKey | null>;
  forcedCandidateIdByItemId: Map<string, string | null>;
  onForceStore: (itemId: string, storeKey: StoreKey | null) => void;
  onForceCandidate: (itemId: string, candidateId: string | null) => void;
  onCandidateConfirmed: (itemId: string) => void;
  storeKey: StoreKey;
  onValidate?: (storeKey: StoreKey) => void;
  validateStatus?: 'idle' | 'validating' | 'done' | 'error';
  validateMessage?: string;
  // Toutes les lignes (succès ET échecs) — le bouton de diagnostic reste
  // disponible même quand tout est vert (mesure temporaire de débogage, cf.
  // downloadCartFillDiagnostic), seule la liste visible ci-dessous filtre
  // sur les échecs.
  cartFillFailures?: CartFillResultLine[];
  trustAllowsActions: boolean;
}) {
  const expectedByProductId = buildExpectedByProductId(decisions, storeKey, productNameById, candidateById);
  // Ajouts que le magasin a bien effectués, mais sur un autre produit que
  // celui validé : invisibles dans la liste des échecs ci-dessous, puisqu'ils
  // sont comptés comme des succès.
  const cartFillMismatches = cartFillFailures ? findCartFillMismatches(cartFillFailures, expectedByProductId) : [];
  return (
    <div className="settingsPanel">
      <div>
        <h3>
          À acheter chez {storeLabels[storeKey]}
          {decisions.length > 0 && (
            <span className="storeDecisionTotal"> · {formatMoney(sumDecisionPrices(decisions))}</span>
          )}
        </h3>
        <p>
          {decisions.length === 0
            ? 'Aucun produit sélectionné automatiquement pour ce magasin.'
            : `${decisions.length} produit(s) sélectionné(s).`}
        </p>
      </div>

      {decisions.length > 0 && onValidate && (
        <div className="cardActions">
          <button
            className="primaryButton"
            type="button"
            onClick={() => onValidate(storeKey)}
            disabled={validateStatus === 'validating' || !trustAllowsActions}
            title={!trustAllowsActions ? 'Corrige d’abord les anomalies critiques du calcul.' : undefined}
          >
            {validateStatus === 'validating'
              ? 'Validation en cours...'
              : `Valider le panier ${storeLabels[storeKey]}`}
          </button>
        </div>
      )}
      {validateMessage && (
        <p className={validateStatus === 'error' ? 'panelText panelTextDanger' : 'panelText'}>
          {validateMessage}
        </p>
      )}
      {cartFillFailures && cartFillFailures.length > 0 && (
        <div className="cardActions">
          {cartFillMismatches.length > 0 && (
            <>
              <p className="panelText panelTextDanger">
                Attention : {cartFillMismatches.length} produit(s) ont bien été ajoutés au panier, mais ce n'est
                pas le produit validé ici. Vérifie ces lignes directement sur le site du magasin avant de
                commander — le total affiché plus haut ne correspond alors plus au panier réel.
              </p>
              <ul className="warningList">
                {cartFillMismatches.map((line) => (
                  <li key={`mismatch-${line.productId}`}>
                    {productNameById.get(line.productId) ?? 'Produit inconnu'} : attendu «{' '}
                    {expectedByProductId.get(line.productId)?.pickedName ?? '?'} », ajouté «{' '}
                    {line.matchedName ?? '?'} »
                  </li>
                ))}
              </ul>
            </>
          )}
          {cartFillFailures.some((line) => !line.added) && (
            <ul className="warningList">
              {cartFillFailures
                .filter((line) => !line.added)
                .map((failure) => (
                  <li key={failure.productId}>
                    {productNameById.get(failure.productId) ?? 'Produit inconnu'} :{' '}
                    {(failure.code && DRIVE_ERROR_LABELS[failure.code]) ?? 'échec non identifié'} — à ajouter manuellement
                  </li>
                ))}
            </ul>
          )}
          <button
            className="secondaryButton"
            type="button"
            onClick={() =>
              downloadCartFillDiagnostic(storeKey, cartFillFailures, expectedByProductId)
            }
          >
            Télécharger le diagnostic d'ajout au panier
          </button>
        </div>
      )}

      <div className="comparisonDecisionList">
        {decisions.map((decision) => {
          const candidate = decision.selectedCandidateId
            ? candidateById.get(decision.selectedCandidateId)
            : undefined;

          return (
            <article className="comparisonDecision" key={decision.itemId}>
              <div>
                <h4>{productNameById.get(decision.productId) ?? 'Produit inconnu'}</h4>
                <p>{candidate?.name ?? 'Produit magasin à vérifier'}</p>
              </div>
              <p className="comparisonDecisionPrice">{formatMoney(decision.price ?? null)}</p>
              {decision.confidenceScore < 100 && (
                // Bloc rendu ACTIONNABLE le 02/09/2026 : jusqu'ici cet
                // avertissement était un simple texte grisé, sans moyen d'y
                // donner suite. Or confirmer la fiche une seule fois règle le
                // problème définitivement : le candidat passe en choix humain
                // (100 % de confiance, plus jamais réécrit par une recherche
                // automatique) et son adresse exacte est mémorisée, donc les
                // rafraîchissements suivants relisent cette fiche au lieu de
                // relancer une recherche qui peut retomber ailleurs.
                <div className="comparisonDecisionCheck">
                  <p className="panelText">
                    Correspondance probable ({decision.confidenceScore} %) — à confirmer.{' '}
                    {APPROXIMATE_MATCH_EXPLANATIONS[candidate?.matchType as keyof typeof APPROXIMATE_MATCH_EXPLANATIONS] ??
                      'Pas de code-barres confirmé pour ce produit — le nom correspond, mais un contrôle rapide reste conseillé avant de valider le panier.'}
                  </p>
                  <CoverageLiveActionButton
                    storeKey={storeKey}
                    itemId={decision.itemId}
                    productId={decision.productId}
                    productName={productNameById.get(decision.productId) ?? 'Produit inconnu'}
                    productBarcode={productBarcodeById?.get(decision.productId)}
                    productUrl={candidate?.productUrl ?? candidate?.searchUrl}
                    onCandidateConfirmed={onCandidateConfirmed}
                    idleLabelOverride="Confirmer la fiche"
                  />
                </div>
              )}
              {decision.warnings.length > 0 && (
                <ul className="warningList">
                  {decision.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
              <details>
                <summary>Voir le calcul de cette ligne</summary>
                <p className="panelText">
                  {decision.quantityToBuy} unité(s) × {formatMoney(
                    decision.quantityToBuy > 0 && decision.price !== undefined
                      ? decision.price / decision.quantityToBuy
                      : null
                  )} = {formatMoney(decision.price ?? null)}. {decision.reason}
                </p>
              </details>
              <StoreOverrideControl
                itemId={decision.itemId}
                forcedStoreKey={forcedStoreKeyByItemId.get(decision.itemId) ?? null}
                onForceStore={onForceStore}
              />
              <ManualCandidateOverrideControl
                itemId={decision.itemId}
                forcedCandidateId={forcedCandidateIdByItemId.get(decision.itemId) ?? null}
                onForceCandidate={onForceCandidate}
              />
              <ManualCorrectionControls
                itemId={decision.itemId}
                productId={decision.productId}
                productName={productNameById.get(decision.productId) ?? 'Produit'}
                productBarcode={productBarcodeById.get(decision.productId)}
                storeCandidateIds={decision.storeCandidateIds}
                candidateById={candidateById}
                onCandidateConfirmed={onCandidateConfirmed}
              />
              <CandidateLinks candidate={candidate} experimentalAddToCart={experimentalAddToCart && trustAllowsActions} />
              <StoreCandidateLinks decision={decision} candidateById={candidateById} selectedCandidate={candidate} />
            </article>
          );
        })}
      </div>
    </div>
  );
}

function StoreOverrideControl({
  itemId,
  forcedStoreKey,
  onForceStore
}: {
  itemId: string;
  forcedStoreKey: StoreKey | null;
  onForceStore: (itemId: string, storeKey: StoreKey | null) => void;
}) {
  return (
    <label className="thresholdControl">
      <span>Magasin forcé</span>
      <select
        value={forcedStoreKey ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          onForceStore(itemId, value === '' ? null : (value as StoreKey));
        }}
      >
        <option value="">Automatique (moins cher)</option>
        <option value="leclerc">{storeLabels.leclerc}</option>
        <option value="hyperu">{storeLabels.hyperu}</option>
      </select>
    </label>
  );
}

// N'affiche rien s'il n'y a rien à annuler. Couvre le choix volontaire d'un
// alternate (bouton "Choisir : ...") et le verrou résiduel d'un ancien pick
// manuel posé avant le passage à onCandidateConfirmed — aucun des deux ne
// peut être retiré autrement dans l'UI.
function ManualCandidateOverrideControl({
  itemId,
  forcedCandidateId,
  onForceCandidate
}: {
  itemId: string;
  forcedCandidateId: string | null;
  onForceCandidate: (itemId: string, candidateId: string | null) => void;
}) {
  if (!forcedCandidateId) {
    return null;
  }

  return (
    <div className="cardActions">
      <button type="button" className="secondaryButton" onClick={() => onForceCandidate(itemId, null)}>
        Annuler le choix de format
      </button>
    </div>
  );
}

export function ValidationPanel({
  decisions,
  probableMatchCount = 0,
  productNameById,
  productBarcodeById,
  candidateById = new Map(),
  forcedStoreKeyByItemId,
  forcedCandidateIdByItemId,
  onForceStore,
  onForceCandidate,
  onCandidateConfirmed,
  onRejectCandidate
}: {
  decisions: ComparisonDecision[];
  // Décisions retenues automatiquement mais dont la correspondance n'est que
  // probable (pas de code-barres confirmé ni de choix humain). Elles ne
  // bloquent rien, donc elles n'apparaissent pas dans `decisions` — sans ce
  // compteur, rien ne disait combien de produits mériteraient une
  // confirmation, et le panneau affichait "aucun produit à valider" alors
  // que la moitié du panier reposait sur un simple recouvrement de noms.
  probableMatchCount?: number;
  productNameById: Map<string, string>;
  productBarcodeById?: Map<string, string | undefined>;
  candidateById?: Map<string, ProductCandidate>;
  forcedStoreKeyByItemId: Map<string, StoreKey | null>;
  forcedCandidateIdByItemId: Map<string, string | null>;
  onForceStore: (itemId: string, storeKey: StoreKey | null) => void;
  onForceCandidate: (itemId: string, candidateId: string | null) => void;
  onCandidateConfirmed: (itemId: string) => void;
  onRejectCandidate: (candidateId: string) => void;
}) {
  return (
    <div className="settingsPanel" id="products-to-validate">
      <div>
        <h3>Produits à valider</h3>
        <p>
          {decisions.length === 0
            ? 'Aucun produit à valider pour cette comparaison.'
            : 'Ces produits restent séparés des choix automatiques.'}
        </p>
        {probableMatchCount > 0 && (
          <p className="panelText">
            {probableMatchCount === 1
              ? '1 autre produit a été retenu sur une simple ressemblance de nom.'
              : `${probableMatchCount} autres produits ont été retenus sur une simple ressemblance de nom.`}{' '}
            Ils sont comptés dans les totaux, mais tu les trouveras signalés « à confirmer » dans les paniers
            ci-dessus. Confirmer une fiche une seule fois suffit : elle sera relue directement aux
            prochains comparatifs, sans nouvelle recherche.
          </p>
        )}
      </div>

      {decisions.length > 0 && (
        <div className="comparisonDecisionList">
          {decisions.map((decision) => (
            <article className="comparisonDecision comparisonDecisionWarning" key={decision.itemId}>
              <h4>{productNameById.get(decision.productId) ?? 'Produit inconnu'}</h4>
              <p>{decision.reason}</p>
              <ul className="warningList">
                {decision.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
              {decision.alternates.length > 0 && (
                <div className="alternateQuantityPicker">
                  <span className="alternateQuantityPickerLabel">
                    {decision.alternates.every((alternate) => alternate.matchType === 'uncertain')
                      ? 'Aucune correspondance fiable — voici ce qui s’en approche le plus :'
                      : 'Quantité demandée indisponible — formats trouvés en magasin :'}
                  </span>
                  <div className="alternateQuantityButtons">
                    {decision.alternates.map((alternate) => (
                      <div className="alternateQuantityCard" key={alternate.candidateId}>
                        <p className="alternateQuantityCardName">
                          {alternate.name} · {formatMoney(alternate.price ?? null)}
                          {alternate.matchType === 'uncertain' ? ' (correspondance incertaine)' : ''}
                        </p>
                        <div className="cardActions">
                          <button
                            type="button"
                            className="alternateQuantityButton"
                            onClick={() => onForceCandidate(decision.itemId, alternate.candidateId)}
                          >
                            Choisir celui-ci
                          </button>
                          {alternate.productUrl && (
                            // Auparavant un simple <a href> : ouvrait la fiche
                            // mais n'armait jamais l'overlay de validation de
                            // l'extension sur cette page, contrairement au
                            // bouton "Choisir sur la page X" plus bas — signalé
                            // par l'utilisateur (04/09) comme incohérent. Même
                            // bouton que "Voir le produit" ailleurs : ouvre ET
                            // arme le pick, donc valider directement depuis la
                            // fiche devient possible ici aussi.
                            <CoverageLiveActionButton
                              storeKey={alternate.storeKey}
                              itemId={decision.itemId}
                              productId={decision.productId}
                              productName={productNameById.get(decision.productId) ?? 'Produit'}
                              productBarcode={productBarcodeById?.get(decision.productId)}
                              productUrl={alternate.productUrl}
                              onCandidateConfirmed={onCandidateConfirmed}
                              idleLabelOverride="Voir la fiche"
                            />
                          )}
                          <button
                            type="button"
                            className="secondaryButton"
                            onClick={() => onRejectCandidate(alternate.candidateId)}
                          >
                            Aucun de ceux-là
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Action principale : chercher soi-même la bonne fiche sur le
                  site du magasin. Les réglages plus rares (forcer un magasin,
                  annuler un choix de format) sont repliés ci-dessous — retour
                  du 04/09 : trop de contrôles à plat rendaient la carte
                  confuse. */}
              <ManualCorrectionControls
                itemId={decision.itemId}
                productId={decision.productId}
                productName={productNameById.get(decision.productId) ?? 'Produit'}
                productBarcode={productBarcodeById?.get(decision.productId)}
                storeCandidateIds={decision.storeCandidateIds}
                candidateById={candidateById}
                onCandidateConfirmed={onCandidateConfirmed}
              />
              <details className="comparisonDecisionAdvanced">
                <summary>Options avancées</summary>
                <StoreOverrideControl
                  itemId={decision.itemId}
                  forcedStoreKey={forcedStoreKeyByItemId.get(decision.itemId) ?? null}
                  onForceStore={onForceStore}
                />
                <ManualCandidateOverrideControl
                  itemId={decision.itemId}
                  forcedCandidateId={forcedCandidateIdByItemId.get(decision.itemId) ?? null}
                  onForceCandidate={onForceCandidate}
                />
              </details>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

const STORE_ACTION_LABELS: Record<StoreKey, string> = { leclerc: 'Leclerc', hyperu: 'Hyper U' };

// État + appel runLivePick pour UN magasin — factorisé pour être réutilisé
// aussi bien groupé par deux (ManualCorrectionControls, panneau de
// validation) que seul, une fois par ligne (CoverageLiveActionButton, détail
// par magasin) : la logique est identique, seul le rendu diffère selon
// l'endroit.
function useStoreLivePick(
  storeKey: StoreKey,
  itemId: string,
  productId: string,
  productName: string,
  productBarcode: string | undefined,
  onCandidateConfirmed: (itemId: string) => void
) {
  const [status, setStatus] = useState<'idle' | 'picking' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [awaitingPick, setAwaitingPick] = useState(false);

  // startUrl optionnel (retour explicite du 31/08) : amène l'onglet
  // directement sur un candidat déjà connu (lien "Voir le produit") plutôt
  // que sur l'accueil catalogue — voir CoverageBreakdown.
  async function trigger(startUrl?: string) {
    setStatus('picking');
    setMessage('');
    setAwaitingPick(false);
    try {
      const outcome = await runLivePick(productId, productName, productBarcode, storeKey, (progress) => {
        setAwaitingPick(progress.state === 'awaiting_pick');
      }, startUrl,
      // Sans startUrl (aucun candidat déjà connu), le catalogue s'ouvrait
      // vierge — ou resté sur la fiche du produit précédent — sans jamais
      // taper la recherche pour l'utilisateur, contrairement à l'écran
      // d'ajout. Un clic « Valider ce produit » sur cette page pouvait alors
      // confirmer silencieusement un produit sans rapport, en confiance
      // 100 % (matchStage 'manual', aucun avertissement affiché ensuite).
      // Cas réel du 04/09 : Nutella/Riz/Lait tous associés à la même fiche
      // Leclerc restée affichée ("Crème Délisse"). On pré-remplit désormais
      // la recherche avec le nom du produit, comme le fait déjà runLivePick
      // depuis l'écran d'ajout.
      startUrl ? undefined : productName);
      setAwaitingPick(false);
      if (outcome.ok) {
        setStatus('done');
        setMessage(`✓ ${outcome.observedName} — ${formatMoney(outcome.priceEuro)}`);
        onCandidateConfirmed(itemId);
      } else {
        setStatus('error');
        setMessage(outcome.reason);
      }
    } catch (error) {
      setAwaitingPick(false);
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'La sélection manuelle a échoué.');
    }
  }

  return { status, message, awaitingPick, trigger };
}

// Correction manuelle "clé en main" pour un produit dont la sélection
// automatique n'est pas fiable (voir DriveManualOverrideEntry côté Hyper U et
// DriveLivePickJobV1 côté Leclerc). Un succès persiste le candidat avec
// matchType 'manual_override' (confiance 100%, voir scoring.ts) et se
// contente de recharger la comparaison via onCandidateConfirmed — il devient
// prioritaire face aux propositions automatiques concurrentes, sans verrouiller
// définitivement ce magasin si l'utilisateur choisit ensuite autre chose.
// Distinct du bouton
// "Choisir : ..." sur un alternate, qui verrouille volontairement un format
// via onForceCandidate/forcedCandidateId.
function ManualCorrectionControls({
  itemId,
  productId,
  productName,
  productBarcode,
  storeCandidateIds,
  candidateById,
  onCandidateConfirmed
}: {
  itemId: string;
  productId: string;
  productName: string;
  productBarcode: string | undefined;
  // Best candidat déjà fiable par magasin pour ce produit (voir
  // ComparisonDecision.storeCandidateIds) — sert uniquement à afficher un
  // magasin comme déjà réglé (recherche automatique ou pick manuel d'un
  // rendu précédent) sans que l'utilisateur ait à cliquer ici cette session.
  // Dérivé en état d'affichage plutôt que copié dans un useState : une
  // valeur initiale figée au montage ne se serait jamais mise à jour quand
  // ce magasin passe de "pas encore résolu" à "résolu" pendant que le popup
  // reste ouvert (retour explicite du 31/08 : garder les deux boutons
  // actionnables jusqu'à ce que les deux magasins soient couverts).
  storeCandidateIds: Partial<Record<StoreKey, string>>;
  candidateById: Map<string, ProductCandidate>;
  onCandidateConfirmed: (itemId: string) => void;
}) {
  const leclerc = useStoreLivePick('leclerc', itemId, productId, productName, productBarcode, onCandidateConfirmed);
  const hyperU = useStoreLivePick('hyperu', itemId, productId, productName, productBarcode, onCandidateConfirmed);

  // 3 états par magasin (retour du 04/09 : un magasin où une fiche a déjà
  // été trouvée automatiquement, mais jamais confirmée par un humain,
  // affichait le même bouton blanc qu'un magasin où rien n'a été trouvé du
  // tout — alors que "Voir produit" prouvait qu'une fiche existait bien.
  // 'confirmed' (vert plein) reste réservé au choix humain (manual_override
  // ou pick réussi cette session) ; 'found' (vert-liseré) signale une fiche
  // automatique à vérifier ; 'empty' = rien à afficher pour ce magasin.
  const leclercCandidate = storeCandidateIds.leclerc ? candidateById.get(storeCandidateIds.leclerc) : undefined;
  const hyperUCandidate = storeCandidateIds.hyperu ? candidateById.get(storeCandidateIds.hyperu) : undefined;
  const leclercConfirmed =
    leclerc.status === 'done' ||
    (leclerc.status === 'idle' && isManuallyConfirmedCandidate(storeCandidateIds.leclerc, candidateById));
  const hyperUConfirmed =
    hyperU.status === 'done' ||
    (hyperU.status === 'idle' && isManuallyConfirmedCandidate(storeCandidateIds.hyperu, candidateById));
  const leclercFound = !leclercConfirmed && leclerc.status === 'idle' && Boolean(leclercCandidate);
  const hyperUFound = !hyperUConfirmed && hyperU.status === 'idle' && Boolean(hyperUCandidate);

  return (
    <div>
      <div className="cardActions">
        <button
          type="button"
          className={
            hyperUConfirmed ? 'secondaryButton successButton' : hyperUFound ? 'secondaryButton foundButton' : 'secondaryButton'
          }
          // Fiche déjà connue mais pas confirmée : on y amène directement
          // (startUrl), comme "Voir le produit" ailleurs, plutôt que de
          // rouvrir le catalogue vierge.
          onClick={() => void hyperU.trigger(hyperUFound ? hyperUCandidate?.productUrl ?? hyperUCandidate?.searchUrl : undefined)}
          disabled={hyperU.status === 'picking'}
        >
          {hyperU.status === 'picking'
            ? 'En attente sur la page Hyper U...'
            : hyperU.status === 'done'
              ? '✓ Choisi sur la page Hyper U'
              : hyperUConfirmed
                ? '✓ Déjà trouvé chez Hyper U'
                : hyperUFound
                  ? '✓ Fiche trouvée chez Hyper U — à confirmer'
                  : 'Choisir sur la page Hyper U'}
        </button>
        <button
          type="button"
          className={
            leclercConfirmed ? 'secondaryButton successButton' : leclercFound ? 'secondaryButton foundButton' : 'secondaryButton'
          }
          onClick={() => void leclerc.trigger(leclercFound ? leclercCandidate?.productUrl ?? leclercCandidate?.searchUrl : undefined)}
          disabled={leclerc.status === 'picking'}
        >
          {leclerc.status === 'picking'
            ? 'En attente sur la page Leclerc...'
            : leclerc.status === 'done'
              ? '✓ Choisi sur la page Leclerc'
              : leclercConfirmed
                ? '✓ Déjà trouvé chez Leclerc'
                : leclercFound
                  ? '✓ Fiche trouvée chez Leclerc — à confirmer'
                  : 'Choisir sur la page Leclerc'}
        </button>
      </div>
      {hyperU.status === 'picking' && (
        <p className="panelText">
          {hyperU.awaitingPick
            ? 'Un onglet Hyper U est ouvert : navigue jusqu’au bon produit puis valide.'
            : 'Ouverture du catalogue Hyper U...'}
        </p>
      )}
      {hyperU.message && (
        <p className={hyperU.status === 'error' ? 'panelText panelTextDanger' : 'panelText'}>{hyperU.message}</p>
      )}
      {leclerc.status === 'picking' && (
        <p className="panelText">
          {leclerc.awaitingPick
            ? 'Un onglet Leclerc est ouvert : navigue jusqu’au bon produit puis valide.'
            : 'Ouverture du catalogue Leclerc...'}
        </p>
      )}
      {leclerc.message && (
        <p className={leclerc.status === 'error' ? 'panelText panelTextDanger' : 'panelText'}>{leclerc.message}</p>
      )}
    </div>
  );
}

// Action "en direct" pour UN SEUL magasin, insérée dans le détail par
// magasin (CoverageBreakdown, déjà scindé Leclerc/Hyper U). Retour explicite
// du 31/08 (2e itération) : PAS un bouton séparé à côté du lien "Voir le
// produit" — le lien LUI-MÊME doit déclencher le mécanisme, exactement comme
// "Choisir sur la page X" dans le popup/ManualCorrectionControls, sinon
// l'utilisateur clique deux fois pour ce qui devrait n'être qu'une action :
// ouvrir la bonne page ET pouvoir y confirmer son choix (coche verte) une
// fois sur la fiche produit.
// productUrl fourni (candidat déjà connu) → libellé "Voir le produit",
// startUrl passé à runLivePick pour y amener directement l'onglet piloté
// plutôt que l'accueil catalogue (voir livePickLeclercProduct). Sans
// candidat connu (notFound complet, rien à "voir") → repli sur l'ancien
// comportement "Valider cette page" (accueil catalogue, navigation libre).
function CoverageLiveActionButton({
  storeKey,
  itemId,
  productId,
  productName,
  productBarcode,
  productUrl,
  onCandidateConfirmed,
  idleLabelOverride
}: {
  storeKey: StoreKey;
  itemId: string;
  productId: string;
  productName: string;
  productBarcode: string | undefined;
  productUrl: string | undefined;
  onCandidateConfirmed: (itemId: string) => void;
  // Le libellé par défaut ("Voir le produit") décrit l'action dans le détail
  // par magasin, où la ligne n'a pas encore de prix ferme. Là où le prix est
  // déjà retenu mais la correspondance seulement probable, ce n'est plus
  // "voir" qu'on demande mais "confirmer" — d'où ce libellé au choix de
  // l'appelant.
  idleLabelOverride?: string;
}) {
  const pick = useStoreLivePick(storeKey, itemId, productId, productName, productBarcode, onCandidateConfirmed);
  const label = STORE_ACTION_LABELS[storeKey];
  const idleLabel = idleLabelOverride ?? (productUrl ? 'Voir le produit' : 'Valider cette page');

  return (
    <span className="coverageBreakdownAction">
      <button
        type="button"
        className={pick.status === 'done' ? 'secondaryButton successButton' : 'secondaryButton'}
        onClick={() => void pick.trigger(productUrl)}
        disabled={pick.status === 'picking'}
      >
        {pick.status === 'picking' ? 'En attente...' : pick.status === 'done' ? '✓ Validé' : idleLabel}
      </button>
      {pick.status === 'picking' && (
        <p className="panelText">
          {pick.awaitingPick
            ? `Un onglet ${label} est ouvert : navigue jusqu’au bon produit puis valide.`
            : `Ouverture du catalogue ${label}...`}
        </p>
      )}
      {pick.message && (
        <p className={pick.status === 'error' ? 'panelText panelTextDanger' : 'panelText'}>{pick.message}</p>
      )}
    </span>
  );
}

function StoreCandidateLinks({
  decision,
  candidateById,
  selectedCandidate
}: {
  decision: ComparisonDecision;
  candidateById: Map<string, ProductCandidate>;
  selectedCandidate?: ProductCandidate;
}) {
  const selectedUrl = selectedCandidate?.productUrl ?? selectedCandidate?.searchUrl;
  const stores: StoreKey[] = ['leclerc', 'hyperu'];
  const links = stores
    .map((storeKey) => {
      const candidateId = decision.storeCandidateIds[storeKey];
      const candidate = candidateId ? candidateById.get(candidateId) : undefined;
      const url = candidate?.productUrl ?? candidate?.searchUrl;
      if (url && selectedUrl && urlsPointToSameProduct(url, selectedUrl)) {
        return null;
      }
      return url ? { storeKey, url } : null;
    })
    .filter((entry): entry is { storeKey: StoreKey; url: string } => entry !== null);

  if (links.length === 0) {
    return null;
  }

  return (
    <div className="cardActions">
      {links.map(({ storeKey, url }) => (
        <a key={storeKey} className="buttonLink" href={url} rel="noreferrer" target="_blank">
          Voir chez {storeLabels[storeKey]}
        </a>
      ))}
    </div>
  );
}

function isManuallyConfirmedCandidate(
  candidateId: string | undefined,
  candidateById: Map<string, ProductCandidate>
) {
  return Boolean(candidateId && candidateById.get(candidateId)?.matchType === 'manual_override');
}

function sumDecisionPrices(decisions: ComparisonDecision[]) {
  return decisions.reduce((sum, decision) => sum + (decision.price ?? 0), 0);
}

function urlsPointToSameProduct(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return left === right;
  }
}

function CandidateLinks({
  candidate,
  experimentalAddToCart
}: {
  candidate?: ProductCandidate;
  experimentalAddToCart: boolean;
}) {
  if (!candidate?.productUrl && !candidate?.searchUrl) {
    return null;
  }

  const addToCartAction = buildAddToCartAction(candidate, { experimentalAddToCart });

  return (
    <>
      <div className="cardActions">
        {candidate.productUrl && (
          <a className="buttonLink" href={candidate.productUrl} rel="noreferrer" target="_blank">
            Voir produit
          </a>
        )}
        {candidate.searchUrl && (
          <a className="buttonLink" href={candidate.searchUrl} rel="noreferrer" target="_blank">
            Recherche magasin
          </a>
        )}
        {addToCartAction && (
          <a className="buttonLink" href={addToCartAction.url} rel="noreferrer" target="_blank">
            {addToCartAction.label}
          </a>
        )}
      </div>
      {addToCartAction && (
        <p className="panelText panelTextWarning">{addToCartAction.warning}</p>
      )}
    </>
  );
}

function groupDecisionsByStore(result: ComparisonResult | null): Record<StoreKey, ComparisonDecision[]> {
  const grouped: Record<StoreKey, ComparisonDecision[]> = {
    leclerc: [],
    hyperu: []
  };

  result?.decisions.forEach((decision) => {
    if (!decision.requiresValidation && decision.selectedStoreKey) {
      grouped[decision.selectedStoreKey].push(decision);
    }
  });

  return grouped;
}

function getStoreGap(result: ComparisonResult | null) {
  if (!result || result.totals.leclerc === null || result.totals.hyperu === null) {
    return null;
  }

  return Math.round(Math.abs(result.totals.leclerc - result.totals.hyperu) * 100) / 100;
}

function formatRecommendation(recommendation: ComparisonResult['recommendation']) {
  if (recommendation.kind === 'split') {
    return `Répartir le panier entre magasins. ${recommendation.reason}`;
  }

  if (recommendation.kind === 'single_store') {
    return `Faire tout le panier chez ${storeLabels[recommendation.storeKey]}. ${recommendation.reason}`;
  }

  return `Validation nécessaire. ${recommendation.reason}`;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeMatchName(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Ce que le comparatif avait retenu pour chaque produit, indexé par productId.
// Extrait de downloadCartFillDiagnostic (02/09) pour que l'ÉCRAN et le fichier
// de diagnostic partagent exactement la même définition de « ce qui était
// attendu » — sans quoi les deux pourraient diverger silencieusement.
function buildExpectedByProductId(
  decisions: ComparisonDecision[],
  storeKey: StoreKey,
  productNameById: Map<string, string>,
  candidateById: Map<string, ProductCandidate>
) {
  return new Map(
    decisions.map((decision) => {
      const candidateId = decision.storeCandidateIds[storeKey] ?? decision.selectedCandidateId;
      const candidate = candidateId ? candidateById.get(candidateId) : undefined;
      return [
        decision.productId,
        {
          expectedName: productNameById.get(decision.productId) ?? '',
          pickedName: candidate?.name,
          pickedUrl: candidate?.productUrl
        }
      ];
    })
  );
}

// Produits que le magasin dit avoir ajoutés, mais sous un nom différent de
// celui validé au comparatif. Ces lignes portent `added: true` : elles ne
// remontent donc JAMAIS dans la liste des échecs, et jusqu'au 02/09 elles
// n'étaient visibles que dans le fichier de diagnostic téléchargé — l'écran
// annonçait un panier conforme alors qu'il pouvait contenir autre chose.
export function findCartFillMismatches(
  results: CartFillResultLine[],
  expectedByProductId: Map<string, { expectedName: string; pickedName?: string; pickedUrl?: string }>
) {
  return results.filter((line) => {
    if (!line.added || !line.matchedName) return false;
    const pickedName = expectedByProductId.get(line.productId)?.pickedName;
    // Sans nom validé de référence, l'écart n'est pas vérifiable : ne rien
    // affirmer plutôt que crier au loup.
    if (!pickedName) return false;
    return normalizeMatchName(line.matchedName) !== normalizeMatchName(pickedName);
  });
}

function downloadCartFillDiagnostic(
  storeKey: StoreKey,
  results: CartFillResultLine[],
  // Ce que le comparatif avait retenu pour chaque produit. Sans ça, le
  // diagnostic disait seulement "ajouté", jamais QUOI — impossible de
  // vérifier après coup que le panier réel contient bien les produits
  // validés (demande du 01/09).
  expectedByProductId: Map<string, { expectedName: string; pickedName?: string; pickedUrl?: string }>
) {
  // `results` couvre TOUJOURS succès + échecs (voir cartFillService.ts) :
  // le diagnostic reste téléchargeable même quand tout est vert (0 échec)
  // -- décision utilisateur du 01/09, un ajout "réussi" côté extension peut
  // quand même avoir cliqué la mauvaise carte (matchedName/matchedPriceEuro
  // permettent de le repérer après coup) sans jamais apparaître dans
  // `failures` seul. À débrancher une fois la version publique stabilisée.
  const detailed = results.map((result) => {
    const expected = expectedByProductId.get(result.productId);
    // undefined = non vérifiable (le magasin n'a pas dit ce qu'il a ajouté,
    // ou aucun candidat validé retrouvé) — à ne pas confondre avec false.
    const matchesPick =
      result.added && expected?.pickedName && result.matchedName
        ? normalizeMatchName(result.matchedName) === normalizeMatchName(expected.pickedName)
        : undefined;
    return {
      ...result,
      expectedName: expected?.expectedName,
      pickedName: expected?.pickedName,
      pickedUrl: expected?.pickedUrl,
      matchesPick
    };
  });

  const payload = {
    format: 'drive-price-splitter-cart-fill-diagnostic',
    formatVersion: 3,
    storeKey,
    createdAt: new Date().toISOString(),
    // Produits ajoutés dont le nom ne correspond PAS à celui validé au
    // comparatif : c'est la seule liste à regarder pour savoir si le panier
    // réel contient autre chose que ce qui a été décidé.
    mismatches: detailed.filter((line) => line.matchesPick === false),
    unverified: detailed.filter((line) => line.added && line.matchesPick === undefined).map((line) => line.productId),
    results: detailed,
    failures: detailed.filter((result) => !result.added)
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cart-fill-diagnostic-${storeKey}-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadCalculationProof(payload: ReturnType<typeof buildCalculationProof>) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `preuve-calcul-panier-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function formatLastSync(isoDate: string | undefined) {
  if (!isoDate) {
    return 'jamais';
  }
  const minutesAgo = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 60_000));
  if (minutesAgo < 1) return "à l'instant";
  if (minutesAgo < 60) return `il y a ${minutesAgo} min`;
  const hoursAgo = Math.round(minutesAgo / 60);
  if (hoursAgo < 24) return `il y a ${hoursAgo} h`;
  const daysAgo = Math.round(hoursAgo / 24);
  return `il y a ${daysAgo} j`;
}

// Explique la raison du plafond à 89% (getCandidateConfidence, scoring.ts) en
// termes compréhensibles pour quelqu'un qui ne connaît pas cette règle
// interne. Sans ce texte, un produit correctement identifié (bon nom, bon
// prix) affiche quand même "89% — à vérifier", ce qui peut faire craindre à
// tort une erreur alors qu'il n'y a simplement pas de code-barres pour le
// confirmer formellement.
const APPROXIMATE_MATCH_EXPLANATIONS: Partial<Record<CandidateMatchType, string>> = {
  equivalent_brand: "Pas de code-barres confirmé, mais le nom du produit correspond bien à ce qui est demandé.",
  private_label: "Marque de distributeur proposée à la place de la marque demandée — vérifie que c'est bien ce que tu veux.",
  same_brand_different_format: "Même marque, mais le conditionnement trouvé n'est pas garanti identique à celui demandé.",
  uncertain: "Correspondance incertaine entre plusieurs produits possibles — un contrôle avant achat est recommandé."
};

const DRIVE_ERROR_LABELS: Record<string, string> = {
  PRODUCT_NOT_FOUND: 'produit(s) introuvable(s) sur le site',
  ADAPTER_NOT_READY: 'magasin non pris en charge',
  TAB_CREATION_FAILED: "impossible d'ouvrir l'onglet",
  STORE_COLLECTION_FAILED: 'collecte interrompue (onglet fermé ou site indisponible)',
  DRIVE_SETUP_REQUIRED: 'magasin Drive non configuré sur le site',
  DRIVE_PAGE_TIMEOUT: 'page trop lente à charger',
  CATALOG_NOT_READY: 'catalogue non accessible',
  CATALOG_NOT_READY_AFTER_ENTRY: 'catalogue non accessible après ouverture',
  PRODUCT_SEARCH_INPUT_NOT_FOUND: 'champ de recherche introuvable sur la page',
  PRODUCT_SEARCH_NOT_STARTED: "recherche produit n'a pas pu démarrer",
  PRODUCT_SEARCH_FAILED: 'recherche produit a échoué',
  // Timeout ponctuel du site (pas un "produit introuvable" : la recherche
  // n'a pas eu le temps d'aboutir) — à distinguer clairement de
  // PRODUCT_NOT_FOUND pour ne pas laisser croire à un défaut de recherche.
  PRODUCT_SEARCH_TIMEOUT: 'site trop lent à répondre (relancer suffit en général)',
  SITE_BLOCKED: 'accès au site bloqué',
  COURSESU_CATALOG_NOT_READY: 'catalogue Hyper U non accessible',
  CIRCUIT_BREAKER_OPEN: 'magasin mis en pause (trop d’échecs récents, nouvelle tentative plus tard)',
  CAPTCHA_DETECTED: 'vérification anti-robot détectée sur le site',
  SCRIPT_EXECUTION_TIMEOUT: 'la page est restée bloquée trop longtemps (nouvelle tentative automatique)',
  CART_NAVIGATION_FAILED: "impossible d'ouvrir la page du produit",
  CART_REDIRECTED_TO_HOME: 'le site a refusé le lien produit et est revenu à sa page d’accueil',
  ADD_TO_CART_CONTROL_NOT_FOUND: 'bouton "ajouter au panier" introuvable sur la page',
  ADD_TO_CART_FAILED: "l'ajout au panier a échoué",
  CART_LOGIN_REQUIRED: "tu n'es pas connecté(e) à ton compte sur le site",
  CART_SEARCH_NOT_STARTED: 'la recherche n’a pas pu démarrer sur le site',
  CART_PRODUCT_NOT_FOUND: 'produit introuvable dans le catalogue du magasin',
  CART_CARD_NOT_FOUND: 'produit trouvé mais impossible de retrouver sa fiche pour l’ajouter',
  CART_ADD_NOT_CONFIRMED: 'le site n’a pas confirmé l’ajout (rupture de stock possible, ou déconnexion en cours de route)',
  // Codes émis par les collecteurs mais qui n’avaient aucun libellé ici : ils
  // ressortaient tels quels (en majuscules techniques) dans le résumé affiché
  // sous le bouton de rafraîchissement.
  STORE_SELECTION_FAILED: 'la sélection du magasin a échoué sur le site',
  STORE_RESULT_NOT_FOUND: 'magasin introuvable dans les résultats du site',
  STORE_RESULT_AMBIGUOUS: 'plusieurs magasins possibles, aucun choix évident',
  STORE_RESULT_NOT_CLICKABLE: 'magasin trouvé mais impossible de le sélectionner',
  STORE_RESULT_STALE: 'la liste des magasins a changé pendant la sélection (nouvelle tentative nécessaire)',
  DRIVE_RESULT_NOT_FOUND: 'drive introuvable dans les résultats du site',
  DRIVE_RESULT_AMBIGUOUS: 'plusieurs drives possibles, aucun choix évident',
  DRIVE_RESULT_NOT_CLICKABLE: 'drive trouvé mais impossible de le sélectionner',
  DRIVE_RESULT_STALE: 'la liste des drives a changé pendant la sélection (nouvelle tentative nécessaire)',
  DRIVE_SELECTION_FAILED: 'la sélection du drive a échoué sur le site',
  DRIVE_SELECTION_REQUIRED: 'il faut d’abord choisir un drive sur le site',
  DRIVE_START_CONTROL_NOT_FOUND: 'bouton "commencer mes courses" introuvable après le choix du drive',
  LOCATION_INPUT_NOT_FOUND: 'champ ville / code postal introuvable sur la page',
  POSTAL_INPUT_NOT_FOUND: 'champ code postal introuvable sur la page',
  POSTAL_AUTOCOMPLETE_NOT_FOUND: 'aucune suggestion proposée pour ce code postal',
  CATALOG_ENTRY_NOT_FOUND: 'entrée du catalogue introuvable sur la page',
  LECLERC_CATALOG_NAVIGATION_FAILED: 'navigation vers le catalogue Leclerc impossible',
  LECLERC_FARM_NOT_RESOLVED: 'serveur du drive Leclerc non identifié',
  MANUAL_URL_NAVIGATION_FAILED: 'impossible d’ouvrir l’adresse corrigée à la main',
  MANUAL_URL_PAGE_NOT_FOUND: 'l’adresse corrigée à la main ne mène à aucune fiche produit',
  MANUAL_URL_PAGE_NOT_READY: 'la fiche de l’adresse corrigée n’a pas fini de s’afficher',
  MANUAL_URL_PAGE_INVALID: 'l’adresse corrigée à la main n’est pas exploitable',
  MANUAL_URL_PRICE_NOT_FOUND: 'aucun prix lisible sur la fiche de l’adresse corrigée',
  CART_DIRECT_URL_NAVIGATION_FAILED: 'impossible d’ouvrir la fiche du produit choisi',
  CART_DIRECT_URL_PAGE_NOT_FOUND: 'la fiche du produit choisi n’existe plus sur le site',
  CART_DIRECT_URL_PAGE_NOT_READY: 'la fiche du produit choisi n’a pas fini de s’afficher',
  CART_DIRECT_URL_MISMATCH: 'la fiche atteinte ne correspond pas au produit choisi (lien périmé)',
  PICK_TIMEOUT: 'aucun produit validé à la main dans le temps imparti',
  DRIVE_PICK_TAB_CLOSED: 'onglet fermé avant la validation manuelle',
  CAPTCHA_REQUIRED: 'vérification anti-robot à faire à la main sur le site',
  LECLERC_SITE_ERROR: 'le site Leclerc Drive est momentanément indisponible (panne côté site, pas l’extension)',
  DRIVE_JOB_CANCELLED: 'opération annulée',
  UNEXPECTED_HOST: 'le site a redirigé vers une adresse inattendue',
  UNSUPPORTED_PAGE: 'page non reconnue par l’extension'
};

// The downloadable JSON diagnostic stays the source of truth, but a short
// human-readable summary directly on the page means the user doesn't have
// to open a file just to know roughly what went wrong.
function summarizeDriveErrors(diagnostic: DriveRefreshDiagnostic) {
  const counts = new Map<string, number>();
  for (const entry of diagnostic.diagnostics) {
    const storeName = storeLabels[entry.storeKey as StoreKey] ?? entry.storeKey;
    const key = `${storeName}|${entry.code}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([key, count]) => {
      const [storeName, code] = key.split('|');
      const label = DRIVE_ERROR_LABELS[code] ?? code;
      return `${storeName} : ${count} ${label}`;
    });
}

const SEARCH_STAGE_LABELS: Record<NonNullable<DriveRefreshProgressEvent['searchStage']>, string> = {
  ean: 'recherche par code-barres',
  name: 'code-barres sans résultat, recherche par nom',
  simplified_name: 'nom sans résultat, nouvel essai simplifié',
  name_only: 'toujours rien avec la marque, nouvel essai sans la marque',
  brand_only: 'toujours rien, recherche par marque seule'
};

function formatDriveProgress(progress: DriveRefreshProgressEvent | null) {
  if (!progress) {
    return 'Démarrage...';
  }
  const storeName = storeLabels[progress.storeKey as StoreKey] ?? progress.storeKey;
  if (progress.state === 'store_retry') {
    return `${storeName} : nouvelle tentative...`;
  }
  if (progress.state === 'product_search' && progress.productIndex && progress.productTotal) {
    const stageLabel = progress.searchStage ? SEARCH_STAGE_LABELS[progress.searchStage] : null;
    return `${storeName} : produit ${progress.productIndex}/${progress.productTotal}${
      progress.productName ? ` (${progress.productName})` : ''
    }${stageLabel ? ` — ${stageLabel}` : ''}`;
  }
  return `${storeName} : collecte démarrée...`;
}

// Formule volontairement différente de celle de "Actualiser les prix Drive"
// (voir handleDriveRefresh) : ce sont deux mécanismes distincts (celui-ci ne
// va PAS sur les sites Leclerc/Hyper U, contrairement à l'autre) et un texte
// trop similaire ("X prix actualisé(s)... indisponible(s)") pour les deux
// laissait croire qu'un seul et même rafraîchissement avait eu lieu.
function formatRefreshReport(report: PriceRefreshReport | undefined) {
  if (!report) {
    return '';
  }

  if (report.attempted === 0) {
    return 'Aucun prix à actualiser pour cette liste.';
  }

  const parts = [`Vérification locale (sans aller sur les sites) : ${report.updated} prix mis à jour`];
  if (report.unavailable > 0) {
    parts.push(`${report.unavailable} non disponible(s) pour cette vérification`);
  }
  if (report.failed > 0) {
    parts.push(`${report.failed} erreur(s), anciens prix conservés`);
  }

  return parts.join('. ') + '.';
}

function formatCoverageDetail(storeLabel: string, coverage: { covered: number; total: number }) {
  const base = `Hypothèse : tout le panier acheté chez ${storeLabel} seul (aucune répartition entre magasins).`;
  if (coverage.total === 0 || coverage.covered >= coverage.total) {
    return base;
  }
  return `${base} Attention : seulement ${coverage.covered}/${coverage.total} produits ont un prix chez ${storeLabel}, ce total ne couvre pas le panier complet.`;
}

function formatMoney(value: number | null) {
  if (value === null) {
    return 'À vérifier';
  }

  return `${value.toFixed(2)} €`;
}
