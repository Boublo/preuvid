# Passe majeur et double anonymat (lot 3)

Objectif : le site ne reçoit que « majeur, oui ou non » ; Preuvid ne sait pas quel site la personne visite.
Complète `verification-age.md`. Décisions de David (20/11/2026) : domaine d'essai tant que le domaine
définitif n'est pas acheté, comptage différé pour la facturation, clés d'accès synchronisées acceptées avec
limites, estimation par le visage en mode test seulement.

Le parcours `age` de l'API v1 (`POST /v1/sessions`) reste en place : c'est la méthode simple, où Preuvid sait
quel client a demandé la vérification. Le double anonymat est une méthode à part, décrite ici.

## Les trois acteurs

- **Le site** : génère un défi, reçoit une preuve, la vérifie seul avec la clé publique de Preuvid.
- **Le navigateur de la personne** : fait le lien entre les deux, et seul il connaît les deux côtés.
- **Preuvid** : vérifie la majorité une fois, garde un passe sans nom, signe des preuves sans les voir.

## Le principe : une signature aveugle

Preuvid signe la preuve sans la voir (signature aveugle RSA, RFC 9474, variante RSABSSA-SHA384-PSS-Randomized,
bibliothèque `@cloudflare/blindrsa-ts`).

1. Le serveur du site tire un défi aléatoire (32 octets) et le garde dans la session de la personne.
2. Le module du site, dans la page du site, **masque** le défi avec la clé publique de Preuvid. Le résultat
   ressemble à du bruit ; seul le module connaît le facteur de masquage.
3. Le module ouvre la page Preuvid dans un nouvel onglet, sans en-tête `Referer`, et lui passe le défi masqué
   par `postMessage`. Rien du site ne part vers le serveur de Preuvid.
4. La page Preuvid fait vérifier la majorité (passe ou première vérification), envoie le défi masqué au
   serveur de Preuvid, qui le signe et renvoie la signature masquée.
5. La page Preuvid rend la signature masquée au module du site, qui la **démasque** : il obtient une signature
   RSA-PSS ordinaire du défi.
6. Le serveur du site vérifie la signature avec la clé publique publiée par Preuvid, et que le défi est bien
   celui de la session, pas encore utilisé.

Ce que chacun apprend :

