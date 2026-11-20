-- Preuvid, lot 2 : la réponse gardée pour l'idempotence contient le lien de la personne (jeton de
-- session en clair), la référence client et l'URL de retour. Elle est désormais chiffrée par l'API
-- et rattachée à sa session, pour que DELETE /v1/sessions/{id} l'efface.

ALTER TABLE v1_idempotency ADD COLUMN IF NOT EXISTS session_id UUID;
CREATE INDEX IF NOT EXISTS v1_idempotency_session_idx ON v1_idempotency (session_id);

-- Réponses enregistrées en clair avant ce correctif (pile locale seulement) : effacées.
DELETE FROM v1_idempotency WHERE response_body IS NOT NULL AND NOT (response_body ? 'chiffre');
