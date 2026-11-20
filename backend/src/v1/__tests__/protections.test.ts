vi.mock('@/config/database.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '@/config/database.js';
import { Compteur, idempotence } from '../protections.js';

describe('Compteur', () => {
  it('bloque au-delà du maximum dans la minute, puis repart', () => {
    const c = new Compteur(3);
    const t = 1_000_000;
    expect([1, 2, 3, 4].map(() => c.prendre('k', t).restant)).toEqual([2, 1, 0, -1]);
    expect(c.prendre('autre', t).restant).toBe(2);
    expect(c.prendre('k', t + 60_000).restant).toBe(2);
  });
});

/** Table v1_idempotency simulée, avec la contrainte de clé primaire. */
function tableIdempotence() {
  const lignes = new Map<string, any>();
  const k = (a: string, b: string) => `${a}|${b}`;
  (supabase.from as any).mockImplementation(() => {
    let filtres: Record<string, string> = {};
    let op: string | null = null;
    let donnees: any = null;
    const q: any = {
      insert: (d: any) => {
        const cle = k(d.api_key_id, d.key);
        if (lignes.has(cle)) return Promise.resolve({ error: { code: '23505', message: 'duplicate' } });
        lignes.set(cle, { ...d, response_status: null, response_body: null, created_at: new Date().toISOString() });
        return Promise.resolve({ error: null });
      },
      select: () => { op = 'select'; return q; },
      update: (d: any) => { op = 'update'; donnees = d; return q; },
      delete: () => { op = 'delete'; return q; },
      eq: (c: string, v: string) => {
        filtres[c] = v;
        if ((op === 'update' || op === 'delete') && filtres.api_key_id && filtres.key) {
          const cle = k(filtres.api_key_id, filtres.key);
          if (op === 'update') lignes.set(cle, { ...lignes.get(cle), ...donnees });
          else lignes.delete(cle);
          return Promise.resolve({ error: null });
        }
        return q;
      },
      single: async () => ({ data: lignes.get(k(filtres.api_key_id, filtres.key)) ?? null }),
    };
    return q;
  });
  return lignes;
}

function appel(corps: unknown, cle = 'idem-1') {
  const req: any = { body: corps, apiKey: { id: 'key-1' }, header: (h: string) => (h === 'Idempotency-Key' ? cle : undefined) };
  const res: any = {
    statusCode: 200, corps: undefined, entetes: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.corps = b; return this; },
    setHeader(k: string, v: string) { this.entetes[k] = v; },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe('idempotence', () => {
  let lignes: Map<string, any>;
  beforeEach(() => { lignes = tableIdempotence(); });

  it('réserve la clé, enregistre la réponse, puis la rejoue', async () => {
    const a = appel({ parcours: 'age' });
    await idempotence(a.req, a.res, a.next);
    expect(a.next).toHaveBeenCalled();
    a.res.status(201).json({ session: 's1' });
    await new Promise(r => setTimeout(r, 0));
    expect(lignes.get('key-1|idem-1')).toMatchObject({ response_status: 201 });

    const b = appel({ parcours: 'age' });
    await idempotence(b.req, b.res, b.next);
    expect(b.next).not.toHaveBeenCalled();
    expect(b.res.statusCode).toBe(201);
    expect(b.res.corps).toEqual({ session: 's1' });
    expect(b.res.entetes['Idempotent-Replayed']).toBe('true');
  });

  it('409 pendant le traitement, 422 pour un autre corps', async () => {
    const a = appel({ parcours: 'age' });
    await idempotence(a.req, a.res, a.next);

    const b = appel({ parcours: 'age' });
    await idempotence(b.req, b.res, b.next);
    expect(b.res.statusCode).toBe(409);

    const c = appel({ parcours: 'identite' });
    await idempotence(c.req, c.res, c.next);
    expect(c.res.statusCode).toBe(422);
  });

  it('une réponse d’erreur libère la clé', async () => {
    const a = appel({ parcours: 'x' });
    await idempotence(a.req, a.res, a.next);
    a.res.status(400).json({ erreur: {} });
    await new Promise(r => setTimeout(r, 0));
    expect(lignes.has('key-1|idem-1')).toBe(false);
  });
});
