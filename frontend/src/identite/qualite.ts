/**
 * Prise automatique de la photo de la pièce (maquette 04) : deux mesures simples sur l'image de la
 * caméra, réduite à 480 pixels de large, sans aucun modèle chargé.
 *
 * - Netteté : variance du laplacien (4 voisins) sur les niveaux de gris. Mesurée sur les images du banc
 *   (preuvid/banc/img) : 1 494 à 4 079 pour les photos exploitables, 295 à 504 pour les floues et
 *   celles à reflet. Le seuil est posé entre les deux.
 * - Lumière : luminance moyenne. 101 à 104 sur les images sombres du banc, 159 et plus ailleurs.
 * - Pièce : au moins deux bords droits et nets près des côtés du cadre (le contour de la pièce, ou ses
 *   bandes imprimées). Une scène nette sans pièce (table, visage) ne doit pas partir : un recto illisible
 *   vaut refus définitif de la session. Mesuré : texture nette sans pièce, rapport 1,1 sur chaque côté ;
 *   passeport cadré, 4 côtés au-dessus de 28 ; carte en perspective, 3 côtés ; carte très inclinée, aucun
 *   (la prise reste possible à la main).
 *
 * Les reflets ne sont pas mesurés : sur les cartes synthétiques du banc, claires, la part de pixels
 * saturés ne les distingue pas (30 à 41 % sur une photo propre, 13 à 15 % avec reflet). Les seuils
 * n'ont été mesurés que sur ces images synthétiques ; le bouton « Prendre la photo moi-même » reste.
 */

export const LARGEUR_MESURE = 480;
export const NETTETE_MIN = 800;
export const LUMIERE_MIN = 130;
export const BORD_MIN = 30;
export const BORD_RAPPORT = 3;
export const COTES_MIN = 2;

export interface Mesure { nettete: number; lumiere: number; cotes: number }
export interface Jugement { net: boolean; eclaire: boolean; piece: boolean; bonne: boolean }

/** Niveaux de gris (BT.601) d'une image RGBA. */
export function gris(rgba: Uint8ClampedArray | Uint8Array, largeur: number, hauteur: number): Float32Array {
  const g = new Float32Array(largeur * hauteur);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return g;
}

export function mesurer(g: Float32Array, largeur: number, hauteur: number): Mesure {
  let somme = 0;
  for (let i = 0; i < g.length; i++) somme += g[i];
  const lumiere = g.length ? somme / g.length : 0;
  let n = 0, s = 0, s2 = 0;
  for (let y = 1; y < hauteur - 1; y++) {
    for (let x = 1; x < largeur - 1; x++) {
      const i = y * largeur + x;
      const l = g[i - 1] + g[i + 1] + g[i - largeur] + g[i + largeur] - 4 * g[i];
      s += l; s2 += l * l; n++;
    }
  }
  const moyenne = n ? s / n : 0;
  return { nettete: n ? s2 / n - moyenne * moyenne : 0, lumiere, cotes: cotesNets(g, largeur, hauteur) };
}

const mediane = (a: number[]) => { const t = [...a].sort((x, y) => x - y); return t.length ? t[t.length >> 1] : 0; };

/** Un côté compte si une ligne (ou colonne) de sa bande a un bord net, bien plus fort que le reste de la bande. */
function coteNet(profil: number[]): boolean {
  if (!profil.length) return false;
  const pic = Math.max(...profil);
  return pic >= BORD_MIN && pic >= BORD_RAPPORT * (mediane(profil) + 1e-6);
}

/** Nombre de côtés (haut, bas, gauche, droite) où un bord droit traverse la bande du quart extérieur. */
export function cotesNets(g: Float32Array, largeur: number, hauteur: number): number {
  if (largeur < 8 || hauteur < 8) return 0;
  const x0 = Math.floor(0.2 * largeur), x1 = Math.floor(0.8 * largeur);
  const y0 = Math.floor(0.2 * hauteur), y1 = Math.floor(0.8 * hauteur);
  const lignes: number[] = [];
  for (let y = 1; y < hauteur - 1; y++) {
    let t = 0;
    for (let x = x0; x < x1; x++) t += Math.abs(g[(y + 1) * largeur + x] - g[(y - 1) * largeur + x]);
    lignes.push(t / (x1 - x0));
  }
  const colonnes: number[] = [];
  for (let x = 1; x < largeur - 1; x++) {
    let t = 0;
    for (let y = y0; y < y1; y++) t += Math.abs(g[y * largeur + x + 1] - g[y * largeur + x - 1]);
    colonnes.push(t / (y1 - y0));
  }
  const quart = (a: number[], debut: boolean) => (debut ? a.slice(0, Math.floor(a.length / 4)) : a.slice(Math.ceil(a.length * 3 / 4)));
  return [quart(lignes, true), quart(lignes, false), quart(colonnes, true), quart(colonnes, false)].filter(coteNet).length;
}

export function juger(m: Mesure): Jugement {
  const net = m.nettete >= NETTETE_MIN;
  const eclaire = m.lumiere >= LUMIERE_MIN;
  const piece = m.cotes >= COTES_MIN;
  return { net, eclaire, piece, bonne: net && eclaire && piece };
}

/**
 * Consigne lue par les lecteurs d'écran : une phrase qui résume les trois voyants. Les voyants eux-mêmes
 * changent jusqu'à quatre fois par seconde ; les annoncer tels quels rendrait la page inaudible.
 */
export function consigne(j: Jugement | null, auto: boolean): string {
  if (!j) return '';
  if (j.bonne) return auto ? 'Pièce bien cadrée. Ne bougez plus, la photo part.' : 'Pièce bien cadrée. Vous pouvez prendre la photo.';
  return [
    !j.piece && 'Alignez la pièce sur les pointillés.',
    !j.net && 'Image floue : tenez immobile.',
    !j.eclaire && 'Trop sombre : rapprochez-vous de la lumière.',
  ].filter(Boolean).join(' ');
}

/** Intervalle minimal entre deux consignes annoncées. */
export const ANNONCE_MS = 3000;

/**
 * Partie de l'image de la caméra visible dans le cadre (vidéo affichée « object-fit: cover ») :
 * c'est elle qu'on mesure et qu'on envoie.
 */
export function recadrage(largeur: number, hauteur: number, rapport: number) {
  if (largeur / hauteur > rapport) {
    const l = Math.round(hauteur * rapport);
    return { x: Math.round((largeur - l) / 2), y: 0, largeur: l, hauteur };
  }
  const h = Math.round(largeur / rapport);
  return { x: 0, y: Math.round((hauteur - h) / 2), largeur, hauteur: h };
}

/** Il faut plusieurs images bonnes de suite : une seule peut l'être par hasard pendant un mouvement. */
export class Stabilite {
  private suite = 0;
  constructor(private readonly requis = 4) {}
  ajouter(bonne: boolean): boolean {
    this.suite = bonne ? this.suite + 1 : 0;
    return this.suite >= this.requis;
  }
}
