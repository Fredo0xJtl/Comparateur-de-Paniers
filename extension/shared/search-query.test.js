import { describe, expect, it } from 'vitest';
import { stripPackagingNoiseFromSearchName, dedupeBrandFromSearchName } from './search-query.js';

describe('stripPackagingNoiseFromSearchName', () => {
  it('strips packaging/serving noise Open Food Facts names carry but store search does not match on', () => {
    expect(stripPackagingNoiseFromSearchName('Riz basmati en sachet 5x 2 personnes Lustucru')).toBe(
      'Riz basmati Lustucru'
    );
    expect(stripPackagingNoiseFromSearchName('Torti qualité supérieure 500g Panzani')).toBe(
      'Torti qualité supérieure Panzani'
    );
    expect(stripPackagingNoiseFromSearchName('La Crème Entière De Normandie 30%MG Elle & Vire')).toBe(
      'La Crème Entière De Normandie Elle & Vire'
    );
    expect(stripPackagingNoiseFromSearchName('Mousse au fromage frais sucré aux fruits - 6x74g U')).toBe(
      'Mousse au fromage frais sucré aux fruits - U'
    );
    // No packaging noise to strip: simplification is a no-op.
    expect(stripPackagingNoiseFromSearchName('Boisson végétale saveur amande U')).toBe(
      'Boisson végétale saveur amande U'
    );
  });

  // Cas réel signalé par l'utilisateur (2026-08-29) : "l'emmental râpé de la
  // marque Président" ressort d'Open Food Facts avec du texte nutritionnel
  // écrit en toutes lettres, pas seulement sous forme d'abréviation "MG" —
  // ce que la version précédente de cette fonction ne retirait pas.
  it('strips spelled-out nutritional-content mentions, not just the "MG" abbreviation', () => {
    expect(
      stripPackagingNoiseFromSearchName('Emmental râpé fondant PRESIDENT - 30% de matière grasse - 200g')
    ).toBe('Emmental râpé fondant PRESIDENT');
    expect(stripPackagingNoiseFromSearchName('Yaourt 0% sucres vanille')).toBe('Yaourt vanille');
    expect(stripPackagingNoiseFromSearchName('Camembert 45% de matière grasse Le Rustique')).toBe(
      'Camembert Le Rustique'
    );
  });

  // Convention Open Food Facts inverse ("sel réduit de 30%", mot avant le
  // pourcentage) : cette fonction ne la couvre pas spécifiquement, mais le
  // caractère '%' isolé reste malgré tout retiré côté Leclerc par
  // sanitizeLeclercSearchText (bug réel confirmé 2026-08-28, voir
  // leclerc-collector.test.js) — documenté ici pour ne pas laisser croire que
  // ce cas est couvert par CETTE fonction.
  it('leaves a "word before percent" phrasing mostly untouched (covered elsewhere for Leclerc)', () => {
    expect(stripPackagingNoiseFromSearchName('President emmental rape sel reduit de 30% 150g')).toBe(
      'President emmental rape sel reduit de 30%'
    );
  });

  it('handles empty/missing input', () => {
    expect(stripPackagingNoiseFromSearchName('')).toBe('');
    expect(stripPackagingNoiseFromSearchName(undefined)).toBe('');
  });
});

describe('dedupeBrandFromSearchName', () => {
  it('drops the brand when it already appears in the name (Open Food Facts often embeds it)', () => {
    expect(dedupeBrandFromSearchName('Emmental râpé fondant PRESIDENT', 'Président')).toBe('');
    expect(dedupeBrandFromSearchName('Pâtes PENNE RIGATE blé Français PANZANI', 'Panzani')).toBe('');
  });

  it('keeps the brand when the name does not already contain it', () => {
    expect(dedupeBrandFromSearchName('Emmental râpé', 'Président')).toBe('Président');
  });

  it('handles empty/missing brand or name', () => {
    expect(dedupeBrandFromSearchName('Emmental râpé', '')).toBe('');
    expect(dedupeBrandFromSearchName('Emmental râpé', undefined)).toBe('');
    expect(dedupeBrandFromSearchName('', 'Président')).toBe('Président');
  });

  it('does not false-positive on a brand that is only a substring of another word', () => {
    // "U" (marque distributeur) ne doit pas matcher dans "Boisson" ou tout
    // autre mot qui le contiendrait — comparaison sur mot entier uniquement.
    expect(dedupeBrandFromSearchName('Boisson végétale saveur amande', 'U')).toBe('U');
  });
});

// Mesuré sur le vrai site le 02/09 : l'étape « nom simplifié » du jambon
// HERTA partait avec la requête « HERTA LE BON PARIS Jambon sel réduit sans
// nitrite x6- ». Le poids collé au multiplicateur ("x6-210g") était bien
// retiré, mais ni le multiplicateur écrit « x6 » (les règles existantes ne
// couvraient que « 6x ») ni le tiret devenu orphelin — faute d'espace des
// deux côtés, le découpage par segments ne le voyait pas.
describe('stripPackagingNoiseFromSearchName — conditionnement collé au poids', () => {
  it('retire le multiplicateur écrit "xN" et le tiret qu\'il laisse derrière lui', () => {
    expect(stripPackagingNoiseFromSearchName('HERTA LE BON PARIS Jambon sel réduit sans nitrite x6-210g')).toBe(
      'HERTA LE BON PARIS Jambon sel réduit sans nitrite'
    );
    expect(stripPackagingNoiseFromSearchName('Yaourt nature x4 125g')).toBe('Yaourt nature');
    expect(stripPackagingNoiseFromSearchName('Compote x12')).toBe('Compote');
  });

  it('laisse intact un nom où le "x" ou le chiffre appartient au produit', () => {
    // Le `\b` de la règle interdit de matcher au milieu d'un mot : sans lui,
    // "Box 4" perdrait son "x 4".
    expect(stripPackagingNoiseFromSearchName('Box 4 saveurs')).toBe('Box 4 saveurs');
    expect(stripPackagingNoiseFromSearchName('Boîte de 12 œufs')).toBe('Boîte de 12 œufs');
    expect(stripPackagingNoiseFromSearchName('Coca-Cola zéro')).toBe('Coca-Cola zéro');
  });
});
