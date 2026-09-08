# Comparateur de Paniers

[![CI](https://github.com/Fredo0xJtl/Comparateur-de-Paniers/actions/workflows/ci.yml/badge.svg)](https://github.com/Fredo0xJtl/Comparateur-de-Paniers/actions/workflows/ci.yml)
[![Licence MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)
[![Local-first](https://img.shields.io/badge/donn%C3%A9es-100%25%20locales-green.svg)](PRIVACY.md)

**Comparez le prix de vos courses entre plusieurs drives, depuis votre téléphone.**

**→ [Ouvrir l'application](https://fredo0xjtl.github.io/Comparateur-de-Paniers/)** — gratuit, sans compte, rien à installer sur votre appareil.

Vous préparez votre liste de courses. L'application va lire les prix affichés sur les catalogues de vos magasins, puis vous dit combien vous économisez en répartissant votre panier entre deux enseignes plutôt qu'en achetant tout au même endroit.

Compatible **Leclerc Drive** et **Courses U / Hyper U**.

> **Projet indépendant**, sans lien ni affiliation avec E.Leclerc, Système U ou leurs filiales. Les marques citées appartiennent à leurs propriétaires respectifs.

---

## Pour commencer

Trois choses à faire une seule fois. L'application vous les rappelle à sa première ouverture.

1. **Utilisez Firefox.** L'application ne fonctionne qu'avec ce navigateur, sur téléphone comme sur ordinateur — c'est le seul qui autorise le connecteur décrit ci-dessous. [Télécharger Firefox](https://www.mozilla.org/fr/firefox/new/)
2. **Ajoutez le connecteur à Firefox.** C'est un petit module qui va lire les prix pour vous. Sans lui, l'application s'ouvre mais ne peut relever aucun prix.
3. **Connectez-vous à vos comptes magasins** dans ce même Firefox, comme d'habitude. L'application ne connaît jamais vos identifiants : elle travaille dans la session que vous avez ouverte vous-même.

Ensuite, ouvrez l'application, choisissez vos magasins, composez votre liste et lancez la comparaison.

> **Astuce :** dans le menu de Firefox, « Ajouter à l'écran d'accueil » installe l'application comme les autres, avec son icône.

## À quoi sert le connecteur

Un navigateur ne laisse pas une page web en consulter une autre — c'est une protection, pas un défaut. Le connecteur est la pièce qui permet à l'application de lire les prix sur les sites des magasins.

Il n'agit que lorsque vous le demandez, ouvre les catalogues dans de vrais onglets, relève les prix affichés, puis rend la main.

Ce qu'il ne fait **jamais** : passer commande, toucher à un moyen de paiement, se connecter à un compte à votre place, ou agir en arrière-plan sans que vous l'ayez demandé. La vérification finale et la commande restent chez le magasin, sous votre contrôle.

## Un problème ? Un prix faux ou manquant ?

Ça arrive, et **c'est utile de le signaler** : les sites des magasins changent régulièrement, et une modification de leur côté peut faire échouer la lecture des prix du jour au lendemain. Sans signalement, le problème peut passer inaperçu pendant des semaines.

### Ce qu'il faut envoyer

Dans l'application, page **Comparer**, un bouton **« Télécharger le diagnostic »** apparaît après une comparaison. Il enregistre un fichier qui explique ce qui s'est passé.

**Ne publiez pas ce fichier tel quel dans un message public.** Il contient le nom des produits de votre liste et les adresses des fiches consultées — donc, indirectement, vos habitudes de courses et la ville où vous les faites.

Pour signaler un problème, [ouvrez un ticket](https://github.com/Fredo0xJtl/Comparateur-de-Paniers/issues) et donnez seulement :

- ce que vous attendiez et ce qui s'est passé à la place ;
- le **nom du produit** concerné, si c'est un seul produit qui pose problème ;
- le **code d'erreur** affiché, s'il y en a un — c'est une suite de lettres majuscules du genre `CART_LOGIN_REQUIRED` ;
- le magasin concerné (l'enseigne suffit, pas la ville).

C'est suffisant dans la grande majorité des cas.

### Si le fichier complet est nécessaire

Il arrive qu'un problème reste incompréhensible sans le diagnostic entier. Dans ce cas, envoyez-le **en privé**, jamais dans le ticket public :

**Comparateur-de-Paniers-Dev@protonmail.com**

Ce que devient ce fichier : il sert uniquement à comprendre et corriger le problème signalé, il n'est ni partagé, ni publié, ni utilisé pour autre chose, et il est supprimé une fois le problème traité.

Cette adresse sert aussi si vous préférez poser une question sans passer par un ticket public.

### Pour une faille de sécurité

N'ouvrez pas de ticket public : suivez la procédure décrite dans [`SECURITY.md`](SECURITY.md).

## Vos données restent chez vous

Il n'y a **aucun serveur**. L'application est un fichier que votre navigateur télécharge une fois, puis exécute sur votre appareil.

- Vos listes, vos prix et vos magasins sont enregistrés **dans votre navigateur**, sur votre téléphone ou votre ordinateur.
- **Aucun compte à créer**, aucun mot de passe, aucune adresse e-mail demandée.
- **Aucun traçage**, aucune statistique d'usage, aucune publicité.
- Le connecteur ne contient **aucun appel réseau** vers un serveur : il ne peut techniquement rien envoyer nulle part.

Le détail, y compris les rares échanges réseau de l'application elle-même, est dans [`PRIVACY.md`](PRIVACY.md).

**Deux conséquences à connaître.** Si vous effacez les données de votre navigateur, vos listes disparaissent — pensez à l'export de sauvegarde dans les réglages. Et cette sauvegarde, elle, contient vos habitudes d'achat : gardez-la comme un document personnel.

## Ce que le projet ne fera pas

Ce sont des décisions assumées, pas des fonctions manquantes :

- pas de serveur, de compte ni de télémétrie ;
- pas de connexion automatique à un compte marchand ;
- pas de validation de commande ni d'accès au paiement ;
- pas de contournement des protections anti-robot ni de résolution de captcha ;
- aucun clic sur un bouton de consentement à votre place.

---

# Pour les développeurs

Le reste de ce document s'adresse à qui veut lire, modifier ou construire le projet.

## Installer et lancer

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

Les instructions de compilation reproductibles du connecteur — celles fournies à Mozilla — sont dans [`BUILD.md`](BUILD.md).

## Héberger l'application soi-même

Le connecteur ne se relie qu'aux adresses qu'il connaît. Votre propre adresse — ordinateur, NAS, Raspberry Pi, nom de domaine personnel — ne peut pas figurer dans un paquet distribué à tout le monde : c'est vous qui la déclarez.

1. Ouvrez votre installation dans un onglet et copiez l'adresse affichée dans la barre du navigateur.
2. Ouvrez les réglages de l'extension : menu ☰ → **Modules et thèmes** → **Comparateur de Paniers — Connecteur Drive** → onglet **Préférences**.
3. Collez l'adresse dans « Adresse de votre installation », puis validez.
4. Firefox demande votre accord **pour cette adresse uniquement**. Acceptez, puis rechargez la page de l'application.

L'autorisation se retire à tout moment, depuis cette même page ou depuis « Gérer les extensions » dans Firefox.

Les adresses en `http://` ne sont acceptées que sur votre propre machine (`localhost`). Ailleurs, la page circule en clair sur le réseau et pourrait être imitée par quiconque s'y interpose, qui hériterait alors du droit de piloter le connecteur dans votre session marchande : servez votre installation en `https://`.

## Construire le connecteur

```bash
npm run extension:build:firefox   # paquet de production, dans dist/extension-firefox/
npm run extension:package         # + archive .zip prête pour Mozilla Add-ons
```

Le paquet produit ne dialogue qu'avec le site publié de l'application, jamais avec un serveur local : **c'est celui-là seul qui doit être distribué**. Des variantes de développement restreintes à un port local existent pour tester (`extension:build:firefox:dev:5174`, `…:4174`).

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
                onboarding/    fenêtre d'accueil des nouveaux utilisateurs
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

## Stockage local

IndexedDB (via Dexie) stocke produits, listes, magasins, candidats, prix horodatés et réglages. Aucun serveur n'est nécessaire. Les réglages ne contiennent jamais d'identifiant de magasin, de cookie, de session ni de moyen de paiement.

Trois chemins réseau seulement sont autorisés, et vérifiés automatiquement à chaque validation — le détail est dans [`PRIVACY.md`](PRIVACY.md).

## Contribuer

Les contributions sont bienvenues : lis [`CONTRIBUTING.md`](CONTRIBUTING.md) avant de commencer, ainsi que le [code de conduite](CODE_OF_CONDUCT.md).

Pour une faille de sécurité, ne passe pas par une issue publique : suis la procédure de [`SECURITY.md`](SECURITY.md).

## Licence

[MIT](LICENSE).
