/**
 * Page Preuvid du parcours identité (maquettes 03 à 07), ouverte par le lien d'une session v1.
 *
 * La page ne connaît que le jeton de session (après le # du lien, jamais envoyé au serveur dans
 * l'adresse) : elle le passe dans le corps des appels. Elle reçoit de quoi enchaîner les écrans et ce
 * qui a été vérifié sur la pièce, en résumé, sans aucun champ lu : ni nom, ni numéro, ni date.
 * Les photos s'envoient par les routes d'Idswyft (/api/v2/verify/:id/…, en-tête X-Session-Token).
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Compteur, erreurV1 } from './protections.js';
import { VerificationStatus } from '@idswyft/shared';
import type { SessionState } from '@idswyft/shared';
import { supabase } from '@/config/database.js';
import { hashHandoffToken } from '@/middleware/auth.js';
import { loadSessionState } from '@/services/sessionPersistence.js';
import { logger } from '@/utils/logger.js';
import { champsV1, motifV1, statutV1, type V1Row, type V1Statut } from './decision.js';
import { effacerPhotos } from './sessions.js';
import { ESSAIS_PHOTO_V1 } from './photos.js';

/** Ce que la page attend de la personne ; `traitement` : le serveur travaille, on patiente. */
export type EtapeParcours = 'recto' | 'verso' | 'visage' | 'traitement' | null;

export function etapeParcours(etat: SessionState | null, statut: V1Statut): EtapeParcours {
  if (statut !== 'en_attente' && statut !== 'en_cours') return null;
  switch (etat?.current_step ?? VerificationStatus.AWAITING_FRONT) {
    case VerificationStatus.AWAITING_FRONT: return 'recto';
    case VerificationStatus.AWAITING_BACK: return 'verso';
    case VerificationStatus.AWAITING_LIVE: return 'visage';
    // Voix (option d'Idswyft) : la page Preuvid ne la propose pas ; la session finira abandonnée.
    default: return 'traitement';
  }
}

/** Photos encore possibles pour le côté demandé (une photo illisible de plus que cela refuse la session). */
export function essaisRestants(etat: SessionState | null, etape: EtapeParcours): number | null {
  if (etape !== 'recto' && etape !== 'verso') return null;
  const faits = (etat as { essais_photo?: { recto?: number; verso?: number } } | null)?.essais_photo?.[etape] ?? 0;
  return Math.max(0, ESSAIS_PHOTO_V1 - faits);
}

/** Ce qui a été vérifié sur la pièce, en résumé. Rien de ce qui est écrit dessus. */
export interface Lecture {
  /** Bande MRZ lue (recto du passeport, verso de la carte). */
  mrz: boolean;
  /** Clés de contrôle justes (dont corrigées), sur celles qui ont pu être calculées. */
  cles: { justes: number; total: number } | null;
  /** Date de fin de validité lue : encore valide, ou dépassée. */
  validite: 'valide' | 'depassee' | null;
}

export function lectureDe(etat: SessionState | null, maintenant = new Date()): Lecture | null {
  const champs = champsV1(etat);
  if (!champs) return null;
  const liste = Object.values(champs);
  const mrz = liste.some(c => c.source === 'mrz' || c.source === 'concordants');
  const avecCle = liste.filter(c => c.cle === 'juste' || c.cle === 'corrigee' || c.cle === 'fausse');
  const cles = avecCle.length ? { justes: avecCle.filter(c => c.cle !== 'fausse').length, total: avecCle.length } : null;
  const fin = champs.date_expiration?.valeur;
  const date = fin && /^\d{4}-\d{2}-\d{2}$/.test(fin) ? new Date(`${fin}T23:59:59Z`) : null;
  const validite = date && !Number.isNaN(date.getTime()) ? (date >= maintenant ? 'valide' : 'depassee') : null;
  return { mrz, cles, validite };
}

