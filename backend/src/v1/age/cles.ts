/**
 * Clés de signature aveugle du passe majeur (preuvid/docs/double-anonymat.md).
 *
 * Variante RSABSSA-SHA384-PSS-Randomized (RFC 9474), RSA 2048 bits. Une clé signifie « majeur » pendant
 * sa période de validité (30 jours) ; une nouvelle clé est créée quand il reste moins de sept jours.
 * La clé privée est chiffrée en base avec ENCRYPTION_KEY.
 */

import crypto from 'crypto';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { encryptSecret, decryptSecret } from '@idswyft/shared';
import { supabase } from '@/config/database.js';
import config from '@/config/index.js';
import { logger } from '@/utils/logger.js';

export const VARIANTE = 'RSABSSA-SHA384-PSS-Randomized';
export const suite = RSABSSA.SHA384.PSS.Randomized();
const ALGO = { name: 'RSA-PSS', hash: 'SHA-384' } as const;
const JOUR = 24 * 60 * 60 * 1000;
export const DUREE_CLE_MS = 30 * JOUR;
const RELEVE_APRES_EXPIRATION_MS = 60 * JOUR;
/** Taille d'un message masqué ou d'une signature, en octets (RSA 2048). */
export const TAILLE = 256;
/** Le message signé est un préfixe aléatoire (32 octets, RFC 9474) suivi du défi du site (32 octets). */
export const TAILLE_MESSAGE = 64;

export interface ClePublique { id: string; spki: string; valide_du: string; valide_au: string }
interface LigneCle extends ClePublique { pkcs8_chiffre: string }

const b64 = (o: ArrayBuffer | Uint8Array) => Buffer.from(o instanceof Uint8Array ? o : new Uint8Array(o)).toString('base64');
export const idDeCle = (spkiDer: Uint8Array) => crypto.createHash('sha256').update(spkiDer).digest('hex');

let enCours: Promise<LigneCle> | null = null;
const privees = new Map<string, CryptoKey>();

async function creerCle(debut: Date): Promise<LigneCle> {
  const { privateKey, publicKey } = await suite.generateKey({ publicExponent: Uint8Array.from([1, 0, 1]), modulusLength: 2048 });
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey));
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);
  const ligne: LigneCle = {
    id: idDeCle(spki),
    spki: b64(spki),
    pkcs8_chiffre: encryptSecret(b64(pkcs8), config.encryptionKey),
    valide_du: debut.toISOString(),
    valide_au: new Date(debut.getTime() + DUREE_CLE_MS).toISOString(),
  };
  const { error } = await supabase.from('v1_age_cles').insert(ligne);
  if (error) throw new Error(`v1_age_cles: ${error.message}`);
  logger.info('passe : nouvelle clé de signature', { cle: ligne.id.slice(0, 16), valide_au: ligne.valide_au });
  return ligne;
}

/** Clé de signature du moment ; en crée une si besoin. */
export async function cleCourante(maintenant = new Date()): Promise<LigneCle> {
  const { data, error } = await supabase.from('v1_age_cles')
    .select('id, spki, pkcs8_chiffre, valide_du, valide_au')
    .lte('valide_du', maintenant.toISOString()).gt('valide_au', maintenant.toISOString())
    .order('valide_au', { ascending: false }).limit(1);
  if (error) throw new Error(`v1_age_cles: ${error.message}`);
  const actuelle = (data ?? [])[0] as LigneCle | undefined;
  if (actuelle && new Date(actuelle.valide_au).getTime() - maintenant.getTime() > 7 * JOUR) return actuelle;
  // Une seule création à la fois dans ce processus.
  enCours ??= creerCle(maintenant).finally(() => { enCours = null; });
  const nouvelle = await enCours;
  return nouvelle;
}

/** Clés publiques à publier : celles encore valides (le site vérifie une preuve dans les minutes qui suivent). */
export async function clesPubliques(maintenant = new Date()): Promise<ClePublique[]> {
  await cleCourante(maintenant);
  const { data, error } = await supabase.from('v1_age_cles')
    .select('id, spki, valide_du, valide_au')
    .gt('valide_au', maintenant.toISOString())
    .order('valide_du', { ascending: true });
  if (error) throw new Error(`v1_age_cles: ${error.message}`);
  // Champs publics seulement, quoi que renvoie la requête.
  return ((data ?? []) as ClePublique[]).map(({ id, spki, valide_du, valide_au }) => ({ id, spki, valide_du, valide_au }));
}

async function lireCle(id: string): Promise<LigneCle | null> {
  const { data } = await supabase.from('v1_age_cles')
    .select('id, spki, pkcs8_chiffre, valide_du, valide_au').eq('id', id).single();
  return (data as LigneCle | null) ?? null;
}

/**
 * Signe un message masqué avec la clé demandée, si elle est valide maintenant. Le serveur ne voit pas
 * le message : seulement un nombre aléatoire de 256 octets.
 */
export async function signerAveugle(cleId: string, masque: Uint8Array, maintenant = new Date()): Promise<Uint8Array | null> {
  if (masque.length !== TAILLE) return null;
  const cle = await lireCle(cleId);
  if (!cle || new Date(cle.valide_du) > maintenant || new Date(cle.valide_au) <= maintenant) return null;
  let privee = privees.get(cle.id);
  if (!privee) {
    const der = Buffer.from(decryptSecret(cle.pkcs8_chiffre, config.encryptionKey), 'base64');
    privee = await crypto.subtle.importKey('pkcs8', der, ALGO, true, ['sign']);
    privees.set(cle.id, privee);
  }
  return suite.blindSign(privee, masque);
}

/**
 * Vérifie une preuve démasquée (relevés des sites). La clé doit avoir été valide il y a moins de
 * 60 jours.
 */
export async function verifierPreuve(cleId: string, message: Uint8Array, signature: Uint8Array, maintenant = new Date()): Promise<boolean> {
  if (message.length !== TAILLE_MESSAGE || signature.length !== TAILLE) return false;
  const cle = await lireCle(cleId);
  if (!cle || new Date(cle.valide_au).getTime() + RELEVE_APRES_EXPIRATION_MS < maintenant.getTime()) return false;
  const publique = await crypto.subtle.importKey('spki', Buffer.from(cle.spki, 'base64'), ALGO, true, ['verify']);
  try {
    return await suite.verify(publique, signature, message);
  } catch {
    return false;
  }
}

/** Pour les tests. */
export function _viderCache() { privees.clear(); }
