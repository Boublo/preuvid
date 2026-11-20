import { describe, expect, it } from 'vitest';
import { gris, juger, mesurer, recadrage, Stabilite } from './qualite';

const L = 60, H = 40;
const image = (f: (x: number, y: number) => number) => {
  const g = new Float32Array(L * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < L; x++) g[y * L + x] = f(x, y);
  return g;
};

describe('prise automatique : netteté et lumière', () => {
  it('un damier net et clair est net et éclairé, mais ce n’est pas une pièce', () => {
    const net = mesurer(image((x, y) => ((x >> 1) + (y >> 1)) % 2 ? 250 : 120), L, H);
    expect(juger(net)).toEqual({ net: true, eclaire: true, piece: false, bonne: false });
    const lisse = mesurer(image(() => 220), L, H);
    expect(lisse.nettete).toBe(0);
    expect(juger(lisse).bonne).toBe(false);
  });

  it('un dégradé doux (flou) ne suffit pas', () => {
    expect(juger(mesurer(image(x => 150 + x), L, H)).net).toBe(false);
  });

  it('une image nette mais sombre est refusée pour la lumière seulement', () => {
    const j = juger(mesurer(image((x, y) => (x + y) % 2 ? 110 : 20), L, H));
    expect(j.net).toBe(true);
    expect(j.eclaire).toBe(false);
    expect(j.bonne).toBe(false);
  });

  it('une pièce claire, cadrée avec une marge sur un fond sombre, est reconnue', () => {
    // Carte de 52 × 32 au centre d'un cadre de 60 × 40, lignes de « texte » à l'intérieur.
    const carte = image((x, y) => {
      const dedans = x >= 4 && x < 56 && y >= 4 && y < 36;
      if (!dedans) return 60;
      return y % 6 === 0 && x % 3 !== 0 ? 40 : 235;
    });
    const m = mesurer(carte, L, H);
    expect(m.cotes).toBe(4);
    expect(juger(m)).toEqual({ net: true, eclaire: true, piece: true, bonne: true });
  });

  it('une texture nette sans pièce (bruit) n’a aucun bord', () => {
    let graine = 7;
    const hasard = () => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine / 2147483648; };
    expect(mesurer(image(() => 90 + 160 * hasard()), L, H).cotes).toBe(0);
  });

  it('niveaux de gris depuis RGBA', () => {
    const g = gris(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), 3, 1);
    expect(Array.from(g).map(Math.round)).toEqual([255, 0, 76]);
  });
});

describe('cadre et stabilité', () => {
  it('garde la partie visible dans un cadre au format carte', () => {
    expect(recadrage(1920, 1080, 1.586)).toEqual({ x: 104, y: 0, largeur: 1713, hauteur: 1080 });
    expect(recadrage(1080, 1920, 1.586)).toEqual({ x: 0, y: 620, largeur: 1080, hauteur: 681 });
  });

  it('plusieurs bonnes images de suite, remises à zéro par une mauvaise', () => {
    const s = new Stabilite(3);
    expect([true, true, false, true, true].map(b => s.ajouter(b))).toEqual([false, false, false, false, false]);
    expect(s.ajouter(true)).toBe(true);
  });
});
