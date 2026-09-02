import { db } from '../../db/db';
import {
  type ComparisonUnit,
  type Product,
  type ProductBaseUnit
} from '../../types/domain';

export const comparisonUnitOptions: ComparisonUnit[] = [
  'unit',
  'liter',
  'kilogram',
  'wash',
  'roll',
  'capsule'
];

export type ProductFormValues = {
  name: string;
  brand: string;
  barcode: string;
  category: string;
  variant: string;
  comparisonUnit: string;
  allowDifferentFormat: boolean;
  allowPrivateLabel: boolean;
};

export type ProductFormErrors = Partial<Record<keyof ProductFormValues, string>>;

export const emptyProductForm: ProductFormValues = {
  name: '',
  brand: '',
  barcode: '',
  category: 'epicerie_seche',
  variant: '',
  comparisonUnit: 'unit',
  allowDifferentFormat: true,
  allowPrivateLabel: true
};

export function productToForm(product: Product): ProductFormValues {
  return {
    name: product.name,
    brand: product.brand ?? '',
    barcode: product.barcode ?? '',
    category: product.category ?? '',
    variant: product.variant ?? '',
    comparisonUnit: product.comparisonUnit,
    allowDifferentFormat: product.allowDifferentFormat,
    allowPrivateLabel: product.allowPrivateLabel
  };
}

export function normalizeProductForm(values: ProductFormValues): ProductFormValues {
  return {
    ...values,
    name: values.name.trim(),
    brand: values.brand.trim(),
    barcode: values.barcode.replace(/\D/g, ''),
    category: values.category.trim(),
    variant: values.variant.trim(),
    comparisonUnit: values.comparisonUnit.trim()
  };
}

export function validateProductForm(values: ProductFormValues) {
  const normalized = normalizeProductForm(values);
  const errors: ProductFormErrors = {};

  if (!normalized.name) {
    errors.name = 'Nom obligatoire';
  }

  if (!isComparisonUnit(normalized.comparisonUnit)) {
    errors.comparisonUnit = 'Unité de comparaison invalide';
  }

  if (normalized.barcode && (normalized.barcode.length < 8 || normalized.barcode.length > 14)) {
    errors.barcode = 'Code-barres invalide';
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
    normalized
  };
}

// `offFormat` : format cible (quantité + unité) remonté par Open Food Facts
// au moment du scan (voir openFoodFactsClient.parseOffQuantity) — jamais
// saisi par l'utilisateur, aucun champ de formulaire ne l'expose. Quand
// connu, il remplace le baseUnit générique déduit de comparisonUnit et fixe
// baseQuantity (sinon toujours vide) : les collecteurs Leclerc/Hyper U s'en
// servent ensuite pour privilégier le même conditionnement dans les deux
// magasins plutôt que d'accepter n'importe quel format de la marque.
export async function createProduct(
  values: ProductFormValues,
  offFormat?: { baseQuantity?: number; baseUnit?: ProductBaseUnit }
) {
  const parsed = validateProductForm(values);
  if (!parsed.isValid || !isComparisonUnit(parsed.normalized.comparisonUnit)) {
    return parsed;
  }

  const now = new Date().toISOString();
  const product: Product = {
    id: createProductId(),
    name: parsed.normalized.name,
    brand: optional(parsed.normalized.brand),
    barcode: optional(parsed.normalized.barcode),
    category: optional(parsed.normalized.category),
    variant: optional(parsed.normalized.variant),
    comparisonUnit: parsed.normalized.comparisonUnit,
    baseUnit: offFormat?.baseUnit ?? inferBaseUnit(parsed.normalized.comparisonUnit),
    ...(offFormat?.baseQuantity !== undefined ? { baseQuantity: offFormat.baseQuantity } : {}),
    allowDifferentFormat: parsed.normalized.allowDifferentFormat,
    allowPrivateLabel: parsed.normalized.allowPrivateLabel,
    createdAt: now,
    updatedAt: now
  };

  await db.products.add(product);
  return parsed;
}

export async function updateProduct(product: Product, values: ProductFormValues) {
  const parsed = validateProductForm(values);
  if (!parsed.isValid || !isComparisonUnit(parsed.normalized.comparisonUnit)) {
    return parsed;
  }

  await db.products.put({
    ...product,
    name: parsed.normalized.name,
    brand: optional(parsed.normalized.brand),
    barcode: optional(parsed.normalized.barcode),
    category: optional(parsed.normalized.category),
    variant: optional(parsed.normalized.variant),
    comparisonUnit: parsed.normalized.comparisonUnit,
    baseUnit: inferBaseUnit(parsed.normalized.comparisonUnit),
    allowDifferentFormat: parsed.normalized.allowDifferentFormat,
    allowPrivateLabel: parsed.normalized.allowPrivateLabel,
    updatedAt: new Date().toISOString()
  });

  return parsed;
}

export async function deleteProduct(productId: string) {
  // Bug réel confirmé le 01/09 (export de sauvegarde bloqué en prod par une
  // "référence orpheline dans productCandidates") : cette fonction ne
  // supprimait que la ligne `products`, jamais les candidats/prix/articles de
  // liste qui la référencent. Chaque suppression de produit laissait donc des
  // lignes orphelines s'accumuler silencieusement dans IndexedDB. Cascade
  // manuelle car Dexie ne gère pas les clés étrangères nativement.
  const candidateIds = await db.productCandidates.where('productId').equals(productId).primaryKeys();
  await db.transaction('rw', db.products, db.productCandidates, db.priceSnapshots, db.shoppingListItems, async () => {
    await db.priceSnapshots.where('candidateId').anyOf(candidateIds).delete();
    await db.productCandidates.where('productId').equals(productId).delete();
    await db.shoppingListItems.where('productId').equals(productId).delete();
    await db.products.delete(productId);
  });
}

export async function markProductUsed(product: Product) {
  await db.products.update(product.id, {
    lastUsedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function isComparisonUnit(value: string): value is ComparisonUnit {
  return comparisonUnitOptions.includes(value as ComparisonUnit);
}

function optional(value: string) {
  return value.length > 0 ? value : undefined;
}

function inferBaseUnit(unit: ComparisonUnit): ProductBaseUnit | undefined {
  if (unit === 'liter') {
    return 'L';
  }
  if (unit === 'kilogram') {
    return 'kg';
  }
  if (unit === 'unit' || unit === 'wash' || unit === 'roll' || unit === 'capsule') {
    return 'unit';
  }
  return undefined;
}

function createProductId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `prod-${crypto.randomUUID()}`;
  }

  return `prod-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
