import { type ComparisonDecision } from '../../features/comparison/comparisonEngine';
import { type ProductCandidate, type StoreKey } from '../../types/domain';
import { type CartFillResultLine } from '../../features/drive-bridge/cartFillService';
import { storeLabels } from '../../features/stores/storeLabels';
import { sumDecisionPrices, APPROXIMATE_MATCH_EXPLANATIONS, DRIVE_ERROR_LABELS, countOf, formatMoney } from './compareFormat';
import { buildExpectedByProductId, findCartFillMismatches, downloadCartFillDiagnostic } from './cartFillDiagnostics';
import { StoreOverrideControl, ManualCandidateOverrideControl, ManualCorrectionControls, CoverageLiveActionButton, StoreCandidateLinks, CandidateLinks } from './candidateControls';

export function StoreDecisionList({
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
  onRejectCandidate,
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
  onRejectCandidate: (candidateId: string) => void;
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
  // Ajouté "réussi" mais quantité non confirmée (stepper +/- introuvable ou
  // clics restés sans effet) : le total calculé compte pourtant la quantité
  // demandée en entier — c'est la cause la plus probable d'un écart entre le
  // total affiché ici et le vrai total du panier sur le site (04/09).
  const cartFillQuantityIssues = (cartFillFailures ?? []).filter(
    (line) => line.added && line.quantityConfirmed === false
  );
  // Rien à acheter ici et rien à signaler : un panneau vide n'apprend rien.
  if (decisions.length === 0 && !validateMessage && !(cartFillFailures && cartFillFailures.length > 0)) {
    return null;
  }
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
            ? 'Aucun produit n’est moins cher ici pour l’instant.'
            : `${decisions.length > 1 ? `${decisions.length} produits moins chers` : '1 produit moins cher'} ici. Le connecteur peut ${decisions.length > 1 ? 'les' : 'l’'}ajouter pour toi à ton panier sur le site ; il ne passe jamais la commande.`}
        </p>
      </div>

      {decisions.length > 0 && onValidate && (
        <div className="cardActions">
          <button
            className="primaryButton"
            type="button"
            onClick={() => onValidate(storeKey)}
            disabled={validateStatus === 'validating'}
            title={!trustAllowsActions ? 'Clique pour afficher la raison du blocage.' : undefined}
          >
            {validateStatus === 'validating'
              ? 'Remplissage en cours…'
              : `Remplir mon panier ${storeLabels[storeKey]}`}
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
                Attention : {cartFillMismatches.length > 1
                  ? `${cartFillMismatches.length} produits ont bien été ajoutés au panier, mais ce n'est pas le produit validé ici.`
                  : '1 produit a bien été ajouté au panier, mais ce n’est pas celui validé ici.'} Vérifie ces lignes directement sur le site du magasin avant de
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
          {cartFillQuantityIssues.length > 0 && (
            <>
              <p className="panelText panelTextDanger">
                Attention : {countOf(cartFillQuantityIssues.length, 'produit ajouté', 'produits ajoutés')} au panier
                sans confirmation que la quantité demandée a bien été atteinte. Vérifie la quantité de ces lignes directement sur le site
                avant de payer — c'est la cause la plus probable d'un total différent de celui calculé ici.
              </p>
              <ul className="warningList">
                {cartFillQuantityIssues.map((line) => (
                  <li key={`qty-${line.productId}`}>
                    {productNameById.get(line.productId) ?? 'Produit inconnu'} : {line.requestedQuantity} demandé
                    {(line.requestedQuantity ?? 0) > 1 ? 's' : ''}, {line.finalQuantity ?? 'nombre inconnu'} sur le site
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
                    {failure.directUrlAttempt?.code &&
                      ` (lien direct refusé : ${DRIVE_ERROR_LABELS[failure.directUrlAttempt.code] ?? failure.directUrlAttempt.code})`}
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
            Télécharger le rapport technique du remplissage
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
                <p>{candidate?.name ?? 'Produit du magasin à vérifier'}</p>
              </div>
              <p className="comparisonDecisionPrice">
                {formatMoney(decision.price ?? null)}
                {/* Sans le détail, « 13,44 € » pour une bouteille de thé à
                    2,24 € ressemblait à une erreur de prix (cas réel 16/11). */}
                {decision.price !== undefined && decision.quantityToBuy > 1 && (
                  <span className="comparisonDecisionQuantity">
                    {decision.quantityToBuy} × {formatMoney(decision.price / decision.quantityToBuy)}
                  </span>
                )}
              </p>
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
                    C’est sans doute le bon produit (sûr à {decision.confidenceScore} %) : vérifie-le d’un coup d’œil.{' '}
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
                    idleLabelOverride="Vérifier sur le site"
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
                <summary>Pourquoi ce magasin ?</summary>
                {/* Reformulé en langage courant (retour du 04/09 : la
                    formule "quantité × prix = total" seule n'était pas assez
                    parlante) + tableau prix/magasin ajouté pour que
                    l'utilisateur puisse vérifier lui-même le choix sans
                    rouvrir les deux fiches — au prix du paquet ET au
                    kilo/litre, seule base comparable entre deux formats
                    différents (voir unitPriceArbitration.ts). */}
                <p className="panelText">
                  Tu en veux {decision.quantityToBuy}
                  {decision.quantityToBuy > 1 ? ' exemplaires' : ' exemplaire'}
                  {decision.price !== undefined && decision.quantityToBuy > 0 && (
                    <>
                      {' '}
                      , à {formatMoney(decision.price / decision.quantityToBuy)} pièce chez{' '}
                      {decision.selectedStoreKey ? storeLabels[decision.selectedStoreKey] : 'le magasin retenu'} —{' '}
                      {formatMoney(decision.price)} au total.
                    </>
                  )}
                </p>
                <p className="panelText">{decision.reason}</p>
                {Object.keys(decision.priceComparisonByStore).length > 0 && (
                  <>
                    <p className="panelText">
                      Prix relevé chez chaque magasin, et ramené au kilo ou au litre pour comparer même quand les
                      tailles de paquet diffèrent :
                    </p>
                    <div className="priceComparisonList">
                      {(['leclerc', 'hyperu'] as StoreKey[]).map((storeKey) => {
                        const info = decision.priceComparisonByStore[storeKey];
                        return (
                          <div
                            className={
                              decision.selectedStoreKey === storeKey
                                ? 'priceComparisonRow priceComparisonRowSelected'
                                : 'priceComparisonRow'
                            }
                            key={storeKey}
                          >
                            <span className="priceComparisonStore">
                              {storeLabels[storeKey]}
                              {decision.selectedStoreKey === storeKey ? ' ✓' : ''}
                            </span>
                            {info ? (
                              <>
                                <span className="priceComparisonName">{info.productName}</span>
                                <span className="priceComparisonPrice">
                                  {formatMoney(info.packagePrice ?? null)}
                                  {info.unitPriceLabel ? ` · ${info.unitPriceLabel}` : ''}
                                </span>
                              </>
                            ) : (
                              <span className="priceComparisonName panelText">Pas encore de produit équivalent trouvé</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </details>
              {/* Sept boutons sous chaque produit noyaient l'essentiel (nom,
                  prix). Les corrections restent là, repliées ; le volet
                  s'ouvre de lui-même si un choix manuel est déjà en place. */}
              <details
                open={
                  Boolean(forcedStoreKeyByItemId.get(decision.itemId)) ||
                  Boolean(forcedCandidateIdByItemId.get(decision.itemId)) ||
                  undefined
                }
              >
                <summary>Changer de magasin ou de produit</summary>
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
                  onRejectCandidate={onRejectCandidate}
                  onForceStore={onForceStore}
                />
              </details>
              <CandidateLinks candidate={candidate} experimentalAddToCart={experimentalAddToCart && trustAllowsActions} />
              <StoreCandidateLinks decision={decision} candidateById={candidateById} selectedCandidate={candidate} />
            </article>
          );
        })}
      </div>
    </div>
  );
}
