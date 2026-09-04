import { db } from '../../db/db';
import { createProduct, deleteProduct, emptyProductForm, markProductUsed } from './productService';
import { addProductToActiveList } from '../shopping-list/shoppingListService';
import { type ComparisonUnit, type Product, type ProductBaseUnit } from '../../types/domain';

export type ObservedStorePick = {
  observedName: string;
  observedQuantity?: number;
  observedUnit?: ProductBaseUnit;
};

// Produit créé à partir des seuls mots tapés dans l'écran d'ajout, quand ni le
// scan ni la base locale n'ont abouti. On ne demande volontairement ni marque,
// ni format, ni unité de comparaison : sur un téléphone, en magasin, un
// formulaire complet est un abandon assuré. Ce qui manque est renseigné juste
// après par `adoptStorePick`, à partir de la fiche que l'utilisateur valide sur
// le site du magasin — une source bien plus fiable que ce qu'il aurait tapé.
//
// Le produit est créé mais PAS ajouté à la liste de courses : la sélection de
// la fiche en magasin, qui suit immédiatement, peut échouer ou être annulée.
// L'ajout à la liste appartient à `confirmProductFromText`, l'abandon à
// `discardProductFromText`. Signalé le 03/09 : un produit tapé à la main
// atterrissait dans la liste avant toute validation, et y restait sans aucune
// fiche magasin — donc sans prix, donc inutile au comparatif.
export async function createProductFromText(text: string): Promise<Product | null> {
  const name = text.trim();
  if (!name) {
    return null;
  }
  const result = await createProduct({ ...emptyProductForm, name });
  if (!result.isValid || !result.product) {
    return null;
  }
  return result.product;
}

// La fiche a bien été validée en magasin : le produit rejoint la liste.
export async function confirmProductFromText(product: Product): Promise<void> {
  await addProductToActiveList(product.id);
  await markProductUsed(product);
}

// Aucune fiche validée (échec, annulation, connecteur indisponible) : le
// produit tout juste créé n'a plus de raison d'être. `deleteProduct` nettoie en
// cascade ses éventuels candidats, prix et articles de liste — un produit sans
// fiche laissé en base ne sert à rien et fait grossir la base à chaque essai.
export async function discardProductFromText(product: Product): Promise<void> {
  await deleteProduct(product.id);
}

// L'utilisateur a validé une fiche sur le site du magasin : le nom du site
// remplace celui qu'il avait tapé. Ce n'est pas cosmétique — le nom du
// catalogue porte le grammage (« Beurre Président demi-sel 250 g »), d'où
// vient le format cible du produit. Sans format, la comparaison au prix au
// kilo entre les deux magasins ne peut pas trancher (voir
// unitPriceArbitration.ts) : un lot de 1 040 g et un paquet de 375 g seraient
// comparés paquet contre paquet, et le moins cher désigné à tort (cas réel du
// 31/08 relevé sur une purée).
//
// Le format arrive déjà normalisé en g/ml par l'extension
// (extension/shared/quantity-parser.js) — même convention que
// parseOffQuantity côté scan, donc aucune reconversion ici.
export async function adoptStorePick(product: Product, pick: ObservedStorePick): Promise<Product> {
  const observedName = pick.observedName.trim();
  const comparisonUnit = comparisonUnitFor(pick.observedUnit) ?? product.comparisonUnit;
  const updated: Product = {
    ...product,
    name: observedName || product.name,
    comparisonUnit,
    ...(pick.observedUnit ? { baseUnit: pick.observedUnit } : {}),
    ...(pick.observedQuantity !== undefined ? { baseQuantity: pick.observedQuantity } : {}),
    updatedAt: new Date().toISOString()
  };
  await db.products.put(updated);
  return updated;
}

// L'unité de comparaison n'est pas le format : c'est ce sur quoi porte la
// comparaison entre magasins. Un produit créé par du texte libre part sur
// 'unit' (défaut du formulaire) ; dès que la fiche annonce un poids ou un
// volume, on corrige — sinon deux formats différents resteraient comparés au
// paquet. Les unités sans équivalent de format (lavage, rouleau, capsule)
// ne sont jamais déduites automatiquement et restent à l'utilisateur.
function comparisonUnitFor(unit: ProductBaseUnit | undefined): ComparisonUnit | undefined {
  if (unit === 'g' || unit === 'kg') {
    return 'kilogram';
  }
  if (unit === 'ml' || unit === 'L') {
    return 'liter';
  }
  return undefined;
}
