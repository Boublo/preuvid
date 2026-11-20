/**
 * Routes du passe majeur, montées sur /v1/age (preuvid/docs/double-anonymat.md).
 *
 * Toutes, sauf /releves, sont appelées par la page Preuvid, sans clé d'API : elles ne lisent ni ne
 * gardent l'en-tête Referer ni Origin (ôtés avant tout traitement), et ne journalisent aucune adresse.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { authenticateAPIKey } from '@/middleware/auth.js';
import { barrageEchecsAuth, Compteur, erreurV1, limiteParCle } from '../protections.js';
import type { CleApi } from '../sessions.js';
import { clesPubliques, TAILLE, VARIANTE } from './cles.js';
import {
  creerPasse, etatVerification, optionsCreation, optionsUsage, ouvrirVerification, preuveAvecPasse, preuveUnique,
  type Echec,
} from './passe.js';
import { declarer, MAX_PREUVES_PAR_RELEVE } from './releves.js';

const asynchrone = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Ôte toute trace de provenance : la page du site ne doit jamais atteindre Preuvid. */
export function sansProvenance(req: Request, _res: Response, next: NextFunction) {
  delete req.headers.referer;
  delete (req.headers as Record<string, unknown>).referrer;
  delete req.headers.origin;
  next();
}

// Limites par adresse, en mémoire seulement (l'adresse n'est écrite nulle part).
const LIMITE_VERIFICATIONS = 10;
const LIMITE_APPELS = 60;
const verifications = new Compteur(LIMITE_VERIFICATIONS);
const appels = new Compteur(LIMITE_APPELS);
function limiteParAdresse(compteur: Compteur, max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const { restant } = compteur.prendre(req.ip || req.socket?.remoteAddress || 'inconnue');
    if (restant < 0) {
      res.setHeader('Retry-After', '60');
      return erreurV1(res, 429, 'limite_depassee', `Plus de ${max} demandes par minute depuis cette adresse.`);
    }
    next();
  };
}

const MESSAGES: Record<Echec, [number, string]> = {
  verification_introuvable: [404, 'Vérification introuvable ou expirée.'],
  verification_non_validee: [409, 'La majorité n’a pas été prouvée par cette vérification.'],
  verification_deja_utilisee: [409, 'Cette vérification a déjà servi.'],
  defi_invalide: [400, 'Défi inconnu, expiré ou déjà utilisé. Recommencez.'],
  cle_acces_refusee: [401, 'Clé d’accès refusée.'],
  passe_introuvable: [404, 'Passe inconnu sur ce service.'],
  limite_passe: [429, 'Trop de preuves avec ce passe dans l’heure.'],
  signature_impossible: [400, 'Clé de signature inconnue ou expirée, ou défi masqué invalide.'],
};
function repondreEchec(res: Response, e: Echec) {
  const [status, message] = MESSAGES[e];
  return erreurV1(res, status, e, message);
}

const UUID = z.string().uuid();
const JETON = z.string().regex(/^[0-9a-f]{64}$/);
const CLE = z.string().regex(/^[0-9a-f]{64}$/);
const MASQUE = z.string().regex(/^[A-Za-z0-9_-]+$/).max(400);
const Verification = z.object({ verification: UUID, jeton: JETON });
const Signature = z.object({ cle: CLE, masque: MASQUE });
const Webauthn = z.object({ id: z.string().max(1500), response: z.object({ clientDataJSON: z.string().max(5000) }).passthrough() }).passthrough();

function lire<T extends z.ZodTypeAny>(schema: T, req: Request, res: Response): z.infer<T> | null {
  const lu = schema.safeParse(req.body ?? {});
  if (lu.success) return lu.data;
  const p = lu.error.issues[0];
  erreurV1(res, 400, 'requete_invalide', `${p.path.join('.') || 'corps'} : ${p.message}`);
  return null;
}

const masqueDe = (s: string) => {
  const o = new Uint8Array(Buffer.from(s, 'base64url'));
  return o.length === TAILLE ? o : null;
};

export const routerAge = express.Router();
routerAge.use(sansProvenance);
routerAge.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });

/** Clés publiques : les sites les récupèrent côté serveur, de temps en temps. */
routerAge.get('/cles', asynchrone(async (_req, res) => {
  const cles = await clesPubliques();
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ variante: VARIANTE, cles });
}));

/** Relevés du site (comptage différé), avec sa clé d'API. */
routerAge.post('/releves', barrageEchecsAuth, authenticateAPIKey, limiteParCle, asynchrone(async (req, res) => {
  const corps = lire(z.object({
    preuves: z.array(z.object({ cle: CLE, message: MASQUE, signature: MASQUE }).strict()).min(1).max(MAX_PREUVES_PAR_RELEVE),
  }).strict(), req, res);
  if (!corps) return;
  res.json(await declarer((req as any).apiKey as CleApi, corps.preuves));
}));

routerAge.post('/verification', limiteParAdresse(verifications, LIMITE_VERIFICATIONS), asynchrone(async (req, res) => {
  const base = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;
  res.status(201).json(await ouvrirVerification(base));
}));

routerAge.use(limiteParAdresse(appels, LIMITE_APPELS));

routerAge.post('/verification/etat', asynchrone(async (req, res) => {
  const c = lire(Verification.strict(), req, res);
  if (!c) return;
  const r = await etatVerification(c.verification, c.jeton);
  if (!r.ok) return repondreEchec(res, r.echec);
  res.json(r.valeur);
}));

/** « Non merci, juste pour cette fois ». */
routerAge.post('/preuve-unique', asynchrone(async (req, res) => {
  const c = lire(Verification.merge(Signature).strict(), req, res);
  if (!c) return;
  const masque = masqueDe(c.masque);
  if (!masque) return repondreEchec(res, 'signature_impossible');
  const r = await preuveUnique(c.verification, c.jeton, c.cle, masque);
  if (!r.ok) return repondreEchec(res, r.echec);
  res.json({ signature_masquee: r.valeur });
}));

routerAge.post('/passe/options', asynchrone(async (req, res) => {
  const c = lire(Verification.strict(), req, res);
  if (!c) return;
  const r = await optionsCreation(c.verification, c.jeton);
  if (!r.ok) return repondreEchec(res, r.echec);
  res.json(r.valeur);
}));

routerAge.post('/passe', asynchrone(async (req, res) => {
  const c = lire(Verification.merge(Signature).extend({ attestation: Webauthn }).strict(), req, res);
  if (!c) return;
  const masque = masqueDe(c.masque);
  if (!masque) return repondreEchec(res, 'signature_impossible');
  const r = await creerPasse(c.verification, c.jeton, c.attestation as any, c.cle, masque);
  if (!r.ok) return repondreEchec(res, r.echec);
  res.status(201).json({ signature_masquee: r.valeur });
}));

routerAge.post('/defi', asynchrone(async (_req, res) => {
  res.json(await optionsUsage());
}));

routerAge.post('/preuve', asynchrone(async (req, res) => {
  const c = lire(Signature.extend({ assertion: Webauthn }).strict(), req, res);
  if (!c) return;
  const masque = masqueDe(c.masque);
  if (!masque) return repondreEchec(res, 'signature_impossible');
  const r = await preuveAvecPasse(c.assertion as any, c.cle, masque);
  if (!r.ok) return repondreEchec(res, r.echec);
  res.json({ signature_masquee: r.valeur });
}));
