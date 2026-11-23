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
1. Cache de PaddleOCR (`ppu-paddle-ocr` 4.1.1) : **correctif proposé au lot 2, en attente de l'accord
   de David** (voir le bilan du lot 2). `recognize(…, { noCache: true })` : plus aucun résultat gardé
   en mémoire entre deux requêtes. Scores du banc identiques, aucun coût en usage réel.
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
  d'autre de modifié, environ 45 ms par image. Sa mémoire est plafonnée : au-delà de 25 Mpx, l'image est
  réduite avant la remise à plat, et une image annoncée à plus de 268 Mpx n'est pas décodée. Sans ce
  plafond, un PNG de quelques Mo suffisait à saturer la mémoire du moteur. Banc relancé après le
  correctif (`scores/2026-11-19-lot-1-durci.txt`) : scores identiques, pic mémoire 973 Mio.
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
- coût de lecture par vérification ≈ `[PRIX DU SERVEUR À L'HEURE]` / 600.
- **Correction du 20/11/2026 (lot 2)** : le temps du recto de la CNI 2021 ci-dessus (2,8 s) était aidé par
  le cache de PaddleOCR. Le banc lit le même fichier en verso puis en recto, et le recto reprenait le
  résultat du verso. Avec deux photos distinctes, comme en vrai, le recto prend environ 6 s et le verso
  environ 4 s (mesure témoin du lot 2, avec et sans cache, même machine). Une vérification CNI 2021 prend
  donc environ 10 s de calcul, soit **350 à 400 vérifications par heure** et par instance du moteur, et
  non 600 : coût ≈ `[PRIX DU SERVEUR À L'HEURE]` / 375. Les temps « cni2021 / front » des fichiers de
  scores du lot 1 sont aidés par le cache de la même façon. La comparaison de visage
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
- **Verso illisible ou clé fausse (gate 2, tranché par David le 19/11/2026).**
  - Avant ce lot, `/back` répondait `checksums_valid: true` même pour des lignes qu'il n'avait pas lues :
    la gate 2 ne se déclenchait jamais. Il dit maintenant la vérité, et la gate 2 rejetait alors comme
    falsifié un verso simplement mal lu (sur le banc : 1 verso de CNI 2021 sur 64, photo sombre et
    bruitée, « TK2Z2DEVY » lu « TK2ZZDEVY »).
  - Une clé fausse seule ne prouve rien : l'OCR qui se trompe d'un caractère donne le même symptôme.
    La gate 2 rejette donc pour falsification (`BACK_MRZ_CHECKSUM_FAILED`) seulement si un champ dont
    la propre clé est fausse (numéro, naissance, expiration) porte la même valeur que le recto, lu
    séparément. Sinon : `BACK_MRZ_UNREADABLE`, avec une demande de nouvelle photo. Un recto qui a sa
    propre MRZ ne compte pas comme lecture indépendante.
  - Les deux cas restent des rejets. Limite : une retouche des seules données couvertes par la clé
    composite (zone facultative) passe pour « illisible ».
- Hors lot 1, non modifiés :
  - le repli local du backend lit encore le verso avec Tesseract ;
  - `/extract/ocr` lit la date de naissance au format mois/jour (1952-08-01 au lieu de 1952-01-08).
- Cache de PaddleOCR (point 1 « À trancher ») : non modifié au lot 1, correctif proposé au lot 2. La clé porte sur les 1 024 premiers octets
  du fichier encodé et sur sa taille ; une collision demande deux fichiers de même taille à l'octet.
  Aucune lecture d'une autre identité n'a été observée sur les 432 appels. Le risque sur les données en
  mémoire reste entier ; la décision revient toujours à David.

## Lot 2 — API Preuvid v1

But : l'interface que les clients intègrent. Détail dans `preuvid/docs/api.md`.

