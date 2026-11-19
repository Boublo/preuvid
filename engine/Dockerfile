# ── Moteur de lecture Preuvid (fork Idswyft) ─────────────────────
# Étape 1 : dépendances figées (package-lock.json), modèles figés et
#           vérifiés (models.manifest.json), compilation TypeScript.
# Étape 2 : exécution, sans compilateur ni accès réseau nécessaire.
#
# Contexte de construction : la racine du dépôt (voir docker-compose.yml).
#   docker compose build engine
# ─────────────────────────────────────────────────────────────────

# ── Étape 1 : construction ─────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Dépendances natives de construction (canvas, sharp, onnxruntime) et
# bzip2 pour extraire le modèle de transcription vocale.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libcairo2-dev \
    libjpeg-dev \
    libpango1.0-dev \
    libgif-dev \
    librsvg2-dev \
    pkg-config \
    bzip2 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Manifestes npm de tous les espaces de travail : npm ci exige qu'ils
# correspondent exactement au package-lock.json.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY engine/package.json engine/
COPY backend/package.json backend/
COPY frontend/package.json frontend/

# Installation reproductible, limitée au moteur et au paquet partagé.
RUN npm ci --include=optional --workspace=shared --workspace=engine --no-audit --no-fund

# Modèles : téléchargés depuis des sources épinglées, empreintes vérifiées.
# La construction échoue si un fichier diffère du manifeste.
COPY shared/models/ shared/models/
COPY engine/models.manifest.json engine/download-models.js engine/
RUN cd engine && node download-models.js

# Paquet partagé, puis moteur.
COPY shared/src/ shared/src/
COPY shared/tsconfig.json shared/
RUN cd shared && npx tsc && npx tsc-alias

COPY engine/src/ engine/src/
COPY engine/tsconfig.json engine/
RUN cd engine && npx tsc && npx tsc-alias

# Dépendances de production seules, réinstallées depuis le lockfile.
# npm range dans engine/node_modules (et shared/node_modules) les paquets dont la
# version diffère de celle hissée à la racine, dotenv par exemple : ces dossiers
# sont copiés eux aussi dans l'image finale.
RUN rm -rf node_modules shared/node_modules engine/node_modules     && npm ci --omit=dev --include=optional --workspace=shared --workspace=engine --no-audit --no-fund     && mkdir -p shared/node_modules engine/node_modules

# ── Étape 2 : exécution ────────────────────────────
FROM node:20-slim
WORKDIR /app/engine

# Bibliothèques d'exécution uniquement (canvas, décodage audio, sonde de santé).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libcairo2 \
    libjpeg62-turbo \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libgif7 \
    librsvg2-2 \
    ffmpeg \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -r nodeuser && useradd -r -g nodeuser -m -s /bin/false nodeuser

# Les fichiers restent la propriété de root : le moteur n'écrit rien sur
# disque, l'utilisateur nodeuser n'a besoin que de les lire.
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/shared/node_modules /app/shared/node_modules
COPY --from=build /app/engine/node_modules /app/engine/node_modules
COPY --from=build /app/shared/dist /app/shared/dist
COPY --from=build /app/shared/models /app/shared/models
COPY --from=build /app/shared/package.json /app/shared/package.json
COPY --from=build /app/engine/package.json ./package.json
COPY --from=build /app/engine/models.manifest.json /app/engine/download-models.js ./
COPY --from=build /app/engine/models ./models
COPY --from=build /app/engine/dist ./dist

# Dernière vérification des modèles dans l'image finale, sans réseau.
RUN node download-models.js --verifier

USER nodeuser
ENV NODE_ENV=production

EXPOSE 3002

CMD ["node", "dist/server.js"]
