import { describe, expect, it, vi } from 'vitest';
import { attendreDecision, lienTelephone, lireLien } from './suivi';

const V = { verification: '5cf0e7e1-773e-4433-82ac-d94296dcb346', jeton: 'a'.repeat(64) };
const sansAttente = { attendre: async () => {} };

describe('lien du QR code', () => {
  it('met la vérification après le #, jamais envoyé au serveur, et rien sur le site', () => {
    const lien = lienTelephone('https://verif.example', V);
    expect(lien).toBe(`https://verif.example/age/telephone#${V.verification}.${V.jeton}`);
    expect(new URL(lien).search).toBe('');
    expect(lireLien(new URL(lien).hash)).toEqual(V);
  });

  it('refuse un lien abîmé ou complété', () => {
    expect(lireLien('')).toBeNull();
    expect(lireLien(`#${V.verification}`)).toBeNull();
    expect(lireLien(`#${V.verification}.${'a'.repeat(63)}`)).toBeNull();
    expect(lireLien(`#${V.verification}.${V.jeton}.site-adulte.example`)).toBeNull();
    expect(lireLien(`#pas-un-uuid.${V.jeton}`)).toBeNull();
  });
});

describe('attente de la décision', () => {
  it('suit les états jusqu’à « majeur »', async () => {
    const etats = [{ statut: 'en_attente', majeur: null }, { statut: 'en_cours', majeur: null }, { statut: 'validee', majeur: true }];
    const vus: string[] = [];
    const issue = await attendreDecision(async () => etats.shift()!, { ...sansAttente, surEtat: e => vus.push(e.statut) });
    expect(issue).toBe('majeur');
    expect(vus).toEqual(['en_attente', 'en_cours', 'validee']);
  });

  it('pièce lue, majeur au recto : il reste le visage, jamais « majeur » avant', async () => {
    const etats = [{ statut: 'en_cours', majeur: null, etape: null }, { statut: 'en_cours', majeur: null, etape: 'visage' as const }];
    expect(await attendreDecision(async () => etats.shift()!, sansAttente)).toBe('visage');
  });

  it('validée mais mineur, ou refusée : refus', async () => {
    expect(await attendreDecision(async () => ({ statut: 'validee', majeur: false }), sansAttente)).toBe('refus');
    expect(await attendreDecision(async () => ({ statut: 'a_revoir', majeur: null }), sansAttente)).toBe('refus');
  });

  it('vérification disparue : introuvable ; panne passagère : on continue', async () => {
    const lire = vi.fn()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockRejectedValueOnce(Object.assign(new Error('404'), { code: 'verification_introuvable' }));
    expect(await attendreDecision(lire, sansAttente)).toBe('introuvable');
    expect(lire).toHaveBeenCalledTimes(2);
  });

  it('s’arrête quand on quitte l’écran, et au bout du délai', async () => {
    let n = 0;
    expect(await attendreDecision(async () => ({ statut: 'en_attente', majeur: null }), { ...sansAttente, arrete: () => ++n > 2 })).toBe('arrete');
    expect(await attendreDecision(async () => ({ statut: 'en_attente', majeur: null }), { ...sansAttente, intervalleMs: 10, limiteMs: 30 })).toBe('delai');
  });
});
