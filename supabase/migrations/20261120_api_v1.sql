-- API Preuvid v1 (lot 2).
-- Préfixe daté : migrate.ts trie par préfixe numérique, ce fichier passe donc après les
-- migrations dont il dépend (webhooks, webhook_deliveries, api_key_id…).

-- Sessions v1 : une ligne verification_requests porte le parcours, la référence opaque du client
-- et l'URL de retour. Après DELETE, la ligne reste comme pierre tombale (v1_deleted_at), vidée
-- de ses données, pour que l'événement session.supprimee et ses reprises existent encore.
ALTER TABLE verification_requests
  ADD COLUMN IF NOT EXISTS v1_parcours    TEXT CHECK (v1_parcours IN ('identite', 'age')),
  ADD COLUMN IF NOT EXISTS v1_reference   TEXT,
  ADD COLUMN IF NOT EXISTS v1_return_url  TEXT,
  ADD COLUMN IF NOT EXISTS v1_deleted_at  TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_verification_requests_v1_key
  ON verification_requests (api_key_id) WHERE v1_parcours IS NOT NULL;

-- Idempotence de POST /v1/sessions, par clé d'API (une clé de test et une clé de production ne
-- partagent jamais une clé d'idempotence). La ligne est insérée AVANT le traitement : la clé
-- primaire empêche deux requêtes simultanées de créer deux sessions.
CREATE TABLE IF NOT EXISTS v1_idempotency (
  api_key_id       UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  response_status  INTEGER,
  response_body    JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, key)
);

-- Événements de webhook v1. L'identifiant de la ligne est l'identifiant d'événement envoyé
-- (X-Preuvid-Event-Id), stable d'une reprise à l'autre. Pas de clé étrangère vers la session :
-- l'événement session.supprimee doit survivre à la suppression.
CREATE TABLE IF NOT EXISTS v1_webhook_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id            UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  session_id            UUID,
  type                  TEXT NOT NULL,
  payload               JSONB NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts              INTEGER NOT NULL DEFAULT 0,
  next_attempt_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_response_status  INTEGER,
  last_error            TEXT,
  delivered_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_v1_webhook_events_due
  ON v1_webhook_events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_v1_webhook_events_session
  ON v1_webhook_events (session_id);
