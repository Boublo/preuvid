# Preuvid — feuille de route

État au 18 novembre 2026 : dépôt créé à partir d'Idswyft v1.12.39, aucun code Preuvid écrit.
Six lots dans l'ordre, puis une étude (lot 6). Chaque lot se termine par ses critères de fin, pas par une date.

## Point de départ mesuré

Banc de 192 images synthétiques (8 identités × 3 pièces × 8 conditions), part des images dont tous les
champs sont lus sans erreur :

| Pièce | Idswyft 1.12.39 | Cible lot 1 |
|---|---|---|
| CNI 2021, verso (`/extract/back`) | 0 % | 90 % |
| CNI 2021, via `/front` | 69 % | 90 % |
| Ancienne CNI | 3 % | 85 % |
| Passeport | 8 % | 90 % |

Les cibles sont des objectifs fixés avant tout travail, pas des résultats.
Non mesuré à ce jour : comparaison de visage, détection de présence, détection de faux document,
coût machine par vérification.

Défauts identifiés dans le moteur :
- le verso passe par Tesseract, qui transforme les `<` en lettres ;
- aucun redressement : 7° de rotation ou de perspective donne 0 % ;
- les prénoms sont perdus ;
- aucune correction par les clés de contrôle (confusions O/0, I/1…) ;
- le moteur plante si le téléchargement d'un modèle échoue au démarrage ;
- le modèle de détection de deepfake est absent de l'image publique.
La bibliothèque `mrz` décode correctement les trois formats français quand on lui donne les bonnes lignes.

## Lot 0 — Socle

But : un dépôt qui se construit, se teste et se mesure sans surprise.

