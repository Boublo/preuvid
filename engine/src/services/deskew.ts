/**
 * Redressement de la pièce avant lecture (lot 1 Preuvid).
 *
 * Une photo de pièce tenue à la main est rarement droite : quelques degrés de rotation, un
 * trapèze dû à l'angle de prise de vue. PaddleOCR lit mal une ligne MRZ inclinée de 7°, et le
 * lot 0 tombait à 0 % au banc sur ces images. On repère donc les quatre coins de la carte
 * (bords détectés, plus grand contour, polygone à quatre sommets) et on la remet à plat par
 * une homographie.
 *
 * Prudence : si la carte remplit déjà l'image (pièce recadrée), si aucun quadrilatère crédible
 * n'est trouvé, ou si la correction serait négligeable, l'image d'origine est rendue telle
 * quelle, au bit près. Le redressement ne doit jamais dégrader une image déjà bonne.
 *
 * OpenCV vient de @techstark/opencv-js (WASM, figé dans le lockfile et l'image Docker), déjà
 * présent comme dépendance de ppu-paddle-ocr : rien n'est téléchargé à l'exécution.
 */

import { createRequire } from 'module';
import sharp from 'sharp';
import { logger } from '@/utils/logger.js';

type CV = any;
// Le module Emscripten est lui-même « thenable » et se résout en lui-même : le renvoyer d'une
// fonction async ou l'attendre avec await boucle sans fin (et bloque la boucle d'événements).
// Constaté sous tsx et vitest le 19/11/2026.
// On le garde donc toujours dans une enveloppe { cv } et on attend son initialisation par son
// propre rappel.
let cvPromise: Promise<{ cv: CV }> | null = null;

/** Charge OpenCV.js une fois ; il s'initialise de façon asynchrone. Renvoie l'enveloppe. */
function loadCv(): Promise<{ cv: CV }> {
  if (!cvPromise) {
    cvPromise = (async () => {
      // require() et non import() : certains chargeurs (vitest) recopient `then` sur l'espace
      // de noms du module, et l'attente de l'import ne se termine alors jamais.
      const cv: any = createRequire(import.meta.url)('@techstark/opencv-js');
      if (!cv.Mat) {
        await new Promise<void>(resolve => {
          if (typeof cv.then === 'function') cv.then(() => resolve());
          else cv.onRuntimeInitialized = () => resolve();
        });
      }
      return { cv };
    })();
  }
  return cvPromise;
}

export interface Point { x: number; y: number }

export interface DeskewResult {
  buffer: Buffer;
  applied: boolean;
  /** Coins de la carte dans l'image d'origine (haut-gauche, haut-droit, bas-droit, bas-gauche). */
  corners: Point[] | null;
  /** Inclinaison du bord haut, en degrés. */
  angle: number;
  reason: string;
}

/** Taille de travail pour la détection ; la remise à plat se fait en pleine résolution. */
const DETECT_MAX = 1000;
/** La carte doit couvrir au moins cette part de l'image (sinon : photo, logo, cadre intérieur). */
const MIN_AREA_RATIO = 0.25;
/** Au-delà, la carte remplit le cadre : déjà recadrée, on n'y touche pas. */
const FULL_FRAME_RATIO = 0.93;
/** Correction jugée négligeable en dessous (degrés d'inclinaison et écart des côtés). */
const MIN_ANGLE = 1.0;
const MIN_KEYSTONE = 0.02;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Range quatre points : haut-gauche, haut-droit, bas-droit, bas-gauche. */
export function orderCorners(pts: Point[]): Point[] {
  const bySum = [...pts].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...pts].sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
}

function polygonArea(p: Point[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** Les angles d'une carte vue de biais restent loin de 0° et de 180°. */
function isPlausibleQuad(q: Point[]): boolean {
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) || 1);
    const deg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (deg < 55 || deg > 125) return false;
  }
  return true;
}

