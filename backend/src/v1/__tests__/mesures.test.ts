import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fausseBase } from '../age/__tests__/fausseBase.js';

const m = vi.hoisted(() => ({ base: null as any, etats: new Map<string, any>() }));
vi.mock('@/config/database.js', () => ({ supabase: { from: (t: string) => m.base.from(t) } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/services/sessionPersistence.js', () => ({ loadSessionState: vi.fn(async (id: string) => m.etats.get(id) ?? null) }));
// parcours.ts importe sessions.ts (Idswyft) : seul etapeParcours sert ici.
vi.mock('../sessions.js', () => ({ effacerPhotos: vi.fn() }));
vi.mock('../photos.js', () => ({ ESSAIS_PHOTO_V1: 3 }));
vi.mock('@/middleware/auth.js', () => ({ hashHandoffToken: (t: string) => `h:${t}` }));

import { calculer, mesurerParcours, mesurerSession, releveParcours, type Faits, type Mesure } from '../mesures.js';
import { ID_INTERNE } from '../age/compte.js';

const T0 = Date.parse('2026-11-20T10:00:00.000Z');
const a = (s: number) => new Date(T0 + s * 1000).toISOString();
const MAINTENANT = new Date(T0 + 2 * 3600_000);

function session(id: string, champs: Record<string, any> = {}) {
  m.base.table('verification_requests').push({
    id, status: 'pending', developer_id: 'dev-site', v1_parcours: 'identite', v1_deleted_at: null,
    v1_ouverte_le: a(0), v1_mesuree_le: null, session_token_expires_at: a(3600), created_at: a(-30), ...champs,
  });
}
const photo = (id: string, s: number, verso = false) =>
  m.base.table('documents').push({ verification_request_id: id, is_back_of_id: verso, created_at: a(s), file_path: null });
const visage = (id: string, s: number) => m.base.table('selfies').push({ verification_request_id: id, created_at: a(s), file_path: null });

beforeEach(() => { m.base = fausseBase(); m.etats.clear(); });

describe('mesures : ce qui est gardé', () => {
  it('la ligne écrite ne contient que le jour, le parcours, l’issue, les essais et les durées', async () => {
    session('s1', { v1_ouverte_le: a(0) });
    photo('s1', 40); photo('s1', 95, true); visage('s1', 150);
    m.etats.set('s1', { current_step: 'COMPLETE', front_extraction: {}, face_match: { similarity_score: 0.9 }, completed_at: a(163) });
    await mesurerSession('s1', false, MAINTENANT);
    const lignes = m.base.table('v1_mesures');
    expect(lignes).toHaveLength(1);
    const { id: _aleatoire, ...ligne } = lignes[0];
    expect(Object.keys(ligne).sort()).toEqual([
      'essais_recto', 'essais_verso', 'essais_visage', 'issue', 'jour', 'page_ouverte', 'parcours',
      'recto_s', 'resultat_s', 'total_s', 'verso_s', 'visage_s',
    ]);
    expect(JSON.stringify(ligne)).not.toContain('s1');
    expect(JSON.stringify(ligne)).not.toContain('dev-site');
    expect(ligne).toEqual({
      jour: '2026-11-20', parcours: 'identite', issue: 'validee', page_ouverte: true,
      essais_recto: 1, essais_verso: 1, essais_visage: 1,
      // 40 → 40, 55 → 55, 55 → 55, 13 → 15, 163 → 165 (pas de 5 s)
      recto_s: 40, verso_s: 55, visage_s: 55, resultat_s: 15, total_s: 165,
    });
  });
});

describe('mesures : une seule fois par session', () => {
  it('deux passages horaires, puis la suppression par le site : une ligne', async () => {
    session('s1', { session_token_expires_at: a(3600) });
    photo('s1', 30);
    m.etats.set('s1', { current_step: 'AWAITING_BACK', front_extraction: {} });
    expect(await mesurerParcours(MAINTENANT)).toBe(1);
    expect(await mesurerParcours(MAINTENANT)).toBe(0);
    expect(await mesurerSession('s1', true, MAINTENANT)).toBeNull();
    expect(m.base.table('v1_mesures')).toHaveLength(1);
    expect(m.base.table('v1_mesures')[0].issue).toBe('abandon_verso');
  });

  it('deux comptages en même temps : une seule ligne', async () => {
    session('s1');
    m.etats.set('s1', { current_step: 'HARD_REJECTED', completed_at: a(60) });
    const r = await Promise.all([mesurerSession('s1', false, MAINTENANT), mesurerSession('s1', true, MAINTENANT)]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(m.base.table('v1_mesures')).toHaveLength(1);
  });

  it('le passage horaire ignore les liens encore valides, les sessions supprimées et celles hors API v1', async () => {
    session('encours', { session_token_expires_at: new Date(MAINTENANT.getTime() + 60_000).toISOString() });
    session('supprimee', { v1_deleted_at: a(100), session_token_expires_at: a(3600) });
    session('v2', { v1_parcours: null, session_token_expires_at: a(3600) });
    expect(await mesurerParcours(MAINTENANT)).toBe(0);
    expect(m.base.table('v1_mesures')).toHaveLength(0);
  });

  it('une session en cours n’est comptée qu’à sa suppression, comme « supprimee »', async () => {
    session('s1', { session_token_expires_at: new Date(MAINTENANT.getTime() + 60_000).toISOString() });
    photo('s1', 30);
    m.etats.set('s1', { current_step: 'AWAITING_BACK', front_extraction: {} });
    expect(await mesurerSession('s1', false, MAINTENANT)).toBeNull();
    expect((await mesurerSession('s1', true, MAINTENANT))?.issue).toBe('supprimee');
  });
});

describe('mesures : classement des sessions', () => {
  const faits = (f: Partial<Faits>): Faits => ({
    parcours: 'identite', statut: 'expiree', etape: 'recto', supprimee: false, creee_le: a(0), ouverte_le: null,
    page_connue: true, recto: [], verso: [], visages: [], finie_le: null, ...f,
  });

  it('page jamais ouverte, page ouverte sans photo', () => {
    expect(calculer(faits({}))).toMatchObject({ issue: 'sans_photo', page_ouverte: false, recto_s: null, total_s: null });
    expect(calculer(faits({ ouverte_le: a(0) }))).toMatchObject({ issue: 'sans_photo', page_ouverte: true });
  });

  it('photos illisibles seulement : abandon au recto, essais comptés', () => {
    // Une photo illisible ne pose pas front_extraction : la session est « expiree » pour le site.
    const r = calculer(faits({ ouverte_le: a(0), recto: [a(20), a(50)] }));
    expect(r).toMatchObject({ issue: 'abandon_recto', essais_recto: 2, recto_s: 50, verso_s: null });
  });

  it('abandons au verso et au visage, lien expiré pendant le traitement', () => {
    expect(calculer(faits({ statut: 'abandonnee', etape: 'verso', ouverte_le: a(0), recto: [a(30)] })).issue).toBe('abandon_verso');
    expect(calculer(faits({ statut: 'abandonnee', etape: 'visage', ouverte_le: a(0), recto: [a(30)], verso: [a(60)] })))
      .toMatchObject({ issue: 'abandon_visage', verso_s: 30, visage_s: null, resultat_s: null });
    expect(calculer(faits({ statut: 'abandonnee', etape: 'traitement', recto: [a(30)] })).issue).toBe('abandon_traitement');
  });

  it('refusée, à revoir ; une session finie puis supprimée garde son issue', () => {
    expect(calculer(faits({ statut: 'refusee', etape: null, recto: [a(1)], finie_le: a(9) })).issue).toBe('refusee');
    expect(calculer(faits({ statut: 'a_revoir', etape: null, recto: [a(1)], finie_le: a(9) })).issue).toBe('a_revoir');
    expect(calculer(faits({ statut: 'validee', etape: null, supprimee: true, recto: [a(1)], finie_le: a(9) })).issue).toBe('validee');
    expect(calculer(faits({ statut: 'expiree', supprimee: true })).issue).toBe('sans_photo');
  });

  it('passeport : pas de verso, le visage suit le recto', () => {
    const r = calculer(faits({ statut: 'validee', etape: null, ouverte_le: a(0), recto: [a(30)], visages: [a(70)], finie_le: a(80) }));
    expect(r).toMatchObject({ verso_s: null, visage_s: 40, resultat_s: 10, total_s: 80 });
  });

  it('vérification d’âge d’un site : ouverture inconnue', () => {
    expect(calculer(faits({ parcours: 'age', page_connue: false })).page_ouverte).toBeNull();
  });
});

describe('mesures : passe majeur', () => {
  it('reconnu par le compte interne, ouvert à sa création', async () => {
    session('p1', { developer_id: ID_INTERNE, v1_parcours: 'age', v1_ouverte_le: null, created_at: a(0) });
    visage('p1', 25);
    m.etats.set('p1', { current_step: 'COMPLETE', front_extraction: {}, face_match: { similarity_score: 0.9 }, completed_at: a(31) });
    const r = await mesurerSession('p1', true, MAINTENANT);
    expect(r).toMatchObject({ parcours: 'passe', issue: 'validee', page_ouverte: true, essais_visage: 1, total_s: 30 });
  });

  it('une vérification d’âge d’un site reste « age »', async () => {
    session('a1', { v1_parcours: 'age', v1_ouverte_le: null });
    expect((await mesurerSession('a1', false, MAINTENANT))?.parcours).toBe('age');
  });
});

describe('mesures : relevé', () => {
  const ligne = (l: Partial<Mesure>): Mesure => ({
    jour: '2026-11-20', parcours: 'identite', issue: 'validee', page_ouverte: true, essais_recto: 1, essais_verso: 1, essais_visage: 1,
    recto_s: 30, verso_s: 30, visage_s: 30, resultat_s: 10, total_s: 100, ...l,
  });

  it('atteintes, abandons, taux, médiane et 90e centile par étape', () => {
    const lignes = [
      ligne({ issue: 'sans_photo', page_ouverte: false, essais_recto: 0, essais_verso: 0, essais_visage: 0 }),
      ligne({ issue: 'sans_photo', essais_recto: 0, essais_verso: 0, essais_visage: 0, recto_s: null }),
      ligne({ issue: 'abandon_recto', essais_verso: 0, essais_visage: 0, recto_s: 90 }),
      ligne({ issue: 'abandon_verso', essais_verso: 0, essais_visage: 0, verso_s: null }),
      ligne({ issue: 'abandon_visage', essais_visage: 0, visage_s: null }),
      ligne({ total_s: 100 }), ligne({ total_s: 200 }), ligne({ issue: 'refusee', total_s: 300 }),
    ];
    const r = releveParcours(lignes);
    expect(r.sessions).toBe(8);
    expect(r.page_jamais_ouverte).toBe(1);
    const [recto, verso, visage, resultat] = r.etapes;
    expect(recto).toMatchObject({ atteinte: 7, abandons: 2, taux_abandon_pct: 28.6 });
    expect(verso).toMatchObject({ atteinte: 5, abandons: 1, taux_abandon_pct: 20 });
    expect(visage).toMatchObject({ atteinte: 4, abandons: 1, taux_abandon_pct: 25 });
    expect(resultat).toMatchObject({ atteinte: 3, abandons: 0, taux_abandon_pct: null });
    expect(recto.mesurees).toBe(6);
    expect(recto.mediane_s).toBe(30);
    expect(recto.p90_s).toBe(90);
    expect(r.duree_totale).toEqual({ mediane_s: 200, p90_s: 300, mesurees: 3 });
    expect(r.taux_validation_pct).toBe(25);
  });

  it('relevé vide', () => {
    expect(releveParcours([]).etapes[0]).toMatchObject({ atteinte: 0, taux_abandon_pct: null, mediane_s: null });
  });
});
