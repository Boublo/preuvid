/**
 * Passe majeur : clé d'accès WebAuthn créée après une vérification d'âge réussie, puis preuves signées
 * à l'aveugle (preuvid/docs/double-anonymat.md).
 *
 * Rien ici ne reçoit ni ne garde l'adresse du site visité : les appels viennent de la page Preuvid, et la
 * preuve demandée n'est qu'un nombre masqué.
 */

import crypto from 'crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { supabase } from '@/config/database.js';
import { logger } from '@/utils/logger.js';
import { hashHandoffToken } from '@/middleware/auth.js';
import { creerSession, lireDecision, supprimerSession, type CleApi } from '../sessions.js';
import { loadSessionState } from '@/services/sessionPersistence.js';
import { signerAveugle } from './cles.js';
import { MARQUE_VISAGE } from './visage.js';

export const LIMITE_PREUVES_HEURE = Number(process.env.PREUVID_PASSE_PREUVES_PAR_HEURE || 20);
const DUREE_DEFI_MS = 5 * 60 * 1000;
const HEURE_MS = 60 * 60 * 1000;

export function domaine(): string {
  return process.env.PREUVID_PASSE_DOMAINE || 'localhost';
}
export function origines(): string[] {
  return (process.env.PREUVID_PASSE_ORIGINE || 'http://localhost,https://localhost')
    .split(',').map(o => o.trim()).filter(Boolean);
}

export type Echec =
  | 'verification_introuvable' | 'verification_non_validee' | 'verification_deja_utilisee'
  | 'defi_invalide' | 'cle_acces_refusee' | 'passe_introuvable' | 'limite_passe' | 'signature_impossible';
export type Resultat<T> = { ok: true; valeur: T } | { ok: false; echec: Echec };
const echec = <T>(e: Echec): Resultat<T> => ({ ok: false, echec: e });

// ── Compte interne des vérifications anonymes ───────────────────────────────────────────────────────
// Les vérifications du passe ne sont rattachées à aucun site : elles vivent sous un compte développeur
// interne, dont la clé d'API ne peut pas servir (son empreinte vient d'un secret jeté aussitôt).

// Le compte est retrouvé par son identifiant fixe, jamais par son adresse : n'importe qui peut inscrire
// un compte développeur à l'adresse de son choix (POST /api/developer/register), et le passe se serait
// alors attaché à ce compte, webhook compris. L'adresse, sans domaine de premier niveau, est en outre
// refusée par les formulaires d'inscription (isEmail).
export const ID_INTERNE = '00000000-0000-4000-8000-000000000a9e';
const EMAIL_INTERNE = 'passe-majeur@interne';
let interne: Promise<CleApi> | null = null;

async function creerCompteInterne(): Promise<CleApi> {
  // Le mode test d'Idswyft n'abaisse que les seuils du visage ; le parcours âge n'en a pas l'usage.
  const essai = false;
  const lire = async () => (await supabase.from('developers').select('id').eq('id', ID_INTERNE).maybeSingle()).data;
  let dev = await lire();
  if (!dev) {
    const r = await supabase.from('developers')
      .insert({ id: ID_INTERNE, email: EMAIL_INTERNE, name: 'Preuvid — passe majeur', is_verified: true }).select('id').single();
    if (r.error && r.error.code !== '23505') throw new Error(`developers: ${r.error.message}`);
    // 23505 : créé entre-temps par une autre requête, ou adresse déjà prise par un autre compte (refus).
    dev = r.data ?? await lire();
    if (!dev) throw new Error('developers : l’adresse du compte interne du passe appartient à un autre compte');
  }
  const developerId = ID_INTERNE;
  // Jamais de criblage AML ni de voix sur ce compte : le criblage garderait nom et date de naissance.
  await supabase.from('developers').update({ aml_enabled: false, voice_auth_enabled: false, webhook_url: null }).eq('id', developerId);
  const { data: cles } = await supabase.from('api_keys').select('id, is_sandbox')
    .eq('developer_id', developerId).eq('name', 'passe majeur').eq('is_sandbox', essai).limit(1);
  const existante = (cles ?? [])[0] as { id: string; is_sandbox: boolean } | undefined;
  if (existante) return { id: existante.id, developer_id: developerId, is_sandbox: existante.is_sandbox };
  const inutilisable = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const { data: k, error } = await supabase.from('api_keys').insert({
    developer_id: developerId, key_hash: inutilisable, key_prefix: 'interne', name: 'passe majeur',
    is_sandbox: essai, is_active: true,
  }).select('id').single();
  if (error) throw new Error(`api_keys: ${error.message}`);
  return { id: (k as { id: string }).id, developer_id: developerId, is_sandbox: essai };
}

