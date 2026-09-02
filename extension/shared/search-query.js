// Nettoyage générique, partagé entre magasins, des noms de produits issus
// d'Open Food Facts avant de les envoyer en texte de recherche sur un site
// de drive. Les noms OFF sont crowdsourcés et embarquent souvent du bruit
// d'emballage/nutrition (poids, conditionnement, taux de matière
// grasse/sel/sucre, marque déjà répétée dans le nom...) qui ne matche pas
// l'index de recherche des sites marchands et qui rallonge la requête pour
// rien — signalé par l'utilisateur sur un cas réel ("Emmental râpé" +
// marque "Président", mais un nom Open Food Facts du type "Emmental râpé
// fondant PRESIDENT - 30% de matière grasse - 200g").
//
// Fonctions pures, testées isolément, jamais utilisées pour le
// scoring/matching — seulement pour construire le texte tapé dans la barre
// de recherche du magasin. Utilisées par les DEUX collecteurs (Leclerc,
// Hyper U) ; chaque collecteur reste libre d'ajouter ses propres règles
// spécifiques par-dessus (ex: le retrait du '%' chez Leclerc, qui casse leur
// recherche pour une raison propre à leur site — voir
// sanitizeLeclercSearchText).
export function stripPackagingNoiseFromSearchName(name) {
  const cleaned = String(name || '')
    .replace(/\b\d+\s*x\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|cl|l)\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:g|kg|ml|cl|l)\b/gi, ' ')
    // Toute mention nutritionnelle "N% ..." — pas seulement l'abréviation
    // "MG" : les noms Open Food Facts varient énormément selon le
    // contributeur ("30% MG", "30% de matière grasse", "sel 1,2%", "0%
    // sucres"...).
    .replace(/\b\d+(?:[.,]\d+)?\s*%\s*(?:de\s+)?(?:m\.?g\.?|mati[eè]res?\s+grasses?|graisses?|sels?|sucres?|prot[eé]ines?)\b/gi, ' ')
    .replace(/\ben\s+sachet\b/gi, ' ')
    .replace(/\bpour\s+\d+\s+personnes?\b/gi, ' ')
    .replace(/\b\d+\s+personnes?\b/gi, ' ')
    // Multiplicateur isolé restant ("5x") une fois la phrase poids/portion
    // qui l'entourait déjà retirée ci-dessus.
    .replace(/\b\d+\s*x\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // Un segment délimité par " - " (convention Open Food Facts courante :
  // "Nom - descripteur - Marque - poids") peut se retrouver entièrement vide
  // une fois son contenu retiré par les remplacements ci-dessus — sans ce
  // passage final, le tiret orphelin reste dans la requête ("PRESIDENT -").
  return cleaned
    .split(/\s-\s/)
    .map((segment) => segment.trim())
    // Un segment vide, ou réduit à un tiret orphelin (cas d'un nom à 3+
    // segments dont deux consécutifs sont vidés par les remplacements
    // ci-dessus, ex: "PRESIDENT - 30% de matière grasse - 200g"), ne doit
    // laisser aucune trace dans le résultat final.
    .filter((segment) => segment && !/^-+$/.test(segment))
    .join(' - ');
}

// Si le nom du produit contient déjà la marque telle quelle (fréquent avec
// Open Food Facts, ex: nom "Emmental râpé fondant PRESIDENT" + marque
// "Président"), l'ajouter une seconde fois à la requête de recherche est
// inutile et rallonge le texte pour rien. Comparaison insensible à la casse
// et aux accents, sur un mot entier — jamais utilisée pour le scoring, qui
// continue de comparer contre la marque ORIGINALE.
export function dedupeBrandFromSearchName(name, brand) {
  const trimmedBrand = String(brand ?? '').trim();
  if (!trimmedBrand) return trimmedBrand;
  const stripDiacritics = (value) => value.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const escaped = stripDiacritics(trimmedBrand).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alreadyPresent = new RegExp(`\\b${escaped}\\b`, 'i').test(stripDiacritics(String(name ?? '')));
  return alreadyPresent ? '' : trimmedBrand;
}
