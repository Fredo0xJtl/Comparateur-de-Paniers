import { type ComparisonDecision } from '../../features/comparison/comparisonEngine';
import { type ProductCandidate, type StoreKey } from '../../types/domain';
import { type CartFillResultLine } from '../../features/drive-bridge/cartFillService';
import { buildCalculationProof } from '../../features/comparison/calculationProof';

function normalizeMatchName(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Ce que le comparatif avait retenu pour chaque produit, indexé par productId.
// Extrait de downloadCartFillDiagnostic (02/09) pour que l'ÉCRAN et le fichier
// de diagnostic partagent exactement la même définition de « ce qui était
// attendu » — sans quoi les deux pourraient diverger silencieusement.
export function buildExpectedByProductId(
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

export function downloadCartFillDiagnostic(
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
    // v4 (04/09) : ajoute requestedQuantity/finalQuantity/quantityConfirmed
    // et directUrlAttempt à chaque ligne (voir CartFillResultLine).
    formatVersion: 4,
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

export function downloadCalculationProof(payload: ReturnType<typeof buildCalculationProof>) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `preuve-calcul-panier-${Date.now()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
