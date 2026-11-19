# Preuvid — feuille de route

État au 19 novembre 2026 : lot 0 en revue (PR 1), lot 1 terminé et en revue. Dépôt créé à partir d'Idswyft v1.12.39.
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
- le moteur plante si le téléchargement d'un modèle échoue au démarrage (corrigé au lot 0) ;
- le modèle de détection de deepfake est absent de l'image publique.
La bibliothèque `mrz` décode correctement les trois formats français quand on lui donne les bonnes lignes.

## Lot 0 — Socle

But : un dépôt qui se construit, se teste et se mesure sans surprise.

- [x] La pile démarre en local avec Docker Compose, les tests existants passent (noter ceux qui échouent d'origine).
- [x] Retirer `watchtower` du compose (mise à jour automatique d'images en production : refusé).
- [x] Figer tous les modèles dans l'image du moteur (Tesseract `eng.traineddata`, modèles PaddleOCR,
      face-api) : aucun appel réseau au démarrage ni à la première requête. Somme de contrôle vérifiée au build.
- [x] Le moteur ne plante plus sur une erreur de chargement : il répond une erreur claire.
- [x] Intégration continue GitHub Actions : lint, tests, construction des images. Écrire nos propres
      workflows (ceux d'Idswyft sont archivés dans `docs/amont/`).
- [ ] Banc lancé par une seule commande, scores écrits dans `preuvid/banc/scores/` ; retrouver les
      chiffres de référence ci-dessus à ±2 points. *Une commande et reproductibilité : faits. ±2 points :
      non atteint (CNI 2021 −5, ancienne CNI +3), la référence du 18/11 n'est pas reproductible, voir
      le bilan.*
- [x] `.env.example` relu : aucun secret par défaut utilisable en production.

Fin du lot : `docker compose up` sur une machine vierge sans accès Internet après le build, tests verts,
banc reproductible.

### Bilan du lot 0 (19 novembre 2026)

**Tests d'origine.** Aucun test ne passait tels quels :
- `npm ci` refusait de s'exécuter, car `package-lock.json` et `frontend/package-lock.json` étaient
  désynchronisés de leurs `package.json` ;
- les images étaient construites par `npm install`, donc avec des versions différentes à chaque build ;
- `@idswyft/shared` ne compilait plus avec sharp 0.35 (dépendance pair restée en 0.34, types déplacés),
  ce qui cassait la résolution de `sharp` et des alias `@/` dans les tests du backend.

Après correction, sous Node 20 Linux, comme en CI :

| Paquet | Résultat |
|---|---|
| backend | 1286 réussis, 10 ignorés d'origine |
| moteur | 8 réussis (nouveaux : registre des modèles, réponse 503) |
| frontend | 48 réussis (aucun script `test` d'origine) |

Les quatre paquets passent `tsc --noEmit`. Il n'y a aucune configuration ESLint dans le dépôt : en CI, le
lint se limite pour l'instant à la vérification de types.

**Ce qui a changé.**
- `docker-compose.yml` :
  - watchtower est retiré ;
  - les images sont construites depuis le dépôt (`pull_policy: never`), jamais tirées de ghcr.io ;
  - les secrets sont obligatoires (`${VAR:?}`) ;
  - le moteur et la base sont sur un réseau interne sans sortie Internet ;
  - le contrôle de santé du moteur passe par `/ready`.
  - `docker-compose.build.yml` est fusionné dans `docker-compose.yml`.
  - `install.sh`, `update.sh` et `uninstall.sh` (tirage des images Idswyft, mise à jour automatique)
    sont archivés dans `docs/amont/scripts/`.
- Modèles :
  - `engine/models.manifest.json` liste les 17 fichiers, leurs sources (épinglées sur un commit ou une
    version) et leurs SHA-256 ;
  - `download-models.js` les récupère et les vérifie à la construction, puis une seconde fois dans
    l'image finale ;
  - PaddleOCR et Tesseract lisent des fichiers locaux (`langPath`, `cacheMethod: 'none'`) ;
  - l'image du moteur passe de 5,3 Go à 2,9 Go : le `chown -R /app` d'origine recopiait 1,5 Go dans une
    couche à part.
- Erreurs :
  - le moteur vérifie ses modèles au démarrage ;
  - `/health` donne leur état, `/ready` répond 503 si la lecture ou le visage est inutilisable ;
  - les routes concernées répondent 503 `MODELS_UNAVAILABLE` avec la liste des fichiers en cause ;
  - Tesseract reçoit un `errorHandler` : avant, une erreur du worker tuait tout le processus (code 7).
- Images :
  - les trois images sont installées par `npm ci` depuis les lockfiles ;
  - les dépendances de production sont réinstallées par `npm ci --omit=dev`, et l'image finale copie
    aussi les `node_modules` propres à chaque paquet (`engine/`, `backend/`, `shared/`) : npm y range les
    versions qui diffèrent de la racine, par exemple `dotenv` 17.4 pour le moteur et l'API ;
  - les fichiers du moteur appartiennent à root, et le processus tourne sous `nodeuser`, en lecture seule.
- Secrets :
  - `.env.example` et `.env.community` n'ont plus aucune valeur utilisable ;
  - `validateSecrets` refuse désormais les variantes longues des valeurs d'exemple (l'ancienne
    `your-super-secret-jwt-key-change-this-in-production` passait) et les chaînes sans entropie.
- CI :
  - `.github/workflows/ci.yml` (types, tests, construction des trois images, démarrage du moteur
    `--network none`) ;
  - `banc.yml`, à lancer à la main ;
  - les actions sont épinglées par SHA.

**Banc.** `python3 preuvid/banc/banc.py`, entièrement dans Docker, moteur sur un réseau sans Internet.
Score « TOUT » (tous les champs justes) :

| Pièce | Référence du 18/11 | Moteur d'origine, banc conteneurisé | Moteur du lot 0, hors ligne |
|---|---|---|---|
| CNI 2021, verso | 0 % | 0 % | 0 % |
| CNI 2021, via `/front` | 69 % | 64 % | 64 % |
| Ancienne CNI | 3 % | 6 % | 6 % |
| Passeport | 8 % | 8 % | 8 % |

- Le moteur du lot 0 donne les mêmes 256 réponses que le moteur d'origine passé le même jour dans le même
  banc (256/256 lignes MRZ identiques, aucun verdict changé). Les confiances ne diffèrent qu'à la sixième
  décimale (`onnxruntime` 1.26.0 du lockfile contre 1.31.1 dans l'image d'origine). Le lot 0 ne change
  donc pas la lecture.
- Le banc est déterministe sur cette machine : deux passages du moteur d'origine donnent les mêmes
  256 réponses, confiances comprises au chiffre près, et le moteur ne change pas de résultat avec 2 ou
  16 cœurs visibles. Reste à vérifier sur un autre processeur (premier passage de `banc.yml` en CI).
- L'écart de ±2 points avec la référence du 18/11 n'est **pas atteint** (CNI 2021 −5, ancienne CNI +3 ;
  11 lignes sur 256 diffèrent, et 172 confiances sur 181 même là où les lignes sont identiques). Cette
  référence n'est pas reproductible :
  - le moteur d'origine mesuré aujourd'hui a été construit sur cette machine le 19/11 à 01 h 08 UTC, depuis
    les sources 1.12.39, après la référence (18/11, 22 h 27 UTC) ; celui du 18/11 a été construit ailleurs,
    à un autre moment, et n'existe plus (ce n'est pas non plus l'image publiée par Idswyft, dont
    l'empreinte diffère) ;
  - le Dockerfile d'origine installe par `npm install` sans lockfile et télécharge des modèles non épinglés,
    donc chaque construction peut changer les versions (`onnxruntime` 1.31.1 aujourd'hui, une version
    qu'aucun lockfile ne mentionne) ;
  - le banc d'origine installait Pillow, OpenCV et NumPy sans version.
  C'est le défaut que le lot 0 corrige ; la décision de changer de référence revient à David (point 6
  ci-dessous).
- Fichiers : `preuvid/banc/scores/2026-11-19-idswyft-1.12.39*` (moteur d'origine) et
  `2026-11-19-lot-0*` (moteur du lot 0).

**Écarts et points ouverts.**
- Détecteur de deepfake : absent. Le fichier publié par Idswyft renvoie 404, et le détecteur se désactive seul
  (inscrit dans `absents` du manifeste).
- Lint : aucune configuration ESLint d'origine (backend en ESLint 10, frontend en ESLint 8). Seuls les
  types sont vérifiés. Une configuration minimale reste à écrire, sans corriger le code en masse.
- `docker-compose.dev.yml` désigne des services qui n'existent plus (`vaas-backend`, `nginx`). Il n'a pas été
  touché.
- L'API garde des appels sortants qui échouent proprement sans Internet : liste Tor au démarrage, liste
  OFAC, OAuth GitHub, fournisseurs SMS et e-mail. Vérifié une fois : pile complète avec les deux réseaux
  coupés d'Internet, base neuve, les quatre services sains, l'API joint le moteur et la liste Tor échoue
  sans bloquer.
- Sur une machine vierge, `docker compose pull --ignore-buildable` doit tourner avant de couper le réseau :
  l'image `postgres:16-alpine` (et `caddy` pour HTTPS) vient de Docker Hub, `build` ne la tire pas.
- `geoip-lite` 2.0.2 demande Node 24, alors que les images sont en Node 20 (simple avertissement, tests verts).

**À trancher par David (non traité, hors lot 0).**
1. Cache de PaddleOCR (`ppu-paddle-ocr` 4.1.1) :
   - il garde en mémoire les 10 derniers résultats, indexés sur les 1024 premiers octets de l'image et sa
     taille ;
   - deux images qui partagent ces octets reçoivent le même résultat, et des données personnelles restent
     en mémoire ;
   - correctif d'une ligne : `recognize(…, { noCache: true })`, à passer au banc.
2. CORS : `backend/src/config/index.ts` autorise toujours `idswyft.app`, `www.idswyft.app` et
   `staging.idswyft.app`, quel que soit `CORS_ORIGINS`.
3. Chiffrement des pièces stockées : `STORAGE_ENCRYPTION` est désactivé par défaut. Il n'est pas passé
   par le compose, donc les photos de pièces sont en clair dans le volume `uploads`.
4. Journaux de l'API en production : ils sont écrits dans `logs/` à l'intérieur du conteneur, sans volume
   ni rotation au-delà de 5 × 5 Mo, et leur contenu n'a pas été relu.
5. La CSP du frontend autorise des scripts venus de `docs.opencv.org` (chargement externe côté client).
6. Nouvelle référence du banc. La référence du 18/11 n'est pas reproductible (voir « Banc »). Proposition :
   prendre comme ligne de base le passage du moteur du lot 0 (`scores/2026-11-19-lot-0.txt` :
   0 / 64 / 6 / 8 %), qui se reconstruit à l'identique depuis le commit (lockfile et modèles épinglés), et
   mettre à jour le tableau du point de départ. Il donne les mêmes 256 réponses que le moteur d'origine
   construit aujourd'hui, dont l'image (`preuvid-engine:idswyft-1.12.39`) n'existe que sur cette machine
   et est conservée. Les fichiers `*-reference-*` et le tableau n'ont pas été modifiés.

## Lot 1 — Lecture des pièces françaises

But : atteindre les cibles du tableau.

- [x] Verso et bande MRZ lus par PaddleOCR (ou un modèle dédié OCR-B), plus par Tesseract.
- [x] Redressement avant lecture : détection des quatre coins, correction de perspective et de rotation.
- [x] Localisation de la bande MRZ, puis décodage par la bibliothèque `mrz` (TD1 CNI 2021, format
      ancienne CNI 2 × 36, TD3 passeport).
- [x] Correction par clés de contrôle : essayer les confusions usuelles (O/0, I/1, B/8, S/5, Z/2) tant que
      la clé est fausse ; ne jamais « corriger » un champ dont la clé est juste.
- [x] Prénoms conservés (tous, dans l'ordre).
- [x] Réponse du moteur : pour chaque champ, valeur, clé de contrôle (juste / fausse / corrigée), confiance.
- [x] Étendre le banc : titre de séjour, permis format carte, reflets, doigt sur la carte.
- [x] Mesurer le temps et la mémoire par image ; en déduire un premier coût par vérification.
      *Coût exprimé en temps machine ; le prix en euros attend `[PRIX DU SERVEUR]`.*

Fin du lot : cibles atteintes ou écart expliqué par écrit, aucun champ faux présenté comme sûr.

### Bilan du lot 1 (19/11/2026)

**Scores** (`preuvid/banc/scores/2026-11-19-lot-1-lecture.txt`, socle de 192 images inchangé, part des
images dont tous les champs sont justes) :

| Pièce | Idswyft 1.12.39 | Lot 0 | Lot 1 | Cible |
|---|---|---|---|---|
| CNI 2021, verso (`/extract/back`) | 0 % | 0 % | 95 % | 90 % |
| CNI 2021, via `/front` | 69 % | 64 % | 95 % | 90 % |
| Ancienne CNI | 3 % | 6 % | 94 % | 85 % |
| Passeport | 8 % | 8 % | 97 % | 90 % |

Les quatre cibles sont atteintes. **Aucun champ faux présenté comme sûr** (confiance ≥ 0,95) sur les
432 appels, extension comprise. `score.py` imprime désormais ce compte. Il porte sur le détail champ par
champ (`mrz_fields` de `/front`, `field_checks` de `/back`) et sur les champs de premier niveau `ocr.*`
de `/front` avec leurs `confidence_scores`, tels que l'API les rend. Sans MRZ trouvée, `/front` rend les
confiances de l'OCR telles quelles : une confiance haute n'y vaut pas vérification.

**Extension du banc** (168 images, notées à part pour que le tableau reste comparable au lot 0) :
- doigt sur la carte, sur les trois pièces du socle : 100 % sur la CNI 2021 (recto et verso) et sur le passeport, 88 % sur l'ancienne CNI ;
- titre de séjour (TD1 « IR », nationalité étrangère) : 86 %. Les échecs viennent du numéro, mal lu sur les images floues, en perspective, à reflet ou sombres ; il n'est jamais présenté comme sûr ;
- permis format carte (ligne `D1FRA` de 30 caractères) : 97 %.
Pas de cible pour l'extension.

**Ce qui a été fait (moteur)** :
- `engine/src/services/mrzReader.ts` : lecteur MRZ tolérant sur le texte de PaddleOCR. Il localise le
  bloc, retaille les lignes, rétablit le remplissage et l'en-tête, corrige par les clés (une seule
  substitution, et seulement si elle est unique), puis décode avec `mrz`. Pour chaque champ, il donne la
  valeur, la clé (juste / corrigée / fausse / sans clé) et la confiance. Formats lus : CNI 2021, ancienne
  CNI, passeport, titre de séjour, permis.
- `engine/src/services/mrzMerge.ts` : fusion MRZ et zone imprimée. Un champ à clé fausse n'est jamais
  repris. Un nom sans clé n'est « sûr » que si la zone imprimée dit la même chose.
- `engine/src/services/deskew.ts` : redressement par les quatre coins (OpenCV.js, déjà présent dans
  les dépendances). Il ne touche que les images inclinées ou en perspective. Sur le banc : 48/48, rien
  d'autre de modifié, environ 45 ms par image.
- `/extract/back` passe de Tesseract à PaddleOCR. Le faux `checksums_valid: true` de secours, renvoyé
  même pour des lignes non lues, est supprimé.
- `/front` et `/back` ne réencodent plus la photo en JPEG qualité 80 avant lecture (comportement
  d'Idswyft) : seulement si l'EXIF demande une rotation, et alors sans perte. Sur les images sombres et
  bruitées, le gain net est d'une image : `cni2021_04` et `_07` sont rattrapées, `cni2021_03` est perdue
  (prénom lu « ZNES »).

**Temps et mémoire** (moteur limité à 2 processeurs et 3 Gio, appels un par un) :
- par image : CNI 2021 recto 2,8 s, verso 3,1 s ; ancienne CNI 5,6 s ; passeport 7,0 s ;
- mémoire du moteur : pic 1 022 Mio, moyenne 907 Mio, à peu près constante ;
- une vérification CNI 2021 (recto et verso) prend donc environ 6 s de calcul sur 2 processeurs,
  soit environ 600 vérifications par heure pour une instance du moteur ;
- coût de lecture par vérification ≈ `[PRIX DU SERVEUR À L'HEURE]` / 600. La comparaison de visage
  et la détection de présence (lot 3) ne sont pas comptées. Le temps processeur exact n'est pas
  relevé (au plus 2 × le temps mesuré).

**Écarts et limites** :
- Deux images de la condition « sombre et bruité » lisaient bien les prénoms avec Idswyft et ne le font
  plus (`cni2021_03` et `_05`, via `/front`) : l'OCR lit « ZNES » et « IES » pour INES. `_05` était déjà
  perdue avant l'arrêt du réencodage, `_03` l'est depuis (voir plus haut). Ces prénoms n'ont
  pas de clé de contrôle, et le verso de la CNI 2021 ne les imprime pas : il n'y a rien pour recouper.
  Ils sont rendus avec une confiance de 0,9, donc non sûrs. C'est la condition la plus faible
  (62 % sur la CNI 2021).
- Les passages du banc ont révélé trois défauts, corrigés :
  - un titre de séjour émis par la France à un étranger se voyait attribuer l'État de sa nationalité ;
  - un nom de permis lu avec des zéros (« 0KAF0R ») était gardé ;
  - un numéro mal lu, dont seule la clé composite passait par hasard, sortait comme « sûr ». C'était le
    seul champ faux présenté comme sûr, sur 432 appels ;
  - quand la MRZ invalidait un champ, la valeur de l'OCR restait dans `ocr.*` avec sa propre confiance
    (souvent 0,99) : elle est maintenant plafonnée sous le seuil « sûr ».
  Chaque cas a son test. S'y ajoutent l'en-tête « IDFRA » de l'ancienne CNI lu « DFRA », et les prénoms
  du permis quand l'OCR perd le numéro de rubrique.
- Banc : la ligne MRZ du permis est imprimée sur l'image du recto, par simplification (elle est au verso
  sur le vrai titre).
- L'analyse de falsification de `/front` voit l'image avant redressement et avant la rotation de 90°.
  Elle voit maintenant le fichier d'origine (EXIF conservé) et non plus une copie réencodée.
- **À trancher par David avant la fusion : un verso illisible devient un rejet pour « falsification ».**
  - Le backend (gate 2) rejette pour falsification toute pièce dont `checksums_valid` est faux.
  - Avant ce lot, `/back` répondait `checksums_valid: true` même pour des lignes qu'il n'avait pas lues :
    la gate 2 ne se déclenchait jamais.
  - Il dit maintenant la vérité. Un verso que l'OCR n'arrive pas à lire est donc rejeté comme faux
    (sur le banc : 1 verso de CNI 2021 sur 64, une photo sombre et bruitée).
  - Proposition : distinguer « illisible, reprendre la photo » de « clé fausse », dans le backend.
- Hors lot 1, non modifiés :
  - le repli local du backend lit encore le verso avec Tesseract ;
  - `/extract/ocr` lit la date de naissance au format mois/jour (1952-08-01 au lieu de 1952-01-08).
- Cache de PaddleOCR (point 1 « À trancher ») : non modifié. La clé porte sur les 1 024 premiers octets
  du fichier encodé et sur sa taille ; une collision demande deux fichiers de même taille à l'octet.
  Aucune lecture d'une autre identité n'a été observée sur les 432 appels. Le risque sur les données en
  mémoire reste entier ; la décision revient toujours à David.

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
