/**
 * Protections de l'API v1 : limites de débit et idempotence.
 *
 * Limites en mémoire : valables pour une seule instance de l'API (le VPS prévu au lot 5). Avec
 * plusieurs instances, il faudra un compteur partagé (Postgres ou Redis).
 */

import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { encryptSecret, decryptSecret } from '@idswyft/shared';
import { supabase } from '@/config/database.js';
import config from '@/config/index.js';
import { logger } from '@/utils/logger.js';

export const LIMITES = { lectures: 600, ecritures: 300, echecsAuthParIp: 20 } as const;
const FENETRE_MS = 60_000;

/** Compteur à fenêtre fixe d'une minute. */
export class Compteur {
  private fenetres = new Map<string, { debut: number; n: number }>();
  constructor(private readonly max: number, private readonly fenetreMs = FENETRE_MS) {}

  /** Compte un appel ; renvoie le nombre restant, ou -1 si la limite est dépassée. */
  prendre(cle: string, maintenant = Date.now()): { restant: number; reinitialisation: number } {
    let f = this.fenetres.get(cle);
    if (!f || maintenant - f.debut >= this.fenetreMs) {
      f = { debut: maintenant, n: 0 };
      this.fenetres.set(cle, f);
      if (this.fenetres.size > 50_000) this.purger(maintenant);
    }
    f.n += 1;
    return { restant: this.max - f.n, reinitialisation: Math.ceil((f.debut + this.fenetreMs) / 1000) };
  }

  /** Nombre déjà compté dans la fenêtre en cours, sans compter. */
  lire(cle: string, maintenant = Date.now()): number {
    const f = this.fenetres.get(cle);
    return f && maintenant - f.debut < this.fenetreMs ? f.n : 0;
  }

  private purger(maintenant: number) {
    for (const [k, f] of this.fenetres) if (maintenant - f.debut >= this.fenetreMs) this.fenetres.delete(k);
  }
}

const lectures = new Compteur(LIMITES.lectures);
const ecritures = new Compteur(LIMITES.ecritures);
const echecsAuth = new Compteur(LIMITES.echecsAuthParIp);

export function erreurV1(res: Response, status: number, code: string, message: string) {
  return res.status(status).json({ erreur: { code, message } });
}

/** Limite par clé d'API : 600 lectures (GET) et 300 écritures par minute. */
export function limiteParCle(req: Request, res: Response, next: NextFunction) {
  const cle = (req as any).apiKey?.id as string | undefined;
  if (!cle) return next();
  const lecture = req.method === 'GET' || req.method === 'HEAD';
  const compteur = lecture ? lectures : ecritures;
  const max = lecture ? LIMITES.lectures : LIMITES.ecritures;
  const { restant, reinitialisation } = compteur.prendre(cle);
  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, restant)));
  res.setHeader('X-RateLimit-Reset', String(reinitialisation));
  if (restant < 0) {
    res.setHeader('Retry-After', String(Math.max(1, reinitialisation - Math.floor(Date.now() / 1000))));
    return erreurV1(res, 429, 'limite_depassee', `Plus de ${max} ${lecture ? 'lectures' : 'écritures'} par minute pour cette clé.`);
  }
  next();
}

/**
 * Bloque une adresse IP après 20 échecs d'authentification dans la minute. Le limiteur global
 * d'Idswyft ignore toute requête qui porte un en-tête x-api-key, même fausse : sans ceci, on
 * pourrait essayer des clés sans limite.
 */
export function barrageEchecsAuth(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket?.remoteAddress || 'inconnue';
  if (echecsAuth.lire(ip) >= LIMITES.echecsAuthParIp) {
    res.setHeader('Retry-After', '60');
    return erreurV1(res, 429, 'trop_d_echecs', "Trop d'échecs d'authentification depuis cette adresse.");
  }
  res.on('finish', () => {
    if (res.statusCode === 401) echecsAuth.prendre(ip);
  });
  next();
}

const DUREE_IDEMPOTENCE_MS = 24 * 60 * 60 * 1000;

function empreinte(corps: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(corps ?? {})).digest('hex');
}

/**
 * La réponse rejouée contient le lien de la personne (jeton de session en clair, que la base ne
 * garde sinon que haché), la référence client et l'URL de retour : elle est chiffrée au repos.
 */
