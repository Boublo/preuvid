vi.mock('@/config/database.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { describe, expect, it, vi } from 'vitest';
import { champsV1, decisionV1, motifV1, statutV1, type V1Row } from '../decision.js';

const maintenant = new Date('2026-11-20T10:00:00Z');
const futur = '2026-11-20T10:30:00Z';
const passe = '2026-11-20T09:30:00Z';

const ligne = (p: Partial<V1Row> = {}): V1Row => ({
  id: 's1', status: 'pending', v1_parcours: 'identite', session_token_expires_at: futur, ...p,
});
const etat = (p: Record<string, unknown> = {}): any => ({
  current_step: 'AWAITING_FRONT', front_extraction: null, cross_validation: null, face_match: null,
  rejection_reason: null, rejection_detail: null, ...p,
});

describe('statutV1', () => {
  it('en_attente puis en_cours', () => {
    expect(statutV1(ligne(), etat(), maintenant)).toBe('en_attente');
    expect(statutV1(ligne(), etat({ current_step: 'AWAITING_BACK', front_extraction: {} }), maintenant)).toBe('en_cours');
  });

  it('expiree sans pièce, abandonnee après un début', () => {
    expect(statutV1(ligne({ session_token_expires_at: passe }), etat(), maintenant)).toBe('expiree');
    expect(statutV1(ligne({ session_token_expires_at: passe }), etat({ current_step: 'AWAITING_LIVE', front_extraction: {} }), maintenant)).toBe('abandonnee');
  });

  it('résultat final de l’état du moteur', () => {
    expect(statutV1(ligne(), etat({ current_step: 'HARD_REJECTED' }), maintenant)).toBe('refusee');
    expect(statutV1(ligne(), etat({ current_step: 'COMPLETE', face_match: { similarity_score: 0.9 } }), maintenant)).toBe('validee');
    expect(statutV1(ligne(), etat({ current_step: 'COMPLETE', face_match: { skipped_reason: 'x' } }), maintenant)).toBe('a_revoir');
  });

  it('la revue manuelle (colonne status) l’emporte, même après expiration du lien', () => {
    const revue = ligne({ status: 'verified', session_token_expires_at: passe });
    expect(statutV1(revue, etat({ current_step: 'COMPLETE', face_match: { skipped_reason: 'x' } }), maintenant)).toBe('validee');
    expect(statutV1(ligne({ status: 'failed' }), etat(), maintenant)).toBe('refusee');
  });
});

describe('motifV1', () => {
  it('donne le score du visage en cas de refus pour visage différent', () => {
    const m = motifV1('refusee', etat({ rejection_reason: 'FACE_MATCH_FAILED', face_match: { similarity_score: 0.714 } }));
    expect(m).toEqual({ code: 'FACE_MATCH_FAILED', texte: 'visage 71 sur 100, différent de la photo de la pièce' });
  });

  it('distingue clé fausse confirmée et verso illisible', () => {
    expect(motifV1('refusee', etat({ rejection_reason: 'BACK_MRZ_CHECKSUM_FAILED' }))?.texte).toMatch(/clé de contrôle fausse/);
    expect(motifV1('refusee', etat({ rejection_reason: 'BACK_MRZ_UNREADABLE' }))?.texte).toMatch(/illisible/);
  });

  it('résume une validation', () => {
    const m = motifV1('validee', etat({ face_match: { similarity_score: 0.92 }, front_extraction: { mrz_valid: true } }));
    expect(m?.texte).toBe('visage 92 sur 100, clés de contrôle justes');
  });
});

describe('champsV1', () => {
  it('reprend le détail MRZ, puis complète par la zone imprimée', () => {
    const champs = champsV1(etat({
      front_extraction: {
        ocr: { first_name: 'JEAN PIERRE', last_name: 'LEFEBVRE' },
        mrz_fields: {
          last_name: { value: 'LEFEBVRE', check: 'sans_cle', source: 'concordants', confidence: 0.99 },
          date_of_birth: { value: null, check: 'fausse', source: null, confidence: 0 },
          expiry_date: { value: '2033-06-16', check: 'absent', source: null, confidence: 0 },
        },
      },
    }))!;
    expect(champs.nom).toEqual({ valeur: 'LEFEBVRE', cle: 'sans_cle', source: 'concordants' });
    expect(champs.date_naissance).toEqual({ valeur: null, cle: 'fausse', source: null });
    expect(champs.date_expiration.cle).toBe('absente');
    expect(champs.prenoms).toEqual({ valeur: 'JEAN PIERRE', cle: 'absente', source: 'zone_imprimee' });
  });
});

describe('decisionV1', () => {
  it('parcours age : seulement majeur, jamais de champ lu', () => {
    const e = etat({ current_step: 'COMPLETE', front_extraction: { ocr: { date_of_birth: '1952-01-08' } } });
    const d = decisionV1(ligne({ v1_parcours: 'age' }), e, maintenant);
    expect(d).toEqual({ session: 's1', parcours: 'age', statut: 'validee', majeur: true });
    expect(decisionV1(ligne({ v1_parcours: 'age' }), etat({ current_step: 'HARD_REJECTED' }), maintenant))
      .toMatchObject({ majeur: false });
    expect(decisionV1(ligne({ v1_parcours: 'age' }), etat(), maintenant)).toMatchObject({ statut: 'en_attente', majeur: null });
  });
});
