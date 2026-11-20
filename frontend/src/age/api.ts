/**
 * Appels de la page du passe majeur. Même origine (nginx), sans Referer, sans cookie : le serveur ne
 * reçoit que le défi masqué et ce qu'il faut pour la clé d'accès.
 */

import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';

export class ErreurAge extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

async function appel<T>(chemin: string, corps?: unknown): Promise<T> {
  const r = await fetch(`/v1/age${chemin}`, {
    method: 'POST',
    headers: corps ? { 'content-type': 'application/json' } : undefined,
    body: corps ? JSON.stringify(corps) : undefined,
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  const texte = await r.text();
  const json = texte ? JSON.parse(texte) : null;
  if (!r.ok) throw new ErreurAge(json?.erreur?.code ?? 'erreur', json?.erreur?.message ?? 'Le service ne répond pas.', r.status);
  return json as T;
}

export interface Verification { verification: string; jeton: string }
/** `etape` : ce que la vérification attend de la personne (recto de la pièce, puis visage). */
export interface Etat { statut: string; majeur: boolean | null; etape?: 'recto' | 'visage' | null }
export type TypePiece = 'national_id' | 'passport' | 'drivers_license';

/** Ne garde que l'identifiant et le jeton : le serveur refuse toute autre clé dans les appels suivants. */
export async function ouvrirVerification(): Promise<Verification> {
  const { verification, jeton } = await appel<Verification & { expire_le: string }>('/verification');
  return { verification, jeton };
}
export const etatVerification = (v: Verification) => appel<Etat>('/verification/etat', v);

export async function envoyerRecto(v: Verification, photo: Blob, type: TypePiece) {
  const form = new FormData();
  form.append('document', photo, 'piece.jpg');
  form.append('document_type', type);
  const r = await fetch(`/api/v2/verify/${v.verification}/front-document`, {
    method: 'POST', headers: { 'X-Session-Token': v.jeton }, body: form, credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (!r.ok) throw new ErreurAge('envoi_impossible', 'La photo n’a pas pu être envoyée.', r.status);
}

/** Selfie et images du mouvement de tête (détection du vivant faite par le serveur). */
export async function envoyerVisage(v: Verification, photo: Blob, meta: unknown) {
  const form = new FormData();
  form.append('selfie', photo, 'visage.jpg');
  form.append('liveness_metadata', JSON.stringify(meta));
  const r = await fetch(`/api/v2/verify/${v.verification}/live-capture`, {
    method: 'POST', headers: { 'X-Session-Token': v.jeton }, body: form, credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  if (!r.ok) throw new ErreurAge('envoi_impossible', 'Les images n’ont pas pu être envoyées.', r.status);
}

export const optionsCreation = (v: Verification) => appel<PublicKeyCredentialCreationOptionsJSON>('/passe/options', v);
export const creerPasse = (v: Verification, cle: string, masque: string, attestation: RegistrationResponseJSON) =>
  appel<{ signature_masquee: string }>('/passe', { ...v, cle, masque, attestation });
export const preuveUnique = (v: Verification, cle: string, masque: string) =>
  appel<{ signature_masquee: string }>('/preuve-unique', { ...v, cle, masque });
export const defi = () => appel<PublicKeyCredentialRequestOptionsJSON>('/defi');
export const preuve = (cle: string, masque: string, assertion: AuthenticationResponseJSON) =>
  appel<{ signature_masquee: string }>('/preuve', { cle, masque, assertion });
