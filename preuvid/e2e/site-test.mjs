/**
 * Essai de bout en bout du lot 2 : « un site de test crée une session, la personne fait le parcours,
 * le site reçoit le webhook et le vérifie ».
 *
 * Tourne dans l'image de l'API (service site-test de compose.e2e.yml), sur le réseau interne de la pile.
 * 1. Prépare un compte développeur, une clé de test et un webhook abonné aux événements v1.
 * 2. Écoute les webhooks sur http://site-test:8080/hook et vérifie chaque signature sur le corps brut.
 * 3. Parcours age : crée la session (avec rejeu idempotent), envoie le recto synthétique, attend
 *    session.terminee, lit la décision.
 * 4. Parcours identite : recto, verso, capture « visage » (l'image synthétique n'a pas de visage, le
 *    dépôt n'en contient aucun), attend l'issue, rejoue l'événement, supprime la session.
 *
 * Images : preuvid/banc/img (synthétiques). Aucun secret écrit sur disque ; tout est aléatoire et propre
 * à l'essai.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { encryptSecret } from '@idswyft/shared';

const API = process.env.API_URL ?? 'http://api:3001';
const HOOK_URL = 'http://site-test:8080/hook';
const IMG = '/img/cni2021_00_propre.jpg';
const ATTENTE_MS = 180_000;

let echecs = 0;
const ok = (cond, texte) => { console.log(`${cond ? '  ok ' : '  ÉCHEC'} ${texte}`); if (!cond) echecs++; };
const etape = t => console.log(`\n== ${t}`);

// ── Vérification de signature, telle que documentée dans preuvid/docs/api.md ─────────────────────
function verifier(secret, horodatage, corpsBrut, signature) {
  if (Math.abs(Date.now() / 1000 - Number(horodatage)) > 300) return false;
  const attendue = crypto.createHmac('sha256', secret).update(`${horodatage}.${corpsBrut}`).digest('hex');
  return attendue.length === String(signature).length
    && crypto.timingSafeEqual(Buffer.from(attendue), Buffer.from(String(signature)));
}

// ── 1. Préparation ──────────────────────────────────────────────────────────────────────────────
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const suffixe = crypto.randomBytes(4).toString('hex');
const cle = `ik_${crypto.randomBytes(24).toString('hex')}`;
const secretWebhook = crypto.randomBytes(32).toString('hex');
const { rows: [dev] } = await db.query(
  `insert into developers (email, name, is_verified) values ($1, $2, true) returning id`,
  [`e2e-${suffixe}@exemple.test`, `Site de test ${suffixe}`],
);
const { rows: [k] } = await db.query(
  `insert into api_keys (developer_id, key_hash, key_prefix, name, is_sandbox, is_active)
   values ($1, $2, $3, 'essai lot 2', true, true) returning id`,
  [dev.id, crypto.createHmac('sha256', process.env.API_KEY_SECRET).update(cle).digest('hex'), cle.slice(0, 8)],
);
await db.query(
  `insert into webhooks (developer_id, api_key_id, url, secret_key, is_sandbox, is_active, events)
   values ($1, $2, $3, $4, true, true, $5)`,
  [dev.id, k.id, HOOK_URL, encryptSecret(secretWebhook, process.env.ENCRYPTION_KEY),
    ['session.terminee', 'session.a_revoir', 'session.revue', 'session.supprimee']],
);
console.log(`compte d'essai ${dev.id}, clé de test ${cle.slice(0, 8)}…`);

// ── 2. Récepteur ────────────────────────────────────────────────────────────────────────────────
const recus = [];
const attentes = [];
http.createServer((req, res) => {
  let brut = '';
  req.setEncoding('utf8');
  req.on('data', c => { brut += c; });
  req.on('end', () => {
    const h = req.headers;
    const valide = verifier(secretWebhook, h['x-preuvid-timestamp'], brut, h['x-preuvid-signature']);
    const ev = { id: h['x-preuvid-event-id'], tentative: h['x-preuvid-attempt'], valide, corps: JSON.parse(brut) };
    recus.push(ev);
    res.writeHead(valide ? 204 : 401).end();
    for (const a of [...attentes]) if (a.filtre(ev)) { attentes.splice(attentes.indexOf(a), 1); a.resoudre(ev); }
  });
}).listen(8080);

function attendreWebhook(filtre, ms = ATTENTE_MS) {
  const deja = recus.find(filtre);
  if (deja) return Promise.resolve(deja);
  return new Promise((resoudre, rejeter) => {
    const a = { filtre, resoudre };
    attentes.push(a);
    setTimeout(() => { attentes.splice(attentes.indexOf(a), 1); rejeter(new Error('webhook non reçu')); }, ms);
  });
}

// ── Appels ──────────────────────────────────────────────────────────────────────────────────────
async function v1(methode, chemin, corps, entetes = {}) {
  const r = await fetch(`${API}/v1${chemin}`, {
    method: methode,
    headers: { 'x-api-key': cle, ...(corps ? { 'content-type': 'application/json' } : {}), ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, entetes: r.headers, corps: texte ? JSON.parse(texte) : null };
}

async function envoyer(id, jeton, etapeV2, champ, extra = {}) {
  const form = new FormData();
  form.append(champ, new Blob([await readFile(IMG)], { type: 'image/jpeg' }), 'piece.jpg');
  for (const [c, v] of Object.entries(extra)) form.append(c, v);
  const r = await fetch(`${API}/api/v2/verify/${id}/${etapeV2}`, {
    method: 'POST', headers: { 'X-Session-Token': jeton }, body: form,
  });
  return r.status;
}

const jetonDe = lien => new URL(lien).searchParams.get('session');

async function creer(parcours) {
  const idem = crypto.randomUUID();
  const a = await v1('POST', '/sessions', { parcours, reference: `client-${suffixe}` }, { 'Idempotency-Key': idem });
  ok(a.status === 201, `${parcours} : session créée (${a.status})`);
  return { ...a.corps, idem };
}

try {
  // ── 3. Parcours age ───────────────────────────────────────────────────────────────────────────
  etape('parcours age');
  const age = await creer('age');
  const rejeu = await v1('POST', '/sessions', { parcours: 'age', reference: `client-${suffixe}` }, { 'Idempotency-Key': age.idem });
  ok(rejeu.corps?.session === age.session && rejeu.entetes.get('idempotent-replayed') === 'true', 'même Idempotency-Key : même session, rejouée');
  const autre = await v1('POST', '/sessions', { parcours: 'identite' }, { 'Idempotency-Key': age.idem });
  ok(autre.status === 422, `même clé, autre corps : 422 (${autre.status})`);

  ok((await envoyer(age.session, jetonDe(age.lien), 'front-document', 'document', { document_type: 'national_id' })) < 300, 'recto envoyé');
  const finAge = await attendreWebhook(e => e.corps.session === age.session && e.corps.evenement === 'session.terminee');
  ok(finAge.valide, 'webhook session.terminee reçu, signature vérifiée');
  ok(finAge.corps.reference === undefined && finAge.corps.nom === undefined, 'webhook sans référence ni champ lu');
  const decAge = await v1('GET', `/sessions/${age.session}/decision`);
  console.log('  décision :', JSON.stringify(decAge.corps));
  ok(decAge.corps?.statut === 'validee' && decAge.corps?.majeur === true, 'décision age : validee, majeur true');
  ok(Object.keys(decAge.corps ?? {}).sort().join() === 'majeur,parcours,session,statut', 'décision age : rien d’autre que majeur');
  ok(finAge.corps.majeur === true, 'webhook age : majeur true');
  // Aucune image après la réponse (securite.md, règle 1). L'effacement suit la réponse : on lui laisse 10 s.
  let cheminsAge = -1;
  for (let i = 0; i < 20 && cheminsAge !== 0; i++) {
    if (i) await new Promise(r => setTimeout(r, 500));
    ({ rows: [{ n: cheminsAge }] } = await db.query(
      `select count(*)::int as n from documents where verification_request_id = $1 and file_path is not null`, [age.session]));
  }
  ok(cheminsAge === 0, `parcours age : image effacée après la réponse (${cheminsAge} chemin restant)`);

  // ── 4. Parcours identite ──────────────────────────────────────────────────────────────────────
  etape('parcours identite');
  const idt = await creer('identite');
  const jeton = jetonDe(idt.lien);
  ok((await envoyer(idt.session, jeton, 'front-document', 'document', { document_type: 'national_id' })) < 300, 'recto envoyé');
  console.log('  verso :', await envoyer(idt.session, jeton, 'back-document', 'document', { document_type: 'national_id' }));
  console.log('  capture :', await envoyer(idt.session, jeton, 'live-capture', 'selfie'));
  const finIdt = await attendreWebhook(e => e.corps.session === idt.session
    && ['session.terminee', 'session.a_revoir'].includes(e.corps.evenement));
  ok(finIdt.valide, `webhook ${finIdt.corps.evenement} (${finIdt.corps.statut}) reçu, signature vérifiée`);
  const decIdt = await v1('GET', `/sessions/${idt.session}/decision`);
  console.log('  décision :', JSON.stringify({ ...decIdt.corps, champs: Object.keys(decIdt.corps?.champs ?? {}) }));
  ok(typeof decIdt.corps?.motif?.texte === 'string', `motif lisible : « ${decIdt.corps?.motif?.texte} »`);
  ok(decIdt.corps?.champs?.nom?.valeur === 'LEFEBVRE', 'nom lu avec l’état de sa clé de contrôle');

  etape('rejeu et suppression');
  const rej = await v1('POST', `/evenements/${finIdt.id}/rejouer`);
  ok(rej.status === 202 && rej.corps?.livre === true, `rejeu manuel : 202, livré (${rej.status})`);
  const deux = recus.filter(e => e.id === finIdt.id);
  ok(deux.length >= 2 && deux.every(e => e.valide), 'même identifiant d’événement reçu deux fois, signatures valides');
  const evts = await v1('GET', `/sessions/${idt.session}/evenements`);
  ok(evts.corps?.evenements?.some(e => e.id === finIdt.id && e.etat === 'delivered'), 'journal des événements : livré');

  const sup = await v1('DELETE', `/sessions/${idt.session}`);
  ok(sup.status === 204, `suppression : 204 (${sup.status})`);
  ok((await v1('GET', `/sessions/${idt.session}`)).status === 404, 'session supprimée : 404');
  const evSup = await attendreWebhook(e => e.corps.session === idt.session && e.corps.evenement === 'session.supprimee');
  ok(evSup.valide, 'webhook session.supprimee reçu, signature vérifiée');
  const { rows: [reste] } = await db.query(
    `select (select count(*) from documents where verification_request_id = $1)::int as documents,
            (select count(*) from selfies where verification_request_id = $1)::int as selfies,
            (select count(*) from verification_contexts where verification_id = $1)::int as contexte,
            (select v1_reference from verification_requests where id = $1) as reference`,
    [idt.session],
  );
  ok(reste.documents === 0 && reste.selfies === 0 && reste.contexte === 0 && reste.reference === null,
    `rien ne reste en base (${JSON.stringify(reste)})`);

  etape('signature falsifiée');
  ok(!verifier(secretWebhook, finAge.corps && Math.floor(Date.now() / 1000), '{"statut":"validee"}', 'ab'.repeat(32)), 'une signature inventée est refusée');
  ok((await v1('GET', '/sessions', null, { 'x-api-key': 'ik_faux' })).status === 401, 'clé inventée : 401');
} catch (err) {
  echecs++;
  console.log(`  ÉCHEC ${err.message}`);
} finally {
  console.log(`\n${echecs === 0 ? 'ESSAI RÉUSSI' : `ESSAI EN ÉCHEC (${echecs})`} — ${recus.length} webhooks reçus`);
  await db.end();
  process.exit(echecs === 0 ? 0 : 1);
}
