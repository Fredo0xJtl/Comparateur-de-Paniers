import { type ProductBaseUnit } from '../../types/domain';
import { normalizeToComparableFormat } from './unitNormalization';

// Unité de référence d'un prix au litre/kilo tel qu'affiché par un site
// marchand ("3,52 €/l", "16,14 €/kg"). Volontairement limité à L et kg : ce
// sont les deux seules unités de référence réellement utilisées par Leclerc
// et Hyper U, et les seules pour lesquelles la vérification ci-dessous a un
// sens (un "€/pièce" ne dit rien du grammage).
export type UnitPriceUnit = 'L' | 'kg';

// - 'ok'       : le prix de l'article est cohérent avec le prix au litre/kilo
//                affiché juste à côté sur la même page.
// - 'mismatch' : les deux ne concordent pas — l'un des deux a été mal extrait.
// - 'unknown'  : pas assez d'éléments pour trancher (c'est le cas le plus
//                fréquent, et il doit rester totalement silencieux).
export type PriceCoherence = 'ok' | 'mismatch' | 'unknown';

export type PriceCoherenceInput = {
  priceEuro: number;
  unitPriceEuro?: number;
  unitPriceUnit?: UnitPriceUnit;
  // Format observé sur la fiche du candidat, à l'échelle "petite" (g/ml) —
  // même convention que extension/shared/quantity-parser.js.
  observedQuantity?: number;
  observedUnit?: ProductBaseUnit;
};

// Un prix au litre/kilo est affiché arrondi au centime : la valeur réelle est
// donc à ±0,005 € de celle qu'on lit. Sur un prix unitaire élevé cet arrondi
// est négligeable (0,005 / 16,14 = 0,03 %), mais sur un prix unitaire faible
// il devient énorme en relatif (0,005 / 0,10 = 5 %). Sans ce plancher, tous
// les produits bon marché au litre — eau, lait, boissons en gros formats —
// déclencheraient un faux avertissement en série alors que leur prix est
// parfaitement correct.
const BASE_TOLERANCE_RATIO = 0.05;
const DISPLAY_ROUNDING_EURO = 0.005;

// Vérifie que le prix de l'article et le prix au litre/kilo affichés sur la
// MÊME page racontent la même histoire :
//
//     prix_total ÷ quantité  ≈  prix_au_litre_affiché
//
// L'intérêt de ce contrôle est qu'il ne dépend d'AUCUN sélecteur CSS : il
// compare deux valeurs extraites indépendamment l'une de l'autre. Si le
// collecteur s'est trompé d'élément (prix au litre pris pour le prix total,
// prix d'un produit voisin dans un carrousel de substituts — deux régressions
// réellement survenues, voir docs/REVUE_ARCHITECTURE.md), l'égalité ne tombe
// plus. C'est donc le seul contrôle du projet qui survive à une refonte du
// site marchand.
//
// Ne renvoie JAMAIS 'mismatch' sur un doute : toute donnée manquante,
// inexploitable ou de nature incompatible donne 'unknown'. Un faux
// avertissement coûte plus cher qu'un contrôle silencieux, puisqu'il pousse
// l'utilisateur à ignorer les avertissements suivants.
export function checkPriceCoherence(input: PriceCoherenceInput): PriceCoherence {
  const { priceEuro, unitPriceEuro, unitPriceUnit } = input;

  if (!Number.isFinite(priceEuro) || priceEuro <= 0) return 'unknown';
  if (unitPriceEuro === undefined || !Number.isFinite(unitPriceEuro) || unitPriceEuro <= 0) {
    return 'unknown';
  }
  if (unitPriceUnit !== 'L' && unitPriceUnit !== 'kg') return 'unknown';

  // Réutilise la normalisation déjà en place (g pour le poids, ml pour le
  // volume) : elle écarte au passage `unit: 'unit'`, les quantités absurdes
  // et les unités non reconnues.
  const format = normalizeToComparableFormat(input.observedQuantity, input.observedUnit);
  if (!format) return 'unknown';

  // Un poids ne se vérifie pas contre un prix au litre, et inversement. Ce
  // croisement signale une extraction douteuse d'un côté ou de l'autre, pas
  // un écart de prix — on se tait plutôt que d'accuser à tort.
  const expectsVolume = unitPriceUnit === 'L';
  if (expectsVolume !== (format.unit === 'ml')) return 'unknown';

  // format.quantity est en g ou ml ; le prix de référence est au kg ou au L.
  const quantityInReferenceUnit = format.quantity / 1000;
  if (quantityInReferenceUnit <= 0) return 'unknown';

  const expectedUnitPrice = priceEuro / quantityInReferenceUnit;
  const tolerance = Math.max(BASE_TOLERANCE_RATIO, DISPLAY_ROUNDING_EURO / unitPriceEuro);
  const deviation = Math.abs(expectedUnitPrice - unitPriceEuro) / unitPriceEuro;

  return deviation <= tolerance ? 'ok' : 'mismatch';
}
