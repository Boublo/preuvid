const m = vi.hoisted(() => ({
  base: null as any,
  decision: { statut: 'validee', majeur: true } as any,
  etat: null as any,
  supprimerSession: vi.fn(async () => 'supprimee'),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  signerAveugle: vi.fn(async () => new Uint8Array(256).fill(9)),
}));
vi.mock('@/config/database.js', () => ({ supabase: { from: (t: string) => m.base.from(t) } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/middleware/auth.js', () => ({ hashHandoffToken: (t: string) => `h:${t}` }));
vi.mock('../../sessions.js', () => ({
  creerSession: vi.fn(async (cle: any) => {
    const id = crypto.randomUUID();
    const jeton = 'a'.repeat(64);
    m.base.table('verification_requests').push({
      id, api_key_id: cle.id, session_token_hash: `h:${jeton}`,
      session_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    return { session: id, lien: `http://x/user-verification?session=${jeton}`, expire_le: 'demain' };
  }),
  lireDecision: vi.fn(async () => m.decision),
  supprimerSession: m.supprimerSession,
}));
vi.mock('@/services/sessionPersistence.js', () => ({ loadSessionState: vi.fn(async () => m.etat) }));
vi.mock('../cles.js', () => ({ signerAveugle: m.signerAveugle }));
vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: vi.fn(async (o: any) => ({ challenge: crypto.randomBytes(32).toString('base64url'), rp: { id: o.rpID }, user: { name: o.userName } })),
  generateAuthenticationOptions: vi.fn(async () => ({ challenge: crypto.randomBytes(32).toString('base64url') })),
  verifyRegistrationResponse: m.verifyRegistrationResponse,
  verifyAuthenticationResponse: m.verifyAuthenticationResponse,
}));

import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fausseBase } from './fausseBase.js';
import {
  creerPasse, etatVerification, LIMITE_PREUVES_HEURE, optionsCreation, optionsUsage, ouvrirVerification,
  preuveAvecPasse, preuveUnique, purgerAge,
} from '../passe.js';

const MASQUE = new Uint8Array(256).fill(1);
const CLE = 'c'.repeat(64);
const client = (challenge: string) => Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge })).toString('base64url');

beforeEach(() => {
  m.base = fausseBase({
    v1_age_verifications_utilisees: 'verification_id', v1_age_defis: 'defi', v1_age_passes: 'credential_id',
    developers: 'email',
  });
  m.decision = { statut: 'validee', majeur: true };
  m.etat = null;
  vi.clearAllMocks();
  m.verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'] },
      credentialDeviceType: 'multiDevice', credentialBackedUp: true,
    },
  });
  m.verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { newCounter: 0, credentialBackedUp: true } });
});

async function verification() {
  const v = await ouvrirVerification('http://x');
  return { id: v.verification, jeton: v.jeton };
}

async function passe() {
  const v = await verification();
  const o = await optionsCreation(v.id, v.jeton) as any;
  const r = await creerPasse(v.id, v.jeton, { id: 'cred-1', response: { clientDataJSON: client(o.valeur.challenge) } } as any, CLE, MASQUE);
  expect(r.ok).toBe(true);
  return v;
}

