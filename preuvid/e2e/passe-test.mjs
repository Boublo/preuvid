/**
 * Essai de bout en bout du passe majeur (lot 3, preuvid/docs/double-anonymat.md).
 *
 * Joue les trois rôles avec de vrais calculs :
 * - le site : tire un défi, le masque (signature aveugle RFC 9474), démasque, vérifie en RSA-PSS, déclare ;
 * - le téléphone : un authentificateur WebAuthn logiciel (attestation « none », clé P-256, déverrouillage
 *   simulé par le drapeau UV) ;
 * - la page Preuvid : appelle /v1/age/* sans clé d'API, sans Referer ni Origin.
 * La première vérification lit la pièce synthétique du banc (preuvid/banc/img), comme le lot 2.
 *
 * Lancement (après l'essai du lot 2, mêmes images) :
 *   docker compose -f docker-compose.yml -f preuvid/e2e/compose.e2e.yml run --rm passe-test
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { RSABSSA } from '@cloudflare/blindrsa-ts';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { MajoritePreuvid } from '../sdk-age/serveur.mjs';

const API = process.env.API_URL ?? 'http://api:3001';
const ORIGINE = 'http://localhost';
const RP_ID = 'localhost';
const IMG = '/img/cni2021_00_propre.jpg';
const suite = RSABSSA.SHA384.PSS.Randomized();

let echecs = 0;
const ok = (cond, texte) => { console.log(`${cond ? '  ok ' : '  ÉCHEC'} ${texte}`); if (!cond) echecs++; };
const etape = t => console.log(`\n== ${t}`);
const b64u = o => Buffer.from(o).toString('base64url');
const attendre = ms => new Promise(r => setTimeout(r, ms));

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

async function age(methode, chemin, corps, entetes = {}) {
  const r = await fetch(`${API}/v1/age${chemin}`, {
    method: methode,
    headers: { ...(corps ? { 'content-type': 'application/json' } : {}), ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  const texte = await r.text();
  return { status: r.status, corps: texte ? JSON.parse(texte) : null };
}

// ── Le site : compte client et module serveur de Preuvid (preuvid/sdk/age/serveur.mjs) ──────────
const suffixe = crypto.randomBytes(4).toString('hex');
const cleApi = `ik_${crypto.randomBytes(24).toString('hex')}`;
const { rows: [dev] } = await db.query(`insert into developers (email, name, is_verified) values ($1, $2, true) returning id`,
  [`passe-${suffixe}@exemple.test`, `Site adulte ${suffixe}`]);
await db.query(`insert into api_keys (developer_id, key_hash, key_prefix, name, is_sandbox, is_active) values ($1, $2, $3, 'essai lot 3', false, true)`,
  [dev.id, crypto.createHmac('sha256', process.env.API_KEY_SECRET).update(cleApi).digest('hex'), cleApi.slice(0, 8)]);
const site = new MajoritePreuvid({ api: `${API}/v1`, cleApi });

const { corps: { cles: [cle] } } = await age('GET', '/cles');
const publique = await crypto.subtle.importKey('spki', Buffer.from(cle.spki, 'base64'), { name: 'RSA-PSS', hash: 'SHA-384' }, true, ['verify']);
const utilises = new Set();

async function nouveauDefi() {
  const defi = crypto.randomBytes(32);
  const message = suite.prepare(defi);
  const { blindedMsg, inv } = await suite.blind(publique, message);
  return { defi, message, inv, masque: b64u(blindedMsg) };
}

/** Démasque, puis vérifie comme un site le ferait : RSA-PSS SHA-384, défi de la session, usage unique. */
async function accepter(d, signatureMasquee) {
  const signature = await suite.finalize(publique, d.message, new Uint8Array(Buffer.from(signatureMasquee, 'base64url')), d.inv);
  const preuve = { cle: cle.id, message: b64u(d.message), signature: b64u(signature) };
  // Le défi sert une fois : le site le retire de la session avant de vérifier.
  const neuf = !utilises.has(b64u(d.defi));
  utilises.add(b64u(d.defi));
  return { accepte: neuf && await site.verifier(preuve, b64u(d.defi)), preuve };
}

