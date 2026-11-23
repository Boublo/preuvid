/**
 * API Preuvid v1, montée sur /v1. Authentification par en-tête x-api-key (clés d'Idswyft, hachées
 * en HMAC-SHA256). Réponses et erreurs en français : { erreur: { code, message } }.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import config from '@/config/index.js';
import { supabase } from '@/config/database.js';
import { logger } from '@/utils/logger.js';
import { authenticateAPIKey } from '@/middleware/auth.js';
import { barrageEchecsAuth, erreurV1, idempotence, limiteParCle } from './protections.js';
import { creerSession, lireDecision, lireSession, supprimerSession, type CleApi } from './sessions.js';
import { rejouer } from './webhooks.js';
import { openapiV1 } from './openapi.js';
import { routerAge } from './age/router.js';
import { routerParcours } from './parcours.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL de retour : https seulement (http admis pour localhost hors production). */
export function retourValide(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.protocol === 'https:') return true;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  return u.protocol === 'http:' && local && config.nodeEnv !== 'production';
}

export const CreationSchema = z.object({
  parcours: z.enum(['identite', 'age']),
  reference: z.string().min(1).max(255).optional(),
  retour: z.string().max(2000).refine(retourValide, 'URL https attendue').optional(),
}).strict();

const cleDe = (req: Request): CleApi => (req as any).apiKey;

const asynchrone = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

function idValide(req: Request, res: Response, next: NextFunction) {
  if (!UUID.test(req.params.id)) return erreurV1(res, 404, 'session_introuvable', 'Session introuvable.');
  next();
}

export const routerV1 = express.Router();

routerV1.get('/openapi.json', (_req, res) => { res.json(openapiV1); });

// Passe majeur : routes de la page Preuvid, sans clé d'API (sauf /age/releves, authentifiée à part).
routerV1.use('/age', routerAge);
// Page du parcours identité : le jeton de session suffit (preuvid/docs/api.md, « Page du parcours »).
routerV1.use('/parcours', routerParcours);

routerV1.use(barrageEchecsAuth, authenticateAPIKey, limiteParCle);

routerV1.post('/sessions', idempotence, asynchrone(async (req, res) => {
  const lu = CreationSchema.safeParse(req.body ?? {});
  if (!lu.success) {
    const p = lu.error.issues[0];
    return erreurV1(res, 400, 'requete_invalide', `${p.path.join('.') || 'corps'} : ${p.message}`);
  }
  const base = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  res.status(201).json(await creerSession(cleDe(req), lu.data, base));
}));

routerV1.get('/sessions/:id', idValide, asynchrone(async (req, res) => {
  const s = await lireSession(cleDe(req), req.params.id);
  if (!s) return erreurV1(res, 404, 'session_introuvable', 'Session introuvable.');
  res.json(s);
}));

routerV1.get('/sessions/:id/decision', idValide, asynchrone(async (req, res) => {
  const d = await lireDecision(cleDe(req), req.params.id);
  if (!d) return erreurV1(res, 404, 'session_introuvable', 'Session introuvable.');
  res.json(d);
}));

routerV1.delete('/sessions/:id', idValide, asynchrone(async (req, res) => {
  const r = await supprimerSession(cleDe(req), req.params.id);
  if (r === 'introuvable') return erreurV1(res, 404, 'session_introuvable', 'Session introuvable.');
  if (r === 'echec_fichiers') return erreurV1(res, 503, 'suppression_incomplete', 'Les photos n’ont pas pu être effacées. Réessayez.');
  if (r === 'echec_base') return erreurV1(res, 503, 'suppression_incomplete', 'Photos effacées, mais certaines données n’ont pas pu être supprimées. Réessayez.');
  res.status(204).end();
}));

/** Événements de webhook d'une session : pour suivre les livraisons et les rejouer. */
routerV1.get('/sessions/:id/evenements', idValide, asynchrone(async (req, res) => {
  const cle = cleDe(req);
  const { data: ligne } = await supabase.from('verification_requests')
    .select('id').eq('id', req.params.id).eq('api_key_id', cle.id).single();
  if (!ligne) return erreurV1(res, 404, 'session_introuvable', 'Session introuvable.');
  const { data } = await supabase.from('v1_webhook_events')
    .select('id, type, status, attempts, next_attempt_at, last_response_status, delivered_at, created_at')
    .eq('session_id', req.params.id).order('created_at', { ascending: true });
  res.json({
    evenements: (data ?? []).map((e: any) => ({
      id: e.id, evenement: e.type, etat: e.status, tentatives: e.attempts,
      prochaine_tentative: e.status === 'pending' ? e.next_attempt_at : null,
      derniere_reponse: e.last_response_status, livre_le: e.delivered_at, cree_le: e.created_at,
    })),
  });
}));

routerV1.post('/evenements/:id/rejouer', idValide, asynchrone(async (req, res) => {
  const cle = cleDe(req);
  const { data: ev } = await supabase.from('v1_webhook_events')
    .select('id, webhook_id').eq('id', req.params.id).single();
  const { data: w } = ev
    ? await supabase.from('webhooks').select('developer_id, api_key_id, is_sandbox').eq('id', (ev as any).webhook_id).single()
    : { data: null };
  const autorise = w && w.developer_id === cle.developer_id && w.is_sandbox === cle.is_sandbox
    && (w.api_key_id == null || w.api_key_id === cle.id);
  if (!autorise) return erreurV1(res, 404, 'evenement_introuvable', 'Événement introuvable.');
  const livre = await rejouer(req.params.id);
  res.status(202).json({ id: req.params.id, livre });
}));

routerV1.use((_req, res) => erreurV1(res, 404, 'introuvable', 'Ressource inconnue.'));

// Erreurs : format v1, sans détail interne.
routerV1.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  const status = Number(err?.statusCode || err?.status) || 500;
  if (status >= 500) logger.error('v1: erreur', { chemin: req.path, error: err instanceof Error ? err.message : String(err) });
  if (status === 401) return erreurV1(res, 401, 'cle_invalide', 'Clé d’API absente, invalide ou révoquée.');
  if (status === 400 && err?.type === 'entity.parse.failed') return erreurV1(res, 400, 'json_invalide', 'Corps JSON invalide.');
  if (status < 500) return erreurV1(res, status, 'refus', err?.message ?? 'Requête refusée.');
  return erreurV1(res, 500, 'erreur_interne', 'Erreur interne.');
});
