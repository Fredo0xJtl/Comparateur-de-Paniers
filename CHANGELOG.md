# Changelog

## Application - Accueil pour les nouveaux utilisateurs

- **Une fenêtre d'accueil s'affiche à la première ouverture** et explique les trois choses à faire une seule fois : utiliser Firefox, ajouter le connecteur, se connecter à ses comptes magasins. Chaque étape indique où elle en est, et celles qui restent à faire portent un bouton qui y mène directement — dont le lien vers la page officielle du connecteur. Jusqu'ici, rien dans l'application ne disait qu'un connecteur était nécessaire : on ne l'apprenait qu'après avoir saisi une liste de courses entière, en voyant échouer le premier comparatif.
- L'accueil revient à chaque ouverture tant que le connecteur manque — sans lui l'application ne peut rien comparer — puis ne se montre plus. Un bouton « Aide » en haut de l'écran permet de le rouvrir à tout moment.
- Le message affiché quand le connecteur ne répond pas s'adresse désormais d'abord au cas courant (il n'est pas installé) et renvoie vers « Aide ». Il mentionnait auparavant l'auto-hébergement en premier, ce qui laissait croire à une manipulation compliquée alors qu'il suffisait d'installer le connecteur ; ce cas reste couvert, en fin de message.

## Connecteur Firefox 0.7.0 - Préparation de la publication sur Mozilla Add-ons

- **Le connecteur fonctionne désormais quelle que soit l'adresse où l'application est installée.** Jusqu'ici, il ne se reliait qu'à l'adresse publique du site, inscrite dans son paquet : toute personne hébergeant l'application ailleurs — sur son ordinateur, un NAS, un Raspberry Pi ou son propre nom de domaine — obtenait « Extension Drive indisponible » sans autre explication, et il n'existait aucun moyen d'y remédier hormis reconstruire l'extension soi-même. Une adresse privée ne peut pas être inscrite dans un paquet distribué à tout le monde : elle n'existe que chez son propriétaire, et y mettre des adresses locales génériques (`localhost`, une IP privée, un nom `.local`) reviendrait à autoriser n'importe quelle page du réseau de n'importe quel utilisateur à piloter le connecteur. Chacun déclare donc son adresse dans les réglages de l'extension, et Firefox demande son accord pour cette adresse et pour elle seule. Rien n'est accordé à l'installation, et l'autorisation se retire à tout moment.
- Ces adresses supplémentaires sont vérifiées deux fois avant qu'un message soit accepté : elles doivent figurer dans la liste enregistrée **et** Firefox doit confirmer que la permission est réellement accordée — ce qui rattrape le cas d'une autorisation retirée depuis « Gérer les extensions » sans passer par la page d'options. Les adresses en `http://` ne sont acceptées que sur la machine elle-même : ailleurs, une page transmise en clair peut être imitée par quiconque s'interpose sur le réseau, et hériterait du droit de piloter le connecteur dans la session marchande de l'utilisateur.
- La page d'options montre maintenant, noir sur blanc, **toutes** les adresses où le connecteur est actif, et permet d'ajouter ou de retirer la sienne.
- Ajoute `npm run extension:package`, qui construit puis archive le paquet destiné à Mozilla. Il refuse de produire une archive contenant des origines de développement, un identifiant de test ou des fichiers de test — les trois erreurs qui font rejeter une soumission, et qui ne se voient qu'une fois le paquet refusé. L'archive est reproductible : deux constructions du même contenu donnent le même fichier.
- Ajoute les icônes de l'extension, absentes jusqu'ici, et retire du paquet livré les clés de documentation internes que Mozilla signale comme propriétés inconnues.
- L'identifiant technique passe de `drive-price-splitter-dev@…` à `comparateur-de-paniers@fredo0xjtl.github.io`, avant toute publication publique. Il ne changera plus : le modifier après publication couperait les mises à jour de tous les utilisateurs installés.

Corrections issues de l'audit de sécurité mené sur ce changement, avant soumission :

- Une adresse contenant un caractère « joker » écrit sous forme encodée (`%2A`, qui signifie `*`) passait le contrôle de saisie : l'adresse n'était jamais enregistrée, mais Firefox demandait entre-temps une autorisation d'accès bien plus large que voulu — jusqu'à tous les sites d'une extension de domaine. Une fois accordée, cette autorisation n'apparaissait nulle part dans la page d'options et ne pouvait donc plus être retirée depuis l'extension. Le nom du serveur est désormais vérifié après lecture de l'adresse, quelle que soit la façon dont il a été écrit.
- Une adresse déclarée sans numéro de port autorisait en réalité **tout** ce qui est hébergé sur ce serveur, y compris sur d'autres ports. Une autre application installée sur la même machine héritait ainsi du droit de piloter le connecteur. Le port est maintenant toujours pris en compte, celui du protocole (443 ou 80) étant retenu quand il n'est pas écrit.
- Un message refusé laissait l'application en attente d'une réponse qui n'arrivait jamais : l'écran restait sur « en cours » au lieu d'afficher « Extension Drive indisponible ». Une réponse vide est désormais toujours renvoyée — le refus ne révèle rien de plus qu'avant, mais il se voit.
- La page d'options signale les adresses dont l'autorisation a été retirée depuis « Modules complémentaires », et prévient lorsqu'un retrait n'a pas pu être appliqué côté Firefox au lieu de le passer sous silence.
- Les adresses IPv6 écrites entre crochets (`[::1]`) sont refusées avec une explication : Firefox ne sait pas accorder d'autorisation pour cette forme, la demande échouait sans motif compréhensible.

## 0.2.0 - Non publié - Fiabilisation du remplissage automatique de panier

- Ajoute l'import des listes déjà enregistrées sur le compte du magasin : les « produits habituels » Leclerc et les listes Courses U rejoignent la liste de courses locale sans avoir à ressaisir chaque produit. L'extension ouvre la page de compte, la lit, et referme l'onglet ; elle ne saisit jamais d'identifiant ni de mot de passe — la connexion au site reste faite par l'utilisateur lui-même. Côté Leclerc, où les produits habituels sont répartis par rayon avec un seul rayon affiché à la fois, chaque rayon est parcouru automatiquement, à rythme humain. Rien n'est ajouté sans validation : un écran affiche ce qui a été lu, repère les produits déjà présents dans le catalogue local (par code-barres côté Courses U, par nom et marque côté Leclerc, faute de code-barres sur ces pages) et les décoche par défaut — cocher un doublon l'ajoute à la liste de courses sans créer de seconde fiche ni toucher aux réglages de la fiche existante. Un import incomplet (rayon non lu, structure de page modifiée) est signalé plutôt que présenté comme complet.
- Permet de lever les deux alertes qu'aucune action automatique ne pouvait résoudre : « prix incohérent avec le prix au litre/kilo » et « format à confirmer ». Toutes deux venaient d'un contrôle volontairement méfiant, sans aucune issue : un lot mal lu (« 2×500 g » compté 500 g) ou une promotion dont le prix au kilo porte sur le prix barré suffisait à rendre le panier entier définitivement non validable, « Actualiser » relisant la même fiche et retrouvant le même écart. Après vérification sur la fiche du magasin, l'utilisateur peut désormais lever l'alerte : elle reste affichée en simple avertissement, et la levée est horodatée pour rester traçable dans l'export de preuve. Les autres alertes bloquantes gardent leur blocage : elles ont toutes une issue réelle.
- Ne soumet plus deux fois la même requête chez Leclerc. Mesuré sur le vrai site : quand le nom du produit commence déjà par sa marque (« HERTA LE BON PARIS Jambon... »), l'étape « nom seul » se réduit au premier mot significatif — soit exactement la requête de l'étape « marque seule » jouée juste après. Une recherche entière pour rien, par produit concerné et par comparatif.
- Unifie le nom du projet sous « Comparateur de Paniers » (application, connecteur, documentation), et ajoute au dépôt public un guide de contribution, un code de conduite, un document d'architecture et un modèle de proposition de modification. La documentation de sécurité et de confidentialité passe en français.

- Répare la mémoire de recherche Leclerc, qui ne faisait plus gagner le temps qu'elle promettait : elle retient l'étape de recherche qui avait trouvé chaque produit la fois précédente pour repartir directement de là, mais un décalage interne (introduit en retirant la recherche par code-barres, inutile chez Leclerc) lui faisait rejouer quand même l'étape précédente — une recherche entière perdue par produit et par comparatif, pour tous les produits non trouvés du premier coup. Si l'étape mémorisée ne trouve plus rien (catalogue du magasin modifié entre deux comparatifs), le produit est désormais rejoué une fois avec la recherche complète au lieu d'être déclaré introuvable puis ignoré pendant 14 jours.
- Ajoute au diagnostic téléchargeable l'étape de recherche qui a réellement fourni chaque prix, et un outil d'analyse hors ligne (`node tools/analyse-cascade.mjs <dossier>`) qui agrège plusieurs diagnostics pour mesurer quelles méthodes de recherche aboutissent le plus souvent et combien de temps chacune coûte. Objectif : décider l'ordre des recherches sur des mesures réelles plutôt qu'au jugé.

- Corrige la perte du rapport de fin de remplissage de panier quand la page se recharge en cours de route (persistance côté extension + reprise automatique au chargement).
- Corrige un faux "tu n'es pas connecté" chez Hyper U alors que l'utilisateur l'était bien (lien de déconnexion caché dans un menu fermé par défaut, non détecté par l'ancien filtre de visibilité).
- Corrige le même faux "tu n'es pas connecté" chez Leclerc, qui bloquait le remplissage entier avant même la première recherche : sur l'accueil du Drive mobile, "Mon compte" et "Se déconnecter" ne sont pas dans la page tant que le menu n'est pas ouvert. Deux preuves de session supplémentaires sont désormais acceptées, choisies parce qu'elles n'existent jamais sur une page déconnectée : un lien de déconnexion reconnu à son adresse (son libellé peut n'être qu'une icône) et le bandeau "Dernière connexion le ...". Comme avant, aucune donnée de compte ne sort dans le diagnostic — seul le code du motif détecté.
- Corrige les quantités doublées au panier Leclerc : après le premier ajout, la fiche remplace le bouton "Ajouter" par un compteur "− 1 +" que l'extension ne reconnaissait pas. Elle croyait avoir échoué, cherchait un nouveau bouton d'ajout et tombait sur le "+" du compteur — une unité de plus à chaque tentative, et un ajout réussi rapporté comme un échec. Le compteur est maintenant reconnu, ses commandes ne peuvent plus être prises pour un bouton d'ajout, et un produit déjà au panier n'est jamais réactivé.
- Corrige la cause du "le comparatif refait toutes les recherches" côté Leclerc : la relecture d'une fiche produit dont l'adresse était déjà connue partait en erreur de programmation silencieuse (un paramètre interne jamais transmis au collecteur), immédiatement rattrapée par un repli sur la recherche par nom. Résultat : depuis l'ouverture de ce chemin, une correction validée à la main chez Leclerc n'a en réalité JAMAIS été relue — chaque comparatif repartait d'une recherche, avec le risque de retenir un autre produit.
- Mémorise l'adresse exacte de la fiche de chaque produit déjà trouvé, magasin par magasin, et la relit directement au comparatif suivant au lieu de refaire la recherche. Plus rapide, et surtout plus fiable : plus de cascade de recherche qui repart de zéro et retombe parfois sur un autre article. Trois garde-fous : rien n'est mémorisé pour une correspondance incertaine ou un produit rejeté (on ne fige pas une erreur), la fiche atteinte est revérifiée à chaque fois (nom, et code-barres quand il est connu des deux côtés), et au moindre doute la recherche normale reprend la main. Ce raccourci ne confère aucune confiance supplémentaire : contrairement à une validation manuelle, il reste un résultat automatique ordinaire.
- Corrige un « champ de recherche introuvable » chez Leclerc introduit par la lecture directe des fiches mémorisées. Une fiche Leclerc est une page complète qui ne contient aucune zone de recherche : tant que l'onglet y est resté, le produit suivant ne pouvait pas être cherché. Deux causes cumulées, corrigées ensemble : l'onglet ne quittait la fiche que lorsque la lecture directe avait ÉCHOUÉ (après une lecture réussie, il y restait), et le retour vers la page de recherche se contentait d'une pause fixe de 2 secondes là où le rechargement de la page prend un temps variable. Désormais l'onglet revient sur la page de recherche systématiquement avant toute recherche, et attend d'avoir réellement quitté la fiche (jusqu'à 10 secondes, vérifiées) avant de continuer.
- Rend actionnable l'avertissement "correspondance probable" du comparatif : il portait déjà le pourcentage de ressemblance, mais aucun moyen d'y donner suite. Un bouton "Confirmer la fiche" permet maintenant de désigner le bon produit directement sur la page du magasin — une seule fois suffit, la fiche est ensuite relue telle quelle à chaque comparatif. Le panneau "Produits à valider" indique en plus combien de produits reposent sur une simple ressemblance de nom, au lieu d'afficher "aucun produit à valider" alors que la moitié du panier était dans ce cas.
- Corrige l'ajout de mauvais produits au panier Hyper U : navigation directe vers la fiche produit exacte déjà validée (vérifiée par code-barres avant tout clic), avec repli automatique sur la recherche par nom si le lien est absent ou périmé.
- Corrige un mauvais code-barres lu sur une fiche produit Hyper U quand des articles sont déjà présents dans le panier (mini-panier) : la lecture ciblait par erreur la première fiche mini-produit du DOM au lieu du produit réellement affiché, provoquant un faux rejet du bon lien et un ajout du mauvais produit après repli sur la recherche par nom. Corrige aussi le choix du bouton "Ajouter au panier" quand plusieurs éléments partagent le même libellé sur la même fiche.
- Corrige une recherche Leclerc qui pouvait échouer en silence ("produit introuvable") quand le site pousse une page de résultats dont l'adresse est mal encodée deux fois : la page atterrissait sur un contenu générique sans aucun résultat ni message d'erreur exploitable.
- Corrige un ajout au panier Leclerc qui échouait ("produit introuvable") sur la route de recherche mobile alors que la page affichait bien des résultats : le déclenchement du chargement différé (lazy-load) ne scrollait qu'un conteneur interne absent sur cette route (c'est la fenêtre elle-même qui défile), et un repli de lecture des cartes pouvait en plus confondre un lien de pied de page ("Rappel produit") avec un résultat de recherche.
- Utilise enfin, pour l'ajout au panier Leclerc, l'URL exacte de la fiche produit quand elle a été validée manuellement par l'utilisateur (bouton "✓ Valider ce produit") : jusqu'ici cette URL était bien enregistrée mais totalement ignorée, et l'ajout au panier repartait systématiquement sur une recherche par nom pouvant retenir un autre produit. Repli automatique sur la recherche par nom si le lien s'avère périmé ou ne correspond plus — corrige au passage un échec de ce repli lui-même ("produit introuvable" alors que la recherche n'avait même pas pu démarrer) : la fiche produit standalone atteinte n'a aucune zone de recherche exploitable, l'onglet revient donc explicitement sur la page de recherche avant toute tentative de repli.
- Corrige un blocage indéfini du comparatif, sans erreur ni diagnostic, quand la lecture d'une page reste bloquée (onglet déchargé par Android en pleine collecte, page qui ne finit jamais de charger) : un délai maximal de 10 secondes interrompt désormais proprement l'opération et relance avec un onglet neuf plutôt que de bloquer la collecte indéfiniment.
- Affiche un message clair (« le site Leclerc Drive est momentanément indisponible ») quand la collecte tombe sur la page d'erreur technique du site, au lieu d'un code générique.
- Corrige un blocage systématique de la recherche Leclerc sur certains produits (ex. un pourcentage dans le nom, "reduit de 30%") : le caractère `%` fait planter le site Leclerc lui-même (redirection immédiate vers sa page d'erreur), il n'est désormais plus jamais envoyé dans une requête de recherche — le reste du nom, lui, est toujours utilisé pour reconnaître le bon produit.

### Durcissement face aux changements des sites marchands

- Refuse désormais tout code-barres qui ne passe pas la clé de contrôle officielle (GS1). Les fiches et cartes produit étaient lues avec une règle « la première suite de 8 à 14 chiffres du texte est le code-barres » : un numéro de service client, une référence de commande ou une date pouvait donc devenir un faux code-barres — or un code-barres identique vaut correspondance PARFAITE lors du choix du produit et sert de critère de rejet avant l'ajout au panier. Les codes issus d'un attribut du site sont eux aussi vérifiés, et côté Leclerc l'attribut du site prime maintenant sur le texte de la carte (qui peut couvrir plusieurs produits à la fois).
- Ne clique plus un magasin ou un drive sur sa seule position dans la page : le libellé retenu est revérifié juste avant le clic. Si la liste a été rechargée entre-temps (résultats affinés, bandeau cookies refermé, carte chargée en différé), la même position désignait un AUTRE magasin — et donc tous les prix relevés ensuite venaient du mauvais magasin, sans le moindre signal.
- Écarte des montants qui ne sont pas le prix de l'article quand la lecture doit se rabattre sur le texte de la page (structure du site modifiée, ou magasin pas encore sélectionné) : bulle d'économie, prix barré « au lieu de », seuil de livraison gratuite, cagnotte, prix au litre ou au kilo. Un prix faux est pire qu'une absence de prix : il s'affiche comme certain et fausse toute la comparaison entre magasins.
- Complète les messages d'erreur affichés après un rafraîchissement : une trentaine de codes techniques ressortaient tels quels, en majuscules, sans explication.
- Ajoute des tests qui verrouillent la cohérence entre le bouton « ✓ Valider ce produit » et la lecture automatique des fiches, chez les deux enseignes. Ces deux lectures sont deux copies séparées du même code (contrainte technique du navigateur) et pouvaient jusqu'ici diverger en silence : un correctif appliqué à une seule des deux laissait le choix manuel relever un autre prix que la comparaison automatique.
- Continue de lire le prix exact chez Hyper U même si le site renomme le bloc où il est affiché : la valeur numérique du prix est désormais recherchée ailleurs sur la fiche avant de se rabattre sur le texte affiché, en ignorant le mini-panier et les carrousels de suggestions (dont les prix concernent d'autres articles).
- Retrouve le bouton « Ajouter au panier » d'une fiche Hyper U même si son libellé d'accessibilité change. Ce repli n'est utilisé que s'il désigne le bouton sans ambiguïté : en cas de doute, l'ajout échoue proprement plutôt que de risquer de mettre un produit d'un carrousel dans le panier réel.
- Vérifie que chaque unité demandée a bien été ajoutée. Les clics successifs sur le « + » n'étaient jamais contrôlés : un clic absorbé par le site laissait moins d'unités que prévu dans le panier, sans aucun signal. Le compteur affiché est maintenant relu après chaque clic, avec deux nouvelles tentatives au plus, et la quantité demandée n'est jamais dépassée.
- Signale dans le journal technique quand un prix n'a pu être lu que par la méthode de dernier recours, chez les deux enseignes. C'est le signe que le site a changé de structure : le problème devient visible pendant que la lecture fonctionne encore, au lieu d'être découvert une fois qu'un prix faux est déjà affiché.

## 0.1.3 - 2026-07-17

- Nettoyage du README public et ajout de `PRIVACY.md`.
- Ajout d'un audit professionnel versionné du projet.
- Ajout de Dependabot pour `npm` et GitHub Actions.
- Suppression du composant temporaire `ScanPageFixed`.
- Durcissement de l'import backup JSON avec limite de taille et validation de date d'export.
- Extension de `privacy:check` aux imports et ressources distants.

## 0.1.2 - Publication GitHub

- Ajout de la licence MIT.
- Ajout de `SECURITY.md` pour documenter les limites privacy/offline et le signalement responsable.
- Ajout d'une checklist de validation : commandes et smoke tests manuels.
- Ajout de la CI GitHub Actions pour `test`, `typecheck`, `privacy:check` et `build`.
- Ajout de templates d'issues GitHub privacy-safe.
- Ajout de fichiers `.github/project/` pour structurer le backlog public.
- Mise à jour du README pour pointer vers les documents publics publiés.

## 0.1.1 - Corrections UX et comparaison

- Déplace le bandeau de navigation principal en haut de l'application.
- Corrige l'édition des quantités de liste pour éviter la suppression involontaire d'un produit.
- Rend l'ajout depuis le scan code-barres explicite avec un bouton d'ajout à la liste.
- Ignore les URL relatives pour l'ajout panier expérimental afin d'éviter les pages locales introuvables.
- Ajoute une prévisualisation de l'export JSON avant téléchargement.
- Calcule les totaux connus de comparaison même quand certains produits restent à valider.
- Ajoute des tests de régression pour ces corrections.

## 0.1.0 - Initialisation

- Ajout du squelette Vite + React + TypeScript.
- Ajout d'une navigation mobile-first.
- Ajout des pages MVP de base.
- Ajout des scripts `dev`, `build`, `test` et `typecheck`.
- Ajout d'un test Vitest de navigation.
- Ajout du stockage local IndexedDB via Dexie.
- Ajout du seed de produits de démonstration.
- Ajout du bouton de réinitialisation des données de démonstration.
- Ajout du CRUD produit local avec validation minimale.
- Ajout de la page Scan avec fallback de saisie manuelle locale.
- Ajout de la liste de courses active persistante.
- Ajout des adapters magasins mockés Leclerc et Hyper U.
- Ajout du moteur de comparaison pur avec scoring, seuil d'économie et gestion des validations.
- Ajout de la page Comparaison branchée sur la liste active et les prix locaux.
- Ajout d'un backfill local non destructif pour compléter les candidats/prix mockés des anciens profils IndexedDB.
- Ajout de l'actualisation des prix à l'ouverture de la comparaison et via bouton manuel, avec conservation des anciens prix en cas d'erreur adapter.
- Ajout du manifest PWA, de l'icône locale, du service worker statique et de la documentation Android/Capacitor future.
- Ajout de `npm run privacy:check` pour bloquer les primitives réseau hors allowlist service worker.
- Ajout du flag local « ajout panier expérimental » et d'une action manuelle visible vers produit/recherche magasin, sans automatisation cachée.
- Ajout de l'export/import JSON local avec version de sauvegarde, validation minimale et confirmation avant remplacement.
