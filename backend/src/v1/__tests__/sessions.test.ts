vi.mock('@/config/database.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/index.js', () => ({ default: { nodeEnv: 'test', storage: { provider: 'local' }, webhooks: { timeoutMs: 1000 } } }));
vi.mock('@/middleware/auth.js', () => ({ hashHandoffToken: (t: string) => t }));
vi.mock('@/services/verification.js', () => ({ VerificationService: class {} }));
vi.mock('@/services/sessionPersistence.js', () => ({
  saveSessionState: vi.fn(),
  loadSessionState: vi.fn(async () => ({ current_step: 'COMPLETE' })),
}));
vi.mock('@/verification/session/VerificationSession.js', () => ({ VerificationSession: class {} }));
const { deleteFile, emettre } = vi.hoisted(() => ({
  deleteFile: vi.fn(async () => undefined),
  emettre: vi.fn(async () => undefined),
}));
vi.mock('@/services/storage.js', () => ({ StorageService: class { deleteFile = deleteFile; } }));
vi.mock('../webhooks.js', () => ({ emettre }));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@/config/database.js';
import { effacerFichiers, effacerImagesAge, supprimerSession } from '../sessions.js';

const ID = '11111111-1111-4111-8111-111111111111';
const cle = { id: 'key-1', developer_id: 'dev-1', is_sandbox: true } as any;

/** Base simulée : chaque table renvoie ses lignes ; `echec` fait échouer une suppression. */
function base(opts: { echec?: string; echecLecture?: string; mode?: string } = {}) {
  const ops: { table: string; op: string; donnees?: any }[] = [];
  const lignes: Record<string, any[]> = {
    documents: [{ file_path: 'uploads/absent-recto.jpg' }],
    selfies: [{ file_path: 'uploads/absent-selfie.jpg', enrollment_audio_path: 'uploads/absent-voix.webm' }],
    verification_requests: [{
      id: ID, status: 'verified', developer_id: 'dev-1', is_sandbox: true, api_key_id: 'key-1',
      v1_parcours: 'identite', v1_reference: 'client-42', v1_deleted_at: null, verification_mode: opts.mode ?? 'full',
      session_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    }],
  };
  (supabase.from as any).mockImplementation((table: string) => {
    let op = 'select';
    let donnees: any;
    const resultat = () => {
      ops.push({ table, op, donnees });
      if (op === 'delete' && opts.echec === table) return { error: { message: 'refus' } };
      if (op === 'select' && opts.echecLecture === table) return { data: null, error: { message: 'refus' } };
      return { data: lignes[table] ?? [], error: null };
    };
    const q: any = {
      select: () => q, eq: () => q, is: () => q,
      delete: () => { op = 'delete'; return q; },
      update: (d: any) => { op = 'update'; donnees = d; return q; },
      single: async () => ({ data: (lignes[table] ?? [])[0] ?? null, error: null }),
      maybeSingle: async () => ({ data: (lignes[table] ?? [])[0] ?? null, error: null }),
      then: (ok: any, ko: any) => Promise.resolve(resultat()).then(ok, ko),
    };
    return q;
  });
  return ops;
}

beforeEach(() => { deleteFile.mockClear(); emettre.mockClear(); });

describe('effacerFichiers', () => {
  it('un fichier local déjà absent compte comme effacé (suppression relançable)', async () => {
    base();
    expect(await effacerFichiers(ID)).toBe(true);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe('effacerImagesAge', () => {
  const misAJour = (ops: { table: string; op: string; donnees?: any }[]) =>
    ops.filter(o => o.op === 'update').map(o => [o.table, o.donnees]);

  it('parcours âge : efface les fichiers et vide les chemins', async () => {
    const ops = base({ mode: 'age_only' });
    await effacerImagesAge(ID);
    expect(misAJour(ops)).toEqual(expect.arrayContaining([
      ['documents', { file_path: null }],
      ['selfies', { file_path: null, enrollment_audio_path: null }],
    ]));
  });

  it('autre parcours : ne touche à rien', async () => {
    const ops = base({ mode: 'full' });
    await effacerImagesAge(ID);
    expect(misAJour(ops)).toEqual([]);
  });

  it('fichiers non effacés : les chemins restent, pour pouvoir réessayer', async () => {
    const ops = base({ mode: 'age_only', echecLecture: 'documents' });
    await effacerImagesAge(ID);
    expect(misAJour(ops)).toEqual([]);
  });
});

describe('supprimerSession', () => {
  it('efface les tables filles, vide les anciennes livraisons, puis pose la pierre tombale', async () => {
    const ops = base();
    expect(await supprimerSession(cle, ID)).toBe('supprimee');
    const supprimees = ops.filter(o => o.op === 'delete').map(o => o.table);
    expect(supprimees).toEqual(expect.arrayContaining(['documents', 'selfies', 'verification_contexts', 'identity_vault', 'aml_screenings', 'v1_idempotency']));
    expect(ops.find(o => o.table === 'webhook_deliveries')?.donnees).toEqual({ payload: {}, response_body: null });
    const tombe = ops.find(o => o.table === 'verification_requests' && o.op === 'update')?.donnees;
    expect(tombe).toMatchObject({ v1_reference: null, session_token_hash: null });
    expect(emettre).toHaveBeenCalledWith('session.supprimee', expect.anything(), expect.not.objectContaining({ reference: expect.anything() }));
  });

  it('une suppression refusée en base : 503 possible, pas de pierre tombale, pas d’événement', async () => {
    const ops = base({ echec: 'identity_vault' });
    expect(await supprimerSession(cle, ID)).toBe('echec_base');
    expect(ops.some(o => o.table === 'verification_requests' && o.op === 'update')).toBe(false);
    expect(emettre).not.toHaveBeenCalled();
  });
});
