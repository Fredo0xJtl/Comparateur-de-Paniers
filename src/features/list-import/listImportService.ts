import { db } from '../../db/db';
import { type DriveImportedItemV1 } from '../drive-bridge/driveProtocol';
import { createProduct } from '../products/productService';
import {
  addProductToActiveList,
  getActiveShoppingListWithItems,
  updateShoppingListItemQuantity
} from '../shopping-list/shoppingListService';
import { type ComparisonUnit, type Product } from '../../types/domain';

// Rapprochement d'un produit lu sur le compte du magasin avec le catalogue
// local, et application de l'import une fois l'utilisateur d'accord.
//
// Décision de conception (voir docs/RAPPORT_PASSATION_IMPORT_LISTES.md §13) :
// rien n'est écrit sans validation. Le rapprochement par nom côté Leclerc
// n'est pas fiable — pas d'EAN sur ces pages — et une fiche produit existante
// porte des réglages que l'utilisateur a choisis (unité de comparaison,
// tolérance de format, acceptation des marques distributeur) qu'un import
// automatique écraserait sans qu'il le sache.

export type ImportMatchKind =
  // Code-barres identique : le produit est le même, sans ambiguïté.
  | 'barcode'
  // Nom + marque normalisés identiques : très probable, mais pas certain —
  // c'est le seul rapprochement possible côté Leclerc.
  | 'name'
  // Rien de comparable dans le catalogue local.
  | 'none';

export type ImportCandidate = {
  item: DriveImportedItemV1;
  existingProduct?: Product;
  matchKind: ImportMatchKind;
  // Coché par défaut sauf doublon : l'utilisateur peut toujours changer d'avis
  // dans les deux sens.
  selected: boolean;
};

export type ImportOutcome = {
  createdProducts: number;
  addedToList: number;
  // Produits déjà connus que l'utilisateur a quand même choisi d'ajouter à sa
  // liste de courses : aucune fiche créée, juste une ligne de liste.
  reusedProducts: number;
  failed: Array<{ name: string; reason: string }>;
};

const PACKAGING_NOISE =
  /\b(?:lot|pack|paquet|barquette|bouteille|brique|boite|boîte|sachet|pot|flacon|x\d+|\d+x)\b/gi;

// Format de lot (« 6x1L », « 2 x 500 g ») retiré AVANT les formats simples :
// sinon « 6x1L » perdait d'abord son « 1L », laissait un « 6x » orphelin que
// plus aucune règle ne reconnaissait, et le produit ne se rapprochait plus de
// la même référence écrite sans son conditionnement.
const MULTIPACK_FORMAT = /\d+(?:[,.]\d+)?\s*x\s*\d+(?:[,.]\d+)?\s*(?:l|cl|ml|kg|g|cc)?\b/gi;
const SIMPLE_FORMAT = /\d+(?:[,.]\d+)?\s*(?:l|cl|ml|kg|g|cc|pieces?|pcs?)\b/gi;

/**
 * Réduit un nom de produit à une forme comparable : minuscules, sans accents,
 * sans ponctuation, sans mentions de conditionnement ni quantités.
 *
 * Objectif : rapprocher « Lait demi-écrémé UHT LAIT D'ICI, 6x1L » de « Lait
 * demi écrémé UHT Lait d'Ici » sans pour autant confondre deux produits
 * réellement différents. C'est volontairement conservateur — un faux
 * rapprochement fait disparaître un vrai produit de l'import.
 */
