/**
 * Abandons et durées par étape des parcours Preuvid (ROADMAP, lot 3), sans donnée personnelle.
 *
 * Chaque session v1 donne, une fois finie, une ligne de `v1_mesures` : le jour, le parcours, comment
 * elle s'est terminée, le nombre de photos par côté et la durée de chaque étape. Aucun identifiant de
 * session, ni site, ni heure ; durées arrondies à 5 s. Limite : l'ordre d'écriture des lignes reste dans la
 * base. Qui lit la base brute peut rapprocher une ligne d'une session supprimée (écrite à l'instant de sa
 * pierre tombale) ; le passage horaire mélange son lot et ne note que le jour du comptage pour l'atténuer.
 * Le passe n'a jamais de site (double anonymat) ; pour l'identité, le site est laissé de côté tant qu'aucun
 * besoin ne le demande (jour, site et durées exactes se rapprocheraient des journaux du site).
 *
 * Les heures viennent du serveur : envoi de chaque photo (`documents`, `selfies`, essais ratés compris,
 * lignes gardées après l'effacement des photos), fin de la session (état), et ouverture de la page
 * (`v1_ouverte_le`, posée au premier appel de /v1/parcours/etat). Une session est comptée une seule fois :
 * `v1_mesuree_le` est posé par une mise à jour conditionnelle avant l'écriture de la mesure.
 *
 * Quand compter : toutes les heures pour les liens expirés (un lien vit une heure), et juste avant toute
 * suppression par le site ou par le passe (`supprimerSession`), qui effacerait ce qu'on mesure. La purge de
 * rétention d'Idswyft (production, après plusieurs jours) passe bien après le comptage horaire.
 */

import crypto from 'crypto';
import type { SessionState } from '@idswyft/shared';
import { supabase } from '@/config/database.js';
import { loadSessionState } from '@/services/sessionPersistence.js';
import { logger } from '@/utils/logger.js';
import { statutV1, V1_TERMINAUX, type V1Row, type V1Statut } from './decision.js';
import { etapeParcours } from './parcours.js';
import { ID_INTERNE } from './age/compte.js';

export type ParcoursMesure = 'identite' | 'age' | 'passe';
export type Issue =
  | 'sans_photo'          // lien expiré sans aucune photo envoyée (page ouverte ou non : voir page_ouverte)
  | 'abandon_recto'       // a commencé, s'est arrêté sur le recto (ou la page unique du passeport)
  | 'abandon_verso'
  | 'abandon_visage'
  | 'abandon_traitement'  // lien expiré pendant que le serveur travaillait (ne devrait pas arriver)
  | 'validee' | 'refusee' | 'a_revoir'
  | 'supprimee';          // supprimée par le site avant la fin

export const ISSUES: readonly Issue[] = [
  'sans_photo', 'abandon_recto', 'abandon_verso', 'abandon_visage', 'abandon_traitement', 'validee', 'refusee', 'a_revoir', 'supprimee',
];

/** Une ligne de `v1_mesures`. Le test vérifie que rien d'autre n'y entre. */
export interface Mesure {
  jour: string;                 // AAAA-MM-JJ, jour de création de la session (UTC)
  parcours: ParcoursMesure;
  issue: Issue;
  page_ouverte: boolean | null; // null : inconnu (sessions âge d'un site, sur la page d'Idswyft)
  essais_recto: number;
  essais_verso: number;
  essais_visage: number;
  recto_s: number | null;       // ouverture → dernière photo du recto
  verso_s: number | null;       // dernière photo du recto → dernière photo du verso (lecture du recto comprise)
  visage_s: number | null;      // dernière photo de la pièce → dernier visage (lecture comprise)
  resultat_s: number | null;    // dernier visage → fin
  total_s: number | null;       // ouverture → fin
}

const PAS_S = 5;
const arrondi = (ms: number | null): number | null =>
  ms === null || !Number.isFinite(ms) || ms < 0 ? null : Math.round(ms / 1000 / PAS_S) * PAS_S;
const ecart = (de: number | null, a: number | null) => (de === null || a === null ? null : arrondi(a - de));
const temps = (s: string | null | undefined) => { const t = s ? new Date(s).getTime() : NaN; return Number.isFinite(t) ? t : null; };
const dernier = (t: number[]) => (t.length ? Math.max(...t) : null);

export interface Faits {
  parcours: ParcoursMesure;
  statut: V1Statut;
  etape: ReturnType<typeof etapeParcours>; // étape où en était la session, lue comme si elle courait encore
  supprimee: boolean;
  creee_le: string;
  ouverte_le: string | null;
  page_connue: boolean;
  recto: string[];
  verso: string[];
  visages: string[];
  finie_le: string | null;
}

