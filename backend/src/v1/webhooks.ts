/**
 * Webhooks de l'API v1.
 *
 * - Signature : X-Preuvid-Signature = HMAC-SHA256(secret, `${horodatage}.${corps}`) en hexadécimal ;
 *   X-Preuvid-Timestamp = horodatage Unix en secondes ; X-Preuvid-Event-Id = identifiant d'événement,
 *   le même à chaque reprise (le client s'en sert pour dédoublonner).
 * - Chaque envoi est signé avec un horodatage neuf : une reprise ou un rejeu tombe dans la fenêtre
 *   de cinq minutes du destinataire.
 * - Seule une réponse 2xx vaut livraison. Reprises après 1 min, 5 min, 30 min et 2 h, puis échec.
 *   Les reprises sont persistées (v1_webhook_events) et relancées par la tâche minute du serveur.
 * - Le corps ne contient jamais d'image, ni de champ lu sur la pièce, ni la référence du client.
 *
 * Les webhooks /api/v2 d'Idswyft (X-Idswyft-Signature) ne passent pas par ici et ne changent pas.
 */

import crypto from 'crypto';
import axios from 'axios';
import { supabase } from '@/config/database.js';
import config from '@/config/index.js';
import { logger } from '@/utils/logger.js';
import { decryptWebhookSecret, WebhookService } from '@/services/webhook.js';

const webhookService = new WebhookService();
import { validateWebhookUrl, getSafeHttpAgent, getSafeHttpsAgent } from '@/utils/validateUrl.js';

export const V1_EVENEMENTS = ['session.terminee', 'session.a_revoir', 'session.revue', 'session.supprimee'] as const;
export type V1Evenement = typeof V1_EVENEMENTS[number];

/** Délais avant chaque reprise, en minutes. Après la dernière, l'événement passe en échec. */
export const REPRISES_MINUTES = [1, 5, 30, 120] as const;

export const SIGNATURE_TOLERANCE_S = 300;

/**
 * Hôtes internes que l'exploitant autorise explicitement comme destinataires (variable
 * PREUVID_WEBHOOK_HOTES_INTERNES, noms exacts séparés par des virgules). Vide par défaut : toute URL
 * interne est refusée par la protection SSRF. Sert à l'essai de bout en bout (site de test sur le
 * réseau Docker) et à un auto-hébergeur dont le récepteur est sur son réseau privé.
 */