export function compteInterne(): Promise<CleApi> {
  interne ??= creerCompteInterne().catch((err) => { interne = null; throw err; });
  return interne;
}

// ── Première vérification ───────────────────────────────────────────────────────────────────────────

/**
 * Ouvre une vérification d'âge anonyme : recto de la pièce (seuil 18 ans), puis visage (selfie, détection du
 * vivant, comparaison avec la photo de la pièce), voir visage.ts.
 */
export async function ouvrirVerification(baseParcours: string) {
  const cle = await compteInterne();
  const s = await creerSession(cle, { parcours: 'age' }, baseParcours);
  const { error } = await supabase.from('verification_requests')
    .update({ addons: { [MARQUE_VISAGE]: true, aml_screening: false } }).eq('id', s.session);
  if (error) throw new Error(`verification_requests: ${error.message}`);
  const jeton = new URL(s.lien).searchParams.get('session')!;
  return { verification: s.session, jeton, expire_le: s.expire_le };
}

type Decision = { statut: string; majeur: boolean | null };
/** Étape attendue de la personne : le recto, le visage, ou rien (lecture en cours ou terminé). */
export type Etape = 'recto' | 'visage' | null;

export function etapeDe(currentStep: string | null | undefined): Etape {
  if (currentStep === 'AWAITING_FRONT') return 'recto';
  if (currentStep === 'AWAITING_LIVE') return 'visage';
  return null;
}

/** La vérification existe, appartient au compte interne et porte ce jeton encore valide. */
async function verificationDuJeton(verificationId: string, jeton: string): Promise<Resultat<{ cle: CleApi; decision: Decision }>> {
  const cle = await compteInterne();
  const { data } = await supabase.from('verification_requests')
    .select('session_token_hash, session_token_expires_at').eq('id', verificationId).eq('api_key_id', cle.id).single();
  const ligne = data as { session_token_hash: string | null; session_token_expires_at: string | null } | null;
  const attendu = ligne?.session_token_hash;
  const recu = Buffer.from(hashHandoffToken(String(jeton ?? '')));
  if (!attendu || attendu.length !== recu.length || !crypto.timingSafeEqual(Buffer.from(attendu), recu)) {
    return echec('verification_introuvable');
  }
  if (!ligne?.session_token_expires_at || new Date(ligne.session_token_expires_at) <= new Date()) {
    return echec('verification_introuvable');
  }
  const decision = await lireDecision(cle, verificationId) as Decision | null;
  if (!decision) return echec('verification_introuvable');
  return { ok: true, valeur: { cle, decision } };
}

/** État de la première vérification, pour la page Preuvid : statut, majorité et étape attendue, rien d'autre. */
export async function etatVerification(verificationId: string, jeton: string): Promise<Resultat<Decision & { etape: Etape }>> {
  const v = await verificationDuJeton(verificationId, jeton);
  if (!v.ok) return v;
  const { statut, majeur } = v.valeur.decision;
  const etape = statut === 'en_attente' || statut === 'en_cours'
    ? etapeDe((await loadSessionState(verificationId))?.current_step) : null;
  return { ok: true, valeur: { statut, majeur, etape } };
}

/** La vérification porte ce jeton et a conclu « majeur ». */
async function verificationMajeure(verificationId: string, jeton: string): Promise<Resultat<CleApi>> {
  const v = await verificationDuJeton(verificationId, jeton);
  if (!v.ok) return v;
  if (v.valeur.decision.statut !== 'validee' || v.valeur.decision.majeur !== true) return echec('verification_non_validee');
  return { ok: true, valeur: v.valeur.cle };
}

/** Une vérification ne donne qu'une chose : un passe ou une preuve unique. */
async function consommer(verificationId: string): Promise<boolean> {
  const { error } = await supabase.from('v1_age_verifications_utilisees').insert({ verification_id: verificationId });
  return !error;
}

