# API v1 (lot 2)

Objectif : trois appels et un webhook. Authentification par en-tête `x-api-key`.

| Appel | Rôle |
|---|---|
| `POST /v1/sessions` | Crée une session. Corps : `parcours` (`identite`, `age`), `reference` (identifiant du client, opaque), `retour` (URL). Réponse : `session`, `lien`, `statut`. En-tête `Idempotency-Key` accepté. |
| `GET /v1/sessions/{id}` | État de la session. |
| `GET /v1/sessions/{id}/decision` | Décision, motif, champs lus avec l'état de chaque clé de contrôle. |
| `DELETE /v1/sessions/{id}` | Supprime la session et ses photos. |

Statuts : `en_attente`, `en_cours`, `validee`, `refusee`, `a_revoir`, `expiree`, `abandonnee`.

## Webhook

- Événements : `session.terminee`, `session.a_revoir`, `session.revue`, `session.supprimee`.
- En-têtes : `X-Preuvid-Signature` (HMAC-SHA256 de `horodatage.corps` avec le secret du webhook),
  `X-Preuvid-Timestamp`, `X-Preuvid-Event-Id`.
- Reprises espacées en cas d'échec (au moins 1 min, 5 min, 30 min, 2 h), rejeu manuel depuis l'espace client.
- Le corps ne contient jamais d'image. Pour le parcours `age`, il ne contient que `majeur: true|false`.

## Repères relevés chez Didit (à égaler, pas à copier)

Session en un appel, décision récupérable, webhook signé avec horodatage et identifiant d'événement,
deux reprises seulement (≈ 1 min et 4 min) : faire mieux sur les reprises. Limites : 600 lectures et
300 écritures par minute et par clé.

## Parcours `age`

Voir `verification-age.md` : l'API de délivrance de la preuve ne doit pas connaître le site demandeur.
