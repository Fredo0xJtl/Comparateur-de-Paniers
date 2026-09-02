import { type ComparisonUnit, type ProductBaseUnit } from '../../types/domain';
import { normalizeToComparableFormat, roundMoney } from './unitNormalization';

// Base de comparaison "au kilo / au litre" pour un candidat.
//
// Pourquoi ce module existe : deux magasins ne vendent presque jamais le même
// produit dans le même conditionnement (cas réel du 31/08 : purée Mousline
// 375 g chez Leclerc, 1 040 g chez Hyper U). Comparer les deux prix affichés
// revient alors à comparer un petit paquet à un grand — le comparateur
// désignait Leclerc « moins cher » (2,56 € contre 4,56 €) alors qu'au kilo
// c'est l'inverse (6,83 €/kg contre 4,39 €/kg). Le prix au kilo/litre est la
// seule base commune, et il est affiché par les deux enseignes.
//
// Limite assumée, formulée par l'utilisateur lui-même : ça ne vaut que si
// c'est bien le MÊME produit (même marque, même goût, même recette) vendu
// dans une autre quantité. Ce module ne tranche donc pas cette question — il
// se contente de fournir la base de comparaison ; c'est l'appelant
// (comparisonEngine) qui n'y recourt que pour des candidats assez sûrs pour
// être sélectionnés automatiquement.
export type UnitPriceBasis = {
  unitPriceEuro: number;
  comparisonUnit: 'liter' | 'kilogram';
  // 'displayed' = prix au kilo/litre lu directement sur la fiche marchande
  // (fait par le magasin, arrondi compris) ; 'computed' = déduit du prix et
  // du format observé quand la fiche ne l'affiche pas.
  source: 'displayed' | 'computed';
};

export type UnitPriceBasisInput = {
  priceEuro?: number;
  unitPriceEuro?: number;
  comparisonUnit?: ComparisonUnit;
  quantity?: number;
  unit?: ProductBaseUnit;
};

export function resolveUnitPriceBasis(input: UnitPriceBasisInput): UnitPriceBasis | null {
  // Le prix affiché par le magasin prime : c'est sa propre référence légale
  // d'étiquetage, elle n'introduit aucune erreur de lecture de format.
  if (
    typeof input.unitPriceEuro === 'number' &&
    Number.isFinite(input.unitPriceEuro) &&
    input.unitPriceEuro > 0 &&
    (input.comparisonUnit === 'liter' || input.comparisonUnit === 'kilogram')
  ) {
    return {
      unitPriceEuro: input.unitPriceEuro,
      comparisonUnit: input.comparisonUnit,
      source: 'displayed'
    };
  }

  const format = normalizeToComparableFormat(input.quantity, input.unit);
  if (!format) return null;
  if (typeof input.priceEuro !== 'number' || !Number.isFinite(input.priceEuro) || input.priceEuro <= 0) {
    return null;
  }
  // normalizeToComparableFormat rend toujours des g ou des ml : on repasse au
  // kilo / au litre, l'unité sous laquelle les deux enseignes affichent.
  const quantityInBigUnit = format.quantity / 1000;
  if (quantityInBigUnit <= 0) return null;
  return {
    unitPriceEuro: roundMoney(input.priceEuro / quantityInBigUnit),
    comparisonUnit: format.unit === 'g' ? 'kilogram' : 'liter',
    source: 'computed'
  };
}

// Deux bases ne sont comparables que dans la même dimension : un prix au kilo
// ne se compare pas à un prix au litre (un poids face à un volume est le signe
// d'une extraction ratée, pas d'un vrai écart de prix).
export function unitPriceBasesComparable(
  left: UnitPriceBasis | null,
  right: UnitPriceBasis | null
): boolean {
  return Boolean(left && right && left.comparisonUnit === right.comparisonUnit);
}

export function isUnitPriceBasisReliable(
  basis: UnitPriceBasis | null,
  formatKnown: boolean,
  priceCoherence: 'ok' | 'mismatch' | 'unknown' | undefined
): boolean {
  if (!basis || priceCoherence === 'mismatch') return false;
  return basis.source === 'displayed' || formatKnown;
}

// Écart minimal (2 %) en dessous duquel les deux prix au kilo sont tenus pour
// équivalents : le prix au kilo affiché est arrondi au centime, et deux
// formats du même produit tombent souvent à quelques centimes près. Sous ce
// seuil, mieux vaut laisser la règle habituelle (le paquet le moins cher)
// trancher plutôt que d'imposer le gros conditionnement pour un écart qui
// tient à l'arrondi.
export const UNIT_PRICE_SIGNIFICANT_GAP_RATIO = 0.02;

export function unitPriceGapIsSignificant(left: UnitPriceBasis, right: UnitPriceBasis): boolean {
  const smallest = Math.min(left.unitPriceEuro, right.unitPriceEuro);
  if (smallest <= 0) return false;
  return Math.abs(left.unitPriceEuro - right.unitPriceEuro) > smallest * UNIT_PRICE_SIGNIFICANT_GAP_RATIO;
}

export function formatUnitPriceLabel(basis: UnitPriceBasis): string {
  return `${basis.unitPriceEuro.toFixed(2)} €/${basis.comparisonUnit === 'liter' ? 'L' : 'kg'}`;
}