// ── Le téléphone : authentificateur logiciel ────────────────────────────────────────────────────
const appareil = (() => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const rpHash = crypto.createHash('sha256').update(RP_ID).digest();
  // UP | UV | BE | BS : présence, déverrouillage, clé synchronisable et synchronisée.
  const DRAPEAUX = 0x01 | 0x04 | 0x08 | 0x10;
  const compteur = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
  const client = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGINE, crossOrigin: false }));
  return {
    creer(options) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
      const longueur = Buffer.alloc(2); longueur.writeUInt16BE(credId.length);
      const authData = Buffer.concat([rpHash, Buffer.from([DRAPEAUX | 0x40]), compteur(0), Buffer.alloc(16), longueur, credId, Buffer.from(isoCBOR.encode(cose))]);
      const attestation = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(client('webauthn.create', options.challenge)), attestationObject: b64u(attestation), transports: ['internal'] },
      };
    },
    signer(options, n) {
      const cd = client('webauthn.get', options.challenge);
      const authData = Buffer.concat([rpHash, Buffer.from([DRAPEAUX]), compteur(n)]);
      const signature = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(cd).digest()]), privateKey);
      return {
        id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {},
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) },
      };
    },
  };
})();

// ── La page Preuvid : première vérification ─────────────────────────────────────────────────────
async function verifierMajorite() {
  const v = await age('POST', '/verification');
  ok(v.status === 201 && v.corps?.verification && /^[0-9a-f]{64}$/.test(v.corps?.jeton ?? ''), `vérification ouverte (${v.status})`);
  const form = new FormData();
  form.append('document', new Blob([await readFile(IMG)], { type: 'image/jpeg' }), 'piece.jpg');
  form.append('document_type', 'national_id');
  const envoi = await fetch(`${API}/api/v2/verify/${v.corps.verification}/front-document`, {
    method: 'POST', headers: { 'X-Session-Token': v.corps.jeton }, body: form,
  });
  ok(envoi.status < 300, `recto envoyé (${envoi.status})`);
  const ids = { verification: v.corps.verification, jeton: v.corps.jeton };
  let etat;
  for (let i = 0; i < 120; i++) {
    etat = await age('POST', '/verification/etat', ids);
    if (['validee', 'refusee', 'a_revoir'].includes(etat.corps?.statut)) break;
    await attendre(1000);
  }
  ok(etat.corps?.statut === 'validee' && etat.corps?.majeur === true, `majorité prouvée (${JSON.stringify(etat.corps)})`);
  ok(Object.keys(etat.corps ?? {}).sort().join() === 'majeur,statut', 'la page ne reçoit que statut et majeur');
  return ids;
}

async function verificationEffacee(id) {
  const { rows: [r] } = await db.query(
    `select v1_deleted_at is not null as supprimee, session_token_hash is null as sans_jeton,
            (select count(*) from documents where verification_request_id = $1)::int as documents
       from verification_requests where id = $1`, [id]);
  return r;
}

