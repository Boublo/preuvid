/**
 * Comptage différé (preuvid/docs/double-anonymat.md) : le site déclare plus tard, avec sa clé d'API,
 * les preuves qu'il a acceptées. Preuvid vérifie chaque signature, ignore les doublons et compte.
 */

import crypto from 'crypto';
import { supabase } from '@/config/database.js';
import type { CleApi } from '../sessions.js';
import { verifierPreuve } from './cles.js';

export const MAX_PREUVES_PAR_RELEVE = 1000;

export interface PreuveDeclaree { cle: string; message: string; signature: string }
export interface Bilan { acceptees: number; doublons: number; invalides: number }

const b64url = (s: unknown): Uint8Array | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  return new Uint8Array(Buffer.from(s, 'base64url'));
};

const premierDuMois = (d: Date) => `${d.toISOString().slice(0, 7)}-01`;

export async function declarer(cle: CleApi, preuves: PreuveDeclaree[], maintenant = new Date()): Promise<Bilan> {
  const bilan: Bilan = { acceptees: 0, doublons: 0, invalides: 0 };
  const vues = new Set<string>();
  for (const p of preuves) {
    const message = b64url(p?.message);
    const signature = b64url(p?.signature);
    if (!message || !signature || typeof p.cle !== 'string' || !(await verifierPreuve(p.cle, message, signature, maintenant))) {
      bilan.invalides++;
      continue;
    }
    const empreinte = crypto.createHash('sha256').update(message).digest('hex');
    if (vues.has(empreinte)) { bilan.doublons++; continue; }
    vues.add(empreinte);
    const { error } = await supabase.from('v1_age_releves').insert({
      preuve_hash: empreinte, api_key_id: cle.id, developer_id: cle.developer_id, cle_id: p.cle,
      mois: premierDuMois(maintenant),
    });
    if (!error) bilan.acceptees++;
    else if (error.code === '23505') bilan.doublons++;
    else throw new Error(`v1_age_releves: ${error.message}`);
  }
  return bilan;
}
