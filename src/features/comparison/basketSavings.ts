import { type StoreKey } from '../../types/domain';
import { type ComparisonDecision, type ComparisonResult } from './comparisonEngine';
import { roundMoney } from './unitNormalization';

const STORE_KEYS: StoreKey[] = ['leclerc', 'hyperu'];

type SavingsInput = Pick<ComparisonResult, 'totals' | 'coverage' | 'excludedLines'>;

/**
 * Magasin de référence : celui où toute la liste coûterait le moins cher en
 * un seul passage. C'est la même définition que celle du moteur
 * (chooseBestSingleStore) — un magasin qui ne couvre pas toute la liste n'est
 * pas une référence, son total porte sur moins de produits.
 */
export function findReferenceStore(result: SavingsInput): StoreKey | null {
  const comparableItemCount = result.coverage.leclerc.total - result.excludedLines.length;
  const complete = STORE_KEYS.filter(
    (storeKey) => result.totals[storeKey] !== null && result.coverage[storeKey].covered >= comparableItemCount
  );
  if (complete.length === 0) return null;
  return complete.sort((left, right) => (result.totals[left] ?? 0) - (result.totals[right] ?? 0))[0];
}

/**
 * Économie d'un panier validé, mesurée contre le magasin de référence :
 * pour chaque ligne, ce qu'elle aurait coûté là-bas moins ce qu'elle coûte
 * ici.
 *
 * L'ancienne formule comparait chaque ligne à l'autre magasin et ne gardait
 * que les écarts favorables. Deux paniers validés (un par magasin) cumulaient
 * alors plus que l'économie affichée sur la page de comparaison : avec un
 * produit moins cher de 1 € dans chaque magasin, l'accueil affichait 2 €
 * d'économie alors que partager le panier n'en rapporte que 1. Avec cette
 * formule, la somme des deux paniers vaut exactement « total du meilleur
 * magasin seul − total réparti », le chiffre montré à l'écran.
 *
 * Renvoie 0 quand aucun magasin ne couvre toute la liste : il n'existe alors
 * pas de point de comparaison honnête.
 */
export function computeBasketSavings(result: SavingsInput, decisions: ComparisonDecision[]): number {
  const reference = findReferenceStore(result);
  if (!reference) return 0;

  const referencePriceByItemId = new Map(
    result.coverage[reference].lines
      .filter((line) => line.status === 'priced' && line.price !== undefined)
      .map((line) => [line.itemId, line.price as number])
  );

  let savings = 0;
  for (const decision of decisions) {
    if (decision.price === undefined) continue;
    const referencePrice = referencePriceByItemId.get(decision.itemId);
    if (referencePrice === undefined) continue;
    savings += referencePrice - decision.price;
  }
  return roundMoney(savings);
}
