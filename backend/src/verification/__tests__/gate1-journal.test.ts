import { describe, it, expect, vi } from 'vitest';

const journal = vi.hoisted(() => [] as unknown[]);
vi.mock('../../utils/logger.js', () => {
  const noter = (...a: unknown[]) => { journal.push(a); };
  return { logger: { info: noter, warn: noter, error: noter, debug: noter } };
});

import { evaluateGate1 } from '../gates/gate1-frontDocument.js';

describe('Gate 1 — journal (Preuvid)', () => {
  it('ne journalise aucune valeur lue sur la pièce, seulement quels champs ont été lus', () => {
    evaluateGate1({
      ocr: { full_name: 'JEAN TESTEUR', date_of_birth: '1952-01-08', id_number: 'ZZ9999999', expiry_date: '' },
      face_embedding: null,
      face_confidence: 0,
      ocr_confidence: 0.9,
      mrz_from_front: null,
    } as never);
    const texte = JSON.stringify(journal);
    expect(texte).not.toMatch(/JEAN|TESTEUR|1952|ZZ9999999/);
    expect(texte).toContain('"full_name":"lu"');
    expect(texte).toContain('"expiry_date":"absent"');
  });
});