- [x] `POST /v1/sessions`, `GET /v1/sessions/{id}`, `GET /v1/sessions/{id}/decision`, `DELETE /v1/sessions/{id}`.
- [ ] Clés d'API par application, séparées test / production, hachées en base, affichées une seule fois.
      *Partiel, hérité d'Idswyft et non modifié : clés de test et de production séparées (une clé de
      test ne voit que les sessions de test), hachées en HMAC-SHA256, renvoyées une seule fois à la
      création (vérifié dans `routes/developer/apiKeys.ts`, la liste n'en montre que le préfixe). La
      notion d'« application » manque : un compte crée une clé par site, en attendant l'écran du lot 4.*
- [x] Webhooks signés HMAC-SHA256 avec horodatage, identifiant d'événement, reprises espacées, rejeu manuel.
      *Rejeu par l'API ; le bouton de l'espace client viendra au lot 4.*
- [x] Idempotence sur la création de session ; limites de débit par clé.
- [x] Motif lisible avec chaque décision (« clé de contrôle fausse », « visage 71 sur 100 »).
- [ ] Renommage : domaines `api.preuvid.fr` / `verif.preuvid.fr`, en-têtes, textes. Retirer le nom et les
      marques Idswyft de tout ce qui est visible (voir `TRADEMARK.md`), garder la licence MIT et la mention d'origine.
      **Bloqué : attend la recherche INPI et l'achat des domaines (David).**
- [x] Documentation OpenAPI générée et exemples curl.

Fin du lot : un site de test crée une session, la personne fait le parcours, le site reçoit le webhook et le vérifie.

### Bilan du lot 2 (20/11/2026)

**Fin de lot atteinte** sur la pile compose (`preuvid/e2e/`, 23 contrôles, tous verts). Un site de test
s'inscrit (compte, clé de test, webhook abonné), crée une session `age`, envoie le recto synthétique,
reçoit `session.terminee` signé et le vérifie sur le corps brut, puis lit `{statut: validee, majeur: true}`
et rien d'autre. Même chose en `identite` : recto, verso et capture, puis refus `LIVENESS_FAILED` (les
images du dépôt n'ont pas de visage). Il contrôle ensuite : rejeu manuel (même identifiant d'événement,
signature neuve), `DELETE` (204, puis 404, `session.supprimee` reçu), plus rien en base, et une clé ou une
signature inventée refusée. Disque vérifié à la main : plus aucune photo de la session supprimée dans
`uploads`, et la référence du client absente des journaux de l'API. Idempotence vérifiée : même clé, même session ;
autre corps, 422.

**Ce qui a été fait** (`backend/src/v1/`, couche à part ; `/api/v2` d'Idswyft n'est pas modifié, la v1 s'y
branche en deux appels : fin de parcours et revue manuelle) :
- statuts, décision, motif en français et champs avec l'état de leur clé de contrôle (`decision.ts`) ;
- webhooks v1 : signature `horodatage.corps`, reprises à 1 min, 5 min, 30 min et 2 h, stockées en base
  (`v1_webhook_events`) et reprises par une tâche minute, donc maintenues après un redémarrage. Seul un 2xx
  vaut livraison (Idswyft comptait un 4xx comme livré). Le corps ne contient jamais la référence du client ;
- idempotence par clé d'API, la place étant réservée avant traitement (deux requêtes simultanées ne créent
  pas deux sessions) ; 600 lectures et 300 écritures par minute et par clé ; une IP est bloquée au bout de
  20 échecs d'authentification ;
- `DELETE` : photos et audio d'abord, puis toutes les tables filles qui peuvent porter une donnée de la
  personne (dont le coffre, le filtrage AML et les attestations). L'appel peut être relancé et répond 503
  tant que tout n'est pas parti. Il reste une pierre tombale sans donnée ;
- OpenAPI 3.1 sur `GET /v1/openapi.json`, confronté par un test aux routes montées ; `preuvid/docs/api.md`
  réécrit (statuts, vérification de signature côté client, exemples curl) ;
- migration `20261120_api_v1.sql` (préfixe daté : `migrate.ts` trie par préfixe numérique).
- Tests : 26 tests v1 ; backend 1 316, engine 41, frontend 48, tous verts (un passage du backend a
  planté une fois sur une erreur de segmentation de Node, sans échec de test ; vert au passage suivant).

