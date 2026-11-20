/**
 * Appels de la page du parcours identité. Même origine (nginx), sans Referer ni cookie. Le jeton de
 * session voyage dans le corps (état, suppression) ou dans l'en-tête X-Session-Token (photos, routes
 * d'Idswyft), jamais dans l'adresse.
 */

export class ErreurParcours extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export type Statut = 'en_attente' | 'en_cours' | 'validee' | 'refusee' | 'a_revoir' | 'expiree' | 'abandonnee';
export type Etape = 'recto' | 'verso' | 'visage' | 'traitement' | null;

export interface Lecture {
  mrz: boolean;
  cles: { justes: number; total: number } | null;
  validite: 'valide' | 'depassee' | null;
}

export interface Etat {
  session: string;
  site: string | null;
  retour: string | null;
  statut: Statut;
  etape: Etape;
  /** Photos encore possibles pour ce côté ; à 0 de plus, la session est refusée. */
  essais_restants: number | null;
  /** Ce côté a déjà donné une photo illisible : plus de prise automatique, la personne déclenche. */
  photo_ratee: boolean;
  lecture: Lecture | null;
  motif: string | null;
  duree_s: number | null;
  photos: 'gardees' | 'effacees';
  expire_le: string | null;
}

export type TypePiece = 'national_id' | 'passport' | 'drivers_license';

async function lireErreur(r: Response, defaut: string): Promise<ErreurParcours> {
  let json: { erreur?: { code?: string; message?: string } } | null = null;
  try { json = await r.json(); } catch { /* corps vide */ }
  return new ErreurParcours(json?.erreur?.code ?? 'erreur', json?.erreur?.message ?? defaut, r.status);
}

async function appel(chemin: string, jeton: string): Promise<Response> {
  const r = await fetch(`/v1/parcours${chemin}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jeton }),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  if (!r.ok) throw await lireErreur(r, 'Le service ne répond pas.');
  return r;
}

export const lireEtat = async (jeton: string): Promise<Etat> => (await appel('/etat', jeton)).json();
export const effacerPhotos = async (jeton: string): Promise<void> => { await appel('/effacer-photos', jeton); };

async function envoyer(session: string, jeton: string, route: string, form: FormData, defaut: string) {
  const r = await fetch(`/api/v2/verify/${session}/${route}`, {
    method: 'POST', headers: { 'X-Session-Token': jeton }, body: form, credentials: 'omit', referrerPolicy: 'no-referrer',
  });
  // 409 : l'étape est déjà passée (envoi en double, autre appareil) ou la vérification est close.
  // L'état relu ensuite dit quoi faire ; ce n'est pas une erreur à montrer.
  if (!r.ok && r.status !== 409) throw new ErreurParcours('envoi_impossible', defaut, r.status);
}

export function envoyerPiece(session: string, jeton: string, photo: Blob, type: TypePiece, cote: 'recto' | 'verso') {
  const form = new FormData();
  form.append('document', photo, `${cote}.jpg`);
  form.append('document_type', type);
  return envoyer(session, jeton, cote === 'recto' ? 'front-document' : 'back-document', form, 'La photo n’a pas pu être envoyée. Réessayez.');
}

export function envoyerVisage(session: string, jeton: string, photo: Blob, meta: unknown) {
  const form = new FormData();
  form.append('selfie', photo, 'visage.jpg');
  form.append('liveness_metadata', JSON.stringify(meta));
  return envoyer(session, jeton, 'live-capture', form, 'Les images n’ont pas pu être envoyées. Réessayez.');
}