export function scellerReponse(corps: unknown): { chiffre: string } {
  return { chiffre: encryptSecret(JSON.stringify(corps), config.encryptionKey) };
}

/** Réponse déchiffrée, ou undefined si elle est illisible (clé changée, ligne ancienne). */
export function ouvrirReponse(stockee: unknown): unknown {
  const chiffre = (stockee as { chiffre?: unknown } | null)?.chiffre;
  if (typeof chiffre !== 'string') return undefined;
  try {
    return JSON.parse(decryptSecret(chiffre, config.encryptionKey));
  } catch {
    return undefined;
  }
}

/**
 * Idempotence de POST, par clé d'API. La clé d'idempotence est réservée avant le traitement
 * (clé primaire) : une seconde requête identique pendant le traitement reçoit 409, après le
 * traitement la même réponse ; un corps différent sous la même clé reçoit 422. Une réponse
 * d'erreur libère la clé pour qu'on puisse réessayer.
 */
export async function idempotence(req: Request, res: Response, next: NextFunction) {
  const cleIdem = req.header('Idempotency-Key');
  const apiKeyId = (req as any).apiKey?.id as string | undefined;
  if (!cleIdem || !apiKeyId) return next();
  if (cleIdem.length > 200) return erreurV1(res, 400, 'idempotence_invalide', 'Idempotency-Key : 200 caractères au plus.');

  const hash = empreinte(req.body);
  const reserver = () => supabase.from('v1_idempotency').insert({ api_key_id: apiKeyId, key: cleIdem, request_hash: hash });

  let { error } = await reserver();
  if (error && error.code === '23505') {
    const { data: existante } = await supabase.from('v1_idempotency')
      .select('request_hash, response_status, response_body, created_at')
      .eq('api_key_id', apiKeyId).eq('key', cleIdem).single();
    const age = existante ? Date.now() - new Date(existante.created_at).getTime() : 0;
    // Réservation sans réponse depuis plus de deux minutes : le traitement a été interrompu
    // (redémarrage du serveur), la clé est libérée.
    const interrompue = existante && existante.response_status == null && age > 2 * 60_000;
    if (existante && (age > DUREE_IDEMPOTENCE_MS || interrompue)) {
      await supabase.from('v1_idempotency').delete().eq('api_key_id', apiKeyId).eq('key', cleIdem);
      ({ error } = await reserver());
    } else if (existante) {
      if (existante.request_hash !== hash) {
        return erreurV1(res, 422, 'idempotence_conflit', 'Cette Idempotency-Key a déjà servi pour une autre requête.');
      }
      if (existante.response_status == null) {
        return erreurV1(res, 409, 'idempotence_en_cours', 'Une requête avec cette Idempotency-Key est en cours.');
      }
      const rejouee = ouvrirReponse(existante.response_body);
      if (rejouee === undefined) {
        // Ne pas recréer de session : le client a peut-être déjà la première.
        logger.error('v1: réponse idempotente illisible');
        return erreurV1(res, 503, 'idempotence_indisponible', 'Réessayez avec une nouvelle Idempotency-Key.');
      }
      res.setHeader('Idempotent-Replayed', 'true');
      return res.status(existante.response_status).json(rejouee);
    }
  }
  if (error) {
    logger.error('v1: idempotence indisponible', { error: error.message });
    return erreurV1(res, 503, 'idempotence_indisponible', 'Réessayez dans un instant.');
  }

  const json = res.json.bind(res);
  res.json = (corps: unknown) => {
    const status = res.statusCode;
    const suite = status >= 200 && status < 300
      ? supabase.from('v1_idempotency').update({
        response_status: status,
        response_body: scellerReponse(corps),
        // Rattache la ligne à la session pour que DELETE /v1/sessions/{id} l'efface.
        session_id: (corps as { session?: string } | null)?.session ?? null,
      })
        .eq('api_key_id', apiKeyId).eq('key', cleIdem)
      : supabase.from('v1_idempotency').delete().eq('api_key_id', apiKeyId).eq('key', cleIdem);
    Promise.resolve(suite).catch(err => logger.error('v1: idempotence non enregistrée', { error: String(err) }));
    return json(corps);
  };
  next();
}
