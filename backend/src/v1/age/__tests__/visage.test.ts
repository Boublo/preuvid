import { describe, expect, it, vi } from 'vitest';
import { FLOW_PRESETS, VerificationStatus } from '@idswyft/shared';
import type { FaceMatchResult, FrontExtractionResult, LiveCaptureResult } from '@idswyft/shared';
import { VerificationSession } from '@/verification/session/VerificationSession.js';
import { mapStatusForResponse } from '@/verification/statusReader.js';
import { decisionV1, type V1Row } from '../../decision.js';
import { avecVisage, fluxAge, MARQUE_VISAGE } from '../visage.js';

vi.mock('@/config/database.js', () => ({ supabase: {} }));

const recto = (naissance: string): FrontExtractionResult => ({
  ocr: { full_name: 'JEAN TESTEUR', date_of_birth: naissance, id_number: 'ZZ9999999', expiry_date: '2031-01-01', nationality: 'FRA' },
  face_embedding: [0.1, 0.2, 0.3],
  face_confidence: 0.92,
  ocr_confidence: 0.9,
  mrz_from_front: null,
});
const vivant: LiveCaptureResult = { face_embedding: [0.4, 0.5, 0.6], face_confidence: 0.95, liveness_passed: true, liveness_score: 0.9 };
const ressemblant: FaceMatchResult = { similarity_score: 0.8, passed: true, threshold_used: 0.6 };

const PASSE = { [MARQUE_VISAGE]: true, aml_screening: false };
const flux = fluxAge(FLOW_PRESETS.age_only, PASSE);

function session(opts: { naissance?: string; live?: Partial<LiveCaptureResult>; match?: FaceMatchResult; front?: Partial<FrontExtractionResult> } = {}) {
  const s = new VerificationSession({
    extractFront: async () => ({ ...recto(opts.naissance ?? '1990-01-15'), ...opts.front }),
    extractBack: async () => { throw new Error('pas de verso'); },
    processLiveCapture: async () => ({ ...vivant, ...opts.live }),
    computeFaceMatch: () => opts.match ?? ressemblant,
    faceMatchThreshold: 0.6,
  } as any, undefined, flux);
  return { s };
}

const ligne = (status: string): V1Row => ({ id: 'v', status, v1_parcours: 'age', session_token_expires_at: new Date(Date.now() + 3600e3).toISOString() });

describe('passe majeur : le visage après l’âge', () => {
  it('la marque ne vaut que pour le parcours âge', () => {
    expect(avecVisage(PASSE)).toBe(true);
    expect(avecVisage({})).toBe(false);
    expect(avecVisage(null)).toBe(false);
    expect(fluxAge(FLOW_PRESETS.age_only, {})).toBe(FLOW_PRESETS.age_only);
    expect(fluxAge(FLOW_PRESETS.full, PASSE)).toBe(FLOW_PRESETS.full);
    expect(flux).toMatchObject({ preset: 'age_only', requiresLiveness: true, requiresFaceMatch: true, afterFront: 'AWAITING_LIVE' });
  });

  it('âge seul (sites, API Idswyft) : inchangé, terminé dès le recto', async () => {
    const s = new VerificationSession({ extractFront: async () => recto('1990-01-15') } as any, undefined, FLOW_PRESETS.age_only);
    const r = await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    expect(r.passed).toBe(true);
    expect(s.getState().current_step).toBe(VerificationStatus.COMPLETE);
  });

  it('majeur au recto : rien n’est conclu avant le visage', async () => {
    const { s } = session();
    const r = await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    expect(r.passed).toBe(true);
    const etat = s.getState();
    expect(etat.current_step).toBe(VerificationStatus.AWAITING_LIVE);
    expect(etat.completed_at).toBeFalsy();
    expect(mapStatusForResponse(etat, flux).final_result).toBeNull();
    // Statut enregistré par la route : « processing ». Le passe et la preuve unique exigent validee + majeur.
    expect(decisionV1(ligne('processing'), etat)).toMatchObject({ statut: 'en_cours', majeur: null });
  });

  it('mineur : refusé au recto, jamais jusqu’au visage', async () => {
    const naissance = `${new Date().getFullYear() - 16}-01-01`;
    const { s } = session({ naissance });
    const r = await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    expect(r.passed).toBe(false);
    expect(s.getState().current_step).toBe(VerificationStatus.HARD_REJECTED);
    expect(s.getState().rejection_reason).toBe('UNDERAGE');
    await expect(s.submitLiveCapture(Buffer.from('y'))).rejects.toThrow();
  });

  it('visage vivant et ressemblant : validé, majeur', async () => {
    const { s } = session();
    await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    const r = await s.submitLiveCapture(Buffer.from('y'));
    expect(r.passed).toBe(true);
    const etat = s.getState();
    expect(etat.current_step).toBe(VerificationStatus.COMPLETE);
    expect(mapStatusForResponse(etat, flux).final_result).toBe('verified');
    expect(decisionV1(ligne('verified'), etat)).toMatchObject({ statut: 'validee', majeur: true });
  });

  it('vivant non détecté : refusé', async () => {
    const { s } = session({ live: { liveness_passed: false, liveness_score: 0.1 } });
    await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    const r = await s.submitLiveCapture(Buffer.from('y'));
    expect(r.passed).toBe(false);
    expect(s.getState().current_step).toBe(VerificationStatus.HARD_REJECTED);
    expect(decisionV1(ligne('failed'), s.getState())).toMatchObject({ statut: 'refusee', majeur: false });
  });

  it('visage différent de la photo de la pièce : refusé', async () => {
    const { s } = session({ match: { similarity_score: 0.2, passed: false, threshold_used: 0.6 } });
    await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    expect((await s.submitLiveCapture(Buffer.from('y'))).passed).toBe(false);
    expect(s.getState().rejection_reason).toBe('FACE_MATCH_FAILED');
  });

  it('pas de visage sur la pièce : refus, pas de revue manuelle', async () => {
    const { s } = session({ front: { face_embedding: null } });
    await s.submitFrontAgeOnly(Buffer.from('x'), 18);
    const r = await s.submitLiveCapture(Buffer.from('y'));
    expect(r.passed).toBe(false);
    expect(s.getState().rejection_reason).toBe('FACE_NOT_DETECTED');
    expect(mapStatusForResponse(s.getState(), flux).final_result).toBe('failed');
  });
});
