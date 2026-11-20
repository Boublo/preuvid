# API v1 (lot 2)

Objectif : trois appels et un webhook. Authentification par en-tête `x-api-key`.
Description complète et à jour : `GET /v1/openapi.json` (OpenAPI 3.1, sans clé). Un test vérifie que
chaque route montée y figure, et inversement.

Code : `backend/src/v1/`. La v1 est une couche à part posée sur le moteur d'Idswyft : elle ne modifie pas
les routes `/api/v2` existantes, elle s'y branche en deux points (fin de parcours, revue manuelle).

| Appel | Rôle |
|---|---|
| `POST /v1/sessions` | Crée une session. Corps : `parcours` (`identite`, `age`), `reference` (votre identifiant, opaque, 255 caractères au plus), `retour` (URL https). Réponse 201 : `session`, `lien`, `statut`, `expire_le`. En-tête `Idempotency-Key` accepté. |
| `GET /v1/sessions/{id}` | État de la session (sans le lien). |
| `GET /v1/sessions/{id}/decision` | Décision, motif, score du visage, champs lus avec l'état de chaque clé de contrôle. |
| `DELETE /v1/sessions/{id}` | Supprime la session et ses photos. 204, ou 503 si les photos n'ont pas pu être effacées (rien n'est supprimé, réessayer). |
| `GET /v1/sessions/{id}/evenements` | Événements de webhook de la session et état de leurs livraisons. |
| `POST /v1/evenements/{id}/rejouer` | Renvoie un événement tout de suite (même identifiant, horodatage neuf). |

Erreurs : toujours `{ "erreur": { "code", "message" } }`. Codes : `requete_invalide`, `json_invalide`,
`idempotence_invalide` (400), `cle_invalide` (401), `session_introuvable`, `evenement_introuvable`,
`introuvable` (404), `idempotence_en_cours` (409), `idempotence_conflit` (422), `limite_depassee`,
`trop_d_echecs` (429), `suppression_incomplete`, `idempotence_indisponible` (503), `erreur_interne` (500),
`refus` (autre 4xx).

Une clé de test (sandbox) ne voit que les sessions créées avec une clé de test, et une clé ne voit que
ses propres sessions.

## Exemples curl

```bash
# Créer une session de vérification d'âge
curl -s https://api.example.test/v1/sessions \
  -H "x-api-key: $PREUVID_CLE" -H "content-type: application/json" \
  -H "Idempotency-Key: commande-1234" \
  -d '{"parcours":"age","reference":"commande-1234","retour":"https://boutique.example.test/fin"}'
# → 201 {"session":"…","parcours":"age","statut":"en_attente","lien":"https://…","expire_le":"…","test":true}

# Où en est-elle ?
curl -s https://api.example.test/v1/sessions/$SESSION -H "x-api-key: $PREUVID_CLE"

# La décision (après le webhook session.terminee)
curl -s https://api.example.test/v1/sessions/$SESSION/decision -H "x-api-key: $PREUVID_CLE"
# → {"session":"…","parcours":"age","statut":"validee","majeur":true}

# Les livraisons de webhook, puis un rejeu
curl -s https://api.example.test/v1/sessions/$SESSION/evenements -H "x-api-key: $PREUVID_CLE"
curl -s -X POST https://api.example.test/v1/evenements/$EVENEMENT/rejouer -H "x-api-key: $PREUVID_CLE"

# Supprimer la session et ses photos
curl -s -X DELETE https://api.example.test/v1/sessions/$SESSION -H "x-api-key: $PREUVID_CLE" -w "%{http_code}\n"
```

`api.example.test` tient la place du domaine définitif (`api.preuvid.fr`, en attente).

## Statuts

| Statut | Sens |
|---|---|
| `en_attente` | Lien créé, aucune pièce envoyée. |
| `en_cours` | Au moins le recto reçu, parcours pas fini. |
| `validee` | Pièce lue, clés de contrôle justes, visage concordant ; ou validée en revue manuelle. |
| `refusee` | Refus du moteur (clé fausse confirmée, visage différent, pièce expirée, mineur…) ou en revue manuelle. |
| `a_revoir` | Le moteur ne tranche pas (visage non comparé, recto et verso divergents) : une personne doit regarder. |
| `expiree` | Le lien (une heure) a expiré sans qu'aucune pièce soit envoyée. |
| `abandonnee` | Le lien a expiré alors que le parcours était commencé. |

`validee`, `refusee`, `expiree` et `abandonnee` sont définitifs. `a_revoir` devient `validee` ou `refusee`
après la revue (événement `session.revue`). Une décision de revue l'emporte toujours sur l'expiration du lien.

## Décision

Parcours `identite` : `statut`, `motif` (`code` + `texte` en français, par exemple « visage 71 sur 100,
différent de la photo de la pièce »), `visage` (0 à 100), `champs`. Chaque champ (`numero_document`, `nom`,
`prenoms`, `date_naissance`, `date_expiration`, `nationalite`, `sexe`) vaut
`{ valeur, cle, source }` :

- `cle` : `juste`, `corrigee` (la clé a permis de corriger un caractère mal lu), `fausse`, `sans_cle`
  (champ MRZ que la norme ne protège pas), `absente` (lu hors MRZ ou non lu) ;
