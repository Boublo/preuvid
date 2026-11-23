-- Preuvid, lot 3 : passe majeur et double anonymat (preuvid/docs/double-anonymat.md).
-- Aucune de ces tables ne contient de nom, de photo, de date de naissance, d'adresse IP ni d'adresse de site.

-- Clés de signature aveugle (RSABSSA-SHA384-PSS-Randomized). Une clé signifie « majeur » pendant sa période.
-- La clé privée est chiffrée par l'API (ENCRYPTION_KEY), jamais en clair en base.
CREATE TABLE IF NOT EXISTS v1_age_cles (
  id               TEXT PRIMARY KEY,               -- SHA-256 de la clé publique (SPKI), en hexadécimal
  spki             TEXT NOT NULL,                  -- clé publique, base64
  pkcs8_chiffre    TEXT NOT NULL,
  valide_du        TIMESTAMPTZ NOT NULL,
  valide_au        TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Passes : clés d'accès WebAuthn. Aucun lien vers la vérification qui a servi à les créer.
CREATE TABLE IF NOT EXISTS v1_age_passes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id    TEXT NOT NULL UNIQUE,           -- base64url
  public_key       TEXT NOT NULL,                  -- clé publique COSE, base64url
  compteur         BIGINT NOT NULL DEFAULT 0,
  sauvegarde_possible BOOLEAN NOT NULL DEFAULT false,  -- BE : clé synchronisable
  sauvegardee      BOOLEAN NOT NULL DEFAULT false,     -- BS : clé synchronisée
  transports       TEXT[],
  -- Compteur glissant pour limiter les preuves par heure ; pas d'historique des usages.
  fenetre_debut    TIMESTAMPTZ,
  fenetre_n        INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Défis WebAuthn en attente (cinq minutes). `verification_id` seulement pour la création d'un passe.
CREATE TABLE IF NOT EXISTS v1_age_defis (
  defi             TEXT PRIMARY KEY,               -- base64url
  usage            TEXT NOT NULL CHECK (usage IN ('creation', 'usage')),
  verification_id  UUID,
  expire_le        TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS v1_age_defis_expiration_idx ON v1_age_defis (expire_le);

-- Une vérification d'âge anonyme ne donne qu'une chose : un passe ou une preuve unique.
CREATE TABLE IF NOT EXISTS v1_age_verifications_utilisees (
  verification_id  UUID PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Relevés des sites (comptage différé). Le message signé identifie la preuve sans rien dire de la personne.
CREATE TABLE IF NOT EXISTS v1_age_releves (
  preuve_hash      TEXT PRIMARY KEY,               -- SHA-256 du message signé (aléa + défi du site)
  api_key_id       UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  developer_id     UUID NOT NULL,
  cle_id           TEXT NOT NULL,
  mois             DATE NOT NULL,                  -- mois de déclaration, pour la facture
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS v1_age_releves_facture_idx ON v1_age_releves (developer_id, mois);
