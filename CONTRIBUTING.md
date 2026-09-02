# Contribuer

Merci de l'intérêt porté à ce projet. Il est développé sur du temps personnel : les réponses peuvent prendre quelques jours.

## Avant d'ouvrir une contribution

- **Un bug ?** Ouvre une issue avec le modèle « Signaler un bug ». Précise le navigateur, le système, et l'enseigne concernée (Leclerc Drive ou Courses U) si le problème vient de la collecte de prix.
- **Une idée ?** Ouvre une issue avec le modèle « Proposer une amélioration » avant d'écrire du code. Le projet a un périmètre volontairement restreint (voir ci-dessous) ; autant vérifier ensemble que l'idée y entre.
- **Une faille de sécurité ?** Ne l'ouvre pas en issue publique : suis la procédure de [`SECURITY.md`](SECURITY.md).

## Périmètre du projet

Ces choix ne sont pas des limitations temporaires, ce sont des décisions de conception. Une contribution qui les remet en cause sera refusée, quelle que soit sa qualité technique :

- **Aucun serveur, aucun compte, aucune télémétrie.** Toutes les données restent dans le navigateur de l'utilisateur.
- **Aucune automatisation de la connexion** à un compte marchand : c'est un geste humain volontaire.
- **Aucune validation de commande ni accès au paiement.** L'application prépare un panier, l'utilisateur vérifie et valide lui-même sur le site officiel.
- **Aucun contournement de protection anti-robot** ni résolution automatique de captcha.
- **Le connecteur ne clique jamais sur un bouton de consentement à la place de l'utilisateur** — il peut refuser les cookies non essentiels, jamais les accepter.

## Mise en route

```bash
npm install
npm run dev
```

Le serveur affiche une adresse locale en HTTPS (certificat local généré automatiquement).

## Avant de proposer une modification

Ces quatre commandes doivent passer — ce sont exactement celles que l'intégration continue exécute :

```bash
npm run test
npm run typecheck
npm run privacy:check
npm run build
```

`privacy:check` refuse tout appel réseau applicatif ajouté hors de la liste autorisée. S'il échoue sur une modification légitime, c'est que la liste doit être discutée : explique le besoin dans la description de la contribution plutôt que d'élargir la liste sans commentaire.

## Style attendu

- **Le code est en anglais, les commentaires et les messages de commit en français.** C'est la convention du projet.
- **Un commentaire explique le *pourquoi*, pas le *quoi*.** Le code dit déjà ce qu'il fait ; le commentaire dit pourquoi il le fait ainsi, et surtout ce qui a été essayé avant. Les commentaires existants suivent cette règle — regarde `extension/adapters/leclerc/` pour le ton.
- **Tout correctif de comportement vient avec un test qui échouait avant.** Les sites des enseignes changent : sans test, une correction se perd au premier remaniement.
- **Modifications ciblées.** Pas de remaniement large glissé dans une correction de bug.

## Messages de commit

Une ligne de titre qui décrit l'effet pour l'utilisateur, pas le fichier touché. Puis, si nécessaire, un corps qui explique le pourquoi et les cas réels observés.

```
Leclerc : ne plus refaire toutes les recherches à chaque comparatif

Le comparatif rejouait la cascade pour chaque produit, y compris ceux déjà
trouvés — d'où la lenteur et les retours sur un autre article quand le
catalogue avait bougé.
```

## Tester le connecteur Firefox

```bash
npm run extension:build:firefox:dev
```

Charge le dossier produit comme extension temporaire dans Firefox (`about:debugging`). Le build sans `--dev` ne dialogue qu'avec le site publié : c'est celui-là seul qui est distribué.

Un rappel utile : les fonctions injectées dans les pages des enseignes sont reconstruites depuis leur code source et **ne voient aucune variable extérieure**. Tout ce dont elles ont besoin doit leur être passé en argument, sinon l'erreur est silencieuse.
