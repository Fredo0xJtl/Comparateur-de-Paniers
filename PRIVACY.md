# Confidentialité

Comparateur de Paniers est conçu comme une application web locale (PWA) de comparaison de paniers de courses : les données restent sur l'appareil.

## Ce qui reste local

- Les produits, listes de courses, magasins, candidats, prix et réglages sont stockés dans le navigateur, via IndexedDB.
- Les sauvegardes JSON sont générées localement par le navigateur.
- Les imports sont lus localement, depuis le fichier choisi.
- Aucun compte, serveur, mesure d'audience, télémétrie, rapport de plantage ni police distante n'est nécessaire.

## Frontière réseau

Il n'y a ni serveur, ni compte, ni mesure d'audience, ni télémétrie, ni rapport de plantage. L'application n'envoie jamais une liste de courses, un panier, un historique de prix ou une sauvegarde où que ce soit.

Quatre chemins réseau sont autorisés, vers trois hôtes seulement. `npm run privacy:check` fait respecter cette frontière dans l'intégration continue : toute primitive réseau hors des modules déclarés, ou tout appel vers un hôte non déclaré, fait échouer la validation.

| Chemin | Hôte | Ce qui quitte l'appareil | Quand |
| --- | --- | --- | --- |
| Coquille PWA | même origine uniquement | rien | le service worker récupère les ressources statiques |
| Recherche par code-barres | `world.openfoodfacts.org` | le code-barres scanné (EAN), seul | uniquement si le code scanné n'est pas déjà dans la base locale |
| Recherche de fiche par son nom | `world.openfoodfacts.org` | les mots tapés dans le champ « Nom du produit » | désactivé par défaut ; uniquement si l'option est activée dans les réglages **et** que l'utilisateur touche « Trouver la fiche produit » |
| Recherche de magasin | `nominatim.openstreetmap.org` | le nom de ville saisi par l'utilisateur, et l'enseigne | uniquement quand l'utilisateur lance une recherche de magasin |

Ces services tiers sont publics, gratuits et sans compte ; aucun ne reçoit d'identifiant, de liste, de prix ni de panier. Comme pour toute requête HTTP, ils voient en revanche l'adresse IP de l'appareil et peuvent la journaliser selon leurs propres politiques ([Open Food Facts](https://world.openfoodfacts.org/privacy), [Fondation OpenStreetMap](https://osmfoundation.org/wiki/Privacy_Policy)). Les recherches de magasin sont limitées à une requête par seconde, conformément aux conditions d'usage de Nominatim.

La recherche d'une fiche par son nom est le seul chemin qui transmette du texte saisi librement, plus révélateur qu'un code-barres isolé : elle est donc désactivée par défaut, ne se déclenche jamais pendant la frappe, et le bouton qui la lance n'apparaît même pas tant que l'option reste désactivée. Son intérêt est de récupérer le code-barres du produit, qui permet ensuite d'identifier sa fiche en magasin avec certitude.

Toutes les autres fonctions — comparaison, listes, historique, sauvegardes — fonctionnent entièrement hors ligne.

### Collecte des prix Drive (extension de navigateur)

Le connecteur facultatif pilote le site de l'enseigne dans un véritable onglet de navigateur, avec la session de l'utilisateur, exactement comme le ferait une visite manuelle. Il ne détient de permissions que pour `leclercdrive.fr` et `coursesu.com`, n'envoie rien à un tiers, et conserve son état dans le stockage de session du navigateur. Ouvrir le site d'une enseigne fait entrer l'utilisateur dans la politique de confidentialité de cette enseigne.

Le remplissage de panier facultatif peut rechercher des produits et cliquer sur « Ajouter au panier » dans les onglets d'enseigne, mais uniquement après une action visible de l'utilisateur et un consentement explicite au premier usage. Il ne valide aucune commande, n'accède à aucun moyen de paiement et n'extrait aucun identifiant. Les liens produits manuels restent disponibles.

#### Sur quelles pages le connecteur s'active

En dehors des deux sites d'enseigne ci-dessus, le connecteur ne se relie qu'à **une seule adresse** : celle de l'application publique, inscrite dans son paquet. Il ne lit, ne modifie et n'observe aucune autre page visitée.

Une seconde possibilité existe pour ceux qui hébergent l'application eux-mêmes — sur leur ordinateur, un NAS, un Raspberry Pi ou leur propre nom de domaine. Leur adresse ne peut par nature pas figurer dans un paquet distribué à tout le monde : elle se déclare dans les réglages de l'extension, et **Firefox demande alors un accord explicite pour cette adresse, et pour elle seule**. Le paquet déclare la permission correspondante comme *facultative* : rien n'est accordé à l'installation, et l'autorisation peut être retirée à tout moment, depuis les réglages de l'extension ou depuis « Gérer les extensions » dans Firefox.

Les adresses en `http://` ne sont acceptées que sur la machine elle-même (`localhost`). Ailleurs, une page transmise en clair pourrait être imitée par quiconque s'interpose sur le réseau, et hériterait du droit de piloter le connecteur.

## Données sensibles

Les listes de courses et les sauvegardes peuvent révéler des habitudes, des magasins fréquentés et des prix. Les fichiers JSON exportés sont à traiter comme des fichiers privés.

Ne publie jamais, dans une issue ou un commit, de sauvegarde réelle, de capture d'écran contenant des données de courses personnelles, d'identifiants d'enseigne, de cookies, de sessions, de données de paiement ni d'adresses de magasin privées.

## Limites connues

- Le stockage du navigateur est local mais pas garanti permanent : le navigateur ou l'appareil peuvent le vider.
- Les sauvegardes ne sont pas chiffrées.
- Les sites d'enseigne ont leur propre politique de confidentialité dès qu'ils sont ouverts.
