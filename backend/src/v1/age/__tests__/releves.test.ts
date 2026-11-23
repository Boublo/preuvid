const base = vi.hoisted(() => ({ courante: null as any }));
vi.mock('@/config/database.js', () => ({ supabase: { from: (t: string) => base.courante.from(t) } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/index.js', () => ({ default: { encryptionKey: 'cle-de-test-pour-le-chiffrement-32c' } }));
vi.mock('@/middleware/auth.js', () => ({ authenticateAPIKey: vi.fn(), hashHandoffToken: (t: string) => t }));

import crypto from 'crypto';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fausseBase } from './fausseBase.js';
import { _viderCache, clesPubliques, signerAveugle, suite } from '../cles.js';
import { declarer } from '../releves.js';
import { sansProvenance } from '../router.js';

const SITE = { id: crypto.randomUUID(), developer_id: crypto.randomUUID(), is_sandbox: false };
const b64u = (o: Uint8Array) => Buffer.from(o).toString('base64url');

async function preuve() {
  const [cle] = await clesPubliques();
  const publique = await crypto.subtle.importKey('spki', Buffer.from(cle.spki, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  const message = suite.prepare(crypto.randomBytes(32));
  const { blindedMsg, inv } = await suite.blind(publique, message);
  const signature = await suite.finalize(publique, message, (await signerAveugle(cle.id, blindedMsg))!, inv);
  return { cle: cle.id, message: b64u(message), signature: b64u(signature) };
}

beforeEach(() => { base.courante = fausseBase({ v1_age_releves: 'preuve_hash' }); _viderCache(); });

describe('relevés des sites', () => {
  it('compte les preuves valides, une seule fois chacune', async () => {
    const a = await preuve();
    const b = await preuve();
    expect(await declarer(SITE, [a, b, a])).toEqual({ acceptees: 2, doublons: 1, invalides: 0 });
    expect(await declarer(SITE, [a])).toEqual({ acceptees: 0, doublons: 1, invalides: 0 });
    const lignes = base.courante.table('v1_age_releves');
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toMatchObject({ api_key_id: SITE.id, developer_id: SITE.developer_id, cle_id: a.cle });
    expect(lignes[0].mois).toMatch(/^\d{4}-\d{2}-01$/);
    // Ni message ni signature en clair : seulement leur empreinte.
    expect(JSON.stringify(lignes)).not.toContain(a.message);
    expect(JSON.stringify(lignes)).not.toContain(a.signature);
  });

  it('refuse une signature inventée ou un message modifié', async () => {
    const a = await preuve();
    const faux = { ...a, signature: b64u(crypto.randomBytes(256)) };
    const autre = Buffer.from(a.message, 'base64url'); autre[50] ^= 1;
    expect(await declarer(SITE, [faux, { ...a, message: b64u(autre) }, { ...a, message: '***' }])).toEqual({ acceptees: 0, doublons: 0, invalides: 3 });
  });
});

describe('aucune provenance', () => {
  it('Referer et Origin sont ôtés avant les routes', async () => {
    const app = express();
    let vu: Record<string, unknown> = {};
    app.use('/v1/age', sansProvenance, (req, res) => { vu = req.headers; res.end(); });
    const serveur = app.listen(0);
    const port = (serveur.address() as any).port;
    await fetch(`http://127.0.0.1:${port}/v1/age/defi`, {
      method: 'POST', headers: { referer: 'https://site-adulte.example/page', origin: 'https://site-adulte.example' },
    });
    serveur.close();
    expect(vu.referer).toBeUndefined();
    expect(vu.origin).toBeUndefined();
    expect(JSON.stringify(vu)).not.toContain('site-adulte');
  });
});