- `source` : `mrz`, `zone_imprimee`, `concordants` (MRZ et zone imprimée d'accord), ou `null`.

Parcours `age` : seulement `majeur`. `null` tant que la session n'est pas terminée, `true` si validée,
`false` sinon. `false` veut dire « majorité non prouvée », pas forcément « mineur ». Aucun champ lu,
aucune date de naissance n'est renvoyé, ni par l'API ni par le webhook.

## Webhook

Le webhook s'enregistre dans l'espace développeur existant (table `webhooks` d'Idswyft). Il ne reçoit les
événements v1 que s'il les liste explicitement : un webhook « tous événements » ne reçoit que les
événements historiques d'Idswyft, pour ne pas surprendre une intégration existante.

- Événements : `session.terminee` (statut définitif atteint par le moteur), `session.a_revoir`,
  `session.revue` (décision de revue manuelle), `session.supprimee`.
- Corps : `{ evenement, session, parcours, statut, date }`, plus `majeur` pour le parcours `age`.
  Jamais d'image, jamais de champ lu, jamais votre `reference` : relisez la décision avec la clé.
- En-têtes : `X-Preuvid-Signature` (HMAC-SHA256 hexadécimal de `horodatage.corps` avec le secret du
  webhook), `X-Preuvid-Timestamp` (secondes Unix), `X-Preuvid-Event-Id` (identique à chaque reprise),
  `X-Preuvid-Event`, `X-Preuvid-Attempt`.
- Seule une réponse 2xx vaut livraison. Sinon, reprises après 1 min, 5 min, 30 min et 2 h, puis échec.
  Les reprises sont stockées en base (`v1_webhook_events`) et survivent à un redémarrage ; le serveur
  les traite chaque minute. Rejeu manuel par `POST /v1/evenements/{id}/rejouer` (l'écran de l'espace
  client viendra avec le tableau de bord).

Vérification côté client, sur le corps brut reçu, avant tout `JSON.parse` :

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifier(secret, horodatage, corpsBrut, signature) {
  if (Math.abs(Date.now() / 1000 - Number(horodatage)) > 300) return false;   // cinq minutes
  const attendue = createHmac('sha256', secret).update(`${horodatage}.${corpsBrut}`).digest('hex');
  return attendue.length === signature.length
    && timingSafeEqual(Buffer.from(attendue), Buffer.from(signature));
}
```

Dédoublonner sur `X-Preuvid-Event-Id` : une reprise peut arriver après une livraison que vous avez
reçue mais pas acquittée à temps.

## Idempotence

`Idempotency-Key` (200 caractères au plus) sur `POST /v1/sessions` : la même clé avec le même corps
renvoie la même réponse pendant 24 h (en-tête `Idempotent-Replayed: true`). Même clé, autre corps : 422.
Même clé pendant que la première requête est en cours : 409. Une réponse d'erreur libère la clé.
La réponse gardée contient le lien de la personne : elle est chiffrée en base (`ENCRYPTION_KEY`) et
effacée avec la session.

## Limites

600 lectures et 300 écritures par minute et par clé (en-têtes `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
`X-RateLimit-Reset`), 429 au-delà. Une adresse IP qui accumule 20 échecs d'authentification en une minute
est bloquée pour le reste de la minute.

Les compteurs sont en mémoire : ils valent pour une seule instance de l'API. Avec plusieurs instances,
il faudra un compteur partagé (Postgres ou Redis) ; c'est noté pour le lot 5.

## Suppression

`DELETE` efface d'abord les photos (pièce, selfie). Si cet effacement échoue, rien d'autre n'est touché
et l'appel renvoie 503. Ensuite : documents, selfies, scores, état du parcours, empreintes de
dédoublonnage, contenu des anciennes livraisons de webhook, réponse gardée pour l'idempotence. Il reste une ligne vide (identifiant, dates,
parcours, statut) pour que la facturation et le journal des événements tiennent ; la session n'est plus
visible par l'API (404).

## Ce que la v1 ne fait pas encore

- Les règles de conformité configurables d'Idswyft (âge minimal par client, pays acceptés…) ne
  s'appliquent pas aux sessions v1 : le parcours `identite` suit le préréglage complet, le parcours `age`
  le seuil de 18 ans.
- La double anonymité du parcours `age` (voir `verification-age.md`) n'est pas en place : aujourd'hui
  Preuvid sait quel client a demandé la vérification. C'est l'objet du lot 3 ; d'ici là, le parcours `age`
  ne doit pas être présenté comme conçu selon le référentiel de l'Arcom.
- Le domaine `api.preuvid.fr` et le retrait de la marque Idswyft attendent la recherche INPI et l'achat
  des domaines.

## Repères relevés chez Didit (à égaler, pas à copier)

Session en un appel, décision récupérable, webhook signé avec horodatage et identifiant d'événement,
deux reprises seulement (≈ 1 min et 4 min) : nous en faisons quatre, sur deux heures. Limites : 600
lectures et 300 écritures par minute et par clé.

## Parcours `age`

Voir `verification-age.md` : l'API de délivrance de la preuve ne doit pas connaître le site demandeur.