**Cache de PaddleOCR (point 1 « À trancher »), correctif proposé.** `PaddleOCRProvider` passe
`{ noCache: true }` : plus aucun résultat ni texte lu gardé en mémoire après la réponse, plus de collision
possible entre deux personnes. Un test vérifie l'option à chaque appel.
- Banc (`scores/2026-11-20-lot-2-sans-cache.txt`) : scores identiques au lot 1, ligne par ligne ; pic
  mémoire 1 034 Mio (973 et 1 022 lors des deux passages du lot 1).
- Temps : le recto de la CNI 2021 passe de 2,7 s à 6,5 s **dans le banc seulement**. Le banc lit le même
  fichier en verso puis en recto, et le recto profitait du cache. En vrai, recto et verso sont deux photos.
  Mesure témoin, même machine, en alternance, avec et sans cache : 6,0 s contre 6,2 s (ancienne CNI),
  3,9 s contre 4,1 s (verso), 5,7 s contre 6,1 s (recto lu en premier). Aucun coût réel. Les temps bruts
  de ce passage sont plus élevés qu'au lot 1 (machine chargée pendant le banc) : ne pas les comparer.

**Écarts et limites** :
- Double anonymat du parcours `age` absent (lot 3) : Preuvid sait quel client demande. Le parcours `age` ne
  doit pas être présenté comme conçu selon le référentiel de l'Arcom avant le lot 3.
