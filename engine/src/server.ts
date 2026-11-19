/**
 * Idswyft Engine Worker — ML Verification Extraction Service
 *
 * Standalone Express server handling the 3 heavy ML extraction operations:
 *   POST /extract/front  — OCR + face detection + tamper analysis
 *   POST /extract/back   — Barcode/PDF417 + MRZ detection
 *   POST /extract/live   — Face detection + liveness + deepfake analysis
 *
 * Designed to run as a separate container from the core API,
 * keeping the API image lightweight (~250MB) while this worker
 * carries the heavy ML dependencies (~1.5GB).
 */

import './instrument.js';
import 'dotenv/config';
import * as Sentry from '@sentry/node';
import express from 'express';
import { logger } from '@/utils/logger.js';
import { configureSharedLogger } from '@idswyft/shared';
import extractRouter from '@/routes/extract.js';
import { getModelStatus, ModelsUnavailableError, modelsUnavailableBody } from '@/models/registry.js';

const app = express();

// Wire shared-package logger to engine's logger instance
configureSharedLogger(logger);
const PORT = parseInt(process.env.PORT || '3002');

// JSON body parsing (for metadata fields)
app.use(express.json({ limit: '1mb' }));

// Vérification des modèles figés, une fois au démarrage. Un écart ne fait pas
// tomber le processus : les routes concernées répondront 503.
const modelStatus = getModelStatus();
if (modelStatus.problemes.length > 0) {
  logger.error('Modèles en écart avec le manifeste', { problemes: modelStatus.problemes });
} else {
  logger.info(`Modèles vérifiés : ${modelStatus.modeles} fichiers conformes au manifeste`);
}

function modelsSummary() {
  const status = getModelStatus();
  return {
    usages: status.usages,
    problemes: status.problemes,
    verifieLe: status.verifieLe,
  };
}

// Vivacité du processus : toujours 200, avec l'état des modèles.
app.get('/health', (_req, res) => {
  const models = modelsSummary();
  const degraded = models.problemes.length > 0;
  res.json({
    status: degraded ? 'degraded' : 'ok',
    service: 'idswyft-engine',
    uptime: process.uptime(),
    models,
  });
});

// Disponibilité : 503 tant que la lecture des pièces ou le visage est inutilisable.
app.get('/ready', (_req, res) => {
  const models = modelsSummary();
  const ready = models.usages.ocr === 'ok' && models.usages.visage === 'ok';
  res.status(ready ? 200 : 503).json({ ready, models });
});

// Extraction routes
app.use('/extract', extractRouter);

// Sentry error handler — must be registered before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ModelsUnavailableError) {
    res.status(503).json(modelsUnavailableBody(err));
    return;
  }
  logger.error('Unhandled engine error', {
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({
    success: false,
    error: 'Internal engine error',
    message: err.message,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`Engine worker listening on port ${PORT}`, {
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});

export default app;
