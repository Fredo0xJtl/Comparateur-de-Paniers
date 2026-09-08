// Version publiée de src/features/sync/SyncSettingsPanel.tsx.
//
// La synchronisation multi-appareils est une fonctionnalité d'atelier
// personnel : elle suppose un serveur que l'utilisateur héberge lui-même
// (sync-server/ dans le dépôt de travail) et ne fait pas partie du produit
// distribué. Plutôt que de publier un écran qui ne mènerait nulle part, le
// panneau est remplacé ici par un composant inerte, et tout le reste du
// dossier src/features/sync/ est exclu de la copie — voir la liste blanche et
// la liste d'exclusions dans tools/publier-vers-public.mjs.
//
// Ce fichier existe pour que SettingsPage.tsx reste STRICTEMENT identique
// dans les deux dépôts : c'est la seule frontière, elle tient en un import.
export function SyncSettingsPanel() {
  return null;
}
