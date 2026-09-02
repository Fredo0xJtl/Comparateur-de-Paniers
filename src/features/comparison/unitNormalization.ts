import { type ComparisonUnit, type ProductBaseUnit } from '../../types/domain';

export type NormalizedFormat = { quantity: number; unit: 'g' | 'ml' };

// Normalise un format observé (quantity/unit d'un ProductCandidate, ex.
// {quantity: 1, unit: 'kg'}) vers l'unité "petite" (g pour le poids, ml pour
// le volume) — jamais kg/L — pour comparer deux formats extraits séparément
// par simple soustraction numérique. Même échelle que
// extension/shared/quantity-parser.js (normalizeQuantity) et
// src/features/scan/openFoodFactsClient.ts (parseOffQuantity), pour que le
// format cible OFF, le format observé par les collecteurs et cette
// comparaison finale parlent tous la même unité. `unit: 'unit'` (compté à la
// pièce, pas de grammage) n'est pas comparable numériquement → null.
export function normalizeToComparableFormat(
  quantity: number | undefined,
  unit: ProductBaseUnit | undefined
): NormalizedFormat | null {
  if (quantity === undefined || !Number.isFinite(quantity) || quantity <= 0 || !unit) return null;
  if (unit === 'g') return { quantity, unit: 'g' };
  if (unit === 'kg') return { quantity: quantity * 1000, unit: 'g' };
  if (unit === 'ml') return { quantity, unit: 'ml' };
  if (unit === 'L') return { quantity: quantity * 1000, unit: 'ml' };
  return null;
}

// Vrai seulement si les deux formats sont connus, dans la MÊME unité de base
// (un poids ne se compare jamais à un volume — signe probable d'une
// extraction ratée plutôt que d'un vrai écart, donc pas de faux avertissement
// dans ce cas), et diffèrent de plus de `toleranceRatio` (5% par défaut,
// absorbe les petits écarts d'arrondi entre la fiche OFF et le site
// marchand — ex. "1 kg" affiché arrondi vs 1040 g exact).
export function formatsDiffer(
  a: NormalizedFormat | null,
  b: NormalizedFormat | null,
  toleranceRatio = 0.05
): boolean {
  if (!a || !b || a.unit !== b.unit) return false;
  const diff = Math.abs(a.quantity - b.quantity);
  return diff > a.quantity * toleranceRatio;
}

export type UnitPriceInput = {
  price: number;
  quantity: number;
  unit: ProductBaseUnit;
  comparisonUnit: ComparisonUnit;
};

export type LineTotalInput = {
  unitPrice: number;
  wantedQuantity: number;
};

export function calculateUnitPrice(input: UnitPriceInput) {
  const normalizedQuantity = normalizeQuantity(input.quantity, input.unit, input.comparisonUnit);
  if (normalizedQuantity <= 0) {
    return null;
  }

  return roundMoney(input.price / normalizedQuantity);
}

export function calculateLineTotal(input: LineTotalInput) {
  return roundMoney(input.unitPrice * input.wantedQuantity);
}

export function normalizeQuantity(
  quantity: number,
  unit: ProductBaseUnit,
  comparisonUnit: ComparisonUnit
) {
  if (comparisonUnit === 'liter') {
    if (unit === 'L') {
      return quantity;
    }
    if (unit === 'ml') {
      return quantity / 1000;
    }
  }

  if (comparisonUnit === 'kilogram') {
    if (unit === 'kg') {
      return quantity;
    }
    if (unit === 'g') {
      return quantity / 1000;
    }
  }

  return quantity;
}

export function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
