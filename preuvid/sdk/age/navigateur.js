/**
 * Module du site, côté navigateur : obtenir une preuve de majorité sans que Preuvid sache quel site
 * la demande (preuvid/docs/double-anonymat.md).
 *
 * À appeler dans le gestionnaire d'un clic (sinon le navigateur bloque l'onglet) :
 *
 *   import { prouverMajorite, minuteurInactivite } from '@preuvid/age/navigateur';
 *   bouton.onclick = async () => {
 *     const { defi, cles } = await (await fetch('/majorite/defi')).json();   // votre serveur
 *     const preuve = await prouverMajorite({ defi, cles });
 *     await fetch('/majorite/preuve', { method: 'POST', body: JSON.stringify(preuve) });
 *   };
 *
 * Dépendance : @cloudflare/blindrsa-ts (Apache-2.0).
 */

import { RSABSSA } from '@cloudflare/blindrsa-ts';

export const PAGE_PREUVID = '[DOMAINE]/age';
const suite = RSABSSA.SHA384.PSS.Randomized();
const ALGO = { name: 'RSA-PSS', hash: 'SHA-384' };

const versOctets = (b64) => {
  const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};
const versB64u = (o) => btoa(String.fromCharCode(...o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Ouvre la page Preuvid dans un onglet, sans Referer, en gardant le lien `opener` pour postMessage. */
function ouvrir(url) {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.referrerPolicy = 'no-referrer'; // pas rel="noreferrer" : il couperait aussi window.opener
  a.rel = 'opener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * @param {{ defi: string, cles: { variante: string, cles: { id: string, spki: string, valide_du: string, valide_au: string }[] },
 *           page?: string, delaiMs?: number }} options
 *   defi : 32 octets aléatoires en base64url, tirés par votre serveur et gardés dans la session.
 *   cles : la réponse de GET /v1/age/cles, récupérée par votre serveur.
 * @returns {Promise<{ cle: string, message: string, signature: string }>}
 */
export async function prouverMajorite({ defi, cles, page = PAGE_PREUVID, delaiMs = 10 * 60 * 1000 }) {
  const maintenant = Date.now();
  const cle = cles.cles
    .filter(c => Date.parse(c.valide_du) <= maintenant && Date.parse(c.valide_au) > maintenant)
    .sort((a, b) => Date.parse(b.valide_du) - Date.parse(a.valide_du))[0];
  if (!cle) throw new Error('preuvid : aucune clé valide, rafraîchir GET /v1/age/cles');
  const octetsDefi = versOctets(defi);
  if (octetsDefi.length !== 32) throw new Error('preuvid : le défi doit faire 32 octets');

  const publique = await crypto.subtle.importKey('spki', versOctets(cle.spki), ALGO, true, ['verify']);
  const message = suite.prepare(octetsDefi);
  const { blindedMsg, inv } = await suite.blind(publique, message);
  const origine = new URL(page).origin;

  return new Promise((resoudre, rejeter) => {
    let onglet = null;
    const fin = (f) => { window.removeEventListener('message', ecouter); clearTimeout(minuteur); f(); };
    const minuteur = setTimeout(() => fin(() => rejeter(new Error('preuvid : délai dépassé'))), delaiMs);
    async function ecouter(e) {
      if (e.origin !== origine || !e.data || typeof e.data !== 'object') return;
      if (e.data.type === 'preuvid:pret') {
        onglet = e.source;
        onglet.postMessage({ type: 'preuvid:demande', cle: cle.id, masque: versB64u(blindedMsg) }, origine);
      } else if (e.data.type === 'preuvid:reponse' && e.source === onglet) {
        try {
          const signature = await suite.finalize(publique, message, versOctets(e.data.signature_masquee), inv);
          fin(() => resoudre({ cle: cle.id, message: versB64u(message), signature: versB64u(signature) }));
        } catch (err) {
          fin(() => rejeter(err));
        }
      } else if (e.data.type === 'preuvid:refus' && e.source === onglet) {
        fin(() => rejeter(Object.assign(new Error(`preuvid : ${e.data.code}`), { code: e.data.code })));
      }
    }
    window.addEventListener('message', ecouter);
    ouvrir(page);
  });
}

/**
 * Fin de visite : une heure sans activité, ou la page fermée. Appelle `fin` (à vous d'oublier la
 * majorité côté serveur, par exemple en détruisant la session).
 */
export function minuteurInactivite(fin, dureeMs = 60 * 60 * 1000) {
  let t;
  const relancer = () => { clearTimeout(t); t = setTimeout(arreter, dureeMs); };
  const evenements = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
  function arreter() {
    clearTimeout(t);
    for (const e of evenements) window.removeEventListener(e, relancer);
    window.removeEventListener('pagehide', arreter);
    fin();
  }
  for (const e of evenements) window.addEventListener(e, relancer, { passive: true });
  window.addEventListener('pagehide', arreter);
  relancer();
  return arreter;
}
