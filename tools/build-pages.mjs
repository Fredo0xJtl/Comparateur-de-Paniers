#!/usr/bin/env node
// Build destiné à GitHub Pages, où l'application est servie sous un
// SOUS-CHEMIN (`https://<compte>.github.io/<dépôt>/`) et non à la racine d'un
// domaine. Tout le reste — dev server, `vite preview`, Raspberry derrière
// Caddy — sert l'application à la racine et continue d'utiliser
// `npm run build` sans rien changer.
//
// Un script Node plutôt qu'une variable d'environnement écrite directement
// dans package.json : `PUBLIC_BASE=... vite build` n'est pas une syntaxe
// valide sous PowerShell/cmd, et l'ajout d'une dépendance (cross-env) pour
// une seule variable ne se justifie pas.
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';

// Le nom du dépôt public. À changer ici, et seulement ici, si le dépôt est
// renommé — le manifest du connecteur (extension/manifest.json) déclare la
// même URL et devra suivre.
const REPOSITORY_NAME = process.env.PUBLIC_BASE ?? '/Comparateur-de-Paniers/';

const base = REPOSITORY_NAME.startsWith('/') ? REPOSITORY_NAME : `/${REPOSITORY_NAME}`;
const normalizedBase = base.endsWith('/') ? base : `${base}/`;

console.log(`Build GitHub Pages — chemin public : ${normalizedBase}`);

// Commande passée en une seule chaîne, sans tableau d'arguments : `npm` est
// un fichier `.cmd` sous Windows, que Node refuse de lancer sans shell
// (EINVAL depuis les correctifs de sécurité de Node 18.20/20.12), et un
// tableau d'arguments AVEC shell déclenche l'avertissement DEP0190. La
// commande est ici une constante, sans aucune valeur extérieure concaténée.
const result = spawnSync('npm run build', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, PUBLIC_BASE: normalizedBase }
});

if (result.error) {
  console.error('Impossible de lancer `npm run build` :', result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// GitHub Pages est un hébergement statique : il ne connaît que les fichiers
// réellement présents. Or l'application est une SPA — une seule page HTML dont
// le routeur affiche la vue correspondant à l'URL. Ouvrir directement
// `.../comparaison`, ou simplement recharger la page, cherche donc un fichier
// qui n'existe pas et donne un 404.
//
// GitHub Pages sert `404.html` dans ce cas. En y plaçant une copie exacte de
// `index.html`, la page se charge normalement (avec un code HTTP 404, sans
// conséquence visible) et le routeur reprend la main sur l'URL demandée.
// C'est la solution recommandée par GitHub lui-même ; aucune redirection ni
// paramètre d'URL n'est nécessaire.
copyFileSync(new URL('../dist/index.html', import.meta.url), new URL('../dist/404.html', import.meta.url));

console.log(
  `\nBuild terminé dans dist/ (avec 404.html pour les liens directs). À servir sous ${normalizedBase} — servi à la racine d'un domaine, il ne fonctionnerait pas.`
);
