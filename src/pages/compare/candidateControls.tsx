import { useState } from 'react';
import { type ComparisonDecision } from '../../features/comparison/comparisonEngine';
import { type ProductCandidate, type StoreKey } from '../../types/domain';
import { buildAddToCartAction } from '../../features/add-to-cart/addToCartAction';
import { runLivePick } from '../../features/drive-bridge/driveRefreshService';
import { storeLabels } from '../../features/stores/storeLabels';
import { isManuallyConfirmedCandidate, urlsPointToSameProduct, formatMoney } from './compareFormat';

export function StoreOverrideControl({
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
      <span>Acheter ce produit chez</span>
      <select
        value={forcedStoreKey ?? ''}
        onChange={(event) => {
          const value = event.target.value;
          onForceStore(itemId, value === '' ? null : (value as StoreKey));
        }}
      >
        <option value="">Le moins cher (choix automatique)</option>
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
export function ManualCandidateOverrideControl({
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
        Annuler mon choix de produit
      </button>
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
export function ManualCorrectionControls({
  itemId,
  productId,
  productName,
  productBarcode,
  storeCandidateIds,
  candidateById,
  onCandidateConfirmed,
  onRejectCandidate,
  onForceStore
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
  onRejectCandidate: (candidateId: string) => void;
  onForceStore: (itemId: string, storeKey: StoreKey | null) => void;
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

  // "Ce n'est pas le bon produit ici, je veux CE produit uniquement chez
  // l'autre magasin" — demande explicite du 04/09 : jusque-là, la seule
  // sortie était de retrouver soi-même le contrôle "Magasin forcé" dans
  // "Options avancées", loin du bouton qui montre le mauvais produit. En un
  // clic : verrouille l'autre magasin (forcedStoreKey, le moteur ne regarde
  // plus que lui) ET rejette le candidat fautif de ce magasin (sinon il
  // resterait proposé si le verrou est levé plus tard).
  function excludeStore(storeToExclude: StoreKey) {
    const other: StoreKey = storeToExclude === 'leclerc' ? 'hyperu' : 'leclerc';
    const badCandidateId = storeCandidateIds[storeToExclude];
    if (badCandidateId) onRejectCandidate(badCandidateId);
    onForceStore(itemId, other);
  }

  return (
    <div>
      <div className="cardActions">
        <div className="storeChoiceRow">
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
              ? 'Choisis le produit sur le site Hyper U…'
              : hyperU.status === 'done'
                ? '✓ Choisi sur la page Hyper U'
                : hyperUConfirmed
                  ? '✓ Déjà trouvé chez Hyper U'
                  : hyperUFound
                    ? '✓ Produit trouvé chez Hyper U — à confirmer'
                    : 'Choisir sur la page Hyper U'}
          </button>
          <button
            type="button"
            className="rejectStoreButton"
            onClick={() => excludeStore('hyperu')}
            disabled={hyperU.status === 'picking' || leclerc.status === 'picking'}
            title="Pas le bon produit chez Hyper U : l’acheter chez Leclerc"
            aria-label="Pas le bon produit chez Hyper U : l’acheter chez Leclerc"
          >
            ✕
          </button>
        </div>
        <div className="storeChoiceRow">
          <button
            type="button"
            className={
              leclercConfirmed ? 'secondaryButton successButton' : leclercFound ? 'secondaryButton foundButton' : 'secondaryButton'
            }
            onClick={() => void leclerc.trigger(leclercFound ? leclercCandidate?.productUrl ?? leclercCandidate?.searchUrl : undefined)}
            disabled={leclerc.status === 'picking'}
          >
            {leclerc.status === 'picking'
              ? 'Choisis le produit sur le site Leclerc…'
              : leclerc.status === 'done'
                ? '✓ Choisi sur la page Leclerc'
                : leclercConfirmed
                  ? '✓ Déjà trouvé chez Leclerc'
                  : leclercFound
                    ? '✓ Produit trouvé chez Leclerc — à confirmer'
                    : 'Choisir sur la page Leclerc'}
          </button>
          <button
            type="button"
            className="rejectStoreButton"
            onClick={() => excludeStore('leclerc')}
            disabled={hyperU.status === 'picking' || leclerc.status === 'picking'}
            title="Pas le bon produit chez Leclerc : l’acheter chez Hyper U"
            aria-label="Pas le bon produit chez Leclerc : l’acheter chez Hyper U"
          >
            ✕
          </button>
        </div>
      </div>
      {hyperU.status === 'picking' && (
        <p className="panelText">
          {hyperU.awaitingPick
            ? 'Un onglet Hyper U est ouvert : va sur la page du bon produit, puis touche le bouton vert de validation.'
            : 'Ouverture du site Hyper U…'}
        </p>
      )}
      {hyperU.message && (
        <p className={hyperU.status === 'error' ? 'panelText panelTextDanger' : 'panelText'}>{hyperU.message}</p>
      )}
      {leclerc.status === 'picking' && (
        <p className="panelText">
          {leclerc.awaitingPick
            ? 'Un onglet Leclerc est ouvert : va sur la page du bon produit, puis touche le bouton vert de validation.'
            : 'Ouverture du site Leclerc…'}
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
export function CoverageLiveActionButton({
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
        {pick.status === 'picking' ? 'En attente…' : pick.status === 'done' ? '✓ Validé' : idleLabel}
      </button>
      {pick.status === 'picking' && (
        <p className="panelText">
          {pick.awaitingPick
            ? `Un onglet ${label} est ouvert : va sur la page du bon produit, puis touche le bouton vert de validation.`
            : `Ouverture du site ${label}…`}
        </p>
      )}
      {pick.message && (
        <p className={pick.status === 'error' ? 'panelText panelTextDanger' : 'panelText'}>{pick.message}</p>
      )}
    </span>
  );
}

export function StoreCandidateLinks({
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

export function CandidateLinks({
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
            Voir sur le site
          </a>
        )}
        {candidate.searchUrl && (
          <a className="buttonLink" href={candidate.searchUrl} rel="noreferrer" target="_blank">
            Chercher sur le site
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