export function hoteInterneAutorise(url: string, liste = process.env.PREUVID_WEBHOOK_HOTES_INTERNES ?? ''): boolean {
  const hotes = liste.split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  if (hotes.length === 0) return false;
  try {
    return hotes.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function signer(secret: string, horodatage: number, corps: string): string {
  return crypto.createHmac('sha256', secret).update(`${horodatage}.${corps}`).digest('hex');
}

/**
 * Vérification côté client (documentée dans api.md, reprise par le site de test) : signature
 * à temps constant, et horodatage à moins de cinq minutes.
 */
export function verifierSignature(
  secret: string, horodatage: string | number, corps: string, signature: string,
  maintenant: number = Math.floor(Date.now() / 1000),
): boolean {
  const ts = Number(horodatage);
  if (!Number.isFinite(ts) || Math.abs(maintenant - ts) > SIGNATURE_TOLERANCE_S) return false;
  const attendue = Buffer.from(signer(secret, ts, corps), 'hex');
  const recue = Buffer.from(String(signature), 'hex');
  return recue.length === attendue.length && crypto.timingSafeEqual(recue, attendue);
}

/** Prochaine tentative après `attempts` envois manqués, ou null s'il n'y a plus de reprise. */
export function prochaineTentative(attempts: number, depuis: Date = new Date()): Date | null {
  const delai = REPRISES_MINUTES[attempts - 1];
  return delai === undefined ? null : new Date(depuis.getTime() + delai * 60_000);
}

export interface V1Payload {
  evenement: V1Evenement;
  session: string;
  parcours: 'identite' | 'age';
  statut: string;
  majeur?: boolean | null;
  date: string;
}

interface EventRow {
  id: string;
  webhook_id: string;
  type: string;
  payload: V1Payload;
  attempts: number;
}

/**
 * Enregistre l'événement pour chaque webhook abonné, puis tente un premier envoi sans attendre.
 * Ne lève jamais : un webhook en échec ne doit pas faire échouer la vérification.
 */
export async function emettre(
  evenement: V1Evenement,
  session: { id: string; developer_id: string; is_sandbox: boolean; api_key_id: string | null },
  payload: Omit<V1Payload, 'evenement' | 'date'>,
): Promise<void> {
  try {
    const webhooks = await webhookService.getActiveWebhooksForDeveloper(
      session.developer_id, session.is_sandbox, evenement, session.api_key_id ?? undefined,
    );
    // Un webhook « tous événements » (events NULL) d'Idswyft ne reçoit que les événements qu'il nomme.
    const abonnes = webhooks.filter(w => Array.isArray((w as any).events) && (w as any).events.includes(evenement));
    if (abonnes.length === 0) return;
    const corps: V1Payload = { evenement, ...payload, date: new Date().toISOString() };
    const { data, error } = await supabase
      .from('v1_webhook_events')
      .insert(abonnes.map(w => ({
        webhook_id: w.id, session_id: session.id, type: evenement, payload: corps,
        // L'envoi immédiat ci-dessous met à jour la ligne ; la tâche minute ne la reprend que s'il n'a
        // pas abouti à une mise à jour (redémarrage du serveur pendant l'envoi).
        next_attempt_at: new Date(Date.now() + 60_000).toISOString(),
      })))
      .select('id, webhook_id, type, payload, attempts');
    if (error) throw new Error(error.message);
    for (const ev of (data ?? []) as EventRow[]) void livrer(ev);
  } catch (err) {
    logger.error('v1 webhook: enregistrement impossible', {
      evenement, session: session.id, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Un envoi. Met à jour l'événement : livré, reprise programmée, ou échec définitif. */
export async function livrer(ev: EventRow): Promise<boolean> {
  const tentative = ev.attempts + 1;
  let statusHttp: number | null = null;
  let erreur: string | null = null;
  try {
    const { data: webhook } = await supabase
      .from('webhooks').select('id, url, secret_key, is_active').eq('id', ev.webhook_id).single();
    if (!webhook || !webhook.is_active) throw new Error('webhook désactivé ou supprimé');
    const brut = webhook.secret_key;
    const secret = brut ? decryptWebhookSecret(brut) : null;
    if (!secret) throw new Error('secret de webhook absent');
    const interne = hoteInterneAutorise(webhook.url);
    if (!interne) await validateWebhookUrl(webhook.url);

    const corps = JSON.stringify(ev.payload);
    const horodatage = Math.floor(Date.now() / 1000);
    const res = await axios.post(webhook.url, corps, {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Preuvid-Webhook/1',
        'X-Preuvid-Signature': signer(secret, horodatage, corps),
        'X-Preuvid-Timestamp': String(horodatage),
        'X-Preuvid-Event-Id': ev.id,
        'X-Preuvid-Event': ev.type,
        'X-Preuvid-Attempt': String(tentative),
      },
      timeout: config.webhooks.timeoutMs,
      maxRedirects: 0,
      ...(interne ? {} : { httpAgent: getSafeHttpAgent(), httpsAgent: getSafeHttpsAgent() }),
      validateStatus: () => true,
      transformRequest: [(d: string) => d],
    });
    statusHttp = res.status;
    if (res.status >= 200 && res.status < 300) {
      await supabase.from('v1_webhook_events').update({
        status: 'delivered', attempts: tentative, last_response_status: res.status,
        last_error: null, delivered_at: new Date().toISOString(),
      }).eq('id', ev.id);
      return true;
    }
    erreur = `HTTP ${res.status}`;
  } catch (err) {
    erreur = err instanceof Error ? err.message : String(err);
  }
  const suivante = prochaineTentative(tentative);
  await supabase.from('v1_webhook_events').update({
    status: suivante ? 'pending' : 'failed',
    attempts: tentative,
    next_attempt_at: (suivante ?? new Date()).toISOString(),
    last_response_status: statusHttp,
    last_error: erreur?.slice(0, 500) ?? null,
  }).eq('id', ev.id);
  logger.warn('v1 webhook: envoi manqué', { evenement: ev.id, tentative, status: statusHttp, reprise: !!suivante });
  return false;
}

/** Tâche minute : relance les événements dont la reprise est due. */
export async function traiterReprises(limite = 50): Promise<number> {
  const { data, error } = await supabase
    .from('v1_webhook_events')
    .select('id, webhook_id, type, payload, attempts')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limite);
  if (error || !data) return 0;
  for (const ev of data as EventRow[]) await livrer(ev);
  return data.length;
}

/**
 * Rejeu manuel d'un événement (livré ou en échec) : nouvel envoi immédiat, même identifiant
 * d'événement, horodatage neuf. Le compteur repart pour que les reprises s'appliquent à nouveau.
 */
export async function rejouer(eventId: string): Promise<boolean> {
  const { data } = await supabase
    .from('v1_webhook_events').select('id, webhook_id, type, payload, attempts').eq('id', eventId).single();
  if (!data) return false;
  await supabase.from('v1_webhook_events').update({ status: 'pending', attempts: 0, next_attempt_at: new Date().toISOString() }).eq('id', eventId);
  return livrer({ ...(data as EventRow), attempts: 0 });
}