const preuves = [];
try {
  etape('clés publiques');
  ok(cle && /^[0-9a-f]{64}$/.test(cle.id) && new Date(cle.valide_au) > new Date(), `clé publiée, valable jusqu’au ${cle.valide_au?.slice(0, 10)}`);

  etape('première visite : vérification, puis création du passe');
  const v1 = await verifierMajorite();
  const d1 = await nouveauDefi();
  const options = await age('POST', '/passe/options', v1);
  ok(options.status === 200 && options.corps?.rp?.id === RP_ID, `options de création (${options.status})`);
  ok(options.corps?.user?.name === 'Passe majeur' && options.corps?.authenticatorSelection?.userVerification === 'required',
    'clé d’accès sans nom, déverrouillage exigé');
  const creation = await age('POST', '/passe', { ...v1, cle: cle.id, masque: d1.masque, attestation: appareil.creer(options.corps) });
  ok(creation.status === 201 && typeof creation.corps?.signature_masquee === 'string', `passe créé, preuve signée (${creation.status})`);
  const p1 = await accepter(d1, creation.corps.signature_masquee);
  ok(p1.accepte, 'le site démasque et vérifie la preuve seul');
  preuves.push(p1.preuve);
  const e1 = await verificationEffacee(v1.verification);
  ok(e1.supprimee && e1.sans_jeton && e1.documents === 0, `vérification supprimée après création (${JSON.stringify(e1)})`);
  ok((await age('POST', '/verification/etat', v1)).status === 404, 'la vérification ne répond plus');
  const { rows: colonnes } = await db.query(`select column_name from information_schema.columns where table_name = 'v1_age_passes'`);
  ok(!colonnes.some(c => /verif|nom|naiss|ip|site|origin/i.test(c.column_name)), 'le passe ne porte ni vérification, ni nom, ni site');
  const { rows: [passe] } = await db.query(`select sauvegarde_possible, sauvegardee, compteur from v1_age_passes where credential_id = $1`, [appareil.creer({ challenge: 'x' }).id]);
  ok(passe?.sauvegarde_possible === true && passe?.sauvegardee === true, 'clé synchronisée acceptée, notée comme telle');

  etape('rejeu');
  const rejeu = await age('POST', '/passe', { ...v1, cle: cle.id, masque: d1.masque, attestation: appareil.creer(options.corps) });
  ok(rejeu.status === 404 || rejeu.status === 409 || rejeu.status === 400, `même vérification, second passe refusé (${rejeu.status})`);
  ok(!(await accepter(d1, creation.corps.signature_masquee)).accepte, 'même défi présenté deux fois au site : refusé');

  etape('visites suivantes avec le passe');
  for (const n of [1, 2]) {
    const d = await nouveauDefi();
    const defi = await age('POST', '/defi', null, { referer: 'https://site-adulte.example/video', origin: 'https://site-adulte.example' });
    const r = await age('POST', '/preuve', { cle: cle.id, masque: d.masque, assertion: appareil.signer(defi.corps, n) });
    ok(r.status === 200, `visite ${n} : preuve signée (${r.status})`);
    const p = await accepter(d, r.corps.signature_masquee);
    ok(p.accepte, `visite ${n} : acceptée par le site`);
    preuves.push(p.preuve);
  }
  const defiRecul = await age('POST', '/defi');
  const recul = await age('POST', '/preuve', { cle: cle.id, masque: (await nouveauDefi()).masque, assertion: appareil.signer(defiRecul.corps, 1) });
  ok(recul.status === 401, `compteur qui recule (clé copiée) : refusé (${recul.status})`);
  const autre = await age('POST', '/preuve', { cle: cle.id, masque: (await nouveauDefi()).masque, assertion: appareil.signer({ challenge: b64u(crypto.randomBytes(32)) }, 9) });
  ok(autre.status === 400, `défi inventé : refusé (${autre.status})`);

  etape('« Non merci, juste pour cette fois »');
  const v2 = await verifierMajorite();
  const d2 = await nouveauDefi();
  const unique = await age('POST', '/preuve-unique', { ...v2, cle: cle.id, masque: d2.masque });
  ok(unique.status === 200, `preuve unique signée (${unique.status})`);
  const p2 = await accepter(d2, unique.corps.signature_masquee);
  ok(p2.accepte, 'acceptée par le site');
  preuves.push(p2.preuve);
  const encore = await age('POST', '/preuve-unique', { ...v2, cle: cle.id, masque: (await nouveauDefi()).masque });
  ok(encore.status === 404 || encore.status === 409, `seconde preuve avec la même vérification : refusée (${encore.status})`);
  const e2 = await verificationEffacee(v2.verification);
  ok(e2.supprimee && e2.documents === 0, `vérification supprimée (${JSON.stringify(e2)})`);

  etape('comptage différé');
  ok(site.aDeclarer.length === preuves.length, `le module du site garde ${site.aDeclarer.length} preuves à déclarer`);
  const r1 = await site.declarer();
  ok(JSON.stringify(r1) === JSON.stringify({ acceptees: preuves.length, doublons: 0, invalides: 0 }), `relevé : ${JSON.stringify(r1)}`);
  ok(site.aDeclarer.length === 0, 'file vidée après le relevé');
  const declarer = corps => age('POST', '/releves', corps, { 'x-api-key': cleApi });
  const r2 = await declarer({ preuves: [...preuves, { ...preuves[0], signature: b64u(crypto.randomBytes(256)) }] });
  ok(JSON.stringify(r2.corps) === JSON.stringify({ acceptees: 0, doublons: preuves.length, invalides: 1 }), `même relevé rejoué : ${JSON.stringify(r2.corps)}`);
  ok((await age('POST', '/releves', { preuves })).status === 401, 'relevé sans clé d’API : 401');
  const { rows: [{ n }] } = await db.query(`select count(*)::int as n from v1_age_releves where developer_id = $1`, [dev.id]);
  ok(n === preuves.length, `${n} preuves comptées pour ce site`);
} catch (err) {
  echecs++;
  console.log(`  ÉCHEC ${err.stack ?? err.message}`);
} finally {
  console.log(`\n${echecs === 0 ? 'ESSAI RÉUSSI' : `ESSAI EN ÉCHEC (${echecs})`} — ${preuves.length} preuves`);
  await db.end();
  process.exit(echecs === 0 ? 0 : 1);
}
