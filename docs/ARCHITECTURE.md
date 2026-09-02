# Architecture

Ce document explique comment le projet est organisé et **pourquoi**. Il s'adresse à quelqu'un qui découvre le dépôt et veut comprendre les décisions avant de lire le code.

## Le problème

Comparer le prix d'un panier entre deux enseignes suppose de connaître le prix de chaque produit chez chacune. Or ces prix ne sont pas publics : il n'existe pas d'API, et un même produit n'a pas le même libellé d'une enseigne à l'autre.

Trois conséquences structurent tout le reste :

1. **Les prix sont relevés depuis les sites d'enseigne eux-mêmes**, dans un navigateur, avec la session de l'utilisateur — d'où une extension plutôt qu'un serveur.
2. **La correspondance entre un produit et une fiche catalogue est incertaine.** Elle est donc traitée comme une hypothèse notée, jamais comme un fait.
3. **Les sites changent sans préavis.** Le code doit échouer de façon lisible plutôt que de deviner.

## Vue d'ensemble

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Application (PWA)          │         │  Connecteur (extension)      │
│                             │  pont   │                              │
│  React + TypeScript         │◄───────►│  Tâches de collecte          │
│  IndexedDB (Dexie)          │ messages│  Adaptateurs par enseigne    │
│  Aucun appel réseau propre  │         │  Onglets réels du navigateur │
└─────────────────────────────┘         └──────────────┬───────────────┘
                                                       │ navigation visible
                                                       ▼
                                        Sites Leclerc Drive / Courses U
```

L'application ne sait pas naviguer sur un site d'enseigne, et l'extension ne sait rien du calcul du comparatif. Elles communiquent par messages, à travers un pont dont l'origine autorisée est déclarée explicitement dans le manifeste.

## Côté application

| Dossier | Rôle |
| --- | --- |
| `src/db/` | Schéma IndexedDB (Dexie), migrations, maintenance. |
| `src/features/products/` | Catalogue local des produits de l'utilisateur. |
| `src/features/shopping-list/` | Listes de courses et produits récurrents. |
| `src/features/stores/` | Magasins de l'utilisateur, recherche par ville. |
| `src/features/scan/` | Lecture de code-barres et recherche Open Food Facts. |
| `src/features/comparison/` | Calcul du comparatif, preuves, cohérence des prix. |
| `src/features/drive-bridge/` | Dialogue avec le connecteur, diagnostics. |
| `src/pages/` | Les écrans. |

**Toute donnée est locale.** Il n'y a pas de couche « API » : ce qui n'est pas dans IndexedDB n'existe pas pour l'application. Deux exceptions strictement délimitées et vérifiées automatiquement (`npm run privacy:check`) : la recherche d'un code-barres chez Open Food Facts et la recherche d'un magasin par ville chez Nominatim. Voir [`PRIVACY.md`](PRIVACY.md).

## Côté connecteur

| Dossier | Rôle |
| --- | --- |
| `extension/background/` | Orchestration : file d'attente des produits, reprise, disjoncteur. |
| `extension/adapters/leclerc/` | Tout ce qui est propre à Leclerc Drive. |
| `extension/adapters/courses-u/` | Tout ce qui est propre à Courses U. |
| `extension/bridge/` | Pont avec l'application. |
| `extension/shared/` | Ce qui est commun : analyse de quantité, normalisation de requête, délais. |

Un **adaptateur** sait où et comment trouver un prix sur *son* site. Ajouter une enseigne revient à écrire un adaptateur ; aucune autre partie du code n'a besoin de le savoir.

### Deux contraintes à connaître avant de toucher aux adaptateurs

**Les fonctions injectées dans une page ne voient rien de l'extérieur.** Elles sont reconstruites depuis leur code source dans le contexte de la page : toute donnée dont elles ont besoin doit leur être passée en argument. Un oubli produit une erreur silencieuse, invisible dans les journaux de l'extension — le genre de bug qui peut rester actif plusieurs jours.

**Une fiche produit n'est pas une page de recherche.** Chez Leclerc, une fiche est une page complète sans aucune zone de recherche : tant que l'onglet ne l'a pas quittée, toute recherche lancée depuis là échoue. Le retour vers la page de recherche est donc fait à un seul endroit, avant toute recherche, et attend d'avoir réellement quitté la fiche.

## La cascade de recherche

Un produit de la liste porte un nom issu d'Open Food Facts (« Tropicana 100 % oranges pressées sans pulpe 1 L »). Le catalogue de l'enseigne, lui, écrit autre chose (« Jus Tropicana Orange sans pulpe - 90 cl »). Chercher le nom complet ne donne souvent rien.

La recherche essaie donc plusieurs formulations, de la plus précise à la plus large, et s'arrête à la première qui donne un candidat acceptable :

```
name  →  simplified_name  →  name_only  →  brand_only
```

Chaque candidat reçoit un **score de correspondance**. Deux règles importantes :

- Un candidat qui franchit le seuil mais **n'est pas de la marque attendue** n'arrête pas la cascade : on continue à chercher un candidat de la bonne marque, et on ne retombe sur l'autre marque qu'en dernier recours.
- L'étage qui a trouvé le produit est **mémorisé**, ainsi que l'adresse exacte de la fiche. Au comparatif suivant, on repart directement de là au lieu de tout rejouer.

Cette mémoire distingue deux canaux qu'il ne faut jamais confondre :

| Canal | Origine | Confiance |
| --- | --- | --- |
| Correction manuelle | l'utilisateur a désigné la fiche lui-même | preuve humaine, jamais remise en cause |
| Permalien appris | l'automatisme a trouvé la fiche | présomption : la fiche est revérifiée et re-notée à chaque passage |

## Le comparatif

Le calcul ne se contente pas d'additionner des prix : il produit une **preuve** pour chaque ligne — d'où vient le prix, quand il a été relevé, à quel point la correspondance est sûre, et ce qui cloche éventuellement.

Une alerte bloque la validation quand elle a une issue (prix absent, prix périmé, produit non identifié : actualiser ou confirmer suffit). Les deux alertes sans issue automatique — prix incohérent avec le prix au litre, format à confirmer — peuvent être levées par l'utilisateur après vérification sur la fiche du magasin ; elles restent alors affichées en avertissement, avec la levée horodatée dans l'export de preuve.

## Ce qui protège le projet des régressions

- **687 tests** couvrant le calcul, les adaptateurs et le pont, exécutés à chaque validation.
- **`privacy:check`** : refuse tout appel réseau applicatif hors de la liste autorisée.
- **`extension:check`** : valide le manifeste du connecteur, notamment ses permissions d'hôtes.
- **Un audit de dépendances** à chaque validation.
- **Des commentaires qui expliquent le pourquoi**, y compris les cas réels observés. C'est délibéré : sans cette trace, une correction subtile est défaite au premier remaniement par quelqu'un qui la prend pour du code inutile.
