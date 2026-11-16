import { type ComparisonDecision } from '../../features/comparison/comparisonEngine';
import { type ProductCandidate, type StoreKey } from '../../types/domain';
import { formatMoney } from './compareFormat';
import { StoreOverrideControl, ManualCandidateOverrideControl, ManualCorrectionControls, CoverageLiveActionButton } from './candidateControls';

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
        <h3>Produits à vérifier</h3>
        <p>
          {decisions.length === 0
            ? 'Rien à vérifier : tous les produits ont été reconnus.'
            : 'L’application n’est pas sûre d’avoir trouvé le bon produit. Pour chacun, choisis le bon dans le magasin : il ne compte pas dans les totaux tant que ce n’est pas fait.'}
        </p>
        {probableMatchCount > 0 && (
          <p className="panelText">
            {probableMatchCount === 1
              ? '1 autre produit a été retenu sur une simple ressemblance de nom.'
              : `${probableMatchCount} autres produits ont été retenus sur une simple ressemblance de nom.`}{' '}
            {probableMatchCount === 1
              ? 'Il compte déjà dans les totaux ; tu le trouveras plus haut avec le bouton « Vérifier sur le site ».'
              : 'Ils comptent déjà dans les totaux ; tu les trouveras plus haut avec le bouton « Vérifier sur le site ».'}
            Une seule vérification suffit : l’application s’en souviendra pour tes prochaines courses.
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
                      ? 'Aucune correspondance fiable — voici les produits les plus proches :'
                      : 'Le format demandé n’est pas vendu ici — voici les formats disponibles :'}
                  </span>
                  <div className="alternateQuantityButtons">
                    {decision.alternates.map((alternate) => (
                      <div className="alternateQuantityCard" key={alternate.candidateId}>
                        <p className="alternateQuantityCardName">
                          {alternate.name} · {formatMoney(alternate.price ?? null)}
                          {alternate.matchType === 'uncertain' ? ' (pas sûr que ce soit le même)' : ''}
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
                onRejectCandidate={onRejectCandidate}
                onForceStore={onForceStore}
              />
              <details className="comparisonDecisionAdvanced">
                <summary>Autres options</summary>
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