/** Supprime la vérification (photos, champs lus) dès qu'elle a servi. */
async function effacerVerification(cle: CleApi, verificationId: string) {
  const r = await supprimerSession(cle, verificationId).catch(() => 'echec' as const);
  if (r !== 'supprimee') logger.error('passe : vérification non supprimée après usage', { verification: verificationId, resultat: r });
}

async function signer(cleId: string, masque: Uint8Array): Promise<Resultat<string>> {
  const signature = await signerAveugle(cleId, masque);
  if (!signature) return echec('signature_impossible');
  return { ok: true, valeur: Buffer.from(signature).toString('base64url') };
}

/** « Non merci, juste pour cette fois » : une preuve, puis la vérification est supprimée. */
export async function preuveUnique(verificationId: string, jeton: string, cleId: string, masque: Uint8Array): Promise<Resultat<string>> {
  const v = await verificationMajeure(verificationId, jeton);
  if (!v.ok) return v;
  if (!(await consommer(verificationId))) return echec('verification_deja_utilisee');
  const s = await signer(cleId, masque);
  await effacerVerification(v.valeur, verificationId);
  return s;
}

// ── Défis WebAuthn ──────────────────────────────────────────────────────────────────────────────────

async function garderDefi(defi: string, usage: 'creation' | 'usage', verificationId: string | null) {
  const { error } = await supabase.from('v1_age_defis').insert({
    defi, usage, verification_id: verificationId, expire_le: new Date(Date.now() + DUREE_DEFI_MS).toISOString(),
  });
  if (error) throw new Error(`v1_age_defis: ${error.message}`);
}

/** Retire le défi (usage unique) et renvoie sa ligne s'il était valide. */
async function prendreDefi(clientDataJSON: string, usage: 'creation' | 'usage') {
  let defi: string;
  try {
    defi = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')).challenge;
  } catch {
    return null;
  }
  if (typeof defi !== 'string') return null;
  const { data } = await supabase.from('v1_age_defis').delete()
    .eq('defi', defi).eq('usage', usage).gt('expire_le', new Date().toISOString()).select('defi, verification_id');
  const ligne = (data ?? [])[0] as { defi: string; verification_id: string | null } | undefined;
  return ligne ?? null;
}

// ── Création du passe ───────────────────────────────────────────────────────────────────────────────

export async function optionsCreation(verificationId: string, jeton: string): Promise<Resultat<unknown>> {
  const v = await verificationMajeure(verificationId, jeton);
  if (!v.ok) return v;
  const options = await generateRegistrationOptions({
    rpName: 'Preuvid',
    rpID: domaine(),
    // Ni nom ni courriel : l'appareil affichera « Passe majeur ».
    userName: 'Passe majeur',
    userDisplayName: 'Passe majeur',
    userID: new Uint8Array(crypto.randomBytes(16)),
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
    timeout: DUREE_DEFI_MS,
  });
  await garderDefi(options.challenge, 'creation', verificationId);
  return { ok: true, valeur: options };
}

export async function creerPasse(
  verificationId: string, jeton: string, reponse: RegistrationResponseJSON, cleId: string, masque: Uint8Array,
): Promise<Resultat<string>> {
  const v = await verificationMajeure(verificationId, jeton);
  if (!v.ok) return v;
  const defi = await prendreDefi(reponse?.response?.clientDataJSON, 'creation');
  if (!defi || defi.verification_id !== verificationId) return echec('defi_invalide');

  let info;
  try {
    const r = await verifyRegistrationResponse({
      response: reponse, expectedChallenge: defi.defi, expectedOrigin: origines(), expectedRPID: domaine(),
      requireUserVerification: true,
    });
    if (!r.verified || !r.registrationInfo) return echec('cle_acces_refusee');
    info = r.registrationInfo;
  } catch {
    return echec('cle_acces_refusee');
  }
  if (!(await consommer(verificationId))) return echec('verification_deja_utilisee');

  const { error } = await supabase.from('v1_age_passes').insert({
    credential_id: info.credential.id,
    public_key: Buffer.from(info.credential.publicKey).toString('base64url'),
    compteur: info.credential.counter,
    sauvegarde_possible: info.credentialDeviceType === 'multiDevice',
    sauvegardee: info.credentialBackedUp,
    transports: info.credential.transports ?? null,
    fenetre_debut: new Date().toISOString(),
    fenetre_n: 1,
  });
  if (error) {
    logger.error('passe : enregistrement impossible', { error: error.message });
    return echec('cle_acces_refusee');
  }
  const s = await signer(cleId, masque);
  await effacerVerification(v.valeur, verificationId);
  logger.info('passe : créé', { synchronisable: info.credentialDeviceType === 'multiDevice' });
  return s;
}

