/**
 * Logique de la page du parcours identité, sans React : quel écran montrer d'après l'état renvoyé
 * par le serveur, et les petits textes calculés.
 */

import type { Etat, TypePiece } from './api';

export type Ecran = 'choix' | 'photo' | 'lecture' | 'visage' | 'validee' | 'refusee' | 'a_revoir' | 'expiree' | 'introuvable';

/** Écran voulu par le serveur ; la page passe ensuite d'elle-même du choix de la pièce à la photo. */
export function ecranDe(etat: Etat | null): Ecran {
  if (!etat) return 'introuvable';
  switch (etat.statut) {
    case 'validee': case 'refusee': case 'a_revoir': return etat.statut;
    case 'expiree': case 'abandonnee': return 'expiree';
    default:
      switch (etat.etape) {
        case 'recto': return 'choix';
        case 'verso': return 'photo';
        case 'visage': return 'visage';
        default: return 'lecture';
      }
  }
}

export const termine = (e: Ecran) => e === 'validee' || e === 'refusee' || e === 'a_revoir' || e === 'expiree' || e === 'introuvable';

/** Étape annoncée en haut de page : 1 pour la pièce, 2 pour le visage, 0 une fois fini. */
export function numeroEtape(e: Ecran): 0 | 1 | 2 {
  if (e === 'visage') return 2;
  return termine(e) ? 0 : 1;
}

export interface Piece { cle: string; type: TypePiece; titre: string; detail: string; verso: boolean }

/** Le titre de séjour (format carte, MRZ sur trois lignes au verso) se lit comme une carte d'identité. */
export const PIECES: readonly Piece[] = [
  { cle: 'cni', type: 'national_id', titre: 'Carte d’identité', detail: 'Format carte bancaire ou ancien format', verso: true },
  { cle: 'passeport', type: 'passport', titre: 'Passeport', detail: 'La page avec votre photo', verso: false },
  { cle: 'sejour', type: 'national_id', titre: 'Titre de séjour', detail: 'Recto et verso', verso: true },
  { cle: 'permis', type: 'drivers_license', titre: 'Permis de conduire', detail: 'Format carte uniquement', verso: true },
];

export function titrePhoto(cote: 'recto' | 'verso', piece: Piece): string {
  if (cote === 'verso') return 'Le verso, à plat dans le cadre';
  return piece.verso ? 'Le recto, à plat dans le cadre' : 'La page photo, à plat dans le cadre';
}

/** 92 → « 1 min 32 » ; 40 → « 40 s ». */
export function duree(secondes: number | null): string {
  if (secondes == null || !Number.isFinite(secondes) || secondes < 0) return '';
  const s = Math.round(secondes);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')}`;
}

/** Adresse de retour vers le site : seulement http(s), jamais un « javascript: » glissé dans la session. */
export function adresseRetour(retour: string | null): string | null {
  if (!retour) return null;
  try {
    const u = new URL(retour);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

const JETON = /^[0-9a-f]{64}$/;
const CLE = 'preuvid.parcours';

/**
 * Jeton de session : après le « # » du lien (jamais envoyé au serveur), puis gardé pour l'onglet
 * seulement, afin qu'un rechargement ne perde pas la vérification une fois l'adresse nettoyée.
 */
export function lireJeton(fragment: string, onglet: Pick<Storage, 'getItem' | 'setItem'> | null): string | null {
  const brut = fragment.replace(/^#/, '').trim().toLowerCase();
  if (JETON.test(brut)) {
    try { onglet?.setItem(CLE, brut); } catch { /* stockage bloqué */ }
    return brut;
  }
  if (brut) return null;
  try {
    const garde = onglet?.getItem(CLE) ?? null;
    return garde && JETON.test(garde) ? garde : null;
  } catch {
    return null;
  }
}

export const lienTelephone = (origine: string, jeton: string) => `${origine}/verifier#${jeton}`;
