# ── Idswyft API — Multi-stage build ──────────────────
# Stage 1: install deps, build shared package, compile TypeScript
# Stage 2: slim runtime with only what's needed to run
#
# ML dependencies (TensorFlow, ONNX, PaddleOCR, canvas) have been moved
# to the Engine Worker container. This image is now lightweight (~250MB).
#
# Contexte de construction : la racine du dépôt (voir docker-compose.yml).
#   docker compose build api
# ─────────────────────────────────────────────────────

# ── Stage 1: Build ──────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Minimal build dependencies (sharp uses pre-built binaries, no native build needed)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Manifestes npm de tous les espaces de travail : npm ci exige qu'ils
# correspondent exactement au package-lock.json (installation reproductible).
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY backend/package.json backend/
COPY engine/package.json engine/
COPY frontend/package.json frontend/

RUN npm ci --include=optional --workspace=shared --workspace=backend --no-audit --no-fund

# Build shared package first (backend depends on it)
COPY shared/src/ shared/src/
COPY shared/tsconfig.json shared/
RUN cd shared && npx tsc && npx tsc-alias

# Copy backend source, entrypoint, and compile TypeScript
COPY backend/src/ backend/src/
COPY backend/tsconfig.json backend/
COPY backend/docker-entrypoint.sh backend/docker-entrypoint.sh
RUN cd backend && npx tsc && npx tsc-alias

# Dépendances de production seules, réinstallées depuis le lockfile.
# npm range dans backend/node_modules (et shared/node_modules) les paquets dont la
# version diffère de celle hissée à la racine, dotenv par exemple : ces dossiers
# sont copiés eux aussi dans l'image finale.
RUN rm -rf node_modules shared/node_modules backend/node_modules     && npm ci --omit=dev --include=optional --workspace=shared --workspace=backend --no-audit --no-fund     && mkdir -p shared/node_modules backend/node_modules

# ── Stage 2: Runtime ────────────────────────────────
FROM node:20-slim
WORKDIR /app/backend

# Runtime: only wget for health checks (sharp pre-built binaries are self-contained)
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r nodeuser && useradd -r -g nodeuser -s /bin/false nodeuser

# Copy compiled output preserving workspace structure for @idswyft/shared resolution
# node_modules at /app/ contains hoisted deps + workspace symlink to /app/shared/
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/shared/node_modules /app/shared/node_modules
COPY --from=build /app/backend/node_modules /app/backend/node_modules
COPY --from=build /app/backend/dist ./dist
COPY --from=build /app/shared/dist /app/shared/dist
COPY --from=build /app/shared/package.json /app/shared/package.json
COPY --from=build /app/backend/package.json ./package.json

# Entrypoint: auto-migrate then start server
# sed converts Windows CRLF → LF (git on Windows may check out with \r\n)
COPY --from=build /app/backend/docker-entrypoint.sh ./docker-entrypoint.sh
RUN sed -i 's/\r$//' ./docker-entrypoint.sh && chmod +x ./docker-entrypoint.sh

# Pre-create volume mount points so Docker initialises named volumes
# with nodeuser ownership (Docker copies ownership from image on first mount)
RUN mkdir -p ./uploads ./temp ./logs

# Migrations are bind-mounted from supabase/migrations/ at runtime
ENV MIGRATIONS_DIR=/app/backend/migrations

# Seuls les dossiers d'envoi et temporaires doivent être inscriptibles.
RUN chown nodeuser:nodeuser ./uploads ./temp ./logs
USER nodeuser

EXPOSE 3001

CMD ["sh", "./docker-entrypoint.sh"]
