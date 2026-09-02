import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // Nécessaire pour que le JSX des composants React (ex. ComparePage.tsx)
  // compile dans les tests — vitest.config.ts est un fichier de config Vite
  // séparé de vite.config.ts, il ne récupère pas ce plugin automatiquement.
  plugins: [react()],
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      ...configDefaults.exclude,
      // Les worktrees Git créés par l'outillage d'agents contiennent une copie
      // complète du dépôt : sans cette exclusion, vitest y collectait une
      // seconde version — souvent périmée — de chaque test. Le décompte de
      // tests devenait instable au fil des worktrees créés/supprimés, et la
      // durée du run doublait (55 s contre 14 s).
      '**/.claude/worktrees/**',
      '**/dist/**',
      '**/graphify-out/**'
    ]
  }
});
