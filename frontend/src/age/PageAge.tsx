/**
 * Page du passe majeur, ouverte par un site dans un nouvel onglet (maquettes 08, 09 et 10).
 *
 * Le site attend une signature de son défi masqué. Cette page la fait produire par le serveur de
 * Preuvid, soit avec le passe (clé d'accès), soit après une première vérification de la pièce, puis
 * la rend au site par postMessage. Elle ne garde rien d'autre qu'un repère local « un passe existe
 * sur cet appareil », jamais envoyé.
 *
 * Sur ordinateur, la photo de la pièce se prend avec le téléphone : un QR code ouvre la page photo
 * (PageTelephone), cet onglet attend la lecture, puis demande le visage à la caméra de l'ordinateur
 * (Visage), crée le passe et répond au site.
 */

import { useEffect, useRef, useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import QRCode from 'react-qr-code';
import * as api from './api';
import { ChoixPiece, Entete, texteErreur } from './commun';
import { attendreDemande, refuser, repondre, type Demande } from './protocole';
import { Rosace } from './Rosace';
import { attendreDecision, lienTelephone, type Issue } from './suivi';
import { Visage } from './Visage';
import type { LivenessMetadata } from '../hooks/useActiveLiveness';

type Ecran = 'attente' | 'sans-site' | 'premiere' | 'telephone' | 'piece' | 'lecture' | 'visage' | 'refus' | 'passe' | 'retour' | 'fini';
const REPERE = 'preuvid.passe';

const lireRepere = () => { try { return localStorage.getItem(REPERE) === '1'; } catch { return false; } };
const ecrireRepere = (oui: boolean) => { try { if (oui) localStorage.setItem(REPERE, '1'); else localStorage.removeItem(REPERE); } catch { /* navigation privée */ } };
/** Pas d'écran tactile principal : on propose de prendre la photo avec le téléphone. */
const surOrdinateur = () => typeof matchMedia === 'function' && !matchMedia('(pointer: coarse)').matches;


export function PageAge() {
  const [ecran, setEcran] = useState<Ecran>('attente');
  const [demande, setDemande] = useState<Demande | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [typePiece, setTypePiece] = useState<api.TypePiece>('national_id');
  const [lien, setLien] = useState<string | null>(null);
  const [surTelephone, setSurTelephone] = useState(false);
  const [essaiVisage, setEssaiVisage] = useState(0);
  const verification = useRef<api.Verification | null>(null);
  const titre = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const arreter = attendreDemande(window, (d) => {
      setDemande(d);
      setEcran(lireRepere() && browserSupportsWebAuthn() ? 'retour' : 'premiere');
    });
    if (!arreter) { setEcran('sans-site'); return; }
    const delai = setTimeout(() => setEcran(e => (e === 'attente' ? 'sans-site' : e)), 8000);
    return () => { arreter(); clearTimeout(delai); };
  }, []);

  // Chaque écran annonce son titre aux lecteurs d'écran.
  useEffect(() => { titre.current?.focus(); setErreur(null); }, [ecran]);

  async function agir(f: () => Promise<void>) {
    setOccupe(true); setErreur(null);
    try { await f(); } catch (err) { setErreur(texteErreur(err)); } finally { setOccupe(false); }
  }

  const rendre = (signature: string) => {
    repondre(window, demande!, signature);
    setEcran('fini');
    setTimeout(() => window.close(), 1500);
  };

  // ── Écran 10 : visites suivantes ────────────────────────────────────────────────────────────
  const confirmer = () => agir(async () => {
    const options = await api.defi();
    const assertion = await startAuthentication({ optionsJSON: options });
    try {
      rendre((await api.preuve(demande!.cle, demande!.masque, assertion)).signature_masquee);
    } catch (err) {
      if (err instanceof api.ErreurAge && err.code === 'passe_introuvable') ecrireRepere(false);
      throw err;
    }
  });

  // ── Première vérification ───────────────────────────────────────────────────────────────────
  const conclure = (issue: Issue) => {
    if (issue !== 'arrete') setEcran(issue === 'majeur' ? 'passe' : issue === 'visage' ? 'visage' : 'refus');
  };
  const suivre = (v: api.Verification) => attendreDecision(() => api.etatVerification(v), { intervalleMs: 1500, limiteMs: 3 * 60 * 1000 });

  const envoyerPhoto = (photo: File) => agir(async () => {
    const v = await api.ouvrirVerification();
    verification.current = v;
    await api.envoyerRecto(v, photo, typePiece);
    setEcran('lecture');
    conclure(await suivre(v));
  });

  const envoyerVisage = (photo: Blob, meta: LivenessMetadata) => agir(async () => {
    const v = verification.current!;
    await api.envoyerVisage(v, photo, meta);
    conclure(await suivre(v));
  });

  // Ordinateur : QR code vers la page photo du téléphone, puis attente de la décision.
  useEffect(() => {
    if (ecran !== 'telephone') return;
    let quitte = false;
    setLien(null); setSurTelephone(false);
    (async () => {
      try {
        const v = await api.ouvrirVerification();
        if (quitte) return;
        verification.current = v;
        setLien(lienTelephone(window.location.origin, v));
        conclure(await attendreDecision(() => api.etatVerification(v), {
          limiteMs: 55 * 60 * 1000, arrete: () => quitte, surEtat: e => setSurTelephone(e.statut === 'en_cours'),
        }));
      } catch (err) {
        if (!quitte) setErreur(texteErreur(err));
      }
    })();
    return () => { quitte = true; };
  }, [ecran]);

  // ── Écran 09 ────────────────────────────────────────────────────────────────────────────────
  const creerPasse = () => agir(async () => {
    const v = verification.current!;
    const options = await api.optionsCreation(v);
    const attestation = await startRegistration({ optionsJSON: options });
    const r = await api.creerPasse(v, demande!.cle, demande!.masque, attestation);
    ecrireRepere(true);
    rendre(r.signature_masquee);
  });
  const justeCetteFois = () => agir(async () => {
    rendre((await api.preuveUnique(verification.current!, demande!.cle, demande!.masque)).signature_masquee);
  });

  const zoneErreur = <p role="alert" className="message" hidden={!erreur}>{erreur}</p>;

  if (ecran === 'retour') {
    return (
      <main className="page sombre">
        <Entete indice="3 secondes" machine />
        <Rosace className={`rosace-centre${occupe ? ' attente' : ''}`} />
        <h1 ref={titre} tabIndex={-1}>Votre passe est là</h1>
        <p className="chapeau">{surOrdinateur()
          ? 'Confirmez avec l’empreinte, le code de l’ordinateur ou votre téléphone : c’est bien vous.'
          : 'Déverrouillez votre téléphone pour confirmer que c’est bien vous.'}</p>
        {zoneErreur}
        <div className="bas">
          <button className="bouton" onClick={confirmer} disabled={occupe}>{occupe ? 'Confirmation…' : 'Confirmer et entrer'}</button>
          <p className="note">Valable pour cette visite : une heure sans activité et il faudra confirmer de nouveau.</p>
          <button className="lien" onClick={() => setEcran('premiere')}>Je n’ai pas de passe sur cet appareil</button>
        </div>
      </main>
    );
  }

  if (ecran === 'passe') {
    return (
      <main className="page">
        <Entete indice="majorité confirmée" machine />
        <h1 ref={titre} tabIndex={-1}>{surOrdinateur() ? 'Gardez votre passe sur votre appareil' : 'Gardez votre passe dans ce téléphone'}</h1>
        <p className="chapeau">{surOrdinateur()
          ? 'Le navigateur propose de le ranger sur cet ordinateur ou sur votre téléphone. Il ne sert qu’après déverrouillage.'
          : 'Il reste chez vous, protégé par le code ou l’empreinte de l’appareil. Il ne sert qu’après déverrouillage.'}</p>
        <div className="carte" aria-hidden="true">
          <Rosace />
          <span className="marque">Preuvid<span>.</span></span>
          <div><b>Passe majeur</b><small>AUCUN NOM · AUCUNE PHOTO</small></div>
        </div>
        <dl className="registre">
          <div><dt>Ce que contient le passe</dt><dd>« majeur »</dd></div>
          <div><dt>Où il est rangé</dt><dd>le trousseau de l’appareil</dd></div>
        </dl>
        {zoneErreur}
        <div className="bas">
          <button className="bouton" onClick={creerPasse} disabled={occupe || !browserSupportsWebAuthn()}>
            {occupe ? 'Création…' : 'Créer mon passe'}
          </button>
          <button className="lien" onClick={justeCetteFois} disabled={occupe}>Non merci, juste pour cette fois</button>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <Rosace className="fond-rosace" />
      {ecran === 'attente' && (
        <>
          <Entete indice="" />
          <h1 ref={titre} tabIndex={-1} className="pouls">Connexion au site…</h1>
        </>
      )}

      {ecran === 'sans-site' && (
        <>
          <Entete indice="" />
          <h1 ref={titre} tabIndex={-1}>Ouvrez cette page depuis le site</h1>
          <p className="chapeau">Le passe majeur se demande depuis le site qui vous le propose : cette page s’ouvre alors toute seule.</p>
        </>
      )}

      {ecran === 'premiere' && (
        <>
          <Entete indice="Une seule fois" />
          <h1 ref={titre} tabIndex={-1}>Prouvez votre majorité une fois, pas à chaque visite</h1>
          <p className="chapeau">Ensuite, un geste suffit. Sur tous les sites qui utilisent Preuvid.</p>
          <fieldset className="choix">
            <legend>Méthode</legend>
            <label className="option">
              <input type="radio" name="methode" defaultChecked />
              <strong>Avec ma pièce d’identité</strong>
              <small>1 minute : la pièce, puis votre visage. Rien n’est gardé.</small>
            </label>
            <label className="option">
              <input type="radio" name="methode" disabled />
              <strong>Avec mon portefeuille d’identité</strong>
              <small>[DISPONIBILITÉ À CONFIRMER]</small>
            </label>
          </fieldset>
          <div className="bas">
            <button className="bouton" onClick={() => setEcran(surOrdinateur() ? 'telephone' : 'piece')}>Commencer</button>
            <p className="note">Le site saura seulement que vous êtes majeur. Nous ne saurons pas quel site vous visitez.</p>
            {lireRepere() || browserSupportsWebAuthn() ? (
              <button className="lien" onClick={() => setEcran('retour')}>J’ai déjà un passe</button>
            ) : null}
          </div>
        </>
      )}

      {ecran === 'telephone' && (
        <>
          <Entete indice="1 minute" />
          <h1 ref={titre} tabIndex={-1}>Continuez sur votre téléphone</h1>
          <p className="chapeau">Scannez ce code avec l’appareil photo du téléphone pour photographier votre pièce. Cet onglet attend la réponse.</p>
          <div className="qr" role="img" aria-label="Code à scanner avec le téléphone">
            {lien ? <QRCode value={lien} size={200} bgColor="#FBFBF8" fgColor="#0F1F1A" /> : <span className="qr-vide" />}
          </div>
          <p className="note centre" role="status">
            {surTelephone ? 'Photo reçue : lecture de la date de naissance…' : 'Le code ne contient ni le nom du site ni vos données. Valable une heure.'}
          </p>
          {zoneErreur}
          <div className="bas">
            <button className="lien" onClick={() => setEcran('piece')}>Envoyer une photo depuis cet ordinateur</button>
            <button className="lien" onClick={() => setEcran('premiere')}>Retour</button>
          </div>
        </>
      )}

      {ecran === 'piece' && (
        <>
          <Entete indice="1 minute" />
          <h1 ref={titre} tabIndex={-1}>Photographiez le recto de votre pièce</h1>
          <p className="chapeau">Seules la date de naissance et la photo du visage servent. Tout est effacé dès la réponse.</p>
          {zoneErreur}
          <ChoixPiece type={typePiece} choisir={setTypePiece} occupe={occupe} envoyer={p => void envoyerPhoto(p)}>
            <button className="lien" onClick={() => setEcran(surOrdinateur() ? 'telephone' : 'premiere')} disabled={occupe}>Retour</button>
          </ChoixPiece>
        </>
      )}

      {ecran === 'lecture' && (
        <>
          <Entete indice="lecture en cours" machine />
          <h1 ref={titre} tabIndex={-1}>Lecture de la date de naissance</h1>
          <p className="chapeau" role="status">Quelques secondes. Rien d’autre n’est gardé.</p>
          <Rosace className="rosace-centre attente" couleur="var(--encre-douce)" />
          {zoneErreur}
        </>
      )}

      {ecran === 'visage' && (
        <>
          <Entete indice="dernière étape" machine />
          <h1 ref={titre} tabIndex={-1}>Montrez votre visage</h1>
          <p className="chapeau">{surOrdinateur()
            ? 'La pièce est lue. Face à la caméra de cet ordinateur, deux mouvements de tête : une quinzaine de secondes.'
            : 'La pièce est lue. Face à l’écran, deux mouvements de tête : une quinzaine de secondes.'}</p>
          <Visage key={essaiVisage} envoyer={(p, m) => void envoyerVisage(p, m)} occupe={occupe}
            echec={erreur} relancer={() => { setErreur(null); setEssaiVisage(n => n + 1); }} />
        </>
      )}

      {ecran === 'refus' && (
        <>
          <Entete indice="" />
          <h1 ref={titre} tabIndex={-1}>La majorité n’a pas pu être prouvée</h1>
          <p className="chapeau">La pièce était peut-être illisible, ou le visage n’a pas pu être rapproché de sa photo. Les images ont été effacées.</p>
          <div className="bas">
            <button className="bouton" onClick={() => setEcran(surOrdinateur() ? 'telephone' : 'piece')}>Recommencer</button>
            <button className="lien" onClick={() => { if (demande) refuser(window, demande, 'majorite_non_prouvee'); window.close(); }}>Revenir au site</button>
          </div>
        </>
      )}

      {ecran === 'fini' && (
        <>
          <Entete indice="" />
          <span className="tampon-resultat" aria-hidden="true">majeur</span>
          <h1 ref={titre} tabIndex={-1}>C’est fait</h1>
          <p className="chapeau" role="status">Le site a reçu sa réponse. Vous pouvez fermer cet onglet.</p>
        </>
      )}
    </main>
  );
}
