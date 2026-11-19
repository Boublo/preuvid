import path from 'node:path';
import { modelFile } from '@/models/registry.js';
import { logger } from '@/utils/logger.js';

/**
 * Options communes des workers Tesseract (lot 0).
 *
 * - langPath : dossier local où l'image place eng.traineddata (non compressé),
 *   au lieu du CDN jsdelivr ;
 * - cacheMethod 'none' : ni lecture ni écriture de cache sur disque ;
 * - errorHandler : sans lui, tesseract.js relance l'erreur du worker dans un
 *   écouteur d'événement, ce qui faisait tomber tout le processus. Avec lui,
 *   la promesse est rejetée et la route renvoie une erreur propre.
 */
export function tesseractWorkerOptions() {
  return {
    langPath: path.dirname(modelFile('tesseract/eng.traineddata')),
    gzip: false,
    cacheMethod: 'none',
    logger: () => {},
    errorHandler: (err: unknown) => {
      logger.error('Tesseract : erreur du worker', {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };
}