/** Cherche le quadrilatère de la carte dans une image RGBA réduite. */
function findCardQuad(cv: CV, rgba: Buffer, width: number, height: number): Point[] | null {
  const src = new cv.Mat(height, width, cv.CV_8UC4);
  src.data.set(rgba);
  const gray = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 40, 120);
    // Referme les bords interrompus (coins arrondis, reflets) avant de chercher les contours.
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel, new cv.Point(-1, -1), 2);
    cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = width * height;
    let best: Point[] | null = null;
    let bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < imageArea * MIN_AREA_RATIO || area <= bestArea) { c.delete(); continue; }
      const hull = new cv.Mat();
      cv.convexHull(c, hull);
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, 0.02 * cv.arcLength(hull, true), true);
      let quad: Point[] | null = null;
      if (approx.rows === 4) {
        quad = [];
        for (let k = 0; k < 4; k++) quad.push({ x: approx.data32S[2 * k], y: approx.data32S[2 * k + 1] });
      } else {
        // Coins arrondis : le rectangle minimal suit bien une rotation simple.
        const rect = cv.minAreaRect(hull);
        quad = cv.RotatedRect.points(rect).map((p: Point) => ({ x: p.x, y: p.y }));
      }
      quad = orderCorners(quad!);
      if (isPlausibleQuad(quad) && polygonArea(quad) >= imageArea * MIN_AREA_RATIO) {
        best = quad;
        bestArea = area;
      }
      approx.delete(); hull.delete(); c.delete();
    }
    return best;
  } finally {
    src.delete(); gray.delete(); edges.delete(); contours.delete(); hierarchy.delete(); kernel.delete();
  }
}

/**
 * Redresse la carte si elle est inclinée ou vue de biais. Rend l'image d'origine sinon.
 * N'échoue jamais : toute erreur ramène l'image d'origine.
 */
export async function deskewDocument(input: Buffer): Promise<DeskewResult> {
  const unchanged = (reason: string, corners: Point[] | null = null, angle = 0): DeskewResult =>
    ({ buffer: input, applied: false, corners, angle, reason });
  try {
    const meta = await sharp(input).metadata();
    if (!meta.width || !meta.height) return unchanged('dimensions inconnues');
    const W = meta.width, H = meta.height;
    const scale = Math.min(1, DETECT_MAX / Math.max(W, H));
    const w = Math.round(W * scale), h = Math.round(H * scale);
    const small = await sharp(input).resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer();

    const { cv } = await loadCv();
    const quadSmall = findCardQuad(cv, small, w, h);
    if (!quadSmall) return unchanged('aucun quadrilatère');

    const quad = quadSmall.map(p => ({ x: p.x / scale, y: p.y / scale }));
    const [tl, tr, br, bl] = quad;
    const angle = (Math.atan2(tr.y - tl.y, tr.x - tl.x) * 180) / Math.PI;
    const top = dist(tl, tr), bottom = dist(bl, br), left = dist(tl, bl), right = dist(tr, br);
    const keystone = Math.max(Math.abs(top - bottom) / Math.max(top, bottom), Math.abs(left - right) / Math.max(left, right));
    const coverage = polygonArea(quad) / (W * H);

    if (coverage > FULL_FRAME_RATIO) return unchanged('carte déjà recadrée', quad, angle);
    if (Math.abs(angle) < MIN_ANGLE && keystone < MIN_KEYSTONE) {
      // Droite mais entourée de fond : on recadre simplement, sans rééchantillonner l'angle.
      return unchanged('carte droite', quad, angle);
    }

    const outW = Math.round(Math.max(top, bottom));
    const outH = Math.round(Math.max(left, right));
    const full = await sharp(input).ensureAlpha().raw().toBuffer();
    const src = new cv.Mat(H, W, cv.CV_8UC4);
    src.data.set(full);
    const dst = new cv.Mat();
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap(p => [p.x, p.y]));
    const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, outW - 1, 0, outW - 1, outH - 1, 0, outH - 1]);
    const M = cv.getPerspectiveTransform(from, to);
    try {
      cv.warpPerspective(src, dst, M, new cv.Size(outW, outH), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
      const out = await sharp(Buffer.from(dst.data), { raw: { width: outW, height: outH, channels: 4 } })
        .removeAlpha()
        .png({ compressionLevel: 1 })
        .toBuffer();
      return { buffer: out, applied: true, corners: quad, angle, reason: 'redressée' };
    } finally {
      src.delete(); dst.delete(); from.delete(); to.delete(); M.delete();
    }
  } catch (err) {
    logger.warn('Redressement impossible, image d\'origine conservée', {
      error: err instanceof Error ? err.message : String(err),
    });
    return unchanged('erreur');
  }
}
