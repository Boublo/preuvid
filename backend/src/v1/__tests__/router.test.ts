vi.mock('@/config/database.js', () => ({ supabase: { from: vi.fn() } }));
vi.mock('@/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, logError: vi.fn() }));
vi.mock('@/config/index.js', () => ({ default: { nodeEnv: 'production', webhooks: { timeoutMs: 5000 } } }));
vi.mock('@/middleware/auth.js', () => ({ authenticateAPIKey: vi.fn(), hashHandoffToken: (t: string) => t }));
vi.mock('@/services/webhook.js', () => ({ decryptWebhookSecret: (s: string) => s, WebhookService: class {} }));
vi.mock('@/services/verification.js', () => ({ VerificationService: class {} }));
vi.mock('@/services/storage.js', () => ({ StorageService: class {} }));
vi.mock('@/services/sessionPersistence.js', () => ({ saveSessionState: vi.fn(), loadSessionState: vi.fn() }));
vi.mock('@/verification/session/VerificationSession.js', () => ({ VerificationSession: class {} }));

import { describe, expect, it, vi } from 'vitest';
import { CreationSchema, retourValide, routerV1 } from '../router.js';
import { openapiV1 } from '../openapi.js';
import { routerAge } from '../age/router.js';

describe('CreationSchema', () => {
  it('accepte les deux parcours et refuse les champs inconnus', () => {
    expect(CreationSchema.safeParse({ parcours: 'identite', reference: 'client-42', retour: 'https://site.fr/fin' }).success).toBe(true);
    expect(CreationSchema.safeParse({ parcours: 'age' }).success).toBe(true);
    expect(CreationSchema.safeParse({ parcours: 'passeport' }).success).toBe(false);
    expect(CreationSchema.safeParse({ parcours: 'age', user_id: 'x' }).success).toBe(false);
  });

  it('URL de retour : https seulement en production, sans identifiants', () => {
    expect(retourValide('https://site.fr/fin?x=1')).toBe(true);
    expect(retourValide('http://localhost:3000/fin')).toBe(false);
    expect(retourValide('javascript:alert(1)')).toBe(false);
    expect(retourValide('https://moi:secret@site.fr/')).toBe(false);
    expect(retourValide('pas une url')).toBe(false);
  });
});

describe('openapi', () => {
  /** Routes montées : « get /sessions/{id} ». */
  const montees = (routerV1 as any).stack
    .filter((l: any) => l.route)
    .flatMap((l: any) => Object.keys(l.route.methods).map(m => `${m} ${l.route.path.replace(/:(\w+)/g, '{$1}')}`))
    .sort();
  const decrites = Object.entries(openapiV1.paths)
    .flatMap(([p, ops]) => Object.keys(ops).map(m => `${m} ${p}`))
    .sort();

  it('décrit exactement les routes montées', () => {
    expect(montees.length).toBeGreaterThan(5);
    expect(decrites.filter(r => !r.includes(' /age/'))).toEqual(montees);
  });

  it('décrit les routes du passe majeur destinées aux sites, et elles existent', () => {
    const age = (routerAge as any).stack
      .filter((l: any) => l.route)
      .flatMap((l: any) => Object.keys(l.route.methods).map(m => `${m} /age${l.route.path}`));
    const pourSites = decrites.filter(r => r.includes(' /age/'));
    expect(pourSites).toEqual(['get /age/cles', 'post /age/releves']);
    for (const r of pourSites) expect(age).toContain(r);
  });
});
