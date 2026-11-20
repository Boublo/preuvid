import { describe, expect, it } from 'vitest';
import type { Etat } from './api';
import { adresseRetour, duree, ecranDe, lireJeton, numeroEtape, PIECES, titrePhoto } from './ecrans';

const etat = (e: Partial<Etat>): Etat => ({
  session: 's', site: null, retour: null, statut: 'en_attente', etape: 'recto', essais_restants: 3, photo_ratee: false, lecture: null,
  motif: null, duree_s: null, photos: 'gardees', expire_le: null, ...e,
});

describe('écran à montrer', () => {
  it('suit l’étape demandée par le serveur', () => {
    expect(ecranDe(etat({}))).toBe('choix');
    expect(ecranDe(etat({ statut: 'en_cours', etape: 'verso' }))).toBe('photo');
    expect(ecranDe(etat({ statut: 'en_cours', etape: 'traitement' }))).toBe('lecture');
    expect(ecranDe(etat({ statut: 'en_cours', etape: 'visage' }))).toBe('visage');
  });

  it('une fois tranché, montre l’issue', () => {
    expect(ecranDe(etat({ statut: 'validee', etape: null }))).toBe('validee');
    expect(ecranDe(etat({ statut: 'refusee', etape: null }))).toBe('refusee');
    expect(ecranDe(etat({ statut: 'a_revoir', etape: null }))).toBe('a_revoir');
    expect(ecranDe(etat({ statut: 'abandonnee', etape: null }))).toBe('expiree');
    expect(ecranDe(null)).toBe('introuvable');
  });

  it('étape 1 la pièce, 2 le visage', () => {
    expect(numeroEtape('photo')).toBe(1);
    expect(numeroEtape('lecture')).toBe(1);
    expect(numeroEtape('visage')).toBe(2);
    expect(numeroEtape('validee')).toBe(0);
  });
});

describe('textes', () => {
  it('durée comme sur la maquette', () => {
    expect(duree(92)).toBe('1 min 32');
    expect(duree(125)).toBe('2 min 05');
    expect(duree(40)).toBe('40 s');
    expect(duree(null)).toBe('');
  });

  it('titre de la photo selon la pièce et le côté', () => {
    const [cni, passeport] = PIECES;
    expect(titrePhoto('recto', cni)).toBe('Le recto, à plat dans le cadre');
    expect(titrePhoto('verso', cni)).toBe('Le verso, à plat dans le cadre');
    expect(titrePhoto('recto', passeport)).toBe('La page photo, à plat dans le cadre');
  });

  it('retour vers le site : http(s) seulement', () => {
    expect(adresseRetour('https://site.example/retour?x=1')).toBe('https://site.example/retour?x=1');
    expect(adresseRetour('javascript:alert(1)')).toBeNull();
    expect(adresseRetour('pas une adresse')).toBeNull();
    expect(adresseRetour(null)).toBeNull();
  });
});

describe('jeton de session', () => {
  const memoire = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

  it('lu après le #, puis retrouvé après rechargement de l’onglet', () => {
    const onglet = memoire();
    const j = 'ab'.repeat(32);
    expect(lireJeton(`#${j}`, onglet)).toBe(j);
    expect(lireJeton('', onglet)).toBe(j);
  });

  it('refuse un fragment qui n’est pas un jeton, sans reprendre l’ancien', () => {
    const onglet = memoire();
    lireJeton(`#${'c'.repeat(64)}`, onglet);
    expect(lireJeton('#autre-chose', onglet)).toBeNull();
    expect(lireJeton('', null)).toBeNull();
  });
});
