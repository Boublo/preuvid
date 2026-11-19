import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertModels,
  ModelsUnavailableError,
  requireModels,
  resetModelStatus,
  verifyModels,
} from './registry.js';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let dir: string;
let manifest: string;
const ocr = Buffer.from('modele ocr');
const visage = Buffer.from('modele visage');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registre-'));
  fs.mkdirSync(path.join(dir, 'paddle'));
  fs.writeFileSync(path.join(dir, 'paddle/det.onnx'), ocr);
  fs.writeFileSync(path.join(dir, 'visage.bin'), visage);
  manifest = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify({
    models: [
      { id: 'det', usage: 'ocr', path: 'paddle/det.onnx', sha256: sha(ocr), size: ocr.length },
      { id: 'vis', usage: 'visage', path: 'visage.bin', sha256: sha(visage), size: visage.length },
    ],
  }));
});

afterEach(() => {
  resetModelStatus();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('verifyModels', () => {
  it('accepte des fichiers conformes au manifeste', () => {
    const s = verifyModels(manifest, dir);
    expect(s.problemes).toEqual([]);
    expect(s.usages).toEqual({ ocr: 'ok', visage: 'ok', voix: 'ok' });
  });

  it('signale un modèle absent sans lever d’exception', () => {
    fs.rmSync(path.join(dir, 'paddle/det.onnx'));
    const s = verifyModels(manifest, dir);
    expect(s.usages.ocr).toBe('indisponible');
    expect(s.usages.visage).toBe('ok');
    expect(s.problemes).toEqual([
      { id: 'det', path: 'paddle/det.onnx', usage: 'ocr', probleme: 'absent' },
    ]);
  });

  it('signale un modèle altéré de même taille', () => {
    fs.writeFileSync(path.join(dir, 'visage.bin'), Buffer.from('modele visagX'));
    const s = verifyModels(manifest, dir);
    expect(s.usages.visage).toBe('indisponible');
    expect(s.problemes[0].probleme).toMatch(/empreinte/);
  });

  it('rend tout indisponible si le manifeste est illisible', () => {
    const s = verifyModels(path.join(dir, 'inexistant.json'), dir);
    expect(s.usages).toEqual({ ocr: 'indisponible', visage: 'indisponible', voix: 'indisponible' });
  });
});

describe('requireModels', () => {
  function run(usages: Parameters<typeof requireModels>) {
    let statusCode = 200;
    let body: unknown;
    let nextCalled = false;
    const res = {
      status(code: number) { statusCode = code; return this; },
      json(b: unknown) { body = b; return this; },
    };
    requireModels(...usages)({} as never, res as never, () => { nextCalled = true; });
    return { statusCode, body, nextCalled };
  }

  it('laisse passer quand les modèles requis sont présents', () => {
    resetModelStatus(verifyModels(manifest, dir));
    expect(run(['ocr', 'visage']).nextCalled).toBe(true);
  });

  it('répond 503 MODELS_UNAVAILABLE avec la liste des fichiers en cause', () => {
    fs.rmSync(path.join(dir, 'paddle/det.onnx'));
    resetModelStatus(verifyModels(manifest, dir));
    const r = run(['ocr']);
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(503);
    expect(r.body).toMatchObject({
      success: false,
      error: 'MODELS_UNAVAILABLE',
      manquants: [{ id: 'det', path: 'paddle/det.onnx', probleme: 'absent' }],
    });
  });

  it('ignore un modèle manquant d’un autre usage', () => {
    fs.rmSync(path.join(dir, 'paddle/det.onnx'));
    resetModelStatus(verifyModels(manifest, dir));
    expect(run(['visage']).nextCalled).toBe(true);
    expect(() => assertModels(['ocr'])).toThrow(ModelsUnavailableError);
  });
});

describe('manifeste du dépôt', () => {
  it('liste des empreintes SHA-256 et des tailles valides, sans doublon', () => {
    const real = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../models.manifest.json'), 'utf8'),
    ) as { models: Array<{ id: string; path: string; sha256: string; size: number; usage: string }> };
    expect(real.models.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const m of real.models) {
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.size).toBeGreaterThan(0);
      expect(['ocr', 'visage', 'voix']).toContain(m.usage);
      expect(ids.has(m.id)).toBe(false);
      expect(paths.has(m.path)).toBe(false);
      ids.add(m.id);
      paths.add(m.path);
    }
  });
});
