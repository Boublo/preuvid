/**
 * API v1 : statut, décision et motif d'une session, calculés à partir de l'état du moteur
 * d'Idswyft (SessionState) et de la ligne verification_requests. Fonctions pures.
 *
 * Statuts (voir preuvid/docs/api.md) :
 * - en_attente : session créée, aucune pièce envoyée ;
 * - en_cours   : au moins une étape commencée, pas de résultat ;
 * - validee / refusee / a_revoir : résultat final (après revue manuelle le cas échéant) ;
 * - expiree    : lien expiré sans qu'aucune pièce ait été envoyée ;
 * - abandonnee : lien expiré alors que la personne avait commencé.
 */

import type { SessionState } from '@idswyft/shared';
import { FLOW_PRESETS, VerificationStatus } from '@idswyft/shared';
import { mapStatusForResponse } from '@/verification/statusReader.js';

export type V1Parcours = 'identite' | 'age';
export type V1Statut = 'en_attente' | 'en_cours' | 'validee' | 'refusee' | 'a_revoir' | 'expiree' | 'abandonnee';
export const V1_STATUTS: readonly V1Statut[] = ['en_attente', 'en_cours', 'validee', 'refusee', 'a_revoir', 'expiree', 'abandonnee'];
export const V1_TERMINAUX: readonly V1Statut[] = ['validee', 'refusee', 'a_revoir', 'expiree', 'abandonnee'];

/** Mode du moteur d'Idswyft utilisé pour chaque parcours. */
export const MODE_PAR_PARCOURS: Record<V1Parcours, 'full' | 'age_only'> = {
  identite: 'full',
  age: 'age_only',
};

export interface V1Row {
  id: string;
  status: string | null;
  v1_parcours: V1Parcours;
  session_token_expires_at: string | null;
  created_at?: string | null;
}

function flowFor(parcours: V1Parcours) {
  return FLOW_PRESETS[MODE_PAR_PARCOURS[parcours]];
}

/**
 * Lien envoyé à la personne. Identité : page Preuvid, jeton après le # (jamais envoyé au serveur dans
 * l'adresse, donc absent des journaux). Âge : encore la page d'Idswyft (suite à faire, ROADMAP lot 3).
 */
export function lienParcours(base: string, parcours: V1Parcours, jeton: string): string {
  const racine = base.replace(/\/$/, '');
  return parcours === 'identite' ? `${racine}/verifier#${jeton}` : `${racine}/user-verification?session=${jeton}`;
}

/** Résultat final : la colonne `status` l'emporte (elle porte la revue manuelle), sinon l'état. */
function finalResult(row: V1Row, state: SessionState | null): 'verified' | 'failed' | 'manual_review' | null {
  if (row.status === 'verified' || row.status === 'failed' || row.status === 'manual_review') return row.status;
  if (!state) return null;
  const r = mapStatusForResponse(state, flowFor(row.v1_parcours)).final_result;
  return r === 'verified' || r === 'failed' || r === 'manual_review' ? r : null;
}

function started(state: SessionState | null): boolean {
  if (!state) return false;
  return !!state.front_extraction || state.current_step !== VerificationStatus.AWAITING_FRONT;
}

export function statutV1(row: V1Row, state: SessionState | null, now: Date = new Date()): V1Statut {
  const result = finalResult(row, state);
  if (result === 'verified') return 'validee';
  if (result === 'failed') return 'refusee';
  if (result === 'manual_review') return 'a_revoir';
  const expired = row.session_token_expires_at !== null && new Date(row.session_token_expires_at) <= now;
  if (expired) return started(state) ? 'abandonnee' : 'expiree';
  return started(state) ? 'en_cours' : 'en_attente';
}

/** Motif lisible : code stable, et texte en français pour l'espace client et le site. */
export interface V1Motif {
  code: string;
  texte: string;
}

const TEXTES: Record<string, string> = {
  FRONT_OCR_FAILED: 'recto illisible',
  FRONT_LOW_CONFIDENCE: 'lecture du recto peu sûre',
  BACK_BARCODE_NOT_FOUND: 'code-barres ou bande MRZ du verso introuvable',
  BACK_MRZ_CHECKSUM_FAILED: 'clé de contrôle fausse, valeur confirmée par le recto',
  BACK_MRZ_UNREADABLE: 'bande MRZ du verso illisible',
  BACK_MRZ_BARCODE_MISMATCH: 'la bande MRZ et le code-barres ne concordent pas',
  CROSS_VALIDATION_FAILED: 'le recto et le verso ne concordent pas',
  DOCUMENT_EXPIRED: 'pièce expirée',
  LIVENESS_FAILED: 'détection du vivant échouée',
  FACE_NOT_DETECTED: 'visage non détecté',
  FACE_MATCH_FAILED: 'visage différent de la photo de la pièce',
  AML_MATCH_FOUND: 'personne présente sur une liste de sanctions',
  AML_POTENTIAL_MATCH: 'correspondance possible avec une liste de sanctions',
  DOCUMENT_TAMPERED: 'signes de falsification de la pièce',
  DEEPFAKE_DETECTED: 'image générée ou truquée',
  VOICE_MATCH_FAILED: 'voix différente de l’enregistrement',
  VOICE_CHALLENGE_FAILED: 'phrase de contrôle vocal non reconnue',
  DOB_NOT_FOUND: 'date de naissance illisible',
  UNDERAGE: 'âge minimal non atteint',
};