| | Le site | Preuvid |
|---|---|---|
| Identité de la personne | rien | rien (le passe n'a ni nom ni photo) |
| Majorité | oui, par la signature | oui |
| Quel site | — | rien : ni adresse de retour, ni `Referer`, ni origine |
| Relier deux visites | non : un défi neuf et une signature neuve à chaque fois | non : le défi masqué change à chaque fois |

Même si le site et Preuvid mettaient leurs données en commun, la signature démasquée ne peut pas être
rapprochée de la signature masquée : c'est la propriété mathématique de la signature aveugle.

**Limite, à dire à l'avocat** : l'heure. Preuvid signe à 21 h 04 min 10 s, le site reçoit une preuve à
21 h 04 min 11 s. Avec les journaux des deux côtés, un rapprochement par l'heure reste possible. Le comptage
différé (plus bas) évite d'ajouter une deuxième occasion de rapprochement.

## Sens de la clé

La clé de signature porte le sens : une clé = « majeur », valable une période. Le défi signé ne contient rien
d'autre que l'aléa du site. Preuvid publie ses clés publiques sur `GET /v1/age/cles` (identifiant, clé,
début et fin de validité). Le site les récupère de temps en temps, côté serveur, pas à chaque visite.

## Validité d'une confirmation

Une preuve vaut pour **une visite** : défi à usage unique, accepté au plus cinq minutes après sa création.
La suite est à la charge du site, et le module l'y aide :

- la visite se termine avec la session, à la fermeture du navigateur, à la mise en veille, et au plus tard
  après une heure d'inactivité ;
- le résultat n'est jamais rangé dans un compte du site.

Le contrat d'intégration le dira ; le module fournit le minuteur d'inactivité.

## Le passe

Clé d'accès (WebAuthn) créée après une première vérification réussie, sur le domaine de Preuvid :

- ce que Preuvid garde : identifiant de la clé, clé publique, compteur, indicateurs de sauvegarde (BE/BS),
  date de création. **Ni nom, ni photo, ni date de naissance, ni lien vers la vérification** ;
- le déverrouillage du téléphone (code, empreinte, visage) est exigé à chaque usage : c'est le second facteur ;
- la vérification qui a servi à créer le passe est supprimée tout de suite après (photos, champs lus) ;
- « Non merci, juste pour cette fois » : une seule preuve est signée, puis la vérification est supprimée.

**Clés synchronisées** (iCloud, Google) : acceptées. Elles peuvent passer d'un appareil à l'autre et se
partager. Limites : au plus `[N]` preuves par heure et par passe (20 proposées), et refus si le compteur de
la clé recule (clé copiée). Preuvid ne garde pas l'historique des usages, seulement un compteur glissant.
Risque à faire valider par l'avocat.

**Domaine** : une clé d'accès est liée au domaine. Tant que le domaine définitif n'est pas acheté, le
domaine est un réglage (`PREUVID_PASSE_DOMAINE`) et les passes créés sur un domaine d'essai seront perdus
au changement. Aucun vrai passe avant le domaine définitif.

## Première vérification

- **Pièce d'identité, puis visage** : le parcours `age_only` d'Idswyft (recto seul, seuil 18 ans), sous un
  compte interne Preuvid, sans clé de site, complété pour le passe par un selfie avec deux mouvements de tête
  (détection du vivant faite par le serveur) et une comparaison avec la photo de la pièce. Sans le visage,
  une pièce trouvée ou empruntée suffirait.
  - Mécanique : la vérification porte la marque `addons.preuvid_passe_visage`, posée seulement par
    `POST /v1/age/verification` ; `fluxAge()` ajoute alors l'étape `AWAITING_LIVE` après le recto. Les
    vérifications `age_only` des sites et de l'API Idswyft ne changent pas (terminées dès le recto).
  - Mineur au recto : refus immédiat, le visage n'est jamais demandé. Pas de visage détecté sur la pièce :
    refus (`FACE_NOT_DETECTED`), jamais de revue manuelle.
  - Pour ces vérifications, pas de contrôle de vélocité ni de géolocalisation (faux positifs derrière un
    même accès opérateur), pas de recherche de doublons, pas de filtrage AML : rien de tout cela ne sert à
    prouver un âge et chacun garderait des données.
  - `GET /v1/age/verification/etat` rend `{statut, majeur, etape}`, `etape` valant `recto`, `visage` ou
    `null`. Le passe et la preuve unique exigent `validee` et `majeur` : rien n'est conclu avant le visage.
  - Effacement : à la réponse, les images (pièce et selfie) et les champs lus (texte, MRZ, empreinte du
    visage, âge et genre estimés) sont retirés ; il reste la décision, les indicateurs de qualité et la date.
    La vérification entière l'est après création du passe ou signature de la preuve.
  - **Jamais mesuré sur de vrais visages** : ni le taux de faux refus, ni la résistance à une photo ou une
    vidéo rejouée, ni les biais. Seul le chemin du refus a été parcouru de bout en bout (lot 3).
- **Ordinateur et téléphone** : sur ordinateur, la page propose un QR code. Le téléphone ouvre
  `/age/telephone#<vérification>.<jeton>` (le fragment n'est jamais envoyé au serveur), photographie la
  pièce, puis renvoie à l'ordinateur. **Le visage se montre à la caméra de l'ordinateur**, celui qui
  recevra le passe : sinon, quelqu'un d'autre pourrait faire la vérification sur son téléphone pour vous.
  Un ordinateur sans caméra ne peut donc pas créer de passe ; la page invite à brancher une webcam ou à
  passer par le téléphone. Une personne majeure présente physiquement peut encore tout faire à la place
  d'un mineur : aucune méthode en ligne ne l'empêche.
- **Visage** : en mode test seulement (`PREUVID_AGE_VISAGE_TEST`), jamais présenté comme fiable. Le
  référentiel exige qu'aucun mineur ne passe pour majeur et que les biais soient mesurés ; ce n'est pas fait.
- **Portefeuille d'identité** : `[DISPONIBILITÉ À CONFIRMER]`, pas au lot 3. **Puce NFC** : impossible depuis
  un navigateur (`nfc-faisabilite.md`).

## Facturation : comptage différé

Preuvid ne peut pas compter au moment de la visite sans savoir quel site est visité. Le site déclare donc ses
preuves par lots, plus tard (une fois par jour au moins), avec sa clé d'API : `POST /v1/age/releves`.
Preuvid vérifie chaque signature, ignore les doublons, et compte. Preuvid sait combien de preuves chaque site
a utilisées, jamais lesquelles appartiennent à qui.

Écart : un site peut ne pas déclarer. Preuvid connaît le total signé, toutes visites confondues, et peut
comparer au total déclaré, sans pouvoir attribuer l'écart. Le contrat devra prévoir un contrôle.

## Ce que le serveur de Preuvid ne doit jamais recevoir

- l'adresse du site, sous aucune forme : pas d'adresse de retour, pas de `Referer` (la page du site ouvre
  l'onglet avec `referrerpolicy="no-referrer"`), pas d'origine (`postMessage` reste dans le navigateur) ;
- le défi en clair, ni la signature démasquée (sauf dans les relevés du site, détachés de la visite).

Défense en profondeur : les routes `/v1/age/` et la page de Preuvid ne lisent ni ne journalisent `Referer`
ni `Origin`, et nginx les écrit sans ces champs. Un test le vérifie.