/** `photos` : photos envoyées, essais ratés compris (une photo illisible du recto ne « commence » pas la session). */
export function issueDe(f: Pick<Faits, 'statut' | 'etape' | 'supprimee'> & { photos: number }): Issue {
  if (f.statut === 'validee' || f.statut === 'refusee' || f.statut === 'a_revoir') return f.statut;
  if (f.supprimee && f.statut !== 'expiree' && f.statut !== 'abandonnee') return 'supprimee';
  if (f.photos === 0) return 'sans_photo';
  switch (f.etape) {
    case 'recto': return 'abandon_recto';
    case 'verso': return 'abandon_verso';
    case 'visage': return 'abandon_visage';
    default: return 'abandon_traitement';
  }
}

export function calculer(f: Faits): Mesure {
  const ouverte = temps(f.ouverte_le);
  const recto = f.recto.map(temps).filter((t): t is number => t !== null);
  const verso = f.verso.map(temps).filter((t): t is number => t !== null);
  const visages = f.visages.map(temps).filter((t): t is number => t !== null);
  const issue = issueDe({ ...f, photos: recto.length + verso.length + visages.length });
  const fin = issue === 'validee' || issue === 'refusee' || issue === 'a_revoir' ? temps(f.finie_le) : null;
  const finRecto = dernier(recto);
  const finVerso = dernier(verso);
  const finPiece = finVerso ?? finRecto;
  const finVisage = dernier(visages);
  return {
    jour: f.creee_le.slice(0, 10),
    parcours: f.parcours,
    issue,
    page_ouverte: f.page_connue ? ouverte !== null : null,
    essais_recto: recto.length,
    essais_verso: verso.length,
    essais_visage: visages.length,
    recto_s: ecart(ouverte, finRecto),
    verso_s: ecart(finRecto, finVerso),
    visage_s: ecart(finPiece, finVisage),
    resultat_s: ecart(finVisage, fin),
    total_s: ecart(ouverte, fin),
  };
}

type LigneMesure = V1Row & {
  developer_id: string;
  v1_deleted_at: string | null;
  v1_ouverte_le: string | null;
  v1_mesuree_le: string | null;
  created_at: string;
};

/**
 * Compte la session si elle est finie (ou si `supprimee` : juste avant sa suppression). Ne fait rien si elle
 * a déjà été comptée. Renvoie la mesure écrite, ou null.
 */
export async function mesurerSession(id: string, supprimee = false, maintenant = new Date()): Promise<Mesure | null> {
  const { data } = await supabase.from('verification_requests')
    .select('id, status, developer_id, v1_parcours, v1_deleted_at, v1_ouverte_le, v1_mesuree_le, session_token_expires_at, created_at')
    .eq('id', id).maybeSingle();
  const ligne = data as LigneMesure | null;
  if (!ligne || !ligne.v1_parcours || ligne.v1_mesuree_le || ligne.v1_deleted_at) return null;

  const etat: SessionState | null = await loadSessionState(id);
  const statut = statutV1(ligne, etat, maintenant);
  if (!supprimee && !V1_TERMINAUX.includes(statut)) return null;

  // Une seule mesure par session, même si deux instances ou la purge et le site y viennent en même temps.
  // Le jour seulement : une heure précise rapprocherait la ligne de la session dans la base.
  const jourDuComptage = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate())).toISOString();
  const { data: prise, error } = await supabase.from('verification_requests')
    .update({ v1_mesuree_le: jourDuComptage }).eq('id', id).is('v1_mesuree_le', null).select('id');
  if (error || !Array.isArray(prise) || prise.length !== 1) return null;

  const [docs, selfies] = await Promise.all([
    supabase.from('documents').select('is_back_of_id, created_at').eq('verification_request_id', id),
    supabase.from('selfies').select('created_at').eq('verification_request_id', id),
  ]);
  const lignesDocs = (docs.data ?? []) as { is_back_of_id: boolean | null; created_at: string }[];
  const passe = ligne.v1_parcours === 'age' && ligne.developer_id === ID_INTERNE;
  const mesure = calculer({
    parcours: passe ? 'passe' : ligne.v1_parcours,
    statut,
    etape: etapeParcours(etat, 'en_cours'),
    supprimee,
    creee_le: ligne.created_at,
    // Le passe crée sa vérification à l'ouverture de la page /age ; l'identité passe par /v1/parcours/etat.
    ouverte_le: passe ? ligne.created_at : ligne.v1_ouverte_le,
    page_connue: passe || ligne.v1_parcours === 'identite',
    recto: lignesDocs.filter(d => !d.is_back_of_id).map(d => d.created_at),
    verso: lignesDocs.filter(d => d.is_back_of_id).map(d => d.created_at),
    visages: ((selfies.data ?? []) as { created_at: string }[]).map(s => s.created_at),
    finie_le: etat?.completed_at ?? null,
  });
  const { error: e2 } = await supabase.from('v1_mesures').insert(mesure);
  if (e2) {
    logger.error('mesures : ligne non écrite', { error: e2.message });
    return null;
  }
  return mesure;
}

