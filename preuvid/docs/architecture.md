# Architecture

## Hérité d'Idswyft 1.12.39 (MIT)

TypeScript, Node 20. Environ 98 000 lignes, 110 fichiers de test.

| Service | Rôle | Technique |
|---|---|---|
| `backend/` (api) | API, sessions, clés, webhooks, stockage | Express 4, PostgreSQL 16 |
| `engine/` | Lecture des pièces, visage | onnxruntime-node, ppu-paddle-ocr (PP-OCRv5), face-api.js (vecteur 128, seuil 0,60), `mrz`, zxing, sharp |
| `frontend/` | Console et parcours | React 18, Tailwind |
| `caddy/` | TLS et routage | Caddy |
| postgres | Données | PostgreSQL 16 |
| watchtower | Mise à jour automatique | **à retirer (lot 0)** |

Déjà en place et à conserver : clés d'API hachées (HMAC), webhooks signés, service TOTP, contrôle du type
de fichier par octets magiques, chiffrement par enveloppe AES-256-GCM en mode S3, compose n'exposant que 80/443.

## Cible Preuvid

- `api.preuvid.fr` : API v1 (lot 2). `verif.preuvid.fr` : parcours mobile (lot 3).
  `app.preuvid.fr` : espace client et administration (lot 4). `preuvid.fr` : site (lot 5).
- Le moteur n'est jamais exposé : seule l'API lui parle, sur le réseau interne.
- Deux bases logiques : vérifications (données personnelles, durée de vie courte) et facturation
  (registre de crédit, sans donnée de personne vérifiée).
- Pour l'âge, séparation stricte : le service qui délivre la preuve ne connaît pas le site demandeur.
- Hébergement de départ : un VPS (le « satellite de paiement »), Docker Compose. Caractéristiques à confirmer.

## Suivre Idswyft

`git fetch amont` puis fusion choisie. Un seul développeur porte l'essentiel d'Idswyft (214 commits sur 229) :
ne pas compter sur l'amont pour corriger nos défauts.
