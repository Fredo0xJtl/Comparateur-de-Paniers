// Affichage des montants en euros au format français : « 1,35 € ».
// Pas d'Intl : ses espaces insécables compliquent les tests. Affichage seulement,
// jamais pour une valeur stockée, exportée ou saisie.
export function formatEuro(value: number): string {
  return `${value.toFixed(2).replace('.', ',')} €`;
}
