const base = vi.hoisted(() => ({ courante: null as any }));
vi.mock('@/config/database.js', () => ({ supabase: { from: (t: string) => base.courante.from(t) } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/index.js', () => ({ default: { encryptionKey: 'cle-de-test-pour-le-chiffrement-32c' } }));

import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fausseBase } from './fausseBase.js';
import { _viderCache, cleCourante, clesPubliques, DUREE_CLE_MS, signerAveugle, suite, verifierPreuve } from '../cles.js';

const JOUR = 24 * 60 * 60 * 1000;

/** Ce que fait le module du site : masquer, faire signer, démasquer. */
async function preuve(defi: Uint8Array, maintenant = new Date()) {
  const [cle] = await clesPubliques(maintenant);
  const publique = await crypto.subtle.importKey('spki', Buffer.from(cle.spki, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
  const message = suite.prepare(defi);
  const { blindedMsg, inv } = await suite.blind(publique, message);
  const masquee = await signerAveugle(cle.id, blindedMsg, maintenant);
  expect(masquee).not.toBeNull();
  const signature = await suite.finalize(publique, message, masquee!, inv);
  return { cle, message, signature, blindedMsg };
}

beforeEach(() => { base.courante = fausseBase(); _viderCache(); });

describe('clés de signature aveugle', () => {
  it('crée une clé au premier besoin, puis la réutilise ; la clé privée est chiffrée', async () => {
    const a = await clesPubliques();
    const b = await clesPubliques();
    expect(a).toHaveLength(1);
    expect(b.map(c => c.id)).toEqual(a.map(c => c.id));
    const ligne = base.courante.table('v1_age_cles')[0];
    expect(ligne.pkcs8_chiffre).not.toContain('MII');
    expect(Object.keys(a[0]).sort()).toEqual(['id', 'spki', 'valide_au', 'valide_du']);
  });

  it('prépare la clé suivante quand il reste moins de sept jours', async () => {
    const t0 = new Date('2026-11-01T00:00:00Z');
    const premiere = await cleCourante(t0);
    const presqueFin = new Date(t0.getTime() + DUREE_CLE_MS - 6 * JOUR);
    const suivante = await cleCourante(presqueFin);
    expect(suivante.id).not.toBe(premiere.id);
    expect((await clesPubliques(presqueFin)).map(c => c.id).sort()).toEqual([premiere.id, suivante.id].sort());
  });

  it('signe sans voir le défi ; la preuve se vérifie en RSA-PSS ordinaire', async () => {
    const defi = crypto.randomBytes(32);
    const { cle, message, signature, blindedMsg } = await preuve(defi);
    // Le serveur n'a reçu qu'un nombre : ni le défi ni le message n'y figurent.
    expect(Buffer.from(blindedMsg).includes(defi)).toBe(false);
    expect(message).toHaveLength(64);
    expect(Buffer.from(message.slice(32)).equals(defi)).toBe(true);
    expect(await verifierPreuve(cle.id, message, signature)).toBe(true);
    // Vérification telle que le site la fait, avec le crypto de Node.
    const ok = crypto.verify('sha384', message, {
      key: crypto.createPublicKey({ key: Buffer.from(cle.spki, 'base64'), format: 'der', type: 'spki' }),
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 48,
    }, signature);
    expect(ok).toBe(true);
  });

  it('refuse un message modifié, une clé inconnue, un masque de mauvaise taille, une clé expirée', async () => {
    const { cle, message, signature } = await preuve(crypto.randomBytes(32));
    const autre = Uint8Array.from(message); autre[40] ^= 1;
    expect(await verifierPreuve(cle.id, autre, signature)).toBe(false);
    expect(await verifierPreuve('0'.repeat(64), message, signature)).toBe(false);
    expect(await signerAveugle(cle.id, new Uint8Array(255))).toBeNull();
    expect(await signerAveugle('0'.repeat(64), new Uint8Array(256))).toBeNull();
    const apres = new Date(new Date(cle.valide_au).getTime() + 1000);
    expect(await signerAveugle(cle.id, new Uint8Array(256).fill(7), apres)).toBeNull();
    // Les relevés restent acceptés 60 jours après la fin de la clé, pas au-delà.
    expect(await verifierPreuve(cle.id, message, signature, apres)).toBe(true);
    expect(await verifierPreuve(cle.id, message, signature, new Date(apres.getTime() + 61 * JOUR))).toBe(false);
  });
});
