// Relecture automatique du code (« linter ») : signale les erreurs classiques
// avant qu'elles n'arrivent en revue. Lancer avec `npm run lint`.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['.claude/', '.codex/', '.agents/', 'dist/', 'build/', 'dev/', 'node_modules/', 'release-assets/', 'graphify-out/', 'diagnostics-locaux/', 'sync-server/', 'docs/']
  },
  js.configs.recommended,
  {
    rules: {
      // `let x = null; try { x = … } catch { … }` : valeur de départ explicite,
      // présente partout dans le connecteur. La règle n'y voit qu'une
      // affectation inutile ; la retirer changerait `null` en `undefined`
      // dans du code validé sur les vrais sites.
      'no-useless-assignment': 'off',
      // Espaces insécables écrits tels quels dans les expressions régulières
      // qui lisent les prix (« 1 234,56 € »).
      'no-irregular-whitespace': ['error', { skipRegExps: true }]
    }
  },
  {
    // Application (TypeScript + React).
    files: ['src/**/*.{ts,tsx}', '*.ts'],
    extends: [...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }]
    }
  },
  {
    // Connecteur navigateur et service worker de la PWA (JavaScript).
    files: ['extension/**/*.js', 'public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, ...globals.serviceworker, ...globals.node }
    },
    rules: {
      // args: 'none' — les fonctions du connecteur reçoivent toutes le même
      // objet d'outils ({ scripting, tabs, … }) sans forcément tout utiliser.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }]
    }
  },
  {
    // Outils de build (Node).
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
    rules: { 'no-unused-vars': ['error', { varsIgnorePattern: '^_', ignoreRestSiblings: true }] }
  },
  {
    files: ['**/*.test.{ts,tsx,js,mjs}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    // Les doublures de test imitent des API externes : y typer chaque champ
    // n'apporte rien.
    rules: { '@typescript-eslint/no-explicit-any': 'off' }
  }
);
