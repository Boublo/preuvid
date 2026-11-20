/**
 * Module du site, côté serveur (Node 18+, sans dépendance) : défi, vérification de la preuve, relevés.
 *
 *   import { MajoritePreuvid } from '@preuvid/age/serveur';
 *   const preuvid = new MajoritePreuvid({ api: '[DOMAINE]/v1', cleApi: process.env.PREUVID_CLE });
 *
 *   // 1. Avant la vérification : un défi neuf, gardé dans la session.
 *   session.defi = preuvid.nouveauDefi();
 *   res.json({ defi: session.defi, cles: await preuvid.cles() });
 *
 *   // 2. Réception de la preuve : le défi sert une fois.
 *   const defi = session.defi; delete session.defi;
 *   if (await preuvid.verifier(req.body, defi)) session.majeur = true;   // pour cette visite seulement
 *
 *   // 3. Une fois par jour au moins : déclarer les preuves acceptées (comptage différé).
 *   setInterval(() => preuvid.declarer(), 6 * 60 * 60 * 1000);
 *
 * Règles d'intégration : la majorité ne vaut que pour la visite (fin de session, fermeture, une heure
 * d'inactivité au plus) et n'est jamais rangée dans un compte.
 */

import crypto from 'node:crypto';

const VARIANTE = 'RSABSSA-SHA384-PSS-Randomized';
const UNE_HEURE = 60 * 60 * 1000;

export class MajoritePreuvid {
  /** @param {{ api: string, cleApi: string, fetch?: typeof fetch }} options */
  constructor({ api, cleApi, fetch: f = fetch }) {
    this.api = api.replace(/\/$/, '');
    this.cleApi = cleApi;
    this.fetch = f;
    this.cache = null;
    this.aDeclarer = [];
  }

  /** Défi aléatoire de 32 octets, en base64url. */
  nouveauDefi() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /** Clés publiques de Preuvid, rafraîchies au plus une fois par heure (à transmettre au navigateur). */
  async cles() {
    if (this.cache && Date.now() - this.cache.lu < UNE_HEURE) return this.cache.corps;
    const r = await this.fetch(`${this.api}/age/cles`);
    if (!r.ok) throw new Error(`preuvid : clés indisponibles (${r.status})`);
    const corps = await r.json();
    if (corps.variante !== VARIANTE) throw new Error(`preuvid : variante inattendue ${corps.variante}`);
    this.cache = { lu: Date.now(), corps };
    return corps;
  }

  /**
   * Vrai si la preuve est une signature valide de Preuvid sur ce défi, par une clé valide maintenant.
   * Le défi doit venir de la session et être retiré avant l'appel (usage unique).
   * @param {{ cle: string, message: string, signature: string }} preuve
   * @param {string} defi
   */
  async verifier(preuve, defi) {
    if (!preuve || typeof preuve.cle !== 'string' || typeof defi !== 'string') return false;
    const message = Buffer.from(String(preuve.message), 'base64url');
    const signature = Buffer.from(String(preuve.signature), 'base64url');
    if (message.length !== 64 || signature.length !== 256) return false;
    if (!message.subarray(32).equals(Buffer.from(defi, 'base64url'))) return false;
    const maintenant = Date.now();
    const cle = (await this.cles()).cles.find(c => c.id === preuve.cle
      && Date.parse(c.valide_du) <= maintenant && Date.parse(c.valide_au) > maintenant);
    if (!cle) return false;
    const valide = crypto.verify('sha384', message, {
      key: crypto.createPublicKey({ key: Buffer.from(cle.spki, 'base64'), format: 'der', type: 'spki' }),
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 48,
    }, signature);
    if (valide) this.aDeclarer.push({ cle: preuve.cle, message: preuve.message, signature: preuve.signature });
    return valide;
  }

  /**
   * Déclare les preuves acceptées depuis le dernier appel, par lots de 1 000. En cas d'échec, elles
   * restent en attente pour le prochain appel. Pour plusieurs serveurs, gardez la file en base.
   * @returns {Promise<{ acceptees: number, doublons: number, invalides: number }>}
   */
  async declarer() {
    const bilan = { acceptees: 0, doublons: 0, invalides: 0 };
    while (this.aDeclarer.length > 0) {
      const lot = this.aDeclarer.slice(0, 1000);
      const r = await this.fetch(`${this.api}/age/releves`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.cleApi },
        body: JSON.stringify({ preuves: lot }),
      });
      if (!r.ok) throw new Error(`preuvid : relevé refusé (${r.status})`);
      const b = await r.json();
      this.aDeclarer.splice(0, lot.length);
      bilan.acceptees += b.acceptees; bilan.doublons += b.doublons; bilan.invalides += b.invalides;
    }
    return bilan;
  }
}
