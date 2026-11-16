import { type ComparisonResult, type FormatNotice, type StoreCoverage, type StoreCoverageLine, type StoreCoverageLineStatus } from '../../features/comparison/comparisonEngine';
import { type ProductCandidate, type StoreKey } from '../../types/domain';
import type { TrustIssue } from '../../features/comparison/trustAssessment';
import { countOf, formatMoney } from './compareFormat';
import { CoverageLiveActionButton } from './candidateControls';

export function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
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

export function TrustSummaryPanel({
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
  const labels = { trusted: 'Les prix sont fiables', attention: 'Les prix sont fiables, avec quelques points à vérifier', blocked: 'Un problème empêche de remplir le panier' } as const;
  const blockingProductName = firstBlocking?.productId ? productNameById.get(firstBlocking.productId) : undefined;
  const acknowledgeableItemId =
    firstBlocking && ACKNOWLEDGEABLE_ISSUE_CODES.has(firstBlocking.code) ? firstBlocking.itemId : undefined;
  return (
    <div className="settingsPanel" aria-label="Niveau de confiance du calcul">
      <div>
        <h3>{labels[report.status]}</h3>
        <p>
          {report.status === 'blocked'
            ? `${countOf(report.blockingIssueCount, 'problème', 'problèmes')} à régler. Les totaux ci-dessous sont seulement une estimation : règle d’abord le problème indiqué pour obtenir un conseil et remplir ton panier.`
            : `Prix sûr pour ${report.summary.trustedDecisionCount} produit${report.summary.trustedDecisionCount > 1 ? 's' : ''} sur ${report.summary.itemCount} ; ${countOf(report.warningIssueCount, 'point', 'points')} à vérifier.`}
        </p>
        {firstBlocking && (
          <p className="panelText panelTextDanger">
            À régler en premier : {blockingProductName ? `${blockingProductName} — ` : ''}
            {firstBlocking.message}
          </p>
        )}
      </div>
      {firstBlocking?.action === 'refresh_prices' && (
        <div className="cardActions"><button className="primaryButton" type="button" onClick={onRefresh}>Actualiser les prix manquants</button></div>
      )}
      {acknowledgeableItemId && (
        <div className="cardActions">
          <button className="primaryButton" type="button" onClick={() => onAcknowledgeWarnings(acknowledgeableItemId)}>
            J’ai vérifié ce produit sur le site du magasin
          </button>
          <p className="panelText">
            Le message restera affiché, mais il ne t’empêchera plus de remplir ce panier.
          </p>
        </div>
      )}
      {firstBlocking && firstBlocking.action !== 'refresh_prices' && !acknowledgeableItemId && (
        <div className="cardActions"><a className="buttonLink" href="#products-to-validate">Corriger le premier produit</a></div>
      )}
      {report.issues.length > 0 && (
        <details><summary>Voir tous les points à vérifier ({report.issues.length})</summary>
          <ul className="warningList">
            {report.issues.map((issue: TrustIssue) => {
              // Sans le nom du produit, « Le format doit être confirmé. »
              // répété trois fois ne permettait pas de savoir quoi vérifier.
              const name = issue.productId ? productNameById.get(issue.productId) : undefined;
              return (
                <li key={issue.id}>
                  {issue.severity === 'blocking' ? 'À régler — ' : 'À vérifier — '}
                  {name ? <strong>{name} : </strong> : null}
                  {issue.message}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

const STORE_NAMES: Record<StoreKey, string> = { leclerc: 'Leclerc', hyperu: 'Hyper U' };

// Résumé des lignes dont le paquet n'a pas le format de la liste, ou dont les
// deux magasins vendent des formats différents. Affiché AVANT le conseil et
// le bouton « Tout acheter chez… » : les totaux comptent le prix du paquet
// réellement acheté, et un 3 L à la place d'un 1 L se voit ici, pas
// seulement en dépliant chaque ligne (cas réel du 16/11).
export function FormatNoticesPanel({
  notices,
  productNameById
}: {
  notices: FormatNotice[];
  productNameById: Map<string, string>;
}) {
  if (notices.length === 0) return null;
  return (
    <div className="settingsPanel formatNoticesPanel" aria-label="Produits dont le format diffère">
      <div>
        <h3>
          {notices.length === 1
            ? '1 produit n’a pas le même format partout'
            : `${notices.length} produits n’ont pas le même format partout`}
        </h3>
        <p>
          Les totaux comptent le prix du paquet réellement vendu. Quand les formats diffèrent entre les magasins, le
          moins cher est choisi au kilo ou au litre. Vérifie que ces quantités te conviennent.
        </p>
      </div>
      <ul className="formatNoticeList">
        {notices.map((notice) => (
          <li key={notice.itemId}>
            <strong>{productNameById.get(notice.productId) ?? 'Produit inconnu'}</strong>
            <span>
              {[
                notice.requested ? `Ta liste : ${notice.requested}` : null,
                ...(['leclerc', 'hyperu'] as StoreKey[]).map((storeKey) => {
                  const format = notice.byStore[storeKey];
                  if (!format) return null;
                  const selected = notice.selectedStoreKey === storeKey ? ' (retenu)' : '';
                  return `${STORE_NAMES[storeKey]} : ${format}${selected}`;
                })
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </li>
        ))}
      </ul>
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
      <summary>Voir le prix de chaque produit chez {storeLabel}</summary>
      {sortedLines.length === 0 ? (
        <p className="panelText">Ta liste de courses est vide.</p>
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