export function normalizeForMatching(value: string): string {
  return value
    .normalize('NFD')
    // Retire les signes diacritiques (accents, cédilles) laissés isolés par la
    // décomposition NFD ci-dessus. `\p{Mn}` (marques non espaçantes) plutôt
    // qu'une plage de caractères combinants écrite littéralement : de tels
    // caractères, isolés dans un fichier source, se recollent au caractère
    // précédent au moindre reformatage — le filtre cesserait alors
    // silencieusement de retirer les accents, donc de reconnaître les doublons.
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(MULTIPACK_FORMAT, ' ')
    .replace(SIMPLE_FORMAT, ' ')
    .replace(PACKAGING_NOISE, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Devine l'unité de comparaison d'un produit importé à partir de son nom.
 *
 * `comparisonUnit` est obligatoire sur une fiche produit, mais les pages de
 * compte ne le donnent jamais. Plutôt que de tout créer en « unité » et de
 * laisser l'utilisateur corriger chaque fiche à la main, on lit le format
 * quand il est écrit dans le nom (« 6x1L », « 900 g »). En cas de doute :
 * 'unit', la valeur par défaut de l'écran d'ajout manuel.
 */
export function inferComparisonUnitFromName(name: string): ComparisonUnit {
  const text = name.toLowerCase();
  // Pas de `\b` en tête : dans « 6x1L » le chiffre est collé au « x » du lot,
  // ce qui n'est pas une frontière de mot — le format passait alors inaperçu
  // et toutes les briques de lait étaient créées en « unité ».
  if (/\d+(?:[,.]\d+)?\s*(?:l|cl|ml)\b/.test(text)) return 'liter';
  if (/\d+(?:[,.]\d+)?\s*(?:kg|g)\b/.test(text)) return 'kilogram';
  if (/\b\d+\s*(?:capsules?|dosettes?)\b/.test(text)) return 'capsule';
  if (/\b\d+\s*(?:lavages?)\b/.test(text)) return 'wash';
  if (/\b\d+\s*(?:rouleaux?)\b/.test(text)) return 'roll';
  return 'unit';
}

/**
 * Rapproche chaque produit lu du catalogue local et pré-décoche les doublons.
 *
 * Deux produits importés peuvent se rapporter à la même fiche locale : le
 * second est alors traité comme un doublon lui aussi, sinon l'import créerait
 * deux fiches pour un produit déjà connu.
 */
export function matchImportedItems(
  items: DriveImportedItemV1[],
  existingProducts: Product[]
): ImportCandidate[] {
  const byBarcode = new Map<string, Product>();
  const byName = new Map<string, Product>();
  for (const product of existingProducts) {
    if (product.barcode) byBarcode.set(product.barcode, product);
    const key = normalizeForMatching(`${product.name} ${product.brand ?? ''}`);
    if (key && !byName.has(key)) byName.set(key, product);
  }

  return items.map((item) => {
    const byBarcodeMatch = item.barcode ? byBarcode.get(item.barcode) : undefined;
    const nameKey = normalizeForMatching(`${item.name} ${item.brand ?? ''}`);
    const byNameMatch = nameKey ? byName.get(nameKey) : undefined;
    const existingProduct = byBarcodeMatch ?? byNameMatch;

    if (!existingProduct) {
      return { item, matchKind: 'none' as const, selected: true };
    }
    return {
      item,
      existingProduct,
      matchKind: byBarcodeMatch ? ('barcode' as const) : ('name' as const),
      selected: false
    };
  });
}

/**
 * Applique l'import : crée les fiches manquantes et ajoute chaque produit
 * retenu à la liste de courses active.
 *
 * Un produit déjà connu et coché par l'utilisateur ne crée AUCUNE fiche — il
 * réutilise l'existante, dont les réglages restent intacts.
 */
export async function applyListImport(candidates: ImportCandidate[]): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { createdProducts: 0, addedToList: 0, reusedProducts: 0, failed: [] };
  // productId -> quantité souhaitée demandée par l'import. Les quantités sont
  // appliquées après coup, en une seule relecture de la liste : la fonction
  // d'ajout partagée (addProductToActiveList) crée toujours une ligne à 1, et
  // la dupliquer ici pour gagner un aller-retour ferait diverger les deux
  // chemins d'ajout.
  const wantedQuantities = new Map<string, number>();

  for (const candidate of candidates) {
    if (!candidate.selected) continue;

    let productId = candidate.existingProduct?.id;
    if (productId) {
      outcome.reusedProducts += 1;
    } else {
      const created = await createProduct({
        name: candidate.item.name,
        brand: candidate.item.brand ?? '',
        barcode: candidate.item.barcode ?? '',
        category: candidate.item.category ?? '',
        variant: '',
        comparisonUnit: inferComparisonUnitFromName(candidate.item.name),
        // Mêmes valeurs par défaut que l'écran d'ajout manuel : un produit
        // importé n'est pas plus contraint qu'un produit saisi à la main.
        allowDifferentFormat: true,
        allowPrivateLabel: true
      });
      if (!created.isValid || !created.product) {
        outcome.failed.push({
          name: candidate.item.name,
          reason: Object.values(created.errors)[0] ?? 'Fiche produit refusée.'
        });
        continue;
      }
      productId = created.product.id;
      outcome.createdProducts += 1;
    }

    await addProductToActiveList(productId);
    outcome.addedToList += 1;

    const quantity = candidate.item.quantity;
    if (typeof quantity === 'number' && quantity > 1) {
      wantedQuantities.set(productId, Math.min(Math.trunc(quantity), 99));
    }
  }

  if (wantedQuantities.size > 0) {
    const list = await getActiveShoppingListWithItems();
    for (const row of list.rows) {
      const wanted = wantedQuantities.get(row.item.productId);
      if (wanted && wanted !== row.item.wantedQuantity) {
        await updateShoppingListItemQuantity(row.item.id, wanted);
      }
    }
  }

  return outcome;
}

/** Catalogue local complet, pour le rapprochement de l'écran d'import. */
export function loadProductsForMatching(): Promise<Product[]> {
  return db.products.toArray();
}