- [ ] La pile démarre en local avec Docker Compose, les tests existants passent (noter ceux qui échouent d'origine).
- [ ] Retirer `watchtower` du compose (mise à jour automatique d'images en production : refusé).
- [ ] Figer tous les modèles dans l'image du moteur (Tesseract `eng.traineddata`, modèles PaddleOCR,
      face-api) : aucun appel réseau au démarrage ni à la première requête. Somme de contrôle vérifiée au build.
- [ ] Le moteur ne plante plus sur une erreur de chargement : il répond une erreur claire.
- [ ] Intégration continue GitHub Actions : lint, tests, construction des images. Écrire nos propres
      workflows (ceux d'Idswyft sont archivés dans `docs/amont/`).
- [ ] Banc lancé par une seule commande, scores écrits dans `preuvid/banc/scores/` ; retrouver les
      chiffres de référence ci-dessus à ±2 points.
- [ ] `.env.example` relu : aucun secret par défaut utilisable en production.

Fin du lot : `docker compose up` sur une machine vierge sans accès Internet après le build, tests verts,
banc reproductible.

## Lot 1 — Lecture des pièces françaises

But : atteindre les cibles du tableau.

- [ ] Verso et bande MRZ lus par PaddleOCR (ou un modèle dédié OCR-B), plus par Tesseract.
- [ ] Redressement avant lecture : détection des quatre coins, correction de perspective et de rotation.
- [ ] Localisation de la bande MRZ, puis décodage par la bibliothèque `mrz` (TD1 CNI 2021, format
      ancienne CNI 2 × 36, TD3 passeport).
- [ ] Correction par clés de contrôle : essayer les confusions usuelles (O/0, I/1, B/8, S/5, Z/2) tant que
      la clé est fausse ; ne jamais « corriger » un champ dont la clé est juste.
- [ ] Prénoms conservés (tous, dans l'ordre).
- [ ] Réponse du moteur : pour chaque champ, valeur, clé de contrôle (juste / fausse / corrigée), confiance.
- [ ] Étendre le banc : titre de séjour, permis format carte, reflets, doigt sur la carte.
- [ ] Mesurer le temps et la mémoire par image ; en déduire un premier coût par vérification.

Fin du lot : cibles atteintes ou écart expliqué par écrit, aucun champ faux présenté comme sûr.

## Lot 2 — API Preuvid v1

But : l'interface que les clients intègrent. Détail dans `preuvid/docs/api.md`.

- [ ] `POST /v1/sessions`, `GET /v1/sessions/{id}`, `GET /v1/sessions/{id}/decision`, `DELETE /v1/sessions/{id}`.
- [ ] Clés d'API par application, séparées test / production, hachées en base, affichées une seule fois.
- [ ] Webhooks signés HMAC-SHA256 avec horodatage, identifiant d'événement, reprises espacées, rejeu manuel.
- [ ] Idempotence sur la création de session ; limites de débit par clé.
- [ ] Motif lisible avec chaque décision (« clé de contrôle fausse », « visage 71 sur 100 »).
- [ ] Renommage : domaines `api.preuvid.fr` / `verif.preuvid.fr`, en-têtes, textes. Retirer le nom et les
      marques Idswyft de tout ce qui est visible (voir `TRADEMARK.md`), garder la licence MIT et la mention d'origine.
- [ ] Documentation OpenAPI générée et exemples curl.

Fin du lot : un site de test crée une session, la personne fait le parcours, le site reçoit le webhook et le vérifie.

## Lot 3 — Parcours de vérification et passe majeur

But : les écrans mobiles des maquettes 03 à 10. Détail dans `preuvid/docs/verification-age.md`.

- [ ] Parcours identité en cinq écrans : choix de la pièce, photo avec déclenchement automatique et
      voyants (netteté, reflets, quatre coins), lecture, visage, résultat.
- [ ] Parcours âge : première vérification, création du passe, confirmation aux visites suivantes.
- [ ] Passe majeur : preuve « majeur » liée au téléphone par WebAuthn (clé d'accès), sans nom ni photo ;
      validité d'une confirmation limitée à la visite, expirée après une heure d'inactivité ;
      rien de stocké dans un compte du site client.
- [ ] Double anonymat : le site ne reçoit que « majeur oui/non » ; Preuvid n'enregistre pas quel site est visité.
- [ ] Étude de faisabilité, avant tout code : lecture de la puce NFC de la CNI 2021 et du passeport depuis
      un navigateur mobile (sans appli). Rendre un avis écrit : possible, possible avec appli, impossible.
- [ ] Accessibilité : cibles tactiles de 44 px, contrastes, lecteur d'écran, animations réduites respectées.
- [ ] Mesurer le taux d'abandon et la durée par étape (sans donnée personnelle).

Fin du lot : parcours complet sur iPhone et Android réels, en moins de deux minutes pour l'identité.

## Lot 4 — Espace client, administration, facturation à l'usage

But : les maquettes 01 et 02. Détail dans `preuvid/docs/facturation.md`.

- [ ] Espace client, cinq rubriques : vérifications, à revoir, parcours, consommation, intégration.
      Aucun nom dans les listes ; l'ouverture d'une fiche est inscrite au journal.
- [ ] Administration : revue manuelle (motif en premier, photos masquées par défaut, panneau de décision
      fixe, raccourcis V / R / P), clients, moteur et seuils, journal d'audit, facturation.
- [ ] Registre de crédit prépayé : chaque brique consommée écrit une ligne ; le registre est la source de vérité.
- [ ] Recharges par Mollie (reprendre le code du satellite de paiement), recharge automatique,
      alertes à 20 % et 5 %, plafond mensuel, découvert toléré court.
- [ ] Double authentification obligatoire pour l'administration (le service TOTP existe déjà).

Fin du lot : un client s'inscrit, recharge, consomme, voit sa consommation ; un opérateur traite un dossier.

## Lot 5 — Site, production, conformité

- [ ] Site `preuvid.fr` selon la maquette 00 : accueil, identité, âge, tarifs, développeurs, liste d'attente.
      Pages et titres du dossier SEO.
- [ ] Registre du pied de page : décider avec David entre activité réelle et démonstration étiquetée.
- [ ] Déploiement sur le VPS : pare-feu (80/443 seuls), sauvegardes chiffrées et test de restauration,
      journaux sans donnée personnelle, supervision et page d'état.
- [ ] Chiffrement des photos au repos (AES-256-GCM par enveloppe, déjà présent en mode S3), suppression
      automatique après `[DÉLAI]`, suppression à la demande.
- [ ] Dossier RGPD : registre des traitements, analyse d'impact (données biométriques), contrat de
      sous-traitance type, mentions d'information.
- [ ] Test d'intrusion externe avant l'ouverture.

Fin du lot : premier client réel en production.

## Lot 6 — Étude : estimation d'âge par le geste de la main

But : savoir si Preuvid peut proposer une estimation d'âge sans visage, sur le principe de BorderAge
(Needemand, Montpellier). C'est une étude, pas un développement : aucun code produit avant ses conclusions.
Elle peut être menée en parallèle des lots 2 à 5.

- [ ] État de l'art : publications sur l'âge et la motricité de la main, méthodes (points de repère de la
      main par image, séries temporelles), précision publiée autour de 18 ans.
- [ ] Brevets : rechercher les brevets et demandes de Needemand et d'autres (INPI, OEB). Sans liberté
      d'exploitation établie par un conseil en propriété industrielle, on ne développe pas.
- [ ] Données : un modèle exige des milliers de vidéos de mains d'âges connus, mineurs compris. Chiffrer
      le recueil (consentement, accord parental, CNIL) ou trouver un jeu de données sous licence.
- [ ] Prototype de laboratoire sur données libres ou d'adultes volontaires : suivi des points de la main
      (par exemple MediaPipe Hands), mesure honnête de l'erreur. Jamais branché sur le produit.
- [ ] Exigences Arcom : aucun mineur pris pour un majeur, absence de biais, résistance aux vidéos rejouées.
- [ ] Alternative : demander à Needemand une offre en marque blanche et comparer coût et délai.

Fin du lot : une note de décision pour David — développer, acheter, ou abandonner — avec budget et délai.

## Ce qui dépend de David

| Sujet | Bloque |
|---|---|
| Adresse, taille et accès du VPS satellite | Lot 5 |
| Recherche d'antériorité INPI sur « Preuvid », achat des domaines | Lot 2 (renommage), lot 5 |
| Prix par brique et crédit offert | Lot 4, site |
| Délai de conservation des photos (30 jours proposés) | Lots 3 et 5 |
| Avocat : contrat, mentions, lecture du référentiel Arcom sur la preuve réutilisable | Lots 3 et 5 |
| Création de la société (David gérant) | Encaissement réel |

## Plus tard, hors feuille de route

Certification iBeta niveau 1 (détection de présence), puis ISO 27001 ; audit indépendant Arcom ;
portefeuille d'identité européen.