/** Durée du parcours en secondes, une fois validé (affichée sur l'écran de fin). */
export function dureeDe(etat: SessionState | null): number | null {
  if (!etat?.completed_at || !etat.created_at) return null;
  const s = Math.round((new Date(etat.completed_at).getTime() - new Date(etat.created_at).getTime()) / 1000);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

type Ligne = V1Row & {
  developer_id: string;
  v1_return_url: string | null;
  v1_deleted_at: string | null;
  v1_ouverte_le: string | null;
  manual_review_reason: string | null;
};

async function ligneDuJeton(jeton: string): Promise<Ligne | null> {
  const { data } = await supabase.from('verification_requests')
    .select('id, status, developer_id, v1_parcours, v1_return_url, v1_deleted_at, v1_ouverte_le, session_token_expires_at, manual_review_reason, created_at')
    .eq('session_token_hash', hashHandoffToken(jeton)).maybeSingle();
  const l = data as Ligne | null;
  // Seul le parcours identité passe par cette page ; une session supprimée n'existe plus.
  return l && l.v1_parcours === 'identite' && !l.v1_deleted_at ? l : null;
}

async function nomDuSite(developerId: string): Promise<string | null> {
  const { data } = await supabase.from('developers').select('branding_company_name, company').eq('id', developerId).maybeSingle();
  const d = data as { branding_company_name?: string | null; company?: string | null } | null;
  const nom = (d?.branding_company_name || d?.company || '').trim();
  return nom ? nom.slice(0, 80) : null;
}

async function photosPresentes(id: string): Promise<boolean> {
  const [d, s] = await Promise.all([
    supabase.from('documents').select('id').eq('verification_request_id', id).not('file_path', 'is', null).limit(1),
    supabase.from('selfies').select('id').eq('verification_request_id', id).not('file_path', 'is', null).limit(1),
  ]);
  return (d.data?.length ?? 0) > 0 || (s.data?.length ?? 0) > 0;
}

export async function etatParcours(jeton: string) {
  const ligne = await ligneDuJeton(jeton);
  if (!ligne) return null;
  // Mesure des abandons (./mesures.ts) : première ouverture de la page, une seule fois.
  if (!ligne.v1_ouverte_le) {
    await Promise.resolve(supabase.from('verification_requests').update({ v1_ouverte_le: new Date().toISOString() })
      .eq('id', ligne.id).is('v1_ouverte_le', null)).catch(() => {});
  }
  const [etat, site, photos] = await Promise.all([loadSessionState(ligne.id), nomDuSite(ligne.developer_id), photosPresentes(ligne.id)]);
  const statut = statutV1(ligne, etat);
  const etape = etapeParcours(etat, statut);
  return {
    session: ligne.id,
    site,
    retour: ligne.v1_return_url,
    statut,
    etape,
    essais_restants: essaisRestants(etat, etape),
    // Ce côté a déjà donné une photo illisible : la page ne prend plus la suivante toute seule.
    photo_ratee: (essaisRestants(etat, etape) ?? ESSAIS_PHOTO_V1) < ESSAIS_PHOTO_V1,
    lecture: lectureDe(etat),
    // Seulement le motif d'un refus, en clair, pour la personne elle-même.
    motif: statut === 'refusee' ? motifV1(statut, etat, ligne.manual_review_reason)?.texte ?? null : null,
    duree_s: statut === 'validee' ? dureeDe(etat) : null,
    photos: photos ? 'gardees' as const : 'effacees' as const,
    expire_le: ligne.session_token_expires_at,
  };
}

/**
 * « Demander la suppression maintenant » : efface les photos d'une session tranchée. La décision et les
 * champs lus restent pour le site. Une session à revoir garde ses photos jusqu'à la revue.
 */
export async function effacerPhotosParcours(jeton: string): Promise<'effacees' | 'introuvable' | 'pas_tranchee' | 'echec'> {
  const ligne = await ligneDuJeton(jeton);
  if (!ligne) return 'introuvable';
  const statut = statutV1(ligne, await loadSessionState(ligne.id));
  if (statut !== 'validee' && statut !== 'refusee') return 'pas_tranchee';
  if (!(await effacerPhotos(ligne.id))) {
    logger.error('parcours : photos non effacées à la demande', { session: ligne.id });
    return 'echec';
  }
  logger.info('parcours : photos effacées à la demande de la personne', { session: ligne.id });
  return 'effacees';
}

// ─── Routes, montées sur /v1/parcours, sans clé d'API : le jeton de session suffit ──────────────


const LIMITE = 120; // appels par minute et par adresse : la page interroge l'état toutes les 2 s
const appels = new Compteur(LIMITE);
const Corps = z.object({ jeton: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

const asynchrone = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function jetonDe(req: Request, res: Response): string | null {
  const lu = Corps.safeParse(req.body ?? {});
  if (lu.success) return lu.data.jeton;
  erreurV1(res, 400, 'requete_invalide', 'jeton : 64 caractères hexadécimaux attendus');
  return null;
}

export const routerParcours = express.Router();
routerParcours.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const { restant } = appels.prendre(req.ip || req.socket?.remoteAddress || 'inconnue');
  if (restant < 0) {
    res.setHeader('Retry-After', '60');
    return erreurV1(res, 429, 'limite_depassee', `Plus de ${LIMITE} demandes par minute depuis cette adresse.`);
  }
  next();
});

routerParcours.post('/etat', asynchrone(async (req, res) => {
  const jeton = jetonDe(req, res);
  if (!jeton) return;
  const etat = await etatParcours(jeton);
  if (!etat) return erreurV1(res, 404, 'session_introuvable', 'Lien inconnu, ou session supprimée.');
  res.json(etat);
}));

routerParcours.post('/effacer-photos', asynchrone(async (req, res) => {
  const jeton = jetonDe(req, res);
  if (!jeton) return;
  const r = await effacerPhotosParcours(jeton);
  if (r === 'introuvable') return erreurV1(res, 404, 'session_introuvable', 'Lien inconnu, ou session supprimée.');
  if (r === 'pas_tranchee') return erreurV1(res, 409, 'session_non_tranchee', 'Les photos servent encore : la vérification n’est pas terminée.');
  if (r === 'echec') return erreurV1(res, 503, 'effacement_impossible', 'Les photos n’ont pas pu être effacées. Réessayez dans un instant.');
  res.status(204).end();
}));