/** Toutes les heures : sessions v1 dont le lien a expiré et qui n'ont pas encore été comptées. */
export async function mesurerParcours(maintenant = new Date(), lot = 500): Promise<number> {
  const { data } = await supabase.from('verification_requests').select('id')
    .not('v1_parcours', 'is', null).is('v1_mesuree_le', null).is('v1_deleted_at', null)
    .lt('session_token_expires_at', maintenant.toISOString())
    .order('created_at', { ascending: true }).limit(lot);
  // Ordre aléatoire : l'ordre des lignes écrites ne suit pas celui de la création des sessions.
  const ids = ((data ?? []) as { id: string }[]).map(l => l.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  let n = 0;
  for (const id of ids) {
    try {
      if (await mesurerSession(id, false, maintenant)) n++;
    } catch (err) {
      logger.error('mesures : session non comptée', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return n;
}

// ── Relevé ─────────────────────────────────────────────────────────────────────────────────────────

const quantile = (v: number[], q: number): number | null => {
  if (!v.length) return null;
  const t = [...v].sort((a, b) => a - b);
  return t[Math.min(t.length - 1, Math.ceil(q * t.length) - 1)];
};
const durees = (v: (number | null)[]) => {
  const ok = v.filter((x): x is number => x !== null);
  return { mediane_s: quantile(ok, 0.5), p90_s: quantile(ok, 0.9), mesurees: ok.length };
};
const taux = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export interface EtapeReleve {
  etape: 'recto' | 'verso' | 'visage' | 'resultat';
  atteinte: number;
  abandons: number;
  taux_abandon_pct: number | null;
  mediane_s: number | null;
  p90_s: number | null;
  mesurees: number;
}

/** Relevé d'un parcours : issues, et par étape les sessions qui l'ont atteinte, les abandons et la durée. */
export function releveParcours(lignes: Mesure[]) {
  const issues = Object.fromEntries(ISSUES.map(i => [i, lignes.filter(l => l.issue === i).length])) as Record<Issue, number>;
  // Recto atteint : page ouverte, ou au moins une photo (page d'Idswyft, ouverture inconnue).
  const recto = lignes.filter(l => l.page_ouverte === true || l.essais_recto > 0 || l.issue === 'abandon_recto');
  const verso = lignes.filter(l => l.essais_verso > 0 || l.issue === 'abandon_verso');
  const visage = lignes.filter(l => l.essais_visage > 0 || l.issue === 'abandon_visage');
  const resultat = lignes.filter(l => l.issue === 'validee' || l.issue === 'refusee' || l.issue === 'a_revoir');
  const etape = (nom: EtapeReleve['etape'], atteintes: Mesure[], abandon: ((l: Mesure) => boolean) | null, d: (l: Mesure) => number | null): EtapeReleve => {
    const abandons = abandon ? atteintes.filter(abandon).length : 0;
    return { etape: nom, atteinte: atteintes.length, abandons, taux_abandon_pct: abandon ? taux(abandons, atteintes.length) : null, ...durees(atteintes.map(d)) };
  };
  return {
    sessions: lignes.length,
    issues,
    page_jamais_ouverte: lignes.filter(l => l.page_ouverte === false).length,
    etapes: [
      // Page ouverte puis lien expiré sans photo : abandon devant le recto.
      etape('recto', recto, l => l.issue === 'abandon_recto' || l.issue === 'sans_photo', l => l.recto_s),
      etape('verso', verso, l => l.issue === 'abandon_verso', l => l.verso_s),
      etape('visage', visage, l => l.issue === 'abandon_visage', l => l.visage_s),
      etape('resultat', resultat, null, l => l.resultat_s),
    ],
    duree_totale: durees(resultat.map(l => l.total_s)),
    taux_validation_pct: taux(issues.validee, lignes.length),
  };
}

const JOUR = /^\d{4}-\d{2}-\d{2}$/;

/** Relevé sur une période (jours inclus), par parcours. Par défaut, les 30 derniers jours. */
export async function releve(du?: string, au?: string, maintenant = new Date()) {
  const fin = au && JOUR.test(au) ? au : maintenant.toISOString().slice(0, 10);
  const debut = du && JOUR.test(du) ? du : new Date(maintenant.getTime() - 29 * 86400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase.from('v1_mesures').select('*').gte('jour', debut).lte('jour', fin).limit(100_000);
  if (error) throw new Error(`v1_mesures: ${error.message}`);
  const lignes = ((data ?? []) as Mesure[]).map(l => ({ ...l, jour: String(l.jour).slice(0, 10) }));
  const parcours: ParcoursMesure[] = ['identite', 'passe', 'age'];
  return {
    du: debut,
    au: fin,
    parcours: Object.fromEntries(parcours.map(p => [p, releveParcours(lignes.filter(l => l.parcours === p))])),
  };
}
