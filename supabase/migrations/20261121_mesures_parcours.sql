-- Preuvid, lot 3 : abandons et durées par étape des parcours, sans donnée personnelle (backend/src/v1/mesures.ts).

-- Ouverture de la page de vérification (premier appel de /v1/parcours/etat) et comptage de la session.
ALTER TABLE verification_requests
  ADD COLUMN IF NOT EXISTS v1_ouverte_le TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS v1_mesuree_le TIMESTAMPTZ;

-- Les sessions créées avant cette migration ne sont pas comptées : leur ouverture n'a pas été notée.
UPDATE verification_requests SET v1_mesuree_le = now() WHERE v1_parcours IS NOT NULL AND v1_mesuree_le IS NULL;

-- Sessions v1 restant à compter (le passage horaire ne lit que celles-ci).
CREATE INDEX IF NOT EXISTS verification_requests_v1_a_mesurer_idx
  ON verification_requests (session_token_expires_at)
  WHERE v1_parcours IS NOT NULL AND v1_mesuree_le IS NULL AND v1_deleted_at IS NULL;

-- Une ligne par session finie. Ni identifiant de session, ni site, ni heure (le jour seulement) ; durées
-- arrondies à 5 secondes. Identifiant aléatoire plutôt qu'une séquence. L'ordre physique d'écriture reste :
-- qui lit la base brute peut approcher le lien avec une session supprimée (voir backend/src/v1/mesures.ts).
CREATE TABLE IF NOT EXISTS v1_mesures (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jour          DATE NOT NULL,
  parcours      TEXT NOT NULL CHECK (parcours IN ('identite', 'age', 'passe')),
  issue         TEXT NOT NULL CHECK (issue IN ('sans_photo', 'abandon_recto', 'abandon_verso', 'abandon_visage',
                  'abandon_traitement', 'validee', 'refusee', 'a_revoir', 'supprimee')),
  page_ouverte  BOOLEAN,                       -- NULL : inconnu (vérification d'âge d'un site, page d'Idswyft)
  essais_recto  SMALLINT NOT NULL DEFAULT 0,
  essais_verso  SMALLINT NOT NULL DEFAULT 0,
  essais_visage SMALLINT NOT NULL DEFAULT 0,
  recto_s       INTEGER,
  verso_s       INTEGER,
  visage_s      INTEGER,
  resultat_s    INTEGER,
  total_s       INTEGER
);
CREATE INDEX IF NOT EXISTS v1_mesures_jour_idx ON v1_mesures (jour, parcours);
