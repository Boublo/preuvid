/**
 * Passage de l'ordinateur au téléphone, et attente de la décision.
 *
 * Le QR code ne contient que l'adresse de la page photo, la vérification et son jeton, placés après
 * le « # » : cette partie de l'adresse n'est jamais envoyée au serveur, donc jamais journalisée. Le
 * site d'où vient la demande n'y figure pas : il n'est connu que de l'onglet ouvert sur l'ordinateur.
 */

import type { Etat, Verification } from './api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JETON = /^[0-9a-f]{64}$/i;

export const CHEMIN_TELEPHONE = '/age/telephone';

export function lienTelephone(origine: string, v: Verification): string {
  return `${origine}${CHEMIN_TELEPHONE}#${v.verification}.${v.jeton}`;
}

export function lireLien(fragment: string): Verification | null {
  const [verification, jeton, ...reste] = fragment.replace(/^#/, '').split('.');
  if (reste.length || !UUID.test(verification ?? '') || !JETON.test(jeton ?? '')) return null;
  return { verification, jeton };
}

/** `visage` : la pièce est lue et la personne est majeure, il reste à montrer son visage. */
export type Issue = 'majeur' | 'visage' | 'refus' | 'introuvable' | 'delai' | 'arrete';
const TERMINAUX_REFUS = ['refusee', 'a_revoir', 'expiree', 'abandonnee'];

/**
 * Interroge l'état jusqu'à une décision. `introuvable` : la vérification n'existe plus (déjà
 * utilisée pour créer un passe, ou effacée). `arreter()` interrompt l'attente (écran quitté).
 */
export async function attendreDecision(
  lire: () => Promise<Etat>,
  { intervalleMs = 2000, limiteMs = 15 * 60 * 1000, surEtat, arrete = () => false, attendre = (ms: number) => new Promise<void>(r => setTimeout(r, ms)) }: {
    intervalleMs?: number; limiteMs?: number; surEtat?: (e: Etat) => void; arrete?: () => boolean; attendre?: (ms: number) => Promise<void>;
  } = {},
): Promise<Issue> {
  for (let ecoule = 0; ecoule <= limiteMs; ecoule += intervalleMs) {
    if (arrete()) return 'arrete';
    let etat: Etat;
    try {
      etat = await lire();
    } catch (err) {
      if ((err as { code?: string })?.code === 'verification_introuvable') return 'introuvable';
      etat = { statut: 'erreur_passagere', majeur: null };
    }
    if (arrete()) return 'arrete';
    surEtat?.(etat);
    if (etat.statut === 'validee') return etat.majeur ? 'majeur' : 'refus';
    if (etat.statut === 'en_cours' && etat.etape === 'visage') return 'visage';
    if (TERMINAUX_REFUS.includes(etat.statut)) return 'refus';
    await attendre(intervalleMs);
  }
  return 'delai';
}
