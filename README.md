# Comparateur de Paniers

PWA mobile-first, **locale et hors ligne**, pour préparer une liste de courses et comparer le prix d'un même panier entre **Hyper U / Courses U** et **Leclerc Drive**.

Aucun serveur, aucun compte, aucune télémétrie : toutes les données restent dans le navigateur de l'appareil.

## Ce que fait l'application

- Gérer des produits simples (boissons, épicerie sèche, hygiène, entretien, conserves, petit-déjeuner) et une liste de courses.
- Comparer le total du panier magasin par magasin à partir de preuves de prix horodatées, et proposer une répartition optimisée.
- Signaler un produit absent d'une enseigne sans bloquer le reste du panier.
- Exporter / réimporter une sauvegarde JSON locale.

Un **connecteur Firefox facultatif** (dossier `extension/`) peut ouvrir les catalogues Leclerc Drive et Courses U dans de vrais onglets, avec la session du navigateur de l'utilisateur, pour relever les prix affichés et — sur demande explicite — cliquer sur « Ajouter au panier ».

L'application **ne passe jamais commande**, n'accède à aucun moyen de paiement, et laisse toujours la vérification finale à l'utilisateur sur le site officiel.

## Installation et lancement

```bash
npm install
npm run dev
```

Vite affiche l'adresse locale à ouvrir (HTTPS, certificat local généré automatiquement — le téléphone du même réseau peut donc y accéder).

## Commandes utiles

```bash
npm run test
npm run typecheck
npm run privacy:check
npm run build
```

- `npm run test` — suite de tests unitaires (Vitest).
- `npm run typecheck` — vérification TypeScript.
- `npm run privacy:check` — refuse tout appel réseau applicatif ajouté hors de la liste autorisée.
- `npm run build` — build de production dans `dist/`.

## Connecteur Firefox

```bash
npm run extension:build:firefox
```

Le paquet produit ne dialogue qu'avec le site publié de l'application, jamais avec un serveur local : c'est celui-là seul qui doit être distribué. Des variantes de développement, restreintes à un port local précis, existent pour tester (`extension:build:firefox:dev:5174`, `…:4174`) — elles ne sont pas destinées à la distribution.

Le connecteur demande un consentement explicite au premier usage, n'automatise jamais la connexion à un compte marchand et ne valide jamais une commande.

## PWA et fonctionnement hors ligne

Le service worker se limite aux ressources statiques de même origine. Il n'actualise aucun prix en arrière-plan et ne met jamais en cache les exports utilisateur.

Pour vérifier le mode hors ligne :

1. `npm run build` ;
2. servir `dist/` avec un serveur statique local ;
3. ouvrir l'application une première fois ;
4. couper le réseau et vérifier que l'interface se recharge.

## Données et confidentialité

IndexedDB (via Dexie) stocke localement produits, listes, magasins, candidats, prix horodatés et préférences. Aucun backend n'est nécessaire. Les préférences ne contiennent jamais d'identifiant de magasin, de cookie, de session ni de moyen de paiement.

Les sauvegardes JSON exportées sont à conserver avec prudence : elles peuvent révéler des habitudes d'achat, des magasins fréquentés et des prix.

Détails : [`PRIVACY.md`](PRIVACY.md) et [`SECURITY.md`](SECURITY.md).

## Documentation

- [`PRIVACY.md`](PRIVACY.md) — garanties locales / hors ligne, données sensibles et limites.
- [`SECURITY.md`](SECURITY.md) — périmètre de sécurité et politique de signalement.
- [`CHANGELOG.md`](CHANGELOG.md) — historique des versions.

## Licence

Voir [`LICENSE`](LICENSE).
