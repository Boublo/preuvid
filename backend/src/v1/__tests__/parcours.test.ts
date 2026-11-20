import { describe, expect, it, vi } from 'vitest';
import type { SessionState } from '@idswyft/shared';

const base = vi.hoisted(() => ({ lignes: [] as { id: string; v1_parcours: string | null }[], erreur: null as unknown }));
vi.mock('@/config/database.js', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        in: async (_c: string, ids: string[]) => ({ data: base.lignes.filter(l => ids.includes(l.id)), error: base.erreur }),
      }),
    }),
  },
}));

vi.mock('@/services/sessionPersistence.js', () => ({ loadSessionState: async () => null }));
vi.mock('../sessions.js', () => ({ effacerPhotos: async () => true }));

import { dureeDe, essaisRestants, etapeParcours, lectureDe } from '../parcours.js';
import { lienParcours as lienParcoursPourTest } from '../decision.js';
import { sessionsV1 } from '../photos.js';

const etat = (e: Partial<SessionState>) => e as SessionState;
const champ = (value: string, check: string, source = 'mrz') => ({ value, check, source });

describe('page du parcours identité : étape attendue', () => {
  it('suit le moteur, et ne demande plus rien une fois tranché', () => {
    expect(etapeParcours(null, 'en_attente')).toBe('recto');
    expect(etapeParcours(etat({ current_step: 'AWAITING_BACK' } as any), 'en_cours')).toBe('verso');
    expect(etapeParcours(etat({ current_step: 'AWAITING_LIVE' } as any), 'en_cours')).toBe('visage');
    expect(etapeParcours(etat({ current_step: 'CROSS_VALIDATING' } as any), 'en_cours')).toBe('traitement');
    expect(etapeParcours(etat({ current_step: 'AWAITING_LIVE' } as any), 'a_revoir')).toBeNull();
    expect(etapeParcours(etat({ current_step: 'COMPLETE' } as any), 'validee')).toBeNull();
  });
});

describe('photos encore possibles', () => {
  it('trois par côté, décomptées à chaque photo illisible ; rien hors des étapes de photo', () => {
    expect(essaisRestants(null, 'recto')).toBe(3);
    const e = etat({ essais_photo: { recto: 2, verso: 1 } } as any);
    expect(essaisRestants(e, 'recto')).toBe(1);
    expect(essaisRestants(e, 'verso')).toBe(2);
    expect(essaisRestants(e, 'visage')).toBeNull();
  });
});

describe('résumé de la lecture, sans aucun champ lu', () => {
  it('compte les clés de contrôle réelles, pas un « 3 sur 3 » fixe', () => {
    const l = lectureDe(etat({
      front_extraction: {
        mrz_fields: {
          document_number: champ('X4RTBPFW4', 'juste'),
          date_of_birth: champ('1990-01-15', 'corrigee'),
          expiry_date: champ('2031-02-11', 'fausse'),
          last_name: champ('MARTIN', 'sans_cle'),
        },
        ocr: {},
      } as any,
    }), new Date('2026-11-20'));
    expect(l).toEqual({ mrz: true, cles: { justes: 2, total: 3 }, validite: 'valide' });
    expect(JSON.stringify(l)).not.toMatch(/MARTIN|X4RT|1990|2031/);
  });

  it('pièce expirée, pas de MRZ, rien de lu', () => {
    const l = lectureDe(etat({ front_extraction: { mrz_fields: null, ocr: { expiration_date: '2020-01-01' } } as any }), new Date('2026-11-20'));
    expect(l).toEqual({ mrz: false, cles: null, validite: 'depassee' });
    expect(lectureDe(etat({ front_extraction: { ocr: { expiration_date: '01.01.2030' } } as any }))?.validite).toBeNull();
    expect(lectureDe(null)).toBeNull();
  });

  it('durée : seulement si le parcours est terminé', () => {
    expect(dureeDe(etat({ created_at: '2026-11-20T10:00:00Z', completed_at: '2026-11-20T10:01:32Z' } as any))).toBe(92);
    expect(dureeDe(etat({ created_at: '2026-11-20T10:00:00Z', completed_at: null } as any))).toBeNull();
  });
});

describe('lien envoyé à la personne', () => {
  it('identité : page Preuvid, jeton après le # ; âge : inchangé', () => {
    const j = 'a'.repeat(64);
    const lien = new URL(lienParcoursPourTest('https://verif.example/', 'identite', j));
    expect(lien.pathname).toBe('/verifier');
    expect(lien.search).toBe('');
    expect(lien.hash).toBe(`#${j}`);
    expect(lienParcoursPourTest('https://verif.example', 'age', j)).toBe(`https://verif.example/user-verification?session=${j}`);
  });
});

describe('photos des sessions v1 : jamais au site', () => {
  it('repère les sessions v1, et cache tout si la base ne répond pas', async () => {
    base.lignes = [{ id: 'v1', v1_parcours: 'identite' }, { id: 'api', v1_parcours: null }];
    base.erreur = null;
    expect([...await sessionsV1(['v1', 'api'])]).toEqual(['v1']);
    base.erreur = { message: 'panne' };
    expect([...await sessionsV1(['v1', 'api'])].sort()).toEqual(['api', 'v1']);
    expect([...await sessionsV1([])]).toEqual([]);
  });
});
