/**
 * Sessions de l'API v1, construites sur les services d'Idswyft sans modifier ses routes /api/v2.
 *
 * Règles de données (preuvid/docs/securite.md) :
 * - chaque session a sa propre ligne `users`, d'identifiant aléatoire, sans lien avec la référence ;
 * - la référence et l'URL de retour ne sont jamais journalisées ;
 * - DELETE efface les photos, l'état du moteur et les champs lus, et garde une pierre tombale
 *   (identifiant, clé, dates) pour l'événement session.supprimee.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { FLOW_PRESETS } from '@idswyft/shared';
import type { SessionState } from '@idswyft/shared';
import { supabase } from '@/config/database.js';
import { logger } from '@/utils/logger.js';
import { hashHandoffToken } from '@/middleware/auth.js';
import { VerificationService } from '@/services/verification.js';
import { StorageService } from '@/services/storage.js';
import config from '@/config/index.js';
import { saveSessionState, loadSessionState } from '@/services/sessionPersistence.js';
import { VerificationSession } from '@/verification/session/VerificationSession.js';
import { decisionV1, lienParcours, MODE_PAR_PARCOURS, statutV1, type V1Parcours, type V1Row } from './decision.js';
import { emettre } from './webhooks.js';

const verificationService = new VerificationService();
const stockage = new StorageService();

/**
 * Efface les fichiers de la session : pièces (recto, verso), selfie, enregistrement vocal.
 * Peut être relancé : en stockage local, un fichier déjà absent compte comme effacé (S3 et Supabase
 * acceptent déjà la suppression d'un objet absent). Renvoie false si un fichier n'a pas pu l'être.
 */
export async function effacerFichiers(id: string): Promise<boolean> {
  const chemins: string[] = [];
  for (const [table, colonnes] of [['documents', 'file_path'], ['selfies', 'file_path, enrollment_audio_path']] as const) {
    const { data, error } = await supabase.from(table).select(colonnes).eq('verification_request_id', id);
    if (error) return false;
    for (const ligne of (data ?? []) as Record<string, string | null>[]) {
      for (const c of Object.values(ligne)) if (c) chemins.push(c);
    }
  }
  let toutEfface = true;
  for (const chemin of chemins) {
    if (config.storage.provider === 'local') {
      const absent = await fs.stat(path.join(process.cwd(), chemin)).then(() => false, (e) => e?.code === 'ENOENT');
      if (absent) continue;
    }
    try {
      await stockage.deleteFile(chemin);
    } catch {
      toutEfface = false;
    }
  }
  return toutEfface;
}

/**
 * Ôte de l'état gardé ce qui a été lu sur la pièce (champs, bande MRZ) et l'empreinte du visage : la
 * réponse « majeur » est donnée, plus rien de la personne ne sert.
 */
async function effacerLecture(id: string): Promise<void> {
  const etat = await loadSessionState(id);
  const recto = etat?.front_extraction as Record<string, unknown> | undefined;
  if (!etat || !recto) return;
  for (const champ of ['ocr', 'mrz_fields', 'mrz_corrections', 'mrz_from_front', 'face_embedding', 'face_age', 'face_gender']) delete recto[champ];
  await saveSessionState(id, etat);
}

/**
 * Parcours âge (v1 et /api/v2) : aucune image après la réponse (preuvid/docs/securite.md, règle 1).
 * Appelé quand la vérification a une issue définitive : validée ou refusée par le moteur, ou décidée en
 * revue manuelle. Une vérification qui attend une revue garde son image jusqu'à la décision.
 */
/** Efface les photos (fichiers, puis leurs chemins). La décision et les champs lus restent. False si un fichier résiste. */
export async function effacerPhotos(id: string): Promise<boolean> {
  if (!(await effacerFichiers(id))) return false;
  const [d, s] = await Promise.all([
    supabase.from('documents').update({ file_path: null }).eq('verification_request_id', id),
    supabase.from('selfies').update({ file_path: null, enrollment_audio_path: null }).eq('verification_request_id', id),
  ]);
  return !d.error && !s.error;
}

