# Vérification d'âge : le passe majeur (lot 3)

## Idée

La pénibilité vient de la répétition. La personne prouve sa majorité une fois, garde une preuve anonyme dans
son téléphone, puis confirme en un geste à chaque visite.

1. **Première fois** : pièce d'identité photographiée, puis selfie avec détection du vivant et comparaison
   à la photo de la pièce (détail et limites : `double-anonymat.md`, « Première vérification »). Puce NFC :
   impossible depuis un navigateur (`nfc-faisabilite.md`). Estimation par le visage seul : en mode test.
2. **Création du passe** : preuve « majeur », sans nom ni photo, liée à l'appareil par WebAuthn (clé d'accès).
   Le déverrouillage du téléphone sert de second facteur.
3. **Visites suivantes** : un bouton, déverrouillage, entrée. Objectif : environ trois secondes (non mesuré).

## Contraintes du référentiel Arcom (octobre 2024)

Lecture de travail, à faire confirmer par l'avocat :

- prestataire indépendant du site, juridiquement et techniquement ;
- le site n'accède à aucune donnée de vérification ; au moins une méthode en double anonymat ;
- vérification à chaque consultation ; la validité prend fin avec la session, la fermeture du navigateur,
  la mise en veille, et au plus tard après une heure d'inactivité ;
- preuve réutilisable admise avec un second facteur, pouvant être liée au terminal, non partageable,
  jamais conservée dans un compte du site ;
- estimation faciale : détection du vivant, aucun mineur pris pour un majeur, biais évalués ;
- audit indépendant.

## Ce qu'on ne fait pas

- Pas d'estimation d'âge par surveillance du comportement ou de la navigation : intrusif sur un site adulte,
  non prévu par le référentiel, peu fiable autour de 18 ans. Les signaux de comportement servent seulement
  à détecter la fraude (robot, vidéo rejouée, passe partagé).
- Pas de carte bancaire comme méthode durable.

## Pistes à l'étude

- Puce NFC (lot 3, étude de faisabilité).
- Geste de la main (lot 6, étude complète).
- Signal d'âge du système (Apple, Google) et portefeuille d'identité, comme raccourcis futurs.
