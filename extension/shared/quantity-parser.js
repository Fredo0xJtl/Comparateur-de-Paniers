// Extrait un format (quantité + unité) depuis le nom d'un produit affiché
// sur un site marchand — ex. "Purée Mousline nature 4 personnes 1040g" →
// { quantity: 1040, unit: 'g' }. Utilisé par les DEUX collecteurs (Leclerc,
// Hyper U) pour comparer le format d'un candidat au format cible transmis
// par la PWA (job.products[i].baseQuantity/baseUnit, remonté depuis Open
// Food Facts au moment du scan — voir src/features/scan/openFoodFactsClient.ts)
// et pour remonter le format du candidat retenu dans l'observation
// (observedQuantity/observedUnit, extension/shared/drive-protocol.js).
//
// Toujours normalisé vers l'unité "petite" (g pour le poids, ml pour le
// volume) — jamais kg/L — pour que deux formats extraits séparément (ici et
// dans src/features/scan/openFoodFactsClient.ts, qui applique la même
// logique côté PWA) se comparent par une simple soustraction numérique en
// aval, sans reconversion d'unité à chaque usage.
//
// Fonction pure, testée isolément, jamais utilisée pour le scoring de nom
// général (tokenScore/overlap) — seulement pour la comparaison de format.
//
// Contrairement aux fonctions injectées via scripting.executeScript({func}),
// ce module est un import ES normal : les points d'appel prévus (choix du
// meilleur candidat, construction de l'observation) tournent tous côté
// service worker, jamais dans le contexte DOM injecté — pas de contrainte de
// sérialisation ici (voir leclerc-collector.js/courses-u-collector.js).

const UNIT_SCALES = {
  g: { unit: 'g', scale: 1 },
  kg: { unit: 'g', scale: 1000 },
  ml: { unit: 'ml', scale: 1 },
  l: { unit: 'ml', scale: 1000 },
  cl: { unit: 'ml', scale: 10 }
};

// Volontairement limité aux unités de poids/volume comparables entre
// magasins — un motif comme "4 personnes" ne dit rien du grammage réel et
// est ignoré plutôt que de produire un faux repère.
const QUANTITY_MULTIPLIER_PATTERN = /(\d+)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/i;

// Même multiplication, écrite en toutes lettres : "6 briques de 1L",
// "4 pots de 125g". Sans ce motif, seul "1L" était lu et la quantité se
// trouvait divisée par la taille du lot — donc le prix au litre calculé
// multiplié d'autant. Cas relevé en conditions réelles le 31/08 sur
// coursesu.com ("Lait UHT demi écrémé - 6 briques de 1L", lu 1 L au lieu de
// 6 L) : le comparateur en déduisait 5,94 €/L au lieu de 0,99 €/L et
// désignait l'autre magasin comme moins cher alors qu'il l'était moins.
// Détecté par le contrôle croisé prix / prix au litre
// (src/features/comparison/priceCoherence.ts), qui a vu l'incohérence entre
// la quantité lue ici et le prix au litre affiché par le site.
//
// Liste de contenants volontairement fermée, et "de" obligatoire : dans
// "6 tranches 200g" le poids est celui du lot entier, pas d'une tranche.
// Multiplier au jugé y produirait un format six fois trop grand — pire que
// l'absence de format, que le reste du module sait déjà traiter.
const PACK_CONTAINERS =
  'briques?|bouteilles?|pots?|bo[iî]tes?|sachets?|packs?|canettes?|barquettes?|tubes?|flacons?|berlingots?|paquets?|bidons?|conserves?';
const QUANTITY_PACK_PATTERN = new RegExp(
  `(\\d+)\\s*(?:${PACK_CONTAINERS})\\s*(?:de|d')\\s*(\\d+(?:[.,]\\d+)?)\\s*(kg|g|cl|ml|l)\\b`,
  'i'
);

const QUANTITY_SIMPLE_PATTERN = /(\d+(?:[.,]\d+)?)\s*(kg|g|cl|ml|l)\b/i;

// Retourne { quantity, unit } ('g'|'ml') ou null si aucun format n'a pu être
// extrait du texte.
export function parseQuantityFromName(name) {
  const text = String(name || '').toLowerCase();
  if (!text) return null;

  const multiplierMatch = text.match(QUANTITY_MULTIPLIER_PATTERN);
  if (multiplierMatch) {
    const count = Number.parseInt(multiplierMatch[1], 10);
    const unitQuantity = Number.parseFloat(multiplierMatch[2].replace(',', '.'));
    const mapped = UNIT_SCALES[multiplierMatch[3].toLowerCase()];
    if (mapped && Number.isFinite(count) && Number.isFinite(unitQuantity)) {
      return { quantity: count * unitQuantity * mapped.scale, unit: mapped.unit };
    }
  }

  const packMatch = text.match(QUANTITY_PACK_PATTERN);
  if (packMatch) {
    const count = Number.parseInt(packMatch[1], 10);
    const unitQuantity = Number.parseFloat(packMatch[2].replace(',', '.'));
    const mapped = UNIT_SCALES[packMatch[3].toLowerCase()];
    if (mapped && Number.isFinite(count) && count > 0 && Number.isFinite(unitQuantity)) {
      return { quantity: count * unitQuantity * mapped.scale, unit: mapped.unit };
    }
  }

  const simpleMatch = text.match(QUANTITY_SIMPLE_PATTERN);
  if (simpleMatch) {
    const quantity = Number.parseFloat(simpleMatch[1].replace(',', '.'));
    const mapped = UNIT_SCALES[simpleMatch[2].toLowerCase()];
    if (mapped && Number.isFinite(quantity)) {
      return { quantity: quantity * mapped.scale, unit: mapped.unit };
    }
  }

  return null;
}

// Normalise un format déjà séparé (quantity numérique + unit ProductBaseUnit,
// tel que transmis par la PWA dans job.products[i].baseQuantity/baseUnit)
// vers la même échelle g/ml que parseQuantityFromName, pour comparaison
// directe. Retourne null si l'unité n'est pas une unité de poids/volume
// reconnue (ex. 'unit' — pas de format cible comparable dans ce cas).
export function normalizeQuantity(quantity, unit) {
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  const mapped = UNIT_SCALES[String(unit || '').toLowerCase()];
  if (!mapped) return null;
  return { quantity: quantity * mapped.scale, unit: mapped.unit };
}

// Vrai si deux formats normalisés (déjà en g/ml) désignent le même
// conditionnement à une tolérance près (5%, pour absorber les petits écarts
// d'arrondi entre la fiche OFF et le site marchand — ex. 1000g vs 1kg
// affiché "1 kg" arrondi). Les deux formats doivent être dans la même unité
// de base (g vs g, ml vs ml) — un poids ne se compare jamais à un volume.
export function quantitiesMatch(a, b, toleranceRatio = 0.05) {
  if (!a || !b || a.unit !== b.unit) return false;
  const diff = Math.abs(a.quantity - b.quantity);
  return diff <= a.quantity * toleranceRatio;
}