/** Score de visage sur 100, ou null si la comparaison n'a pas eu lieu. */
export function scoreVisage(state: SessionState | null): number | null {
  const s = state?.face_match?.similarity_score;
  return typeof s === 'number' ? Math.round(s * 100) : null;
}

export function motifV1(statut: V1Statut, state: SessionState | null, manualReviewReason?: string | null): V1Motif | null {
  const visage = scoreVisage(state);
  if (statut === 'refusee') {
    const code = (state?.rejection_reason as string | undefined) ?? 'REFUS';
    let texte = TEXTES[code] ?? 'vérification refusée';
    if (code === 'FACE_MATCH_FAILED' && visage !== null) texte = `visage ${visage} sur 100, différent de la photo de la pièce`;
    return { code, texte };
  }
  if (statut === 'a_revoir') {
    if (state?.face_match?.skipped_reason) return { code: 'VISAGE_NON_COMPARE', texte: 'comparaison du visage impossible, revue manuelle' };
    if (state?.cross_validation?.verdict === 'REVIEW') return { code: 'RECTO_VERSO_A_REVOIR', texte: 'le recto et le verso diffèrent sur un champ, revue manuelle' };
    return { code: 'REVUE_MANUELLE', texte: manualReviewReason ? 'revue manuelle demandée par une règle' : 'revue manuelle' };
  }
  if (statut === 'validee') {
    const cles = state?.front_extraction?.mrz_valid === true ? 'clés de contrôle justes' : null;
    const parts = [visage !== null ? `visage ${visage} sur 100` : null, cles].filter(Boolean);
    return { code: 'VALIDEE', texte: parts.length ? parts.join(', ') : 'vérification réussie' };
  }
  if (statut === 'expiree') return { code: 'LIEN_EXPIRE', texte: 'lien expiré sans envoi de pièce' };
  if (statut === 'abandonnee') return { code: 'ABANDON', texte: 'parcours commencé puis abandonné' };
  return null;
}

/** Champ lu sur la pièce, avec l'état de la clé de contrôle MRZ qui le couvre. */
export interface V1Champ {
  valeur: string | null;
  cle: 'juste' | 'corrigee' | 'fausse' | 'sans_cle' | 'absente';
  source: 'mrz' | 'zone_imprimee' | 'concordants' | null;
}

const CHAMPS_MRZ: Record<string, string> = {
  document_number: 'numero_document',
  last_name: 'nom',
  first_names: 'prenoms',
  date_of_birth: 'date_naissance',
  expiry_date: 'date_expiration',
  nationality: 'nationalite',
  sex: 'sexe',
};

const CHAMPS_OCR: Record<string, string> = {
  document_number: 'numero_document',
  last_name: 'nom',
  first_name: 'prenoms',
  date_of_birth: 'date_naissance',
  expiration_date: 'date_expiration',
  nationality: 'nationalite',
  sex: 'sexe',
};

export function champsV1(state: SessionState | null): Record<string, V1Champ> | null {
  const front = state?.front_extraction;
  if (!front) return null;
  const out: Record<string, V1Champ> = {};
  const mrz = front.mrz_fields ?? null;
  if (mrz) {
    for (const [k, nom] of Object.entries(CHAMPS_MRZ)) {
      const f = mrz[k];
      if (!f) continue;
      out[nom] = { valeur: f.value, cle: f.check === 'absent' ? 'absente' : f.check, source: f.source };
    }
  }
  const ocr = (front.ocr ?? {}) as Record<string, unknown>;
  for (const [k, nom] of Object.entries(CHAMPS_OCR)) {
    if (out[nom] || ocr[k] == null || ocr[k] === '') continue;
    out[nom] = { valeur: String(ocr[k]), cle: 'absente', source: 'zone_imprimee' };
  }
  return out;
}

/** Corps de GET /v1/sessions/{id}/decision. Pour le parcours `age`, seulement `majeur`. */
export function decisionV1(row: V1Row & { manual_review_reason?: string | null }, state: SessionState | null, now: Date = new Date()) {
  const statut = statutV1(row, state, now);
  const termine = V1_TERMINAUX.includes(statut);
  if (row.v1_parcours === 'age') {
    // « false » veut dire : majorité non prouvée (mineur, ou pièce illisible).
    return { session: row.id, parcours: row.v1_parcours, statut, majeur: termine ? statut === 'validee' : null };
  }
  return {
    session: row.id,
    parcours: row.v1_parcours,
    statut,
    motif: motifV1(statut, state, row.manual_review_reason),
    visage: scoreVisage(state),
    champs: champsV1(state),
  };
}
