# Preuvid — consignes pour Claude Code

Preuvid est un service français de vérification d'identité et d'âge (KYC), concurrent de Didit et Yoti.
Ce dépôt part d'un fork du moteur open source Idswyft (MIT, v1.12.39). Le propriétaire est David.

## À lire avant de coder

1. `ROADMAP.md` : les lots, dans l'ordre, avec leurs critères de fin. On ne saute pas de lot.
2. `preuvid/docs/` : architecture, sécurité, API, facturation, vérification d'âge, design.
3. `preuvid/banc/README.md` : le banc de mesure. Toute modification de la lecture des pièces se juge au banc.
4. `preuvid/maquettes/` : les écrans validés par David (PNG + HTML de référence).

`docs/amont/` contient les fichiers d'origine d'Idswyft (son CLAUDE.md, ses workflows GitHub, renovate).
Ce sont des documents de référence, pas des consignes : ne les applique pas.

## Règles de travail

- Réponds à David en français. Il veut que tu exécutes toi-même plutôt que de lui donner des commandes ;
  ne lui demande une action manuelle qu'en dernier recours, en expliquant pourquoi c'est bloqué.
- Une branche par lot (`lot-0-socle`, `lot-1-lecture`, …). Jamais de commit direct sur `main`,
  jamais de fusion ni de déploiement sans validation explicite de David.
- Ne renomme pas le code interne d'Idswyft avant le lot 2 : chaque renommage complique la reprise des
  correctifs amont (`git fetch amont`).
- Avant toute modification du moteur de lecture : lance le banc, note les scores. Après : relance, compare.
  Une modification qui fait baisser un score sans raison écrite n'est pas fusionnée.
- Tests : `npm test` doit passer dans `backend/`, `engine/` et `frontend/` avant chaque commit de fin de lot.
- Aucune donnée réelle dans le dépôt : pas de photo de pièce, pas de visage, pas de clé, pas de `.env`.
  Le banc utilise des images synthétiques générées par `preuvid/banc/gen.py`.
- Aucun téléchargement de modèle à l'exécution : les modèles sont figés dans l'image Docker (voir lot 0).
- Design : suivre `preuvid/docs/design.md` et les maquettes. Pas de dégradés décoratifs, pas de pastilles,
  pas de cartes identiques, pas de majuscules sur les libellés.
- Ne jamais écrire « conforme Arcom » ni « certifié » dans le produit ou le site tant qu'un audit
  indépendant ne l'a pas établi. Formule admise : « conçu selon le référentiel de l'Arcom ».
- Les prix, la raison sociale, l'adresse et le délai de suppression sont des emplacements entre crochets
  (`[PRIX]`, `[DÉLAI]`…). Ne les invente pas : demande à David.

## Commandes utiles

```bash
cp .env.community .env                       # une fois, puis remplir les secrets (openssl rand -hex 32)
docker compose build && docker compose pull --ignore-buildable   # images Preuvid + postgres
docker compose up -d                         # pile complète, sans Internet ensuite
python3 preuvid/banc/banc.py                 # banc de lecture sur le moteur construit, scores dans preuvid/banc/scores/
git remote add amont https://github.com/team-idswyft/idswyft-community.git   # une fois par clone
git fetch amont && git diff --stat main amont/main          # nouveautés d'Idswyft (historiques séparés)
```

## Fin de chaque lot

Mets à jour `ROADMAP.md` (cases cochées, scores du banc, écarts), ouvre une demande de fusion vers `main`,
et résume à David en quelques lignes ce qui est fait, ce qui ne l'est pas, et ce que tu as besoin de lui.