- Les règles de conformité configurables d'Idswyft ne s'appliquent pas aux sessions v1.
- `session.revue` (après une revue manuelle) n'est vérifié ni par l'essai (il faut une session
  d'administrateur) ni par un test unitaire. Seul le chargement du module est vérifié dans l'image
  construite ; un échec est journalisé. À couvrir avec l'écran de revue (lot 4).
- Limites de débit en mémoire : valables pour une seule instance de l'API (compteur partagé au lot 5).
- Livraison à un hôte interne : refusée par la protection SSRF, sauf nom exact listé dans
  `PREUVID_WEBHOOK_HOTES_INTERNES` (vide par défaut ; l'essai y met `site-test`).
- Le site de test s'inscrit directement en base : l'inscription par l'espace développeur passe par un
  code envoyé par e-mail.
- Trouvé en passant, non corrigé (Idswyft) : la purge des anciennes livraisons de webhooks
  (`runWebhookPayloadCleanup`) met `payload` à `null`, alors que la colonne est `NOT NULL`. La purge
  échoue donc à chaque fois, et les champs lus restent dans `webhook_deliveries` au-delà des 30 jours.
  Correctif d'une ligne (`{}` au lieu de `null`), à décider.
- Modèles : le modèle de voix est épinglé sur une révision Hugging Face (le lien GitHub d'origine avait
  changé de contenu). L'archive ASR reste sur une publication GitHub modifiable ; son empreinte est
  vérifiée à chaque construction.

## Lot 3 — Parcours de vérification et passe majeur

But : les écrans mobiles des maquettes 03 à 10. Détail dans `preuvid/docs/verification-age.md`.

- [x] Parcours identité en cinq écrans : choix de la pièce, photo avec déclenchement automatique et
      voyants (netteté, reflets, quatre coins), lecture, visage, résultat. Page `/verifier#jeton`
      (`frontend/src/identite/`). Voyants : netteté, lumière et présence de la pièce (voir les écarts).
- [x] Parcours âge : première vérification, création du passe, confirmation aux visites suivantes.
      Pour le passe : page `/age` (`frontend/src/age/`), essai de bout en bout `preuvid/e2e/passe-test.mjs`.
      Les sessions `age` créées par l'API v1 restent sur la page d'Idswyft, sans visage (voir les écarts).
- [x] Passe majeur : preuve « majeur » liée au téléphone par WebAuthn (clé d'accès), sans nom ni photo ;
      validité d'une confirmation limitée à la visite, expirée après une heure d'inactivité ;
      rien de stocké dans un compte du site client. Le minuteur d'inactivité et la fin à la fermeture de
      la page sont fournis par le module du site (`preuvid/sdk/age/navigateur.js`) : aucun test ne les couvre,
      et le site doit les brancher.
- [x] Double anonymat : le site ne reçoit que « majeur oui/non » ; Preuvid n'enregistre pas quel site est visité.
      Signature aveugle, voir `preuvid/docs/double-anonymat.md` (limite : rapprochement par l'heure).
- [x] Étude de faisabilité, avant tout code : lecture de la puce NFC de la CNI 2021 et du passeport depuis
      un navigateur mobile (sans appli). Rendre un avis écrit : possible, possible avec appli, impossible.
      Avis : impossible depuis un navigateur, possible avec une appli (`preuvid/docs/nfc-faisabilite.md`).
- [x] Accessibilité : cibles tactiles de 44 px, contrastes, lecteur d'écran, animations réduites respectées.
      Écrans 03 à 07 audités avec axe-core (WCAG 2.2 A et AA) et au clavier : aucune violation, aucune cible
      sous 44 px, pas de défilement horizontal à 320 px, contour du focus lisible partout (lilas sur les
      écrans sombres, 9,6:1). Lecteur d'écran : vérifié par l'arbre d'accessibilité et les régions annoncées,
      pas encore avec VoiceOver ni TalkBack (à faire avec l'essai sur appareils réels).
- [x] Mesurer le taux d'abandon et la durée par étape (sans donnée personnelle).
      `backend/src/v1/mesures.ts` : une ligne par session finie dans `v1_mesures`, écrite une seule fois
      (marque conditionnelle `v1_mesuree_le`), au passage horaire pour les liens expirés et juste avant
      toute suppression (site ou passe). Issues : page jamais ouverte, ouverte sans photo, abandon au recto,
      au verso, au visage, validée, refusée, à revoir, supprimée en cours. Parcours identité, passe majeur
      et vérifications d'âge des sites. Relevé par parcours et par étape (atteintes, abandons, taux, médiane,
      90e centile) : `GET /api/admin/preuvid/mesures?du=&au=`, administrateurs de la plateforme seulement.
      Vérifié sur la pile : quatre sessions réelles (recto envoyé puis lien expiré, ouverte sans photo,
      jamais ouverte, supprimée par le site après le recto) donnent les quatre bonnes lignes ; un second
      passage n'ajoute rien ; une vérification du passe ouverte puis purgée à l'expiration donne `passe`,
      `sans_photo`, page ouverte ; la route refuse sans jeton d'administrateur (401). Les essais ratés
      font bien chacun une ligne `documents` (jusqu'à 3 rectos par session en base).

Fin du lot : parcours complet sur iPhone et Android réels, en moins de deux minutes pour l'identité.

Écarts relevés en cours de lot (à reprendre au bilan) :

- Visage du passe (selfie, détection du vivant, comparaison à la pièce) : jamais mesuré sur de vrais
  visages (faux refus, photo ou vidéo rejouée, biais). Le chemin du refus est parcouru de bout en bout ; celui
  de la réussite n'est couvert que par des tests unitaires (images synthétiques refusées par le vivant).
- Seule la machine d'états (`backend/src/verification`) a changé, pas `engine/` : le banc de lecture n'est
  pas concerné.
- Un ordinateur sans caméra ne peut pas créer de passe. Un majeur présent physiquement peut encore tout
  faire à la place d'un mineur.
- Les sessions `parcours: age` créées par un site (API v1) n'ont pas encore le visage : suite à faire.
- Journaux : les métadonnées de vivant invalides ne sont plus recopiées dans le message d'erreur.
- Page identité, voyants : « reflets » et « quatre coins » abandonnés. Pas de détection des coins sans
  modèle ; les reflets ne se distinguent pas sur les cartes synthétiques du banc (claires : 30 à 41 % de
  pixels saturés sur une photo propre, 13 à 15 % avec reflet). Remplacés par les voyants « lumière » et
  « pièce » (des bords droits près d'au moins deux côtés du cadre, guidés par un rectangle en pointillés).
- Seuils de la prise automatique (netteté 800, lumière 130, bords sur 2 côtés, sur l'image réduite à
  480 px) mesurés sur les images synthétiques du banc seulement. Une carte très inclinée n'est pas
  reconnue : la prise se fait alors à la main. Le bouton « Prendre la photo moi-même » reste toujours là.
- Parcours de bout en bout fait avec une fausse caméra (vidéo tirée d'un passeport synthétique) : prise
  automatique en 2,3 s (attente de 2,5 s voulue après l'ouverture de la caméra), lecture en 10 à 45 s, MRZ et 3 clés sur 3, visage, refus réel par le vivant,
  suppression des photos à la demande. La réussite (écran « C'est fait ») n'est vue qu'avec un état simulé.
- Photos des sessions v1 jamais servies au site : ni par `/selfie`, ni par `/api/files`, ni dans la liste
  ou le détail de la console, y compris pour ses relecteurs et opérateurs. Seuls les administrateurs de
  la plateforme les voient. Une option par client pourra venir au lot 4.
- Photos chiffrées sur le disque par défaut (`STORAGE_ENCRYPTION=true`) : vérifié sur la pile (en-tête
  `IDSW`, plus de JPEG lisible). Les fichiers déjà enregistrés en clair restent lisibles.
- Le site reçoit nom, prénoms, date de naissance, numéro et validité de la pièce, nationalité et sexe :
  l'écran 07 le dit. La maquette 03 annonçait « recevra seulement le résultat » : c'est faux pour ce
  parcours. Le texte de la page a été corrigé ; le fichier de la maquette n'a pas été modifié.
- Accessibilité, corrections faites : contour du focus invisible sur les écrans sombres (1,6:1, passé à
  9,6:1, page `/age` comprise) ; voyants de la photo annoncés jusqu'à quatre fois par seconde, remplacés
  par une consigne d'une phrase, annoncée seulement quand elle change et au plus toutes les 3 s ; après une
  photo illisible, le focus va au message d'erreur (avant : au titre, qui pouvait couvrir l'alerte) ;
  titre de l'onglet propre à chaque écran ; `aria-label` interdit retiré de la marque ; bouton
  « Demander la suppression maintenant » sorti de la phrase (26 px de haut, 44 maintenant).
  Reste ouvert : la détection du vivant demande de tourner la tête, et la page ne propose aucune autre
  voie à qui ne le peut pas. Question à trancher avec David.
- Titre de séjour envoyé au moteur comme `national_id` (même format carte, MRZ au verso) : pas de type
  propre chez Idswyft.
- Un refus est définitif : pas de « recommencer » sur la page, la personne repasse par le site.
- Chez Idswyft, un seul recto illisible refuse la session (porte 1, `FRONT_OCR_FAILED`) et prévient le
  site : vérifié sur la pile. Décision de David (20/11/2026) : 3 essais par côté pour le parcours
  `identite` v1 (photo illisible seulement : `FRONT_OCR_FAILED`, `FRONT_LOW_CONFIDENCE`,
  `BACK_BARCODE_NOT_FOUND`, `BACK_MRZ_UNREADABLE`), refus au troisième ; les signaux de fraude refusent
  tout de suite. Les autres sessions (Idswyft, âge) gardent un seul essai. Vérifié sur la pile : trois
  photos sans pièce prises à la main donnent deux reprises (« dernier essai » au deuxième échec), puis le
  refus « recto illisible » ; une photo ratée puis le passeport mènent au visage. Après une photo
  illisible, la prise automatique s'arrête pour ce côté (le même mauvais objet userait les essais) :
  vérifié, rien ne part en 10 s, le bouton fait passer la photo. `/restart` d'Idswyft, qui accepte le
  jeton de la personne, refuse désormais les sessions v1 (409) : il effaçait le refus et le compte d'essais.
  Ce changement touche `VerificationSession.ts` d'Idswyft : à surveiller à la prochaine reprise amont.
- Prise automatique durcie en plus (présence de la pièce, attente de 2,5 s, 4 images bonnes de suite) :
  une scène nette sans pièce filmée 10 s ne déclenche rien. Une feuille de texte, une carte bancaire ou
  une autre pièce posée à plat ont aussi des bords nets, et le bouton manuel n'a aucun contrôle : les
  essais couvrent ces cas.
- Recto puis verso d'une CNI parcouru avec une fausse caméra : prise du recto, lecture, écran du verso,
  prise du verso. Le banc n'avait pas de recto de CNI 2021 : l'essai associait le recto d'une ancienne CNI
  au verso d'une CNI 2021 d'une autre personne, d'où un refus attendu (`BACK_MRZ_BARCODE_MISMATCH`).
- Recto de la CNI 2021 (23/11/2026) : ajouté au banc (72 images, série `extension`, mêmes identités que
  les versos ; mise en page d'après le spécimen public, de mémoire, jamais comparée au spécimen officiel).
  Lecture corrigée dans le moteur : libellés « Surname », « Given names », « DATE DE NAISS. »,
  « DATE D'EXPIR. », « N° du document », dates « JJ MM AAAA » séparées par des espaces (indication DMY
  seulement), virgules entre les prénoms. Banc : recto TOUT 0 % → 72 % (propre, reflet, rotation,
  perspective, doigt, JPEG fort : 100 % ; flou et basse résolution : 0 %, prénoms mal lus ; sombre : 50 %).
  Socle inchangé au chiffre près (95 / 95 / 94 / 97 %). Faux sûrs : la nouvelle série en montrait 2
  (numéro lu « O » pour « 0 » à 0,96) ; un recto sans MRZ n'est plus jamais présenté comme sûr champ par
  champ (plafond 0,9, après le calcul de `ocr_confidence`, qui ne change pas) : 0 faux sûr.
  Pas fait : l'essai recto puis verso sur la pile, et tout essai sur une vraie carte. Une confusion O/0
  au recto ne donne que 0,5 au numéro dans la validation croisée d'Idswyft (champ critique).
- Le suivi de la lecture ne s'arrête plus sur une erreur réseau passagère : il attend et relit l'état.
- La voix (option d'Idswyft) n'est pas proposée par la page ; une session qui l'exigerait finirait abandonnée.
- Pas de page « Comment vos données sont utilisées » : le lien de la maquette 03 attend son texte.
- Les sessions `parcours: age` créées par l'API restent sur la page d'Idswyft.
- Mesures d'abandon : les durées sont prises à l'arrivée des photos au serveur, lecture comprise (l'écart
  « verso » contient la lecture du recto). L'ouverture de la page n'est connue que pour l'identité et le
  passe ; pour les vérifications d'âge des sites (page d'Idswyft), « page ouverte » reste inconnu. Les
  sessions créées avant la migration ne sont pas comptées. Si l'écriture de la ligne échoue après la
  marque, la session est perdue pour la mesure (erreur journalisée). Le relevé n'existe qu'en JSON : pas
  encore d'écran dans la console (lot 4). La route n'a été essayée sur la pile que sans jeton (refus) ; le
  calcul du relevé l'a été directement dans le conteneur.
- Mesures d'abandon, lien résiduel : aucune ligne ne porte d'identifiant, mais l'ordre d'écriture reste dans
  la base. Qui lit la base brute peut rapprocher la ligne d'une session supprimée par le site (écrite au
  moment de la pierre tombale). Atténué pour le passage horaire (lot mélangé, marque au jour seulement).
- Une session est comptée « supprimée » avant que la suppression soit confirmée : si elle échoue (503) et
  que la session va au bout, elle reste comptée « supprimée ».
- Moteur froid : le premier recto après un long repos a dépassé 60 s (504 de nginx, nouvel essai du
  serveur, réponse en 83 s) ; le suivant, 10 s. À regarder avec l'essai sur appareils réels.

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
