/**
 * Dialogue avec l'onglet du site (preuvid/docs/double-anonymat.md) : le site ouvre cette page sans
 * Referer et lui passe un défi masqué par postMessage. L'origine du site reste dans la mémoire de la
 * page : elle n'est jamais envoyée au serveur de Preuvid.
 */

export interface Demande {
  cle: string;
  masque: string;
  /** Origine du site, pour lui répondre à lui seul. Ne quitte jamais le navigateur. */
  origine: string;
}

type Fenetre = {
  opener: { postMessage(message: unknown, cible: string): void } | null;
  addEventListener(type: 'message', f: (e: MessageEvent) => void): void;
  removeEventListener(type: 'message', f: (e: MessageEvent) => void): void;
};

const CLE = /^[0-9a-f]{64}$/;
// RSA 2048 : 256 octets, soit 342 caractères en base64url sans remplissage.
const MASQUE = /^[A-Za-z0-9_-]{342}$/;

/**
 * Annonce la page au site et attend sa demande. Ne retient que la première demande valide venue de
 * l'onglet qui a ouvert cette page. Renvoie de quoi arrêter l'écoute ; null si la page n'a pas été
 * ouverte par un site.
 */
export function attendreDemande(fenetre: Fenetre, rappel: (d: Demande) => void): (() => void) | null {
  const site = fenetre.opener;
  if (!site) return null;
  const ecouter = (e: MessageEvent) => {
    if (e.source !== site) return;
    const d = e.data as { type?: unknown; cle?: unknown; masque?: unknown } | null;
    if (!d || d.type !== 'preuvid:demande') return;
    if (typeof d.cle !== 'string' || !CLE.test(d.cle) || typeof d.masque !== 'string' || !MASQUE.test(d.masque)) return;
    if (typeof e.origin !== 'string' || !/^https?:\/\//.test(e.origin)) return;
    fenetre.removeEventListener('message', ecouter);
    rappel({ cle: d.cle, masque: d.masque, origine: e.origin });
  };
  fenetre.addEventListener('message', ecouter);
  // « pret » ne contient rien : il peut partir sans cible précise.
  site.postMessage({ type: 'preuvid:pret' }, '*');
  return () => fenetre.removeEventListener('message', ecouter);
}

export function repondre(fenetre: Fenetre, d: Demande, signatureMasquee: string) {
  fenetre.opener?.postMessage({ type: 'preuvid:reponse', signature_masquee: signatureMasquee }, d.origine);
}

export function refuser(fenetre: Fenetre, d: Demande, code: string) {
  fenetre.opener?.postMessage({ type: 'preuvid:refus', code }, d.origine);
}
