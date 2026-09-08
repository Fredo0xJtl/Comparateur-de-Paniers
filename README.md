# Comparateur de Paniers

[![CI](https://github.com/Fredo0xJtl/Comparateur-de-Paniers/actions/workflows/ci.yml/badge.svg)](https://github.com/Fredo0xJtl/Comparateur-de-Paniers/actions/workflows/ci.yml)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Local-first](https://img.shields.io/badge/donn%C3%A9es-100%25%20locales-green.svg)](PRIVACY.md)

**→ [Ouvrir l'application](https://fredo0xjtl.github.io/Comparateur-de-Paniers/)** (rien à installer)

Application web mobile-first, **locale et hors ligne**, pour préparer une liste de courses et comparer le prix d'un même panier entre **Hyper U / Courses U** et **Leclerc Drive**.

Aucun serveur, aucun compte, aucune télémétrie : toutes les données restent dans le navigateur de l'appareil.

> **Projet indépendant**, sans lien ni affiliation avec E.Leclerc, Système U ou leurs filiales. Les marques citées appartiennent à leurs propriétaires respectifs.

---

## Sommaire

- [Ce que fait l'application](#ce-que-fait-lapplication)
- [Installation](#installation)
- [Commandes](#commandes)
- [Connecteur Firefox](#connecteur-firefox)
- [Fonctionnement hors ligne](#fonctionnement-hors-ligne)
- [Structure du projet](#structure-du-projet)
- [Données et confidentialité](#données-et-confidentialité)
- [Ce que le projet ne fera pas](#ce-que-le-projet-ne-fera-pas)
- [Contribuer](#contribuer)
- [Licence](#licence)

## Ce que fait l'application

- Gérer des produits simples (boissons, épicerie sèche, hygiène, entretien, conserves, petit-déjeuner) et une liste de courses.
- Ajouter un produit par **scan de code-barres**, avec repli sur la saisie manuelle.
- Comparer le total du panier magasin par magasin à partir de **preuves de prix horodatées**, et proposer une répartition optimisée entre les deux enseignes.
- Signaler un produit absent d'une enseigne, ou une correspondance douteuse, sans bloquer le reste du panier.
- Exporter et réimporter une sauvegarde JSON locale.

Un **connecteur Firefox facultatif** ouvre les catalogues Leclerc Drive et Courses U dans de vrais onglets, avec la session du navigateur de l'utilisateur, pour relever les prix affichés et — sur demande explicite — cliquer sur « Ajouter au panier ».

L'application **ne passe jamais commande**, n'accède à aucun moyen de paiement, et laisse la vérification finale à l'utilisateur sur le site officiel.

## Installation

Prérequis : **Node.js 22** ou plus récent.

```bash
npm install
npm run dev
```

Vite affiche l'adresse locale à ouvrir. Le serveur tourne en HTTPS avec un certificat local généré automatiquement, ce qui permet aussi d'ouvrir l'application depuis un téléphone du même réseau.

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm run dev` | Serveur de développement. |
| `npm run build` | Build de production dans `dist/`, pour un hébergement à la racine d'un domaine. |
| `npm run build:pages` | Build destiné à GitHub Pages, qui sert le site sous `/<dépôt>/` et non à la racine. Ajoute aussi `404.html`, sans lequel un lien direct ou un simple rechargement de page renverrait une erreur. |
| `npm run test` | Suite de tests (Vitest). |
| `npm run typecheck` | Vérification TypeScript. |
| `npm run privacy:check` | Refuse tout appel réseau applicatif hors de la liste autorisée. |
| `npm run extension:check` | Valide le manifeste du connecteur. |
| `npm run extension:build:firefox` | Construit le connecteur Firefox distribuable. |
| `npm run extension:package` | Construit puis archive le connecteur en `.zip` prêt pour Mozilla Add-ons, en refusant tout paquet contenant des origines de développement, un identifiant de test ou des fichiers de test. |

Les quatre premières, plus la validation du manifeste et un audit des dépendances, constituent l'intégration continue.

## Connecteur Firefox

Le connecteur est l'extension qui relève les prix dans les catalogues des enseignes et les renvoie à l'application. Il est facultatif : sans lui, l'application fonctionne, mais les prix doivent être saisis à la main.

### L'installer

Depuis Mozilla Add-ons, sur ordinateur comme sur Firefox pour Android. Une fois installé, ouvrez [l'application](https://fredo0xjtl.github.io/Comparateur-de-Paniers/) : **il n'y a rien à régler**, cette adresse est reconnue d'origine.

### Si vous hébergez l'application vous-même

Le connecteur ne se relie qu'aux adresses qu'il connaît. Votre propre adresse — ordinateur, NAS, Raspberry Pi, nom de domaine personnel — ne peut pas figurer dans un paquet distribué à tout le monde : c'est vous qui la déclarez.

1. Ouvrez votre installation dans un onglet et copiez l'adresse affichée dans la barre du navigateur.
2. Ouvrez les réglages de l'extension : menu ☰ → **Modules et thèmes** → **Comparateur de Paniers — Connecteur Drive** → onglet **Préférences**.
3. Collez l'adresse dans « Adresse de votre installation », puis validez.
4. Firefox demande votre accord **pour cette adresse uniquement**. Acceptez, puis rechargez la page de l'application.

L'autorisation se retire à tout moment, depuis cette même page ou depuis « Gérer les extensions » dans Firefox.

Les adresses en `http://` ne sont acceptées que sur votre propre machine (`localhost`). Ailleurs, la page circule en clair sur le réseau et pourrait être imitée par quiconque s'y interpose, qui hériterait alors du droit de piloter le connecteur dans votre session marchande : servez votre installation en `https://`.

### Le construire soi-même

```bash
npm run extension:build:firefox   # paquet de production, dans dist/extension-firefox/
npm run extension:package         # + archive .zip prête pour Mozilla Add-ons
```

Le paquet produit ne dialogue qu'avec le site publié de l'application, jamais avec un serveur local : **c'est celui-là seul qui doit être distribué**. Des variantes de développement restreintes à un port local existent pour tester (`extension:build:firefox:dev:5174`, `…:4174`).

Le connecteur demande un consentement explicite au premier usage, n'automatise jamais la connexion à un compte marchand et ne valide jamais de commande.

## Fonctionnement hors ligne

Le service worker se limite aux ressources statiques de même origine. Il n'actualise aucun prix en arrière-plan et ne met jamais en cache les exports utilisateur.

Pour vérifier :

1. `npm run build` ;
2. servir `dist/` avec un serveur statique local ;
3. ouvrir l'application une première fois ;
4. couper le réseau et vérifier que l'interface se recharge.

## Structure du projet

```
src/
  app/          Coquille de l'application et routage
  db/           Schéma IndexedDB (Dexie) et maintenance
  features/     Une fonctionnalité par dossier :
                comparison/    calcul du comparatif et preuves
                drive-bridge/  dialogue avec le connecteur
                products/      catalogue local
                scan/          code-barres et Open Food Facts
                shopping-list/ listes de courses
                stores/        magasins de l'utilisateur
  pages/        Écrans (Accueil, Produits, Liste, Comparaison, Réglages)
extension/
  adapters/     Code propre à chaque enseigne (leclerc/, coursesu/)
  background/   Orchestration des tâches de collecte
  bridge/       Pont entre l'application et l'extension
  shared/       Utilitaires communs aux adaptateurs
tools/          Scripts de build et de vérification
```

Le détail des choix de conception — pourquoi une extension, comment fonctionne la cascade de recherche, ce qui protège des régressions — est dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Les commentaires du code expliquent le *pourquoi* d'une décision, y compris ce qui a été essayé avant : les sites d'enseigne changent souvent, et ce contexte est ce qui évite de refaire deux fois la même erreur.

## Données et confidentialité

IndexedDB (via Dexie) stocke localement produits, listes, magasins, candidats, prix horodatés et réglages. Aucun serveur n'est nécessaire. Les réglages ne contiennent jamais d'identifiant de magasin, de cookie, de session ni de moyen de paiement.

Trois chemins réseau seulement sont autorisés, et vérifiés automatiquement à chaque validation — le détail est dans [`PRIVACY.md`](PRIVACY.md).

Les sauvegardes JSON exportées sont à conserver avec prudence : elles peuvent révéler des habitudes d'achat, des magasins fréquentés et des prix.

## Ce que le projet ne fera pas

Ces choix sont des décisions de conception, pas des fonctionnalités manquantes :

- pas de serveur, de compte ni de télémétrie ;
- pas d'automatisation de la connexion à un compte marchand ;
- pas de validation de commande ni d'accès au paiement ;
- pas de contournement de protection anti-robot ni de résolution de captcha ;
- aucun clic sur un bouton de consentement à la place de l'utilisateur.

## Contribuer

Les contributions sont bienvenues : lis [`CONTRIBUTING.md`](CONTRIBUTING.md) avant de commencer, ainsi que le [code de conduite](CODE_OF_CONDUCT.md).

Pour une faille de sécurité, ne passe pas par une issue publique : suis la procédure de [`SECURITY.md`](SECURITY.md).

## Licence

[MIT](LICENSE).
