/**
 * Page photo du téléphone, ouverte par le QR code affiché sur l'ordinateur.
 *
 * Elle reçoit la vérification et son jeton après le « # » (jamais envoyés au serveur dans l'adresse),
 * les retire aussitôt de l'historique, envoie la photo du recto, puis renvoie la personne vers
 * l'ordinateur : c'est l'onglet de l'ordinateur qui demande le visage (à sa propre caméra), crée le passe
 * et répond au site. Cette page ne sait pas quel site a fait la demande, et ne prend jamais le visage :
 * sinon la personne qui scanne le code pourrait tout faire à la place de celle devant l'ordinateur.
 */

import { useEffect, useRef, useState } from 'react';
import * as api from './api';
import { ChoixPiece, Entete, texteErreur } from './commun';
import { Rosace } from './Rosace';
import { attendreDecision, lireLien } from './suivi';

type Ecran = 'controle' | 'piece' | 'lecture' | 'suite' | 'ok' | 'refus' | 'invalide';

export function PageTelephone() {
  const [v] = useState(() => lireLien(window.location.hash));
  const [ecran, setEcran] = useState<Ecran>(v ? 'controle' : 'invalide');
  const [type, setType] = useState<api.TypePiece>('national_id');
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const titre = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
    if (!v) return;
    api.etatVerification(v).then(
      e => setEcran(e.statut === 'en_attente' ? 'piece' : e.statut === 'validee' && e.majeur ? 'ok'
        : e.statut === 'en_cours' ? (e.etape === 'visage' ? 'suite' : 'lecture') : 'invalide'),
      () => setEcran('invalide'),
    );
  }, [v]);

  useEffect(() => { titre.current?.focus(); }, [ecran]);

  const envoyer = async (photo: File) => {
    setOccupe(true); setErreur(null);
    try {
      await api.envoyerRecto(v!, photo, type);
      setEcran('lecture');
      const issue = await attendreDecision(() => api.etatVerification(v!), { intervalleMs: 1500, limiteMs: 3 * 60 * 1000 });
      // « introuvable » : l'ordinateur a déjà créé le passe, la vérification est effacée.
      setEcran(issue === 'visage' ? 'suite' : issue === 'majeur' || issue === 'introuvable' ? 'ok' : 'refus');
    } catch (err) {
      if (err instanceof api.ErreurAge && err.status === 401) setEcran('invalide');
      else setErreur(texteErreur(err));
    } finally {
      setOccupe(false);
    }
  };

  return (
    <main className="page">
      <Rosace className="fond-rosace" />
      {ecran === 'controle' && (
        <>
          <Entete indice="" />
          <h1 ref={titre} tabIndex={-1} className="pouls">Un instant…</h1>
        </>
      )}

      {ecran === 'piece' && (
        <>
          <Entete indice="depuis l’ordinateur" machine />
          <h1 ref={titre} tabIndex={-1}>Photographiez le recto de votre pièce</h1>
          <p className="chapeau">Seules la date de naissance et la photo du visage servent. Tout est effacé dès la réponse.</p>
          <p role="alert" className="message" hidden={!erreur}>{erreur}</p>
          <ChoixPiece type={type} choisir={setType} occupe={occupe} envoyer={p => void envoyer(p)} />
        </>
      )}

      {ecran === 'lecture' && (
        <>
          <Entete indice="lecture en cours" machine />
          <h1 ref={titre} tabIndex={-1}>Lecture de la date de naissance</h1>
          <p className="chapeau" role="status">Quelques secondes. Rien d’autre n’est gardé.</p>
          <Rosace className="rosace-centre attente" couleur="var(--encre-douce)" />
        </>
      )}

      {ecran === 'suite' && (
        <>
          <Entete indice="pièce lue" machine />
          <h1 ref={titre} tabIndex={-1}>Revenez sur l’ordinateur</h1>
          <p className="chapeau" role="status">Dernière étape là-bas : montrer votre visage à sa caméra, pour vérifier que la pièce est bien la vôtre. Vous pouvez fermer cette page.</p>
        </>
      )}

      {ecran === 'ok' && (
        <>
          <Entete indice="" />
          <span className="tampon-resultat" aria-hidden="true">majeur</span>
          <h1 ref={titre} tabIndex={-1}>Revenez sur l’ordinateur</h1>
          <p className="chapeau" role="status">Votre majorité est confirmée. La suite se passe sur l’ordinateur. Vous pouvez fermer cette page.</p>
        </>
      )}

      {ecran === 'refus' && (
        <>
          <Entete indice="" />
          <h1 ref={titre} tabIndex={-1}>La majorité n’a pas pu être prouvée</h1>
          <p className="chapeau">La photo était peut-être floue ou la pièce illisible. Elle a été effacée. Recommencez depuis l’ordinateur : il affichera un nouveau code.</p>
        </>
      )}

      {ecran === 'invalide' && (
        <>
          <Entete indice="" />
          <h1 ref={titre} tabIndex={-1}>Ce code n’est plus valable</h1>
          <p className="chapeau">Il a expiré ou a déjà servi. Sur l’ordinateur, reprenez depuis le site : un nouveau code s’affichera.</p>
        </>
      )}
    </main>
  );
}
