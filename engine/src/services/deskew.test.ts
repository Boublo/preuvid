import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { deskewDocument, orderCorners } from './deskew.js';

// Carte synthétique : fond clair, quelques bandes sombres en guise de texte. Aucune donnée réelle.
async function carte(width = 856, height = 540): Promise<Buffer> {
  const bandes = Array.from({ length: 6 }, (_, i) => ({
    input: { create: { width: 360 + 40 * i, height: 18, channels: 3 as const, background: { r: 20, g: 20, b: 20 } } },
    top: 60 + 70 * i,
    left: 40,
  }));
  return sharp({ create: { width, height, channels: 3, background: { r: 235, g: 240, b: 248 } } })
    .composite(bandes)
    .png()
    .toBuffer();
}

/** Pose la carte sur un fond sombre, tournée de `angle` degrés. */
async function photo(angle: number): Promise<Buffer> {
  const c = await sharp(await carte()).rotate(angle, { background: { r: 60, g: 75, b: 95 } }).toBuffer();
  return sharp({ create: { width: 1300, height: 1000, channels: 3, background: { r: 60, g: 75, b: 95 } } })
    .composite([{ input: c, gravity: 'center' }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe('orderCorners', () => {
  it('range haut-gauche, haut-droit, bas-droit, bas-gauche', () => {
    const q = orderCorners([{ x: 10, y: 90 }, { x: 100, y: 0 }, { x: 0, y: 0 }, { x: 110, y: 95 }]);
    expect(q).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 110, y: 95 }, { x: 10, y: 90 }]);
  });
});

describe('deskewDocument', () => {
  it('redresse une carte tournée de 7°', async () => {
    const r = await deskewDocument(await photo(7));
    expect(r.applied).toBe(true);
    expect(Math.abs(Math.abs(r.angle) - 7)).toBeLessThan(1);
    const m = await sharp(r.buffer).metadata();
    // Les proportions de la carte (856 × 540) sont retrouvées à quelques pixels près.
    expect(Math.abs(m.width! / m.height! - 856 / 540)).toBeLessThan(0.05);
  });

  it("rend l'image d'origine, au bit près, quand la carte remplit le cadre", async () => {
    const img = await sharp(await carte()).jpeg().toBuffer();
    const r = await deskewDocument(img);
    expect(r.applied).toBe(false);
    expect(r.buffer).toBe(img);
  });

  it("ne touche pas une carte droite posée sur un fond", async () => {
    const img = await photo(0);
    const r = await deskewDocument(img);
    expect(r.applied).toBe(false);
    expect(r.buffer).toBe(img);
  });

  it("rend l'image d'origine si elle est illisible", async () => {
    const pasUneImage = Buffer.from('pas une image');
    const r = await deskewDocument(pasUneImage);
    expect(r.applied).toBe(false);
    expect(r.buffer).toBe(pasUneImage);
  });
});
