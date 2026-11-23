/**
 * Photo de la pièce (maquette 04) : caméra arrière, cadre au format carte, prise automatique dès que
 * l'image est nette, assez éclairée et montre les bords d'une pièce plusieurs fois de suite, ou prise à
 * la main. La prise automatique attend aussi quelques secondes, et s'arrête après une photo illisible
 * (`auto` faux) : le même mauvais objet, encore devant la caméra, userait tous les essais du côté.
 *
 * La caméra est ouverte par la page, dans le clic qui mène ici (Safari sur iPhone la refuse sinon), et
 * passée en `flux`. Sans caméra, un champ fichier prend le relais (appareil photo du téléphone, ou
 * photo déjà prise).
 */

import { useEffect, useRef, useState } from 'react';
import { ANNONCE_MS, consigne, gris, juger, LARGEUR_MESURE, mesurer, recadrage, Stabilite, type Jugement } from './qualite';

export const RAPPORT_CARTE = 1.586; // ISO/IEC 7810 ID-1 : 85,6 × 54 mm
const INTERVALLE_MS = 250;
const DELAI_MISE_AU_POINT_MS = 2500;

export type EtatCamera = 'eteinte' | 'demarrage' | 'prete' | 'absente' | 'refusee' | 'panne';

export const MESSAGES_CAMERA: Partial<Record<EtatCamera, string>> = {
  absente: 'Aucune caméra trouvée. Choisissez une photo de la pièce déjà prise, ou ouvrez le lien sur votre téléphone.',
  refusee: 'La caméra est bloquée. Autorisez-la pour ce site dans le navigateur, ou choisissez une photo déjà prise.',
  panne: 'La caméra n’a pas démarré. Fermez les autres applications qui l’utilisent, ou choisissez une photo déjà prise.',
};

function photographier(video: HTMLVideoElement): Promise<Blob | null> {
  const r = recadrage(video.videoWidth, video.videoHeight, RAPPORT_CARTE);
  const toile = document.createElement('canvas');
  toile.width = r.largeur; toile.height = r.hauteur;
  toile.getContext('2d')!.drawImage(video, r.x, r.y, r.largeur, r.hauteur, 0, 0, r.largeur, r.hauteur);
  return new Promise(res => toile.toBlob(res, 'image/jpeg', 0.92));
}

export function Capture({ flux, camera, allumer, envoyer, occupe, note, auto = true }: {
  flux: MediaStream | null;
  camera: EtatCamera;
  allumer: () => void;
  envoyer: (photo: Blob) => void;
  occupe: boolean;
  note?: string;
  auto?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [jugement, setJugement] = useState<Jugement | null>(null);
  const [annonce, setAnnonce] = useState('');
  const pris = useRef(false);
  const rappel = useRef(envoyer);
  rappel.current = envoyer;

  useEffect(() => {
    const v = video.current;
    if (!v || !flux) return;
    v.srcObject = flux;
    void v.play().catch(() => {});
    pris.current = false;
    const stabilite = new Stabilite();
    const toile = document.createElement('canvas');
    const debut = Date.now();
    let derniere = { texte: '', a: 0 };
    const minuterie = setInterval(() => {
      if (pris.current || !v.videoWidth) return;
      const r = recadrage(v.videoWidth, v.videoHeight, RAPPORT_CARTE);
      const l = LARGEUR_MESURE, h = Math.round(LARGEUR_MESURE / RAPPORT_CARTE);
      toile.width = l; toile.height = h;
      const ctx = toile.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, r.x, r.y, r.largeur, r.hauteur, 0, 0, l, h);
      const j = juger(mesurer(gris(ctx.getImageData(0, 0, l, h).data, l, h), l, h));
      setJugement(j);
      const texte = consigne(j, auto);
      if (texte !== derniere.texte && Date.now() - derniere.a >= ANNONCE_MS) { derniere = { texte, a: Date.now() }; setAnnonce(texte); }
      if (stabilite.ajouter(j.bonne) && auto && Date.now() - debut >= DELAI_MISE_AU_POINT_MS) {
        pris.current = true;
        void photographier(v).then(b => { if (b) rappel.current(b); else pris.current = false; });
      }
    }, INTERVALLE_MS);
    return () => { clearInterval(minuterie); v.srcObject = null; };
  }, [flux, auto]);

  const prendre = () => {
    const v = video.current;
    if (!v || !v.videoWidth || pris.current) return;
    pris.current = true;
    void photographier(v).then(b => { if (b) envoyer(b); else pris.current = false; });
  };

  const message = MESSAGES_CAMERA[camera];
  const sansCamera = camera === 'absente' || camera === 'refusee' || camera === 'panne';

  return (
    <>
      <div className={`cadre-piece${flux ? ' actif' : ''}`}>
        <video ref={video} muted playsInline autoPlay aria-hidden="true" />
        <span className="coins" aria-hidden="true" />
        <span className="guide" aria-hidden="true" />
      </div>
      <dl className="indicateurs">
        <div className={jugement ? (jugement.net ? 'ok' : 'non') : ''}>
          <dt>Netteté</dt><dd>{!jugement ? '…' : jugement.net ? 'bonne' : 'tenez immobile'}</dd>
        </div>
        <div className={jugement ? (jugement.eclaire ? 'ok' : 'non') : ''}>
          <dt>Lumière</dt><dd>{!jugement ? '…' : jugement.eclaire ? 'suffisante' : 'trop sombre'}</dd>
        </div>
        <div className={jugement ? (jugement.piece ? 'ok' : 'non') : ''}>
          <dt>Pièce</dt><dd>{!jugement ? '…' : jugement.piece ? 'dans le cadre' : 'alignez-la'}</dd>
        </div>
      </dl>
      <p className="sr" role="status">{annonce}</p>
      <p role="alert" className="message" hidden={!message}>{message}</p>
      <div className="bas">
        {flux && (
          <button className="bouton" onClick={prendre} disabled={occupe}>{occupe ? 'Envoi…' : auto ? 'Prendre la photo moi-même' : 'Prendre la photo'}</button>
        )}
        {((sansCamera && camera !== 'absente') || camera === 'eteinte') && (
          <button className="bouton" onClick={allumer}>{camera === 'eteinte' ? 'Activer la caméra' : 'Réessayer la caméra'}</button>
        )}
        {!flux && (
          <label className={`lien fichier${occupe ? ' occupe' : ''}`}>
            <input className="sr" type="file" accept="image/*" capture="environment" disabled={occupe}
              onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) envoyer(f); }} />
            Choisir une photo
          </label>
        )}
        {note && <p className="note">{note}</p>}
      </div>
    </>
  );
}
