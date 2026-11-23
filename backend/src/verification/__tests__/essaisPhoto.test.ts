/**
 * Preuvid : photos illisibles admises par côté avant le refus (parcours identité v1, 3 essais).
 * Les signaux de fraude restent des refus immédiats ; sans option, le comportement d'Idswyft ne change pas.
 */
import { describe, it, expect } from 'vitest';
import { VerificationSession } from '../session/VerificationSession.js';
import { VerificationStatus } from '@idswyft/shared';
import type { FrontExtractionResult, BackExtractionResult } from '@idswyft/shared';

const recto: FrontExtractionResult = {
  ocr: { full_name: 'JOHN DOE', date_of_birth: '1990-01-15', id_number: 'AB1234567', expiry_date: '2030-12-31', nationality: 'USA' },
  face_embedding: [0.1, 0.2, 0.3], face_confidence: 0.92, ocr_confidence: 0.87, mrz_from_front: null,
};
const rectoIllisible: FrontExtractionResult = { ...recto, ocr: { full_name: '', date_of_birth: '', id_number: '', expiry_date: '' } };
const verso: BackExtractionResult = {
  qr_payload: { full_name: 'JOHN DOE', first_name: 'JOHN', last_name: 'DOE', date_of_birth: '1990-01-15', id_number: 'AB1234567', expiry_date: '2030-12-31', nationality: 'USA' },
  mrz_result: null, barcode_format: 'PDF417', raw_barcode_data: 'data',
};
const versoIllisible: BackExtractionResult = { qr_payload: null, mrz_result: null, barcode_format: null, raw_barcode_data: null } as any;

/** Session dont chaque appel d'extraction renvoie l'élément suivant de la liste. */
function session(rectos: FrontExtractionResult[], versos: BackExtractionResult[] = [], essais?: number, hydration?: any) {
  const r = [...rectos], v = [...versos];
  const s = new VerificationSession({
    extractFront: async () => r.shift()!,
    extractBack: async () => v.shift()!,
    processLiveCapture: async () => { throw new Error('inutile ici'); },
    computeFaceMatch: () => { throw new Error('inutile ici'); },
  }, hydration);
  if (essais) s.autoriserEssaisPhoto(essais);
  return s;
}
const image = Buffer.from('x');

describe('essais de photo', () => {
  it('sans option, un recto illisible refuse la session (Idswyft)', async () => {
    const s = session([rectoIllisible]);
    const r = await s.submitFront(image);
    expect(r.a_reprendre).toBeUndefined();
    expect(s.getState().current_step).toBe(VerificationStatus.HARD_REJECTED);
  });

  it('avec 3 essais : deux rectos illisibles reviennent au recto, sans motif de refus, puis le bon passe', async () => {
    const s = session([rectoIllisible, rectoIllisible, recto], [], 3);
    for (let i = 0; i < 2; i++) {
      const r = await s.submitFront(image);
      expect(r).toMatchObject({ passed: false, a_reprendre: true, rejection_reason: 'FRONT_OCR_FAILED' });
      expect(s.getState().current_step).toBe(VerificationStatus.AWAITING_FRONT);
      expect(s.getState().rejection_reason).toBeNull();
    }
    expect((await s.submitFront(image)).passed).toBe(true);
    expect(s.getState().current_step).toBe(VerificationStatus.AWAITING_BACK);
  });

  it('le troisième recto illisible refuse la session', async () => {
    const s = session([rectoIllisible, rectoIllisible, rectoIllisible], [], 3);
    await s.submitFront(image); await s.submitFront(image);
    const r = await s.submitFront(image);
    expect(r.a_reprendre).toBeUndefined();
    expect(s.getState().current_step).toBe(VerificationStatus.HARD_REJECTED);
    expect(s.getState().rejection_reason).toBe('FRONT_OCR_FAILED');
  });

  it('le verso a ses propres essais', async () => {
    const s = session([rectoIllisible, rectoIllisible, recto], [versoIllisible, versoIllisible, verso], 3);
    await s.submitFront(image); await s.submitFront(image); await s.submitFront(image);
    for (let i = 0; i < 2; i++) {
      expect(await s.submitBack(image)).toMatchObject({ a_reprendre: true, rejection_reason: 'BACK_BARCODE_NOT_FOUND' });
      expect(s.getState().current_step).toBe(VerificationStatus.AWAITING_BACK);
    }
    expect((await s.submitBack(image)).passed).toBe(true);
    expect((s.getState() as any).essais_photo).toEqual({ recto: 2, verso: 2 });
  });

  it('recto et verso qui ne concordent pas : refus immédiat malgré les essais', async () => {
    const avecMrz = { ...recto, mrz_from_front: ['P<USADOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'AB12345671USA9001150M3012310<<<<<<<<<<<<<<00'] };
    const autre: BackExtractionResult = { ...verso, mrz_result: {
      raw_lines: ['P<USASMITH<<JANE<<<<<<<<<<<<<<<<<<<<<<<<<<<<', 'XY98765431USA8501150F2812310<<<<<<<<<<<<<<00'], checksums_valid: true,
    } } as any;
    const s = session([avecMrz], [autre], 3);
    await s.submitFront(image);
    const r = await s.submitBack(image);
    expect(r.rejection_reason).toBe('BACK_MRZ_BARCODE_MISMATCH');
    expect(r.a_reprendre).toBeUndefined();
    expect(s.getState().current_step).toBe(VerificationStatus.HARD_REJECTED);
  });

  it('le compte survit à l’enregistrement de la session (une requête par photo)', async () => {
    let s = session([rectoIllisible], [], 3);
    await s.submitFront(image);
    s = session([rectoIllisible], [], 3, JSON.parse(JSON.stringify(s.getState())));
    await s.submitFront(image);
    s = session([rectoIllisible], [], 3, JSON.parse(JSON.stringify(s.getState())));
    await s.submitFront(image);
    expect(s.getState().current_step).toBe(VerificationStatus.HARD_REJECTED);
  });
});
