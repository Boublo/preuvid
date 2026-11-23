import { describe, expect, it, vi } from 'vitest';
import { attendreDemande, refuser, repondre } from './protocole';

const MASQUE = 'A'.repeat(342);
const CLE = 'f'.repeat(64);

function fenetre(avecSite = true) {
  const ecouteurs = new Set<(e: MessageEvent) => void>();
  const site = { postMessage: vi.fn() };
  return {
    site,
    ecouteurs,
    f: {
      opener: avecSite ? site : null,
      addEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => { ecouteurs.add(fn); },
      removeEventListener: (_t: 'message', fn: (e: MessageEvent) => void) => { ecouteurs.delete(fn); },
    },
    recevoir(data: unknown, source: unknown, origin = 'https://site.example') {
      for (const fn of [...ecouteurs]) fn({ data, source, origin } as MessageEvent);
    },
  };
}

describe('dialogue avec le site', () => {
  it('sans onglet d’origine : rien n’est envoyé', () => {
    const w = fenetre(false);
    expect(attendreDemande(w.f, vi.fn())).toBeNull();
  });

  it('annonce « pret » sans rien dire, ne retient que la demande du site qui a ouvert la page', () => {
    const w = fenetre();
    const rappel = vi.fn();
    attendreDemande(w.f, rappel);
    expect(w.site.postMessage).toHaveBeenCalledWith({ type: 'preuvid:pret' }, '*');

    w.recevoir({ type: 'preuvid:demande', cle: CLE, masque: MASQUE }, { autre: true });
    w.recevoir({ type: 'preuvid:demande', cle: 'pas-une-cle', masque: MASQUE }, w.site);
    w.recevoir({ type: 'preuvid:demande', cle: CLE, masque: 'court' }, w.site);
    expect(rappel).not.toHaveBeenCalled();

    w.recevoir({ type: 'preuvid:demande', cle: CLE, masque: MASQUE }, w.site);
    expect(rappel).toHaveBeenCalledWith({ cle: CLE, masque: MASQUE, origine: 'https://site.example' });
    expect(w.ecouteurs.size).toBe(0);
  });

  it('répond au seul site demandeur', () => {
    const w = fenetre();
    const d = { cle: CLE, masque: MASQUE, origine: 'https://site.example' };
    repondre(w.f, d, 'sig');
    refuser(w.f, d, 'majorite_non_prouvee');
    expect(w.site.postMessage).toHaveBeenNthCalledWith(1, { type: 'preuvid:reponse', signature_masquee: 'sig' }, 'https://site.example');
    expect(w.site.postMessage).toHaveBeenNthCalledWith(2, { type: 'preuvid:refus', code: 'majorite_non_prouvee' }, 'https://site.example');
  });
});