describe('première vérification', () => {
  it('le compte interne est créé une fois ; sa clé d’API ne sert à rien d’autre', async () => {
    await verification();
    await verification();
    expect(m.base.table('developers')).toHaveLength(1);
    const cles = m.base.table('api_keys');
    expect(cles).toHaveLength(1);
    expect(cles[0]).toMatchObject({ name: 'passe majeur', is_sandbox: false });
  });

  it('jeton faux ou expiré : introuvable ; mineur : non validée', async () => {
    const v = await verification();
    expect(await etatVerification(v.id, 'b'.repeat(64))).toEqual({ ok: false, echec: 'verification_introuvable' });
    m.decision = { statut: 'validee', majeur: false };
    expect(await preuveUnique(v.id, v.jeton, CLE, MASQUE)).toEqual({ ok: false, echec: 'verification_non_validee' });
    m.base.table('verification_requests')[0].session_token_expires_at = new Date(Date.now() - 1).toISOString();
    expect(await etatVerification(v.id, v.jeton)).toEqual({ ok: false, echec: 'verification_introuvable' });
  });

  it('état : statut, majorité et étape attendue seulement', async () => {
    m.decision = { session: 'x', parcours: 'age', statut: 'en_cours', majeur: null };
    const v = await verification();
    expect(await etatVerification(v.id, v.jeton)).toEqual({ ok: true, valeur: { statut: 'en_cours', majeur: null, etape: null } });
    m.etat = { current_step: 'AWAITING_LIVE', front_extraction: { ocr: { full_name: 'JEAN TESTEUR' } } };
    expect(await etatVerification(v.id, v.jeton)).toEqual({ ok: true, valeur: { statut: 'en_cours', majeur: null, etape: 'visage' } });
    m.decision = { statut: 'validee', majeur: true };
    expect(await etatVerification(v.id, v.jeton)).toEqual({ ok: true, valeur: { statut: 'validee', majeur: true, etape: null } });
  });

  it('la vérification du passe exige le visage, sans criblage AML', async () => {
    const v = await verification();
    const ligne = m.base.table('verification_requests').find((l: any) => l.id === v.id);
    expect(ligne.addons).toEqual({ preuvid_passe_visage: true, aml_screening: false });
  });
});

describe('preuve unique (« Non merci »)', () => {
  it('signe une fois, supprime la vérification, refuse un second usage', async () => {
    const v = await verification();
    const r = await preuveUnique(v.id, v.jeton, CLE, MASQUE);
    expect(r).toEqual({ ok: true, valeur: Buffer.from(new Uint8Array(256).fill(9)).toString('base64url') });
    expect(m.signerAveugle).toHaveBeenCalledWith(CLE, MASQUE);
    expect(m.supprimerSession).toHaveBeenCalledWith(expect.anything(), v.id);
    expect(await preuveUnique(v.id, v.jeton, CLE, MASQUE)).toEqual({ ok: false, echec: 'verification_deja_utilisee' });
    expect(m.signerAveugle).toHaveBeenCalledTimes(1);
  });
});

describe('création du passe', () => {
  it('garde la clé d’accès sans lien vers la vérification, puis supprime la vérification', async () => {
    const v = await passe();
    const [p] = m.base.table('v1_age_passes');
    expect(Object.keys(p).sort()).toEqual([
      'compteur', 'credential_id', 'fenetre_debut', 'fenetre_n', 'id', 'public_key', 'sauvegarde_possible', 'sauvegardee', 'transports',
    ]);
    expect(JSON.stringify(p)).not.toContain(v.id);
    expect(p).toMatchObject({ sauvegarde_possible: true, sauvegardee: true });
    expect(m.supprimerSession).toHaveBeenCalledWith(expect.anything(), v.id);
    expect(m.base.table('v1_age_defis')).toHaveLength(0);
    // Exige le déverrouillage et le bon domaine.
    expect(m.verifyRegistrationResponse.mock.calls[0][0]).toMatchObject({ requireUserVerification: true, expectedRPID: 'localhost' });
  });

  it('défi rejoué, défi d’une autre vérification ou clé refusée : rien n’est créé ni consommé', async () => {
    const v = await verification();
    const o = await optionsCreation(v.id, v.jeton) as any;
    m.verifyRegistrationResponse.mockRejectedValueOnce(new Error('signature fausse'));
    const att = { id: 'cred-1', response: { clientDataJSON: client(o.valeur.challenge) } } as any;
    expect(await creerPasse(v.id, v.jeton, att, CLE, MASQUE)).toEqual({ ok: false, echec: 'cle_acces_refusee' });
    expect(await creerPasse(v.id, v.jeton, att, CLE, MASQUE)).toEqual({ ok: false, echec: 'defi_invalide' });

    const w = await verification();
    const o2 = await optionsCreation(w.id, w.jeton) as any;
    const att2 = { id: 'cred-1', response: { clientDataJSON: client(o2.valeur.challenge) } } as any;
    expect(await creerPasse(v.id, v.jeton, att2, CLE, MASQUE)).toEqual({ ok: false, echec: 'defi_invalide' });

    expect(m.base.table('v1_age_passes')).toHaveLength(0);
    expect(m.base.table('v1_age_verifications_utilisees')).toHaveLength(0);
    expect(m.signerAveugle).not.toHaveBeenCalled();
  });
});