export async function effacerImagesAge(id: string): Promise<void> {
  try {
    const { data } = await supabase.from('verification_requests').select('verification_mode').eq('id', id).single();
    if ((data as { verification_mode?: string } | null)?.verification_mode !== 'age_only') return;
    if (!(await effacerPhotos(id))) {
      logger.error('âge : images non effacées', { session: id });
      return;
    }
    await effacerLecture(id);
    logger.info('âge : images effacées après la réponse', { session: id });
  } catch (err) {
    logger.error('âge : effacement des images impossible', {
      session: id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Durée de validité du lien envoyé à la personne. */
export const DUREE_LIEN_MS = 60 * 60 * 1000;
export const AGE_MAJORITE = 18;

export interface CleApi {
  id: string;
  developer_id: string;
  is_sandbox: boolean;
}

export interface CreationV1 {
  parcours: V1Parcours;
  reference?: string | null;
  retour?: string | null;
}

const COLONNES = 'id, status, developer_id, is_sandbox, api_key_id, v1_parcours, v1_reference, v1_return_url, '
  + 'v1_deleted_at, session_token_expires_at, manual_review_reason, created_at, updated_at';

type Ligne = V1Row & {
  developer_id: string;
  is_sandbox: boolean;
  api_key_id: string | null;
  v1_reference: string | null;
  v1_return_url: string | null;
  v1_deleted_at: string | null;
  manual_review_reason: string | null;
  created_at: string;
  updated_at: string | null;
};

export async function creerSession(cle: CleApi, demande: CreationV1, baseParcours: string) {
  const userId = crypto.randomUUID();
  const { error: userError } = await supabase.from('users').insert({ id: userId });
  if (userError) throw new Error(`users: ${userError.message}`);

  const requete = await verificationService.createVerificationRequest({
    user_id: userId,
    developer_id: cle.developer_id,
    is_sandbox: cle.is_sandbox,
    source: 'api',
  });

  const mode = MODE_PAR_PARCOURS[demande.parcours];
  const jeton = crypto.randomBytes(32).toString('hex');
  const maintenant = new Date();
  const expiration = new Date(maintenant.getTime() + DUREE_LIEN_MS);
  const { error } = await supabase.from('verification_requests').update({
    session_started_at: maintenant.toISOString(),
    verification_mode: mode,
    step_timestamps: { init: maintenant.toISOString() },
    api_key_id: cle.id,
    session_api_key_id: cle.id,
    session_token_hash: hashHandoffToken(jeton),
    session_token_expires_at: expiration.toISOString(),
    ...(mode === 'age_only' && { age_threshold: AGE_MAJORITE }),
    v1_parcours: demande.parcours,
    v1_reference: demande.reference ?? null,
    v1_return_url: demande.retour ?? null,
  }).eq('id', requete.id);
  if (error) throw new Error(`verification_requests: ${error.message}`);

  // État initial du moteur. Aucune étape n'est exécutée ici : les dépendances ne servent pas.
  const session = new VerificationSession({} as any, { session_id: requete.id }, FLOW_PRESETS[mode]);
  await saveSessionState(requete.id, session.getState());

  logger.info('v1: session créée', { session: requete.id, parcours: demande.parcours, sandbox: cle.is_sandbox });

  return {
    session: requete.id,
    parcours: demande.parcours,
    statut: 'en_attente' as const,
    lien: lienParcours(baseParcours, demande.parcours, jeton),
    expire_le: expiration.toISOString(),
    reference: demande.reference ?? null,
    retour: demande.retour ?? null,
    test: cle.is_sandbox,
  };
}

/** Session de cette clé d'API, ou null (inconnue, autre clé, ou supprimée). */
async function lire(cle: CleApi, id: string): Promise<{ ligne: Ligne; etat: SessionState | null } | null> {
  const { data } = await supabase
    .from('verification_requests').select(COLONNES)
    .eq('id', id).eq('api_key_id', cle.id).single();
  const ligne = data as Ligne | null;
  if (!ligne || !ligne.v1_parcours || ligne.v1_deleted_at) return null;
  return { ligne, etat: await loadSessionState(id) };
}

export async function lireSession(cle: CleApi, id: string) {
  const s = await lire(cle, id);
  if (!s) return null;
  return {
    session: s.ligne.id,
    parcours: s.ligne.v1_parcours,
    statut: statutV1(s.ligne, s.etat),
    reference: s.ligne.v1_reference,
    retour: s.ligne.v1_return_url,
    expire_le: s.ligne.session_token_expires_at,
    cree_le: s.ligne.created_at,
    test: s.ligne.is_sandbox,
  };
}

export async function lireDecision(cle: CleApi, id: string) {
  const s = await lire(cle, id);
  if (!s) return null;
  return decisionV1(s.ligne, s.etat);
}

/**
 * Supprime la session : photos d'abord (si l'une ne peut pas être effacée, rien d'autre ne
 * l'est et l'appel échoue, pour pouvoir le relancer), puis lignes filles et état du moteur.
 * Renvoie false si la session n'existe pas pour cette clé.
 */
export async function supprimerSession(cle: CleApi, id: string): Promise<'supprimee' | 'introuvable' | 'echec_fichiers' | 'echec_base'> {
  const s = await lire(cle, id);
  if (!s) return 'introuvable';

  const fichiersEffaces = await effacerFichiers(id);
  if (!fichiersEffaces) return 'echec_fichiers';

  // Toutes les tables filles qui peuvent porter une donnée de la personne (champs lus, nom filtré,
  // téléphone, coffre, attestation). Chaque erreur compte : la ligne ne devient pierre tombale que si
  // tout est parti, sinon l'appel renvoie 503 et peut être relancé.
  const parSession = (table: string, colonne = 'verification_request_id') =>
    supabase.from(table).delete().eq(colonne, id);
  const resultats = await Promise.all([
    parSession('documents'),
    parSession('selfies'),
    parSession('verification_risk_scores'),
    parSession('verification_contexts', 'verification_id'),
    parSession('dedup_fingerprints'),
    parSession('aml_screenings'),
    parSession('expiry_alerts'),
    parSession('phone_otp_codes'),
    parSession('phone_otp_rate_limits'),
    parSession('verifiable_credentials'),
    parSession('identity_vault', 'verification_id'),
    // Réponse de création gardée pour l'idempotence : lien, référence, URL de retour.
    parSession('v1_idempotency', 'session_id'),
    // Les livraisons de webhooks /api/v2 gardent une copie des champs lus ; payload est NOT NULL.
    supabase.from('webhook_deliveries').update({ payload: {}, response_body: null }).eq('verification_request_id', id),
  ]);
  const erreurs = resultats.map(r => (r as { error?: { message?: string } | null }).error).filter(Boolean);
  if (erreurs.length > 0) {
    logger.error('v1: suppression incomplète', { session: id, erreurs: erreurs.map(e => e!.message) });
    return 'echec_base';
  }

  await supabase.from('verification_requests').update({
    v1_deleted_at: new Date().toISOString(),
    v1_reference: null,
    v1_return_url: null,
    session_token_hash: null,
    face_match_score: null,
    liveness_score: null,
    cross_validation_score: null,
    failure_reason: null,
    duplicate_flags: null,
    client_ip: null,
  }).eq('id', id);

  logger.info('v1: session supprimée', { session: id });
  await emettre('session.supprimee', s.ligne, { session: id, parcours: s.ligne.v1_parcours, statut: 'supprimee' });
  return 'supprimee';
}

/**
 * Appelé par le moteur d'Idswyft quand une vérification arrive à un résultat (fin de parcours
 * ou revue manuelle). Ne fait rien pour une vérification qui n'est pas une session v1.
 */
export async function notifierFinV1(verificationId: string, origine: 'parcours' | 'revue'): Promise<void> {
  try {
    const { data } = await supabase.from('verification_requests').select(COLONNES).eq('id', verificationId).single();
    const ligne = data as Ligne | null;
    if (!ligne?.v1_parcours || ligne.v1_deleted_at) return;
    const etat = await loadSessionState(verificationId);
    const statut = statutV1(ligne, etat);
    const evenement = origine === 'revue' ? 'session.revue'
      : statut === 'a_revoir' ? 'session.a_revoir'
      : 'session.terminee';
    if (origine === 'parcours' && !['validee', 'refusee', 'a_revoir'].includes(statut)) return;
    const age = ligne.v1_parcours === 'age';
    await emettre(evenement, ligne, {
      session: ligne.id,
      parcours: ligne.v1_parcours,
      statut,
      ...(age && { majeur: statut === 'validee' }),
    });
  } catch (err) {
    logger.error('v1: notification de fin impossible', {
      session: verificationId, error: err instanceof Error ? err.message : String(err),
    });
  }
}
