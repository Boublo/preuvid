vi.mock('@/config/database.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/config/index.js', () => ({ default: { nodeEnv: 'test', webhooks: { timeoutMs: 5000 }, encryptionKey: 'k' } }));
vi.mock('@/services/webhook.js', () => ({
  decryptWebhookSecret: (s: string) => s,
  WebhookService: class { getActiveWebhooksForDeveloper = vi.fn(); },
}));
vi.mock('@/utils/validateUrl.js', () => ({
  validateWebhookUrl: vi.fn(async () => undefined),
  getSafeHttpAgent: () => undefined,
  getSafeHttpsAgent: () => undefined,
}));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { supabase } from '@/config/database.js';
import { livrer, prochaineTentative, signer, verifierSignature } from '../webhooks.js';

describe('signature', () => {
  const corps = JSON.stringify({ evenement: 'session.terminee', session: 's1' });
  const ts = 1_800_000_000;

  it('se vérifie avec le même secret, le même corps et un horodatage récent', () => {
    expect(verifierSignature('secret', ts, corps, signer('secret', ts, corps), ts + 10)).toBe(true);
  });

  it('refuse un corps modifié, un autre secret, un horodatage de plus de cinq minutes', () => {
    const sig = signer('secret', ts, corps);
    expect(verifierSignature('secret', ts, corps + ' ', sig, ts)).toBe(false);
    expect(verifierSignature('autre', ts, corps, sig, ts)).toBe(false);
    expect(verifierSignature('secret', ts, corps, sig, ts + 301)).toBe(false);
    expect(verifierSignature('secret', ts + 1, corps, sig, ts)).toBe(false);
  });
});

describe('prochaineTentative', () => {
  it('reprend après 1 min, 5 min, 30 min, 2 h, puis abandonne', () => {
    const t0 = new Date('2026-11-20T10:00:00Z');
    const minutes = [1, 2, 3, 4].map(n => (prochaineTentative(n, t0)!.getTime() - t0.getTime()) / 60_000);
    expect(minutes).toEqual([1, 5, 30, 120]);
    expect(prochaineTentative(5, t0)).toBeNull();
  });
});

describe('livrer', () => {
  let maj: any[];
  beforeEach(() => {
    maj = [];
    (supabase.from as any).mockImplementation((table: string) => {
      const q: any = {
        select: () => q, eq: () => q,
        single: async () => ({ data: { id: 'w1', url: 'https://client.test/hook', secret_key: 'secret', is_active: true } }),
        update: (d: any) => { maj.push({ table, ...d }); return { eq: async () => ({}) }; },
      };
      return q;
    });
  });

  const ev = (attempts = 0) => ({
    id: 'evt-1', webhook_id: 'w1', type: 'session.terminee', attempts,
    payload: { evenement: 'session.terminee' as const, session: 's1', parcours: 'identite' as const, statut: 'validee', date: 'd' },
  });

  it('signe horodatage.corps, envoie l’identifiant d’événement, et marque livré sur 2xx', async () => {
    (axios.post as any).mockResolvedValue({ status: 204 });
    expect(await livrer(ev())).toBe(true);
    const [, corps, opts] = (axios.post as any).mock.calls.at(-1);
    const h = opts.headers;
    expect(h['X-Preuvid-Event-Id']).toBe('evt-1');
    expect(verifierSignature('secret', h['X-Preuvid-Timestamp'], corps, h['X-Preuvid-Signature'])).toBe(true);
    expect(maj.at(-1)).toMatchObject({ status: 'delivered', attempts: 1, last_response_status: 204 });
  });

  it('une réponse 4xx n’est pas une livraison : reprise programmée', async () => {
    (axios.post as any).mockResolvedValue({ status: 400 });
    expect(await livrer(ev())).toBe(false);
    expect(maj.at(-1)).toMatchObject({ status: 'pending', attempts: 1, last_response_status: 400 });
  });

  it('échec définitif après la dernière reprise', async () => {
    (axios.post as any).mockRejectedValue(new Error('ECONNREFUSED'));
    await livrer(ev(4));
    expect(maj.at(-1)).toMatchObject({ status: 'failed', attempts: 5, last_error: 'ECONNREFUSED' });
  });
});

describe('hoteInterneAutorise', () => {
  it('vide par défaut, nom exact seulement', async () => {
    const { hoteInterneAutorise } = await import('../webhooks.js');
    expect(hoteInterneAutorise('http://site-test:8080/hook', '')).toBe(false);
    expect(hoteInterneAutorise('http://site-test:8080/hook', 'site-test')).toBe(true);
    expect(hoteInterneAutorise('http://site-test.evil.fr/hook', 'site-test')).toBe(false);
    expect(hoteInterneAutorise('http://localhost/hook', 'site-test, autre')).toBe(false);
  });
});