describe('visites avec le passe', () => {
  const assertion = async (id = 'cred-1') => {
    const o = await optionsUsage();
    return { id, response: { clientDataJSON: client(o.challenge) } } as any;
  };

  it('signe à chaque visite, avec un défi neuf', async () => {
    await passe();
    m.signerAveugle.mockClear();
    expect((await preuveAvecPasse(await assertion(), CLE, MASQUE)).ok).toBe(true);
    expect(m.signerAveugle).toHaveBeenCalledTimes(1);
    expect(m.verifyAuthenticationResponse.mock.calls[0][0]).toMatchObject({ requireUserVerification: true });
  });

  it(`au plus ${LIMITE_PREUVES_HEURE} preuves par heure et par passe`, async () => {
    await passe();
    for (let i = 1; i < LIMITE_PREUVES_HEURE; i++) expect((await preuveAvecPasse(await assertion(), CLE, MASQUE)).ok).toBe(true);
    expect(await preuveAvecPasse(await assertion(), CLE, MASQUE)).toEqual({ ok: false, echec: 'limite_passe' });
    // Une heure plus tard, la fenêtre repart.
    m.base.table('v1_age_passes')[0].fenetre_debut = new Date(Date.now() - 3600_001).toISOString();
    expect((await preuveAvecPasse(await assertion(), CLE, MASQUE)).ok).toBe(true);
    expect(m.base.table('v1_age_passes')[0].fenetre_n).toBe(1);
  });

  it('refuse un passe inconnu, un compteur qui recule, un défi de création', async () => {
    const v = await passe();
    expect(await preuveAvecPasse(await assertion('inconnu'), CLE, MASQUE)).toEqual({ ok: false, echec: 'passe_introuvable' });
    m.verifyAuthenticationResponse.mockRejectedValueOnce(new Error('counter'));
    expect(await preuveAvecPasse(await assertion(), CLE, MASQUE)).toEqual({ ok: false, echec: 'cle_acces_refusee' });
    void v;
    const w = await verification();
    const o = await optionsCreation(w.id, w.jeton) as any;
    const mauvais = { id: 'cred-1', response: { clientDataJSON: client(o.valeur.challenge) } } as any;
    expect(await preuveAvecPasse(mauvais, CLE, MASQUE)).toEqual({ ok: false, echec: 'defi_invalide' });
    expect(await preuveAvecPasse({ id: 'cred-1', response: { clientDataJSON: 'pas du json' } } as any, CLE, MASQUE))
      .toEqual({ ok: false, echec: 'defi_invalide' });
  });
});

describe('purge', () => {
  it('supprime les vérifications abandonnées et les défis expirés, pas le reste', async () => {
    const vieille = await verification();
    const recente = await verification();
    m.base.table('verification_requests').find((l: any) => l.id === vieille.id).session_token_expires_at = new Date(Date.now() - 1).toISOString();
    await optionsUsage();
    m.base.table('v1_age_defis')[0].expire_le = new Date(Date.now() - 1).toISOString();
    await optionsUsage();
    expect(await purgerAge()).toBe(1);
    expect(m.supprimerSession).toHaveBeenCalledTimes(1);
    expect(m.supprimerSession).toHaveBeenCalledWith(expect.anything(), vieille.id);
    expect(m.base.table('v1_age_defis')).toHaveLength(1);
    void recente;
  });
});