// ── Visites suivantes ───────────────────────────────────────────────────────────────────────────────

export async function optionsUsage() {
  const options = await generateAuthenticationOptions({
    rpID: domaine(), userVerification: 'required', timeout: DUREE_DEFI_MS,
  });
  await garderDefi(options.challenge, 'usage', null);
  return options;
}

interface LignePasse {
  id: string; credential_id: string; public_key: string; compteur: number;
  transports: string[] | null; fenetre_debut: string | null; fenetre_n: number;
}

/**
 * Compteur glissant d'une heure : renvoie false si la limite est atteinte.
 * La mise à jour n'aboutit que si la fenêtre n'a pas bougé depuis la lecture (verrou optimiste) : deux
 * preuves demandées en même temps ne peuvent pas compter pour une seule. La perdante est refusée.
 */
async function compterUsage(p: LignePasse, nouveauCompteur: number, sauvegardee: boolean): Promise<boolean> {
  const maintenant = Date.now();
  const neuve = !p.fenetre_debut || maintenant - new Date(p.fenetre_debut).getTime() >= HEURE_MS;
  const n = neuve ? 1 : p.fenetre_n + 1;
  if (n > LIMITE_PREUVES_HEURE) return false;
  let q = supabase.from('v1_age_passes').update({
    compteur: nouveauCompteur,
    sauvegardee,
    fenetre_n: n,
    ...(neuve && { fenetre_debut: new Date(maintenant).toISOString() }),
  }).eq('id', p.id).eq('fenetre_n', p.fenetre_n);
  q = p.fenetre_debut ? q.eq('fenetre_debut', p.fenetre_debut) : q.is('fenetre_debut', null);
  const { data, error } = await q.select('id');
  return !error && Array.isArray(data) && data.length === 1;
}

export async function preuveAvecPasse(reponse: AuthenticationResponseJSON, cleId: string, masque: Uint8Array): Promise<Resultat<string>> {
  const defi = await prendreDefi(reponse?.response?.clientDataJSON, 'usage');
  if (!defi) return echec('defi_invalide');
  const { data } = await supabase.from('v1_age_passes')
    .select('id, credential_id, public_key, compteur, transports, fenetre_debut, fenetre_n')
    .eq('credential_id', String(reponse?.id ?? '')).maybeSingle();
  const passe = data as LignePasse | null;
  if (!passe) return echec('passe_introuvable');

  let info;
  try {
    const r = await verifyAuthenticationResponse({
      response: reponse, expectedChallenge: defi.defi, expectedOrigin: origines(), expectedRPID: domaine(),
      requireUserVerification: true,
      credential: {
        id: passe.credential_id,
        publicKey: new Uint8Array(Buffer.from(passe.public_key, 'base64url')),
        counter: Number(passe.compteur),
        transports: passe.transports ?? undefined,
      },
    });
    if (!r.verified) return echec('cle_acces_refusee');
    info = r.authenticationInfo;
  } catch {
    // Signature fausse, ou compteur qui recule (clé copiée).
    return echec('cle_acces_refusee');
  }
  if (!(await compterUsage(passe, info.newCounter, info.credentialBackedUp))) return echec('limite_passe');
  return signer(cleId, masque);
}

// ── Purge ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Toutes les heures : défis expirés, vérifications anonymes abandonnées (lien expiré, jamais servies),
 * et marques d'usage devenues inutiles (le lien de la vérification a expiré depuis).
 */
export async function purgerAge(maintenant = new Date()): Promise<number> {
  await supabase.from('v1_age_defis').delete().lt('expire_le', maintenant.toISOString());
  const cle = await compteInterne();
  const { data } = await supabase.from('verification_requests').select('id')
    .eq('api_key_id', cle.id).lt('session_token_expires_at', maintenant.toISOString()).is('v1_deleted_at', null).limit(200);
  const abandons = (data ?? []) as { id: string }[];
  for (const { id } of abandons) await effacerVerification(cle, id);
  await supabase.from('v1_age_verifications_utilisees').delete()
    .lt('created_at', new Date(maintenant.getTime() - 2 * HEURE_MS).toISOString());
  return abandons.length;
}
