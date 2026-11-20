/**
 * Photos des sessions Preuvid (API v1) : le site ne les reçoit jamais (décision du 20/11/2026,
 * maquette 07 « Vos photos : non »). Seuls les administrateurs de la plateforme Preuvid les voient,
 * pour la revue manuelle.
 *
 * Les routes d'Idswyft qui les exposent à un site (clé d'API, relecteurs et opérateurs du site)
 * consultent ces fonctions : selfie (/api/v2/verify/:id/selfie), fichiers (/api/files/*), liste et
 * fiche de l'administration.
 */

import type { Request } from 'express';
import { supabase } from '@/config/database.js';

/** Administrateur de la plateforme (Preuvid), par opposition à la clé, au relecteur ou à l'opérateur d'un site. */
export const estAdminPlateforme = (req: Request) => !!(req as { user?: unknown }).user;

/** Identifiants, parmi `ids`, des vérifications créées par l'API v1. */
export async function sessionsV1(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase.from('verification_requests').select('id, v1_parcours').in('id', ids);
  // En cas d'erreur, on considère qu'elles le sont toutes : mieux vaut cacher une photo que la montrer.
  if (error) return new Set(ids);
  return new Set(((data ?? []) as { id: string; v1_parcours: string | null }[]).filter(l => l.v1_parcours).map(l => l.id));
}

export async function estSessionV1(id: string): Promise<boolean> {
  return (await sessionsV1([id])).has(id);
}

/** Le fichier (chemin tel qu'en base) appartient-il à une session v1 ? Inconnu : non (la route renvoie déjà 403). */
export async function fichierDeSessionV1(cheminBase: string): Promise<boolean> {
  for (const table of ['documents', 'selfies'] as const) {
    const { data, error } = await supabase.from(table).select('verification_request_id')
      .eq('file_path', cheminBase).limit(1).maybeSingle();
    if (error) return true;
    const id = (data as { verification_request_id?: string } | null)?.verification_request_id;
    if (id) return estSessionV1(id);
  }
  return false;
}

/** Photos illisibles admises par côté de la pièce avant le refus, pour le parcours identité v1 (décision de David, 20/11/2026). */
export const ESSAIS_PHOTO_V1 = 3;

/**
 * Essais de photo par côté pour cette vérification : `ESSAIS_PHOTO_V1` pour une session v1 `identite`,
 * 1 sinon (comportement d'Idswyft, y compris si la base ne répond pas).
 */
export async function essaisPhoto(id: string): Promise<number> {
  try {
    const { data, error } = await supabase.from('verification_requests').select('v1_parcours').eq('id', id).single();
    return !error && (data as { v1_parcours?: string | null } | null)?.v1_parcours === 'identite' ? ESSAIS_PHOTO_V1 : 1;
  } catch {
    return 1;
  }
}
