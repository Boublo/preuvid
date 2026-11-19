/**
 * Registre des modèles figés (lot 0).
 *
 * Les modèles sont construits dans l'image depuis models.manifest.json.
 * Au démarrage, le moteur vérifie chaque fichier (présence, taille, SHA-256).
 * Un modèle absent ou altéré ne fait pas tomber le processus : les routes qui
 * en dépendent répondent 503 MODELS_UNAVAILABLE avec la liste des fichiers en
 * cause, et /ready signale le moteur comme non prêt.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Racine du moteur : engine/ (depuis src/models ou dist/models). */
const ENGINE_ROOT = path.resolve(__dirname, '../..');

export const MODELS_DIR = process.env.ENGINE_MODELS_DIR
  ? path.resolve(process.env.ENGINE_MODELS_DIR)
  : path.join(ENGINE_ROOT, 'models');

const MANIFEST_PATH = process.env.ENGINE_MODELS_MANIFEST
  ? path.resolve(process.env.ENGINE_MODELS_MANIFEST)
  : path.join(ENGINE_ROOT, 'models.manifest.json');

export type ModelUsage = 'ocr' | 'visage' | 'voix';

export interface ManifestModel {
  id: string;
  usage: ModelUsage;
  path: string;
  sha256: string;
  size: number;
}

export interface ModelProblem {
  id: string;
  path: string;
  usage: ModelUsage;
  probleme: string;
}

export interface ModelStatus {
  verifieLe: string;
  manifeste: string | null;
  modeles: number;
  problemes: ModelProblem[];
  usages: Record<ModelUsage, 'ok' | 'indisponible'>;
}

/** Chemin absolu d'un fichier de modèle (relatif à MODELS_DIR). */
export function modelFile(relativePath: string): string {
  return path.join(MODELS_DIR, relativePath);
}

function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function checkModel(model: ManifestModel, root = MODELS_DIR): string | null {
  const file = path.join(root, model.path);
  if (!fs.existsSync(file)) return 'absent';
  const size = fs.statSync(file).size;
  if (size !== model.size) return `taille ${size} octets au lieu de ${model.size}`;
  const digest = sha256File(file);
  if (digest !== model.sha256) return 'empreinte SHA-256 différente du manifeste';
  return null;
}

export function verifyModels(
  manifestPath = MANIFEST_PATH,
  root = MODELS_DIR,
): ModelStatus {
  const usages: Record<ModelUsage, 'ok' | 'indisponible'> = { ocr: 'ok', visage: 'ok', voix: 'ok' };
  const problemes: ModelProblem[] = [];
  let models: ManifestModel[] = [];
  let manifeste: string | null = manifestPath;

  try {
    models = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).models ?? [];
  } catch (err) {
    manifeste = null;
    for (const usage of Object.keys(usages) as ModelUsage[]) usages[usage] = 'indisponible';
    problemes.push({
      id: 'manifeste',
      path: manifestPath,
      usage: 'ocr',
      probleme: `manifeste illisible : ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  for (const model of models) {
    const probleme = checkModel(model, root);
    if (probleme) {
      problemes.push({ id: model.id, path: model.path, usage: model.usage, probleme });
      usages[model.usage] = 'indisponible';
    }
  }

  return { verifieLe: new Date().toISOString(), manifeste, modeles: models.length, problemes, usages };
}

let status: ModelStatus | null = null;

/** État des modèles, calculé une fois au démarrage (ou au premier appel). */
export function getModelStatus(): ModelStatus {
  if (!status) status = verifyModels();
  return status;
}

/** Pour les tests : force une nouvelle vérification. */
export function resetModelStatus(next: ModelStatus | null = null): void {
  status = next;
}

export class ModelsUnavailableError extends Error {
  readonly code = 'MODELS_UNAVAILABLE';
  constructor(readonly manquants: ModelProblem[]) {
    super(
      `Modèles indisponibles : ${manquants.map((m) => `${m.path} (${m.probleme})`).join(', ')}`,
    );
    this.name = 'ModelsUnavailableError';
  }
}

/** Lève ModelsUnavailableError si un modèle requis par ces usages est en défaut. */
export function assertModels(usages: ModelUsage[]): void {
  const current = getModelStatus();
  const manquants = current.problemes.filter((p) => usages.includes(p.usage) || p.id === 'manifeste');
  if (manquants.length > 0) throw new ModelsUnavailableError(manquants);
}

export function modelsUnavailableBody(err: ModelsUnavailableError) {
  return {
    success: false,
    error: err.code,
    message: err.message,
    manquants: err.manquants.map(({ id, path: p, probleme }) => ({ id, path: p, probleme })),
  };
}

/** Middleware Express : 503 explicite au lieu d'un plantage si un modèle manque. */
export function requireModels(...usages: ModelUsage[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    try {
      assertModels(usages);
      next();
    } catch (err) {
      if (err instanceof ModelsUnavailableError) {
        res.status(503).json(modelsUnavailableBody(err));
        return;
      }
      next(err);
    }
  };
}
