/**
 * Visage du passe majeur : selfie avec deux mouvements de tête (détection du vivant faite par le serveur
 * sur les images), puis comparaison avec la photo de la pièce. Aucun modèle n'est chargé dans le
 * navigateur : le déroulé vient de useActiveLiveness (Idswyft), l'interface est propre à Preuvid.
 *
 * Sur ordinateur, le visage se montre à la caméra de l'ordinateur, celui qui recevra le passe : la pièce
 * photographiée au téléphone par quelqu'un d'autre ne suffit donc pas.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useActiveLiveness, type LivenessMetadata } from '../hooks/useActiveLiveness';

type Camera = 'eteinte' | 'demarrage' | 'prete' | 'absente' | 'refusee' | 'panne';

const MESSAGES_CAMERA: Partial<Record<Camera, string>> = {
  absente: 'Aucune caméra sur cet appareil. Il en faut une pour montrer votre visage : branchez une webcam, ou ouvrez le site sur votre téléphone.',
  refusee: 'La caméra est bloquée. Autorisez-la pour ce site dans le navigateur, puis réessayez.',
  panne: 'La caméra n’a pas démarré. Fermez les autres applications qui l’utilisent, puis réessayez.',
};

function consigne(phase: string, direction: 'left' | 'right'): string {
  switch (phase) {
    case 'ready': return 'Placez votre visage dans le cadre, bien éclairé.';
    case 'turn': return direction === 'left' ? 'Tournez lentement la tête vers la gauche.' : 'Tournez lentement la tête vers la droite.';
    case 'return_center': return 'Revenez face à l’écran.';
    case 'capturing':
    case 'completed': return 'Ne bougez plus…';
    default: return '';
  }
}

const NOTE = 'L’image sert à vérifier que vous êtes bien la personne de la pièce, puis elle est effacée. Elle n’est jamais montrée au site.';

/** `echec` : l'envoi a échoué ; `relancer` remonte le composant pour un nouvel essai. */
export function Visage({ envoyer, occupe, echec, relancer, note = NOTE }: {
  envoyer: (photo: Blob, meta: LivenessMetadata) => void; occupe: boolean; echec: string | null; relancer: () => void; note?: string;
}) {
  const [camera, setCamera] = useState<Camera>('eteinte');
  const flux = useRef<MediaStream | null>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [toile, setToile] = useState<HTMLCanvasElement | null>(null);

  const couper = useCallback(() => {
    flux.current?.getTracks().forEach(t => t.stop());
    flux.current = null;
  }, []);
  useEffect(() => couper, [couper]);

  // Appel direct dans le clic, sans attente avant : Safari sur iPhone refuse la caméra sinon.
  const allumer = () => {
    couper();
    setCamera('demarrage');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        flux.current = s;
        if (video) { video.srcObject = s; void video.play().catch(() => {}); }
        setCamera('prete');
      })
      .catch((err: { name?: string }) => {
        setCamera(err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError' ? 'absente'
          : err?.name === 'NotAllowedError' || err?.name === 'SecurityError' ? 'refusee' : 'panne');
      });
  };

  const fini = useCallback((photo: Blob, meta: LivenessMetadata) => {
    couper();
    envoyer(photo, meta);
  }, [couper, envoyer]);

  const { phase, direction, progress, error, retry } = useActiveLiveness({
    videoElement: video, canvasElement: toile, enabled: camera === 'prete', onComplete: fini, onFallback: () => {},
  });

  const enCours = camera === 'prete' && phase !== 'failed';
  const message = echec ?? MESSAGES_CAMERA[camera] ?? (phase === 'failed' ? 'Le délai est dépassé. Recommencez, sans vous presser.' : null);

  return (
    <>
      <div className={`cadre-visage${camera === 'prete' ? ' actif' : ''}`}>
        <video ref={setVideo} muted playsInline autoPlay aria-hidden="true" />
        <canvas ref={setToile} hidden />
        {camera !== 'prete' && <span className="cadre-vide" aria-hidden="true" />}
      </div>
      <p className="consigne" role="status" aria-live="assertive">
        {occupe ? 'Comparaison avec la photo de la pièce…'
          : echec ? ''
          : enCours ? consigne(phase, direction)
          : camera === 'demarrage' ? 'Démarrage de la caméra…' : ''}
      </p>
      {enCours && !occupe && !echec && (
        <div className="avancement" aria-hidden="true"><span style={{ width: `${Math.round(progress * 100)}%` }} /></div>
      )}
      <p role="alert" className="message" hidden={!message || occupe}>{message}{error && phase !== 'failed' ? ` ${error}` : ''}</p>
      <div className="bas">
        {echec && !occupe && <button className="bouton" onClick={relancer}>Recommencer</button>}
        {!echec && camera !== 'prete' && camera !== 'demarrage' && camera !== 'absente' && (
          <button className="bouton" onClick={allumer}>{camera === 'eteinte' ? 'Activer la caméra' : 'Réessayer'}</button>
        )}
        {camera === 'prete' && phase === 'failed' && !occupe && (
          <button className="bouton" onClick={retry}>Recommencer</button>
        )}
        <p className="note">{note}</p>
      </div>
    </>
  );
}
