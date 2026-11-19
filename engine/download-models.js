#!/usr/bin/env node
/**
 * Préparation des modèles du moteur (lot 0).
 *
 * Lit models.manifest.json, récupère chaque fichier depuis sa source épinglée
 * (URL figée sur un commit ou une version, ou copie depuis node_modules),
 * vérifie son empreinte SHA-256 et échoue à la moindre différence.
 * Exécuté pendant la construction de l'image : à l'exécution, le moteur
 * ne télécharge plus rien.
 *
 *   node download-models.js              récupère ce qui manque puis vérifie tout
 *   node download-models.js --verifier   vérifie seulement, sans réseau (code 1 si écart)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const MANIFEST = path.join(__dirname, 'models.manifest.json');
const MODELS_DIR = path.join(__dirname, 'models');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

async function fetchBuffer(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function check(model) {
  const file = path.join(MODELS_DIR, model.path);
  if (!fs.existsSync(file)) return `absent`;
  const size = fs.statSync(file).size;
  if (size !== model.size) return `taille ${size} au lieu de ${model.size}`;
  const digest = sha256File(file);
  if (digest !== model.sha256) return `empreinte ${digest} au lieu de ${model.sha256}`;
  return null;
}

const archiveCache = new Map();

async function archiveFor(source) {
  if (archiveCache.has(source.url)) return archiveCache.get(source.url);
  const buf = await fetchBuffer(source.url);
  const digest = sha256(buf);
  if (digest !== source.sha256) {
    throw new Error(`archive ${source.url} : empreinte ${digest} au lieu de ${source.sha256}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preuvid-modele-'));
  const file = path.join(dir, 'archive.tar.bz2');
  fs.writeFileSync(file, buf);
  archiveCache.set(source.url, { dir, file });
  return archiveCache.get(source.url);
}

async function fetchModel(model) {
  const { source } = model;
  if (source.npm) {
    return fs.readFileSync(require.resolve(source.npm));
  }
  if (source.tarMember) {
    const { dir, file } = await archiveFor(source);
    execFileSync('tar', ['xjf', file, '-C', dir, source.tarMember], { stdio: 'pipe' });
    return fs.readFileSync(path.join(dir, source.tarMember));
  }
  if (source.url) {
    const buf = await fetchBuffer(source.url);
    if (source.sha256 && sha256(buf) !== source.sha256) {
      throw new Error(`${source.url} : empreinte du fichier source inattendue`);
    }
    return source.gunzip ? zlib.gunzipSync(buf) : buf;
  }
  throw new Error(`source inconnue pour ${model.id}`);
}

async function main() {
  const verifyOnly = process.argv.includes('--verifier');
  const { models } = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  let errors = 0;

  for (const model of models) {
    let problem = check(model);
    if (problem && !verifyOnly) {
      try {
        const buf = await fetchModel(model);
        const file = path.join(MODELS_DIR, model.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf);
        problem = check(model);
      } catch (err) {
        problem = err.message;
      }
    }
    if (problem) {
      errors++;
      console.error(`ÉCHEC  ${model.path} : ${problem}`);
    } else {
      console.log(`ok     ${model.path}`);
    }
  }

  for (const { dir } of archiveCache.values()) fs.rmSync(dir, { recursive: true, force: true });

  if (errors > 0) {
    console.error(`\n${errors} modèle(s) en écart avec models.manifest.json.`);
    process.exit(1);
  }
  console.log(`\n${models.length} modèles conformes au manifeste.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
