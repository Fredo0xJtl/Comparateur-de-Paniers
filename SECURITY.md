# Politique de sécurité

## Périmètre

Comparateur de Paniers est une application web locale (PWA) de comparaison de paniers de courses. Elle stocke ses données dans IndexedDB, dans le navigateur de l'appareil, et ne nécessite ni compte applicatif, ni serveur, ni télémétrie, ni mesure d'audience, ni script distant, ni police de caractères externe.

Son connecteur de navigateur facultatif peut, après une action explicite de l'utilisateur, automatiser de façon visible la collecte de prix et le remplissage d'un panier sur les sites d'enseignes pris en charge.

Voir [`PRIVACY.md`](PRIVACY.md) pour la frontière de confidentialité côté utilisateur et ses limites connues.

## Frontières réseau et confidentialité

- Aucune requête réseau applicative n'est autorisée par défaut.
- Les produits, listes, magasins, candidats, prix, réglages, exports et imports restent locaux à l'appareil.
- Les sauvegardes JSON peuvent révéler des habitudes d'achat : ce sont des fichiers locaux à traiter comme sensibles.
- Le connecteur facultatif peut utiliser la session d'enseigne déjà ouverte dans le navigateur pour relever des prix et remplir un panier, après consentement explicite.
- Il ne doit **jamais** automatiser la connexion, le paiement, la validation d'une commande, ni extraire de cookies ou d'identifiants.

## Vérifications

À exécuter avant toute publication de modification :

```bash
npm run test
npm run typecheck
npm run privacy:check
npm run build
```

`npm run privacy:check` analyse le code de production à la recherche de primitives réseau interdites hors de la liste autorisée du service worker. Ces quatre commandes sont exactement celles que l'intégration continue exécute, avec en plus la validation du manifeste d'extension (`npm run extension:check`) et un audit des dépendances.

## Signaler une faille

**N'ouvre pas d'issue publique pour une faille de sécurité.** Utilise l'onglet *Security* du dépôt (« Report a vulnerability »), qui ouvre un signalement privé visible du seul mainteneur.

Sans compte GitHub, écris à **Comparateur-de-Paniers-Dev@protonmail.com**. Ce canal reste privé, mais il n'offre pas le suivi structuré du signalement GitHub : préfère ce dernier quand c'est possible.

Merci d'indiquer :

- ce que la faille permet de faire concrètement ;
- les étapes pour la reproduire ;
- la version concernée (application et connecteur).

**Ne joins jamais** de données personnelles, de sauvegarde réelle, de cookie, de session, de donnée de paiement ni de capture d'écran non anonymisée. Si un exemple est nécessaire, utilise des données fictives.

Le projet est maintenu sur du temps personnel : aucun délai de réponse n'est garanti, mais tout signalement est lu.

## Limites connues

- Le stockage local du navigateur peut être vidé par le navigateur lui-même ou par une politique de l'appareil.
- Les sauvegardes ne sont pas chiffrées.
- Une preuve de prix peut provenir de données de démonstration locales, ou d'une collecte visible sur les sites d'enseignes pris en charge.
- Les onglets d'enseigne et leurs sessions existantes restent à l'intérieur du périmètre de confidentialité de chaque enseigne.
